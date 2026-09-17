import { fork } from "node:child_process";
import { once } from "node:events";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/pi-agent-core/harness/context";
import { operationResult } from "@earendil-works/pi-agent-core/harness/session";
import type { RunEvent } from "@nimplex/contracts";
import { startFakeAnthropic } from "@nimplex/testkit";
import { expect, it } from "vitest";
import { PI_TENANT } from "./pi-harness-engine.ts";
import { SqlitePiStorage } from "./pi-storage/sqlite.ts";
import { NimplexRuntime } from "./runtime.ts";

type Boundary = "after-response" | "after-tool" | "during-request";
const ofType = (events: RunEvent[], type: string) => events.filter((e) => e.type === type);

it.each<Boundary>(["after-response", "after-tool", "during-request"])(
  "resumes a harness turn after SIGKILL %s without repeating committed work",
  async (boundary) => {
    const child = fork(
      fileURLToPath(new URL("./testing/pi-harness-engine-child.ts", import.meta.url)),
      [boundary],
      { execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"] },
    );
    const exited = once(child, "exit");
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    let directory: string | undefined;
    let runtime: NimplexRuntime | undefined;
    let upstream: Awaited<ReturnType<typeof startFakeAnthropic>> | undefined;
    try {
      const witness = await new Promise<{
        directory: string;
        sessionId: string;
        runId: string;
        requests: number;
      }>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Boundary timeout (${boundary}): ${stderr}`)),
          20_000,
        );
        const seen: Record<string, unknown> = {};
        child.once("exit", () => {
          clearTimeout(timer);
          reject(new Error(`Unexpected child exit: ${stderr}`));
        });
        child.on("message", (message: Record<string, unknown> & { stage: string }) => {
          Object.assign(seen, message);
          if (message.stage === "ready") directory = String(message.directory);
          if (message.stage === "committed") {
            clearTimeout(timer);
            resolve(seen as typeof witness);
          }
        });
      });
      child.kill("SIGKILL");
      expect(await exited).toEqual([null, "SIGKILL"]);
      if (!directory) throw new Error("Child did not report its state root");
      const db = new DatabaseSync(join(directory, "runtime.sqlite"));
      const before = db
        .prepare("SELECT id,parent_id,seq,data FROM pi_store_entries ORDER BY seq")
        .all();
      const eventsBefore = db.prepare("SELECT COUNT(*) AS count FROM events").get()?.count;
      db.close();
      // The killed request may or may not have reached the child's upstream before the kill.
      if (boundary === "during-request") expect([1, 2]).toContain(witness.requests);
      else expect(witness.requests).toBe(2);
      // The child's fake upstream died with it; a new one continues the same script.
      upstream = await startFakeAnthropic(0, {
        script: [
          { name: "write", input: { path: "/workspace/a.txt", content: "first\n" } },
          { name: "bash", input: { command: "echo once >> /workspace/append.txt" } },
          { name: "read", input: { path: "/workspace/a.txt" } },
        ],
      });
      const url = upstream.url;
      runtime = new NimplexRuntime({
        directory,
        engine: "pi-harness",
        credential: () => ({ apiKey: "fake-key", baseUrl: url }),
      });
      const interrupted = runtime.getTurn(witness.runId);
      expect(interrupted.status).toBe("failed");
      expect(interrupted.error).toBe("runtime_interrupted");
      expect(runtime.getSession(witness.sessionId).engine).toBe("pi-harness");
      expect(upstream.state.messagesCalls).toHaveLength(0);
      const resumed = await runtime.resumeTurn(witness.sessionId);
      expect(resumed.runId).toBe(witness.runId);
      for await (const _event of runtime.events(witness.runId)) {
        /* Drain until the resumed turn settles. */
      }
      const turn = runtime.getTurn(witness.runId);
      expect(turn.status).toBe("completed");
      const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
      expect(decode(runtime.readFile(witness.runId, "/workspace/a.txt"))).toBe("first\n");
      // The bash effect happened exactly once across both processes.
      expect(decode(runtime.readFile(witness.runId, "/workspace/append.txt"))).toBe("once\n");
      const events = runtime.getSession(witness.sessionId).turns[0]?.events ?? [];
      const reserved = ofType(events, "model.reserved").length;
      expect(ofType(events, "spend.updated")).toHaveLength(reserved);
      expect(
        ofType(events, "tool.result").map((e) => (e.payload as { name: string }).name),
      ).toEqual(["write", "bash", "read"]);
      // Requests after restart: a committed response is never re-requested.
      if (boundary === "during-request") {
        // The in-flight request has an unknown outcome: its reservation stays allocated
        // and Pi's durable retry issues a new identified attempt.
        expect(ofType(events, "model.unknown")).toHaveLength(1);
        expect(turn.reserved_usd).toBeGreaterThan(0);
        expect(upstream.state.messagesCalls).toHaveLength(3);
        expect(reserved).toBe(5);
      } else {
        expect(ofType(events, "model.unknown")).toHaveLength(0);
        expect(turn.reserved_usd).toBe(0);
        expect(upstream.state.messagesCalls).toHaveLength(2);
        expect(reserved).toBe(4);
      }
      expect(ofType(events, "model.call")).toHaveLength(4);
      // Committed Pi history is a prefix of the recovered history.
      const after = new DatabaseSync(join(directory, "runtime.sqlite"));
      try {
        expect(
          after
            .prepare("SELECT id,parent_id,seq,data FROM pi_store_entries ORDER BY seq")
            .all()
            .slice(0, before.length),
        ).toEqual(before);
        expect(
          Number(after.prepare("SELECT COUNT(*) AS count FROM events").get()?.count),
        ).toBeGreaterThan(Number(eventsBefore));
        const storage = new SqlitePiStorage(
          after,
          { tenantId: PI_TENANT, sessionId: witness.sessionId },
          () => {},
        );
        expect(
          (await storage.getValue(operationResult(witness.runId), context))?.value.status,
        ).toBe("completed");
        expect((await storage.rebuildProjections()).stats).toEqual(await storage.getStats(context));
        await storage.close(context);
      } finally {
        after.close();
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
      await runtime?.close();
      await upstream?.close();
      if (directory) rmSync(directory, { recursive: true, force: true });
    }
  },
  40_000,
);

it("finishes a durably cancelled turn as canceled when the process died before reconciliation", async () => {
  const child = fork(
    fileURLToPath(new URL("./testing/pi-harness-engine-child.ts", import.meta.url)),
    ["cancel-pending"],
    { execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  const exited = once(child, "exit");
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  let directory: string | undefined;
  let runtime: NimplexRuntime | undefined;
  let upstream: Awaited<ReturnType<typeof startFakeAnthropic>> | undefined;
  try {
    const witness = await new Promise<{ directory: string; sessionId: string; runId: string }>(
      (resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Boundary timeout: ${stderr}`)), 20_000);
        const seen: Record<string, unknown> = {};
        child.once("exit", () => {
          clearTimeout(timer);
          reject(new Error(`Unexpected child exit: ${stderr}`));
        });
        child.on("message", (message: Record<string, unknown> & { stage: string }) => {
          Object.assign(seen, message);
          if (message.stage === "ready") directory = String(message.directory);
          if (message.stage === "committed") {
            clearTimeout(timer);
            resolve(seen as typeof witness);
          }
        });
      },
    );
    child.kill("SIGKILL");
    expect(await exited).toEqual([null, "SIGKILL"]);
    if (!directory) throw new Error("Child did not report its state root");
    upstream = await startFakeAnthropic(0, {});
    const url = upstream.url;
    runtime = new NimplexRuntime({
      directory,
      engine: "pi-harness",
      credential: () => ({ apiKey: "fake-key", baseUrl: url }),
    });
    expect(runtime.getTurn(witness.runId).error).toBe("runtime_interrupted");
    await runtime.resumeTurn(witness.sessionId);
    for await (const _event of runtime.events(witness.runId)) {
      /* Drain until reconciliation settles. */
    }
    const turn = runtime.getTurn(witness.runId);
    expect(turn.status).toBe("canceled");
    expect(turn.error).toBe("canceled");
    expect(upstream.state.messagesCalls).toHaveLength(0);
    expect(runtime.files(witness.runId)).toEqual([]);
    const db = new DatabaseSync(join(directory, "runtime.sqlite"));
    try {
      const storage = new SqlitePiStorage(
        db,
        { tenantId: PI_TENANT, sessionId: witness.sessionId },
        () => {},
      );
      expect((await storage.getValue(operationResult(witness.runId), context))?.value.status).toBe(
        "aborted",
      );
      await storage.close(context);
    } finally {
      db.close();
    }
    // The session accepts new work after the cancelled turn settled.
    const next = await runtime.startTurn(witness.sessionId, {
      prompt: "Again",
      instructions: "Complete the task.",
      model: "claude-haiku-4-5",
      sandbox: "docker",
      budget: 1,
      timeout: 180,
      contextMode: "continue",
      executionMode: "build",
    });
    for await (const _event of runtime.events(next.runId)) {
      /* Drain. */
    }
    expect(runtime.getTurn(next.runId).status).toBe("completed");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    await runtime?.close();
    await upstream?.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
}, 40_000);

