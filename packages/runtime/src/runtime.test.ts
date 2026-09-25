import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { startTurnRequest } from "@nimplex/contracts";
import type { RunExecutor } from "@nimplex/core";
import { getSandboxProvider } from "@nimplex/sandbox";
import { startFakeAnthropic } from "@nimplex/testkit";
import { afterEach, describe, expect, it } from "vitest";
import { NimplexRuntime } from "./runtime.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function setup(script?: Parameters<typeof startFakeAnthropic>[1], executor?: RunExecutor) {
  const dir = mkdtempSync(join(tmpdir(), "nimplex-runtime-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const upstream = await startFakeAnthropic(0, script);
  cleanup.push(upstream.close);
  const options = {
    directory: dir,
    credential: () => ({ apiKey: "fake-key", baseUrl: upstream.url }),
    // This suite covers the legacy executor, which legacy sessions still run on; the
    // default harness engine has pi-harness-engine.test.ts. An injected executor
    // replaces the legacy loop.
    engine: "pi-executor" as const,
    executor,
  };
  const runtime = new NimplexRuntime(options);
  cleanup.push(() => runtime.close());
  return { runtime, dir, options, upstream };
}
const request = (prompt = "Work", extra = {}) =>
  startTurnRequest.parse({ prompt, sandbox: "docker", ...extra });
async function finish(runtime: NimplexRuntime, id: string) {
  for await (const _event of runtime.events(id)) {
    /* Drain the committed event stream. */
  }
  return runtime.getTurn(id);
}

describe("local session authority", () => {
  it("refuses an injected executor unless the legacy engine is selected", () => {
    const dir = mkdtempSync(join(tmpdir(), "nimplex-runtime-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const executor: RunExecutor = async (run) => ({
      events: [],
      files: run.files,
      costUsd: 0,
      stopReason: "stop",
    });
    const credential = () => ({ apiKey: "unused", baseUrl: null });
    for (const engine of [undefined, "pi-harness"] as const)
      expect(() => new NimplexRuntime({ directory: dir, credential, executor, engine })).toThrow(
        'requires engine: "pi-executor"',
      );
    const legacy = new NimplexRuntime({
      directory: dir,
      credential,
      executor,
      engine: "pi-executor",
    });
    cleanup.push(() => legacy.close());
    expect(legacy.createSession(dir).engine).toBe("pi-executor");
  });
  it("runs the real Pi loop without API/Postgres, continues history, and isolates branches", async () => {
    const f = await setup({
      script: [{ name: "bash", input: { command: "echo FIRST > /workspace/hello.txt" } }],
    });
    const session = f.runtime.createSession(f.dir);
    const a = await f.runtime.startTurn(session.id, request());
    expect((await finish(f.runtime, a.runId)).status).toBe("completed");
    expect(new TextDecoder().decode(f.runtime.readFile(a.runId, "/workspace/hello.txt"))).toBe(
      "FIRST\n",
    );
    const branch = f.runtime.forkSession(session.id);
    if (!branch.headRunId) throw new Error("Branch must retain its source turn");
    const b = await f.runtime.startTurn(
      session.id,
      request("Remember FIRST", {
        attachments: [{ path: "/workspace/hello.txt", content: "SECOND" }],
      }),
    );
    expect((await finish(f.runtime, b.runId)).status).toBe("completed");
    expect(f.runtime.getSession(session.id).turns).toHaveLength(2);
    expect(JSON.stringify(f.upstream.state.messagesCalls.at(-1)?.body.messages)).toContain(
      "Remember FIRST",
    );
    expect(JSON.stringify(f.upstream.state.messagesCalls.at(-1)?.body.messages)).toContain(
      "echo FIRST",
    );
    expect(new TextDecoder().decode(f.runtime.readFile(a.runId, "/workspace/hello.txt"))).toBe(
      "FIRST\n",
    );
    await f.runtime.close();
    const reopened = new NimplexRuntime(f.options);
    cleanup.push(() => reopened.close());
    expect(reopened.getSession(session.id).turns).toHaveLength(2);
    expect(new TextDecoder().decode(reopened.readFile(b.runId, "/workspace/hello.txt"))).toBe(
      "SECOND",
    );
    const cursor = reopened.getSession(session.id).turns[0]?.events[0]?.seq;
    if (cursor === undefined) throw new Error("Missing committed cursor");
    const replay = [];
    for await (const event of reopened.events(a.runId, { after: cursor })) replay.push(event);
    expect(replay.every((event) => event.seq > cursor)).toBe(true);
  });
  it("rejects a second root owner and concurrent turns in one session", async () => {
    const f = await setup({ delayMs: 100 });
    expect(() => new NimplexRuntime(f.options)).toThrow("already owns");
    const session = f.runtime.createSession(f.dir);
    const a = await f.runtime.startTurn(session.id, request());
    await expect(f.runtime.startTurn(session.id, request())).rejects.toThrow("active turn");
    const other = f.runtime.createSession(f.dir);
    const b = await f.runtime.startTurn(other.id, request());
    expect((await finish(f.runtime, a.runId)).status).toBe("completed");
    expect((await finish(f.runtime, b.runId)).status).toBe("completed");
  });
  it("enforces read-only tools without a budget", async () => {
    const f = await setup({
      script: [{ name: "write", input: { path: "/workspace/no.txt", content: "forbidden" } }],
    });
    const session = f.runtime.createSession(f.dir);
    const b = await f.runtime.startTurn(
      session.id,
      request("Read only", { executionMode: "read_only" }),
    );
    expect((await finish(f.runtime, b.runId)).status).toBe("completed");
    expect(f.runtime.files(b.runId)).toEqual([]);
    expect(
      f.runtime
        .getSession(session.id)
        .turns.at(-1)
        ?.events.some(
          (e) => e.type === "tool.result" && (e.payload as { is_error: boolean }).is_error,
        ),
    ).toBe(true);
  });
  it("settles cancellation, records unknown outcomes, and sends no subsequent tool", async () => {
    const f = await setup({ delayMs: 200, toolCalls: 1 });
    const session = f.runtime.createSession(f.dir);
    const a = await f.runtime.startTurn(session.id, request());
    for await (const event of f.runtime.events(a.runId)) {
      if (event.type === "model.started") {
        await f.runtime.stopTurn(a.runId);
        break;
      }
    }
    expect(f.runtime.getTurn(a.runId).status).toBe("canceled");
    expect(f.runtime.getTurn(a.runId)).not.toHaveProperty("reserved_usd");
    expect(f.runtime.files(a.runId)).toEqual([]);
  });
  it("resumes interrupted work explicitly and never commits a partial workspace", async () => {
    let invocation = 0;
    const executor: RunExecutor = async (run, signal) => {
      invocation++;
      if (invocation === 1) {
        await run.persistence.commitTool(
          [
            {
              type: "tool.result",
              payload: {
                id: "done",
                name: "write",
                content: [{ type: "text", text: "Saved" }],
                is_error: false,
              },
            },
          ],
          { "/workspace/saved": new TextEncoder().encode("durable") },
          {},
        );
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        signal.throwIfAborted();
      }
      expect(new TextDecoder().decode(run.files["/workspace/saved"])).toBe("durable");
      return { events: [], files: run.files, costUsd: 0, stopReason: "stop" };
    };
    const f = await setup({}, executor);
    const session = f.runtime.createSession(f.dir);
    const a = await f.runtime.startTurn(session.id, request());
    for await (const event of f.runtime.events(a.runId))
      if (event.type === "workspace.committed") break;
    await f.runtime.close();
    const reopened = new NimplexRuntime(f.options);
    cleanup.push(() => reopened.close());
    expect(reopened.getTurn(a.runId).error).toBe("runtime_interrupted");
    expect(invocation).toBe(1);
    expect((await reopened.resumeTurn(session.id)).runId).toBe(a.runId);
    expect((await finish(reopened, a.runId)).status).toBe("completed");
    expect(invocation).toBe(2);
  });
  it("rejects attachment traversal, directory paths and trailing slashes", async () => {
    const f = await setup();
    const session = f.runtime.createSession(f.dir);
    for (const path of ["/workspace/../outside", "/workspace/", "/workspace/dir/", "/workspace"])
      await expect(
        f.runtime.startTurn(session.id, request("bad", { attachments: [{ path, content: "x" }] })),
      ).rejects.toThrow("Invalid attachment");
    expect(f.runtime.getSession(session.id).turns).toHaveLength(0);
  });
  it("prunes untouched default sessions on close and keeps renamed or used ones", async () => {
    const f = await setup();
    const untouched = f.runtime.createSession(f.dir);
    const renamed = f.runtime.createSession(f.dir);
    f.runtime.renameSession(renamed.id, "Keep me");
    const used = f.runtime.createSession(f.dir);
    const a = await f.runtime.startTurn(used.id, request());
    expect((await finish(f.runtime, a.runId)).status).toBe("completed");
    expect(
      f.runtime
        .listSessions()
        .map((s) => s.id)
        .sort(),
    ).toEqual([untouched.id, renamed.id, used.id].sort());
    await f.runtime.close();
    const reopened = new NimplexRuntime(f.options);
    cleanup.push(() => reopened.close());
    expect(
      reopened
        .listSessions()
        .map((s) => s.id)
        .sort(),
    ).toEqual([renamed.id, used.id].sort());
    expect(() => reopened.getSession(untouched.id)).toThrow("not found");
    expect(reopened.getSession(used.id).turns).toHaveLength(1);
  });
  it("keeps a resumable session's native environment across close and deletes idle ones", async () => {
    const provider = getSandboxProvider("docker");
    const deleted: string[] = [];
    const original = provider.delete;
    provider.delete = async (state) => {
      deleted.push(String(state.providerState.containerId));
    };
    cleanup.push(() => {
      provider.delete = original;
    });
    const executor: RunExecutor = async (run, signal) => {
      if (run.config && (run.config as { input: string }).input === "hang") {
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        signal.throwIfAborted();
      }
      return { events: [], files: run.files, costUsd: 0, stopReason: "stop" };
    };
    const f = await setup({}, executor);
    const idle = f.runtime.createSession(f.dir);
    const interrupted = f.runtime.createSession(f.dir);
    const done = await f.runtime.startTurn(idle.id, request("finish"));
    expect((await finish(f.runtime, done.runId)).status).toBe("completed");
    const hanging = await f.runtime.startTurn(interrupted.id, request("hang"));
    for await (const event of f.runtime.events(hanging.runId))
      if (event.type === "run.started") break;
    // Give both sessions a durable native handle, as a journaled native command would.
    const db = new DatabaseSync(join(f.dir, "runtime.sqlite"));
    cleanup.push(() => db.close());
    for (const [id, container] of [
      [idle.id, "idle-box"],
      [interrupted.id, "journal-box"],
    ] as const) {
      const row = JSON.parse(
        String(db.prepare("SELECT data FROM sessions WHERE id=?").get(id)?.data),
      );
      row.sandboxProvider = "docker";
      row.sandboxState = {
        backendId: "docker",
        providerState: { containerId: container },
      };
      db.prepare("UPDATE sessions SET data=? WHERE id=?").run(JSON.stringify(row), id);
    }
    await f.runtime.close();
    expect(deleted).toEqual(["idle-box"]);
    const reopened = new NimplexRuntime(f.options);
    cleanup.push(() => reopened.close());
    expect(reopened.getTurn(hanging.runId).error).toBe("runtime_interrupted");
    const kept = JSON.parse(
      String(db.prepare("SELECT data FROM sessions WHERE id=?").get(interrupted.id)?.data),
    );
    expect(kept.sandboxState?.providerState?.containerId).toBe("journal-box");
  });
});

it("completes legacy-engine requests above the former cap using Pi catalog pricing", async () => {
  const f = await setup({ inputTokens: 100000, toolCalls: 2 });
  const session = f.runtime.createSession(f.dir);
  const run = await f.runtime.startTurn(session.id, request());
  const result = await finish(f.runtime, run.runId);
  expect(result.status).toBe("completed");
  expect(result.spent_usd).toBeGreaterThan(0.2);
  expect(result).not.toHaveProperty("budget_usd");
  expect(f.upstream.state.messagesCalls).toHaveLength(3);
});