it("records an interrupted summary request as unknown and completes the compaction on resume", async () => {
  const child = fork(
    fileURLToPath(new URL("./testing/pi-harness-engine-child.ts", import.meta.url)),
    ["during-summary"],
    { execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  const exited = once(child, "exit");
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  let directory: string | undefined;
  let runtime: NimplexRuntime | undefined;
  let upstream: Awaited<ReturnType<typeof startFakeAnthropic>> | undefined;
  try {
    const witness = await new Promise<{ directory: string; sessionId: string; runId: string }>(
      (resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Boundary timeout: ${stderr}`)), 60_000);
        const seen: Record<string, unknown> = {};
        child.once("exit", () => {
          clearTimeout(timer);
          reject(new Error(`Unexpected child exit: ${stderr}`));
        });
        child.on("message", (message: Record<string, unknown> & { stage: string }) => {
          Object.assign(seen, message);
          if (message.stage === "ready") directory = String(message.directory);
          if (message.stage === "committed") {
            clearTimeout(timer);
            resolve(seen as typeof witness);
          }
        });
      },
    );
    child.kill("SIGKILL");
    expect(await exited).toEqual([null, "SIGKILL"]);
    if (!directory) throw new Error("Child did not report its state root");
    upstream = await startFakeAnthropic(0, { honorToolAvailability: true });
    const url = upstream.url;
    runtime = new NimplexRuntime({
      directory,
      engine: "pi-harness",
      credential: () => ({ apiKey: "fake-key", baseUrl: url }),
    });
    expect(runtime.getTurn(witness.runId).error).toBe("runtime_interrupted");
    await runtime.resumeTurn(witness.sessionId);
    for await (const _event of runtime.events(witness.runId)) {
      /* Drain until the resumed turn settles. */
    }
    const turn = runtime.getTurn(witness.runId);
    expect(turn.status).toBe("completed");
    // The interrupted summary request keeps its reservation as an unknown outcome; the
    // retry and the prompt are new identified reservations.
    expect(upstream.state.messagesCalls).toHaveLength(2);
    expect(upstream.state.messagesCalls[0]?.body.tools).toBeUndefined();
    const events = runtime.getSession(witness.sessionId).turns[1]?.events ?? [];
    expect(ofType(events, "model.unknown")).toHaveLength(1);
    expect(ofType(events, "model.unknown")[0]?.payload).toMatchObject({ step: "summary" });
    expect(ofType(events, "model.call")).toHaveLength(2);
    expect(ofType(events, "spend.updated")).toHaveLength(ofType(events, "model.reserved").length);
    expect(ofType(events, "context.compacted")).toHaveLength(1);
    expect(turn.reserved_usd).toBeGreaterThan(0);
    const db = new DatabaseSync(join(directory, "runtime.sqlite"));
    try {
      const storage = new SqlitePiStorage(
        db,
        { tenantId: PI_TENANT, sessionId: witness.sessionId },
        () => {},
      );
      expect(await storage.scanEntries({ type: "compaction" }, context)).toHaveLength(1);
      expect(
        (await storage.getValue(operationResult(`${witness.runId}:compact`), context))?.value
          .status,
      ).toBe("completed");
      await storage.close(context);
    } finally {
      db.close();
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    await runtime?.close();
    await upstream?.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
}, 90_000);
