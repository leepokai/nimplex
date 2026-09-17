import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/pi-agent-core/harness/context";
import { operationResult } from "@earendil-works/pi-agent-core/harness/session";
import { type RunEvent, startTurnRequest } from "@nimplex/contracts";
import { computeCost } from "@nimplex/core";
import { type FakeAnthropicOptions, startFakeAnthropic } from "@nimplex/testkit";
import { afterEach, describe, expect, it } from "vitest";
import { PI_TENANT } from "./pi-harness-engine.ts";
import { initializePiStorage } from "./pi-storage/schema.ts";
import { SqlitePiStorage } from "./pi-storage/sqlite.ts";
import { NimplexRuntime, type RuntimeOptions } from "./runtime.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const SCRIPT: FakeAnthropicOptions["script"] = [
  { name: "write", input: { path: "/workspace/a.txt", content: "first\n" } },
  { name: "bash", input: { command: "echo once >> /workspace/append.txt" } },
  { name: "read", input: { path: "/workspace/a.txt" } },
];

async function setup(upstream: FakeAnthropicOptions = {}, extra: Partial<RuntimeOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "nimplex-harness-engine-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const fake = await startFakeAnthropic(0, {
    script: SCRIPT,
    honorToolAvailability: true,
    ...upstream,
  });
  cleanup.push(fake.close);
  const options: RuntimeOptions = {
    directory: dir,
    engine: "pi-harness",
    credential: () => ({ apiKey: "fake-key", baseUrl: fake.url }),
    ...extra,
  };
  const runtime = new NimplexRuntime(options);
  cleanup.push(() => runtime.close());
  return { runtime, dir, options, upstream: fake };
}
const request = (prompt = "Work", extra = {}) =>
  startTurnRequest.parse({ prompt, sandbox: "docker", budget: 1, ...extra });
async function finish(runtime: NimplexRuntime, id: string) {
  for await (const _event of runtime.events(id)) {
    /* Drain committed events. */
  }
  return runtime.getTurn(id);
}
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const ofType = (events: RunEvent[], type: string) => events.filter((e) => e.type === type);
function piStorage(dir: string, sessionId: string) {
  const db = new DatabaseSync(join(dir, "runtime.sqlite"));
  cleanup.push(() => db.close());
  return new SqlitePiStorage(db, { tenantId: PI_TENANT, sessionId }, () => {});
}

describe("Pi harness engine", () => {
  it("runs a tool turn with atomic Pi/nimplex commits, exact accounting and continued history", async () => {
    const f = await setup();
    const session = f.runtime.createSession(f.dir);
    expect(session.engine).toBe("pi-harness");
    const a = await f.runtime.startTurn(session.id, request("Write, run, read"));
    const turn = await finish(f.runtime, a.runId);
    expect(turn.status).toBe("completed");
    expect(f.upstream.state.messagesCalls).toHaveLength(4);
    expect(text(f.runtime.readFile(a.runId, "/workspace/a.txt"))).toBe("first\n");
    expect(text(f.runtime.readFile(a.runId, "/workspace/append.txt"))).toBe("once\n");
    const events = f.runtime.getSession(session.id).turns[0]?.events ?? [];
    expect(ofType(events, "model.reserved")).toHaveLength(4);
    expect(ofType(events, "model.call")).toHaveLength(4);
    expect(ofType(events, "spend.updated")).toHaveLength(4);
    expect(ofType(events, "model.unknown")).toHaveLength(0);
    expect(ofType(events, "tool.call").map((e) => (e.payload as { name: string }).name)).toEqual([
      "write",
      "bash",
      "read",
    ]);
    expect(ofType(events, "tool.started")).toHaveLength(3);
    expect(ofType(events, "tool.result")).toHaveLength(3);
    expect(ofType(events, "workspace.committed")).toHaveLength(3);
    // Every reservation settles to the priced usage of its committed response.
    const expected = f.upstream.state.messagesCalls.reduce(
      (sum, call) =>
        sum +
        computeCost("anthropic", "claude-haiku-4-5", {
          inputTokens: 1000,
          outputTokens: Math.min(500, call.maxTokens),
        }).costUsd,
      0,
    );
    expect(turn.spent_usd).toBeCloseTo(expected, 6);
    expect(turn.reserved_usd).toBe(0);
    // The tool result and its workspace revision share one commit: no result without files.
    const order = events.map((e) => e.type);
    for (const [index, type] of order.entries()) {
      if (type !== "tool.result") continue;
      let next = index + 1;
      while (order[next] === "file.changed") next++;
      expect(order[next]).toBe("workspace.committed");
    }
    // Pi's own history is the authority for the next turn's context.
    const storage = piStorage(f.dir, session.id);
    const entries = await storage.scanEntries({}, context);
    expect(entries.filter((e) => e.type === "message")).toHaveLength(1 + 4 + 3);
    expect((await storage.getValue(operationResult(a.runId), context))?.value.status).toBe(
      "completed",
    );
    const b = await f.runtime.startTurn(session.id, request("Now say hello"));
    expect((await finish(f.runtime, b.runId)).status).toBe("completed");
    const last = JSON.stringify(f.upstream.state.messagesCalls.at(-1)?.body.messages);
    expect(last).toContain("Write, run, read");
    expect(last).toContain("Now say hello");
    expect(f.runtime.getSession(session.id).turns).toHaveLength(2);
    await f.runtime.close();
    const reopened = new NimplexRuntime(f.options);
    cleanup.push(() => reopened.close());
    expect(reopened.getSession(session.id).engine).toBe("pi-harness");
    expect(text(reopened.readFile(b.runId, "/workspace/append.txt"))).toBe("once\n");
  });

  it("denies unaffordable dispatch before any provider call and kills the turn", async () => {
    const f = await setup();
    const session = f.runtime.createSession(f.dir);
    const a = await f.runtime.startTurn(session.id, request("Tiny", { budget: 0.000001 }));
    const turn = await finish(f.runtime, a.runId);
    expect(turn.status).toBe("killed");
    expect(turn.error).toBe("budget_exceeded");
    expect(f.upstream.state.messagesCalls).toHaveLength(0);
    expect(turn.spent_usd).toBe(0);
    expect(turn.reserved_usd).toBe(0);
    const events = f.runtime.getSession(session.id).turns[0]?.events ?? [];
    expect(ofType(events, "model.reserved")).toHaveLength(0);
    expect(ofType(events, "model.call")).toHaveLength(0);
  });

  it("keeps read-only turns from writing", async () => {
    const f = await setup({
      script: [{ name: "write", input: { path: "/workspace/no.txt", content: "forbidden" } }],
    });
    const session = f.runtime.createSession(f.dir);
    const a = await f.runtime.startTurn(
      session.id,
      request("Read", { executionMode: "read_only" }),
    );
    expect((await finish(f.runtime, a.runId)).status).toBe("completed");
    expect(f.runtime.files(a.runId)).toEqual([]);
    const events = f.runtime.getSession(session.id).turns[0]?.events ?? [];
    expect(
      ofType(events, "tool.result").map((e) => (e.payload as { is_error: boolean }).is_error),
    ).toEqual([true]);
    expect(f.runtime.getSession(session.id).turns).toHaveLength(1);
  });

  it("branches a harness session through Pi's fork policy and keeps both lineages independent", async () => {
    const f = await setup();
    const session = f.runtime.createSession(f.dir);
    const a = await f.runtime.startTurn(session.id, request("Turn one"));
    expect((await finish(f.runtime, a.runId)).status).toBe("completed");
    const b = await f.runtime.startTurn(session.id, request("Turn two"));
    expect((await finish(f.runtime, b.runId)).status).toBe("completed");
    // Branch from the earlier turn: the branch sees turn one only.
    const early = f.runtime.forkSession(session.id, a.runId);
    expect(early.engine).toBe("pi-harness");
    expect(early.turns.map((t) => t.runId)).toEqual([a.runId]);
    const c = await f.runtime.startTurn(early.id, request("Branch prompt"));
    expect((await finish(f.runtime, c.runId)).status).toBe("completed");
    const branchRequest = JSON.stringify(f.upstream.state.messagesCalls.at(-1)?.body.messages);
    expect(branchRequest).toContain("Turn one");
    expect(branchRequest).toContain("Branch prompt");
    expect(branchRequest).not.toContain("Turn two");
    // The source continues with its full history and never sees the branch.
    const d = await f.runtime.startTurn(session.id, request("Source continues"));
    expect((await finish(f.runtime, d.runId)).status).toBe("completed");
    const sourceRequest = JSON.stringify(f.upstream.state.messagesCalls.at(-1)?.body.messages);
    expect(sourceRequest).toContain("Turn two");
    expect(sourceRequest).not.toContain("Branch prompt");
    // Branch from the latest turn copies the whole path; Pi entries keep their identity.
    const latest = f.runtime.forkSession(session.id);
    const sourceEntries = await piStorage(f.dir, session.id).scanEntries({}, context);
    const branchEntries = await piStorage(f.dir, latest.id).scanEntries({}, context);
    expect(branchEntries.map((e) => e.id)).toEqual(sourceEntries.map((e) => e.id));
    expect(branchEntries.map((e) => [e.timestamp, e.parentId])).toEqual(
      sourceEntries.map((e) => [e.timestamp, e.parentId]),
    );
    const branchStorage = piStorage(f.dir, latest.id);
    expect(await branchStorage.scanUsage({}, context)).toEqual([]);
    expect((await branchStorage.rebuildProjections()).nextSeq).toBeGreaterThan(1);
    // Branching from an interrupted or unfinished turn stays rejected.
    const slow = await setup({ delayMs: 500 });
    const running = slow.runtime.createSession(slow.dir);
    const e = await slow.runtime.startTurn(running.id, request("Running"));
    expect(() => slow.runtime.forkSession(running.id)).toThrow("completed or stopped");
    await finish(slow.runtime, e.runId);
  });

  it("creates the branch's Pi scope and host record atomically", async () => {
    const f = await setup();
    const session = f.runtime.createSession(f.dir);
    const a = await f.runtime.startTurn(session.id, request("Turn one"));
    expect((await finish(f.runtime, a.runId)).status).toBe("completed");
    const db = new DatabaseSync(join(f.dir, "runtime.sqlite"));
    cleanup.push(() => db.close());
    const sessionsBefore = db.prepare("SELECT COUNT(*) AS count FROM sessions").get()?.count;
    db.exec(`CREATE TRIGGER reject_fork BEFORE INSERT ON pi_store_entries
      BEGIN SELECT RAISE(ABORT, 'injected fork failure'); END;`);
    expect(() => f.runtime.forkSession(session.id)).toThrow("injected fork failure");
    expect(db.prepare("SELECT COUNT(*) AS count FROM sessions").get()?.count).toBe(sessionsBefore);
    expect(db.prepare("SELECT COUNT(*) AS count FROM pi_store_sessions").get()?.count).toBe(1);
    db.exec("DROP TRIGGER reject_fork");
    const branch = f.runtime.forkSession(session.id);
    expect(f.runtime.getSession(branch.id).turns).toHaveLength(1);
  });

  it("rolls Pi writes and nimplex accounting back together when a required commit fails", async () => {
    const f = await setup();
    const session = f.runtime.createSession(f.dir);
    const db = new DatabaseSync(join(f.dir, "runtime.sqlite"));
    cleanup.push(() => db.close());
    initializePiStorage(db);
    // Reject the first settlement: Pi's usage row and nimplex's spend must both be absent.
    db.exec(`CREATE TRIGGER reject_usage BEFORE INSERT ON pi_store_usage
      BEGIN SELECT RAISE(ABORT, 'injected settlement failure'); END;`);
    const a = await f.runtime.startTurn(session.id, request("Fail once"));
    const turn = await finish(f.runtime, a.runId);
    expect(turn.status).toBe("failed");
    expect(turn.error).toContain("injected settlement failure");
    expect(f.upstream.state.messagesCalls).toHaveLength(1);
    expect(db.prepare("SELECT COUNT(*) AS count FROM pi_store_usage").get()?.count).toBe(0);
    const events = f.runtime.getSession(session.id).turns[0]?.events ?? [];
    expect(ofType(events, "model.reserved")).toHaveLength(1);
    expect(ofType(events, "model.call")).toHaveLength(0);
    expect(ofType(events, "spend.updated")).toHaveLength(0);
    expect(ofType(events, "tool.call")).toHaveLength(0);
    expect(f.runtime.files(a.runId)).toEqual([]);
    // The dispatched request's outcome is unknown to accounting: its reservation stays allocated.
    expect(turn.spent_usd).toBe(0);
    expect(turn.reserved_usd).toBeGreaterThan(0);
    const storage = piStorage(f.dir, session.id);
    expect((await storage.scanEntries({ type: "message" }, context)).map((e) => e.type)).toEqual([
      "message",
    ]);
    db.exec("DROP TRIGGER reject_usage");
  });

  it("settles cancellation durably in Pi and nimplex without a later tool effect", async () => {
    const f = await setup({ delayMs: 300 });
    const session = f.runtime.createSession(f.dir);
    const a = await f.runtime.startTurn(session.id, request("Slow"));
    for await (const event of f.runtime.events(a.runId)) {
      if (event.type === "model.reserved") {
        await f.runtime.stopTurn(a.runId);
        break;
      }
    }
    const turn = f.runtime.getTurn(a.runId);
    expect(turn.status).toBe("canceled");
    expect(f.runtime.files(a.runId)).toEqual([]);
    // The reservation precedes dispatch, so cancellation may land before the request is sent.
    const dispatched = f.upstream.state.messagesCalls.length;
    expect(dispatched).toBeLessThanOrEqual(1);
    const storage = piStorage(f.dir, session.id);
    expect((await storage.getValue(operationResult(a.runId), context))?.value.status).toBe(
      "aborted",
    );
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(f.runtime.files(a.runId)).toEqual([]);
    expect(f.upstream.state.messagesCalls).toHaveLength(dispatched);
    // A cancelled turn does not block the session: the next turn reconciles and proceeds.
    const b = await f.runtime.startTurn(session.id, request("Again"));
    expect((await finish(f.runtime, b.runId)).status).toBe("completed");
  });

  it("compacts on request with a budgeted summary that settles atomically with Pi's usage", async () => {
    const f = await setup();
    const session = f.runtime.createSession(f.dir);
    const a = await f.runtime.startTurn(session.id, request("Write, run, read"));
    expect((await finish(f.runtime, a.runId)).status).toBe("completed");
    const before = f.upstream.state.messagesCalls.length;
    const b = await f.runtime.startTurn(
      session.id,
      request("Summarize then continue", { contextMode: "compact" }),
    );
    const turn = await finish(f.runtime, b.runId);
    expect(turn.status).toBe("completed");
    // One summary request first; the stateless fake then replays its script for the prompt.
    const summaryRequest = f.upstream.state.messagesCalls[before];
    expect(summaryRequest?.body.tools).toBeUndefined();
    expect(JSON.stringify(summaryRequest?.body.messages)).toContain("<conversation>");
    const requests = f.upstream.state.messagesCalls.slice(before);
    expect(requests.filter((call) => call.body.tools === undefined)).toHaveLength(1);
    const events = f.runtime.getSession(session.id).turns[1]?.events ?? [];
    const calls = ofType(events, "model.call");
    expect(calls.map((e) => (e.payload as { step: string }).step)).toEqual([
      "summary",
      ...requests.slice(1).map(() => "assistant"),
    ]);
    expect(ofType(events, "model.reserved")).toHaveLength(requests.length);
    expect(ofType(events, "spend.updated")).toHaveLength(requests.length);
    expect(ofType(events, "context.compacted")).toHaveLength(1);
    // The summary is context maintenance, not transcript output.
    for (const event of ofType(events, "message.delta"))
      expect((event.payload as { text: string }).text).not.toContain("summary of the conversation");
    expect(turn.reserved_usd).toBe(0);
    expect(turn.spent_usd).toBeGreaterThan(0);
    const storage = piStorage(f.dir, session.id);
    const compactions = await storage.scanEntries({ type: "compaction" }, context);
    expect(compactions).toHaveLength(1);
    expect(JSON.stringify(compactions[0])).toContain("summary of the conversation");
    // The follow-up prompt saw the summary rather than the raw first turn.
    const prompt = JSON.stringify(f.upstream.state.messagesCalls.at(-1)?.body.messages);
    expect(prompt).toContain("summary of the conversation");
    expect(prompt).toContain("Summarize then continue");
    expect(prompt).not.toContain("Write, run, read");
    // Nothing to compact is not an error.
    const c = await f.runtime.startTurn(
      session.id,
      request("Compact again", { contextMode: "compact" }),
    );
    expect((await finish(f.runtime, c.runId)).status).toBe("completed");
  });

  it("denies an unaffordable summary before dispatch and kills the turn", async () => {
    const f = await setup();
    const session = f.runtime.createSession(f.dir);
    const a = await f.runtime.startTurn(session.id, request("Write, run, read"));
    expect((await finish(f.runtime, a.runId)).status).toBe("completed");
    const before = f.upstream.state.messagesCalls.length;
    const b = await f.runtime.startTurn(
      session.id,
      request("Compact", { contextMode: "compact", budget: 0.000001 }),
    );
    const turn = await finish(f.runtime, b.runId);
    expect(turn.status).toBe("killed");
    expect(turn.error).toBe("budget_exceeded");
    expect(f.upstream.state.messagesCalls).toHaveLength(before);
    expect(turn.spent_usd).toBe(0);
    expect(turn.reserved_usd).toBe(0);
    const storage = piStorage(f.dir, session.id);
    expect(await storage.scanEntries({ type: "compaction" }, context)).toEqual([]);
  });

  it("resets context at the root while preserving the earlier history in Pi's tree", async () => {
    const f = await setup();
    const session = f.runtime.createSession(f.dir);
    const a = await f.runtime.startTurn(session.id, request("First conversation"));
    expect((await finish(f.runtime, a.runId)).status).toBe("completed");
    const b = await f.runtime.startTurn(
      session.id,
      request("Fresh start", { contextMode: "reset" }),
    );
    expect((await finish(f.runtime, b.runId)).status).toBe("completed");
    const prompt = JSON.stringify(f.upstream.state.messagesCalls.at(-1)?.body.messages);
    expect(prompt).toContain("Fresh start");
    expect(prompt).not.toContain("First conversation");
    const storage = piStorage(f.dir, session.id);
    const messages = await storage.scanEntries({ type: "message" }, context);
    expect(JSON.stringify(messages)).toContain("First conversation");
    // The reset navigation is a settled Pi operation owned by the turn.
    expect(
      (await storage.getValue(operationResult(`${b.runId}:reset`), context))?.value.status,
    ).toBe("completed");
    // Reset on an already-root lane is a no-op.
    const fresh = f.runtime.createSession(f.dir);
    const c = await f.runtime.startTurn(fresh.id, request("Root", { contextMode: "reset" }));
    expect((await finish(f.runtime, c.runId)).status).toBe("completed");
    // Continuing after a reset builds on the new root branch only.
    const d = await f.runtime.startTurn(session.id, request("Continue fresh"));
    expect((await finish(f.runtime, d.runId)).status).toBe("completed");
    const next = JSON.stringify(f.upstream.state.messagesCalls.at(-1)?.body.messages);
    expect(next).toContain("Fresh start");
    expect(next).not.toContain("First conversation");
  });

  it("delivers durable steering and follow-up input at Pi's boundaries exactly once", async () => {
    const f = await setup({ delayMs: 150 });
    const session = f.runtime.createSession(f.dir);
    await expect(
      f.runtime.queueInput(session.id, { kind: "steer", text: "nobody is running" }),
    ).rejects.toThrow("no active turn");
    const a = await f.runtime.startTurn(session.id, request("Write, run, read"));
    let steered: { entryId: string } | undefined;
    let followed: { entryId: string } | undefined;
    for await (const event of f.runtime.events(a.runId)) {
      if (event.type === "tool.result" && !steered) {
        steered = await f.runtime.queueInput(session.id, { kind: "steer", text: "STEER NOW" });
        followed = await f.runtime.queueInput(session.id, {
          kind: "followUp",
          text: "FOLLOW UP LATER",
        });
      }
    }
    const turn = f.runtime.getTurn(a.runId);
    expect(turn.status).toBe("completed");
    if (!steered || !followed) throw new Error("Input was not queued");
    const bodies = f.upstream.state.messagesCalls.map((call) => JSON.stringify(call.body.messages));
    const firstSteer = bodies.findIndex((body) => body.includes("STEER NOW"));
    const firstFollowUp = bodies.findIndex((body) => body.includes("FOLLOW UP LATER"));
    expect(firstSteer).toBeGreaterThan(0);
    // Steering interrupts before the follow-up, which only runs after the work would end.
    expect(firstFollowUp).toBeGreaterThan(firstSteer);
    expect(bodies.at(-1)).toContain("FOLLOW UP LATER");
    const events = f.runtime.getSession(session.id).turns[0]?.events ?? [];
    expect(ofType(events, "input.queued").map((e) => e.payload)).toEqual([
      { entry_id: steered.entryId, kind: "steer" },
      { entry_id: followed.entryId, kind: "followUp" },
    ]);
    expect(ofType(events, "input.consumed").map((e) => e.payload)).toEqual([
      { entry_id: steered.entryId, kind: "steer", delivered: true },
      { entry_id: followed.entryId, kind: "followUp", delivered: true },
    ]);
    const storage = piStorage(f.dir, session.id);
    const messages = await storage.scanEntries({ type: "message" }, context);
    expect(messages.filter((e) => e.id === steered?.entryId)).toHaveLength(1);
    expect(messages.filter((e) => e.id === followed?.entryId)).toHaveLength(1);
    expect(JSON.stringify(messages).split("STEER NOW")).toHaveLength(2);
    expect(ofType(events, "spend.updated")).toHaveLength(ofType(events, "model.reserved").length);
    // Legacy engine sessions have no in-flight inbox.
    await f.runtime.close();
    const legacy = new NimplexRuntime({ ...f.options, engine: "pi-executor" });
    cleanup.push(() => legacy.close());
    const old = legacy.createSession(f.dir);
    const b = await legacy.startTurn(old.id, request("Legacy"));
    await expect(legacy.queueInput(old.id, { kind: "steer", text: "x" })).rejects.toThrow(
      "Pi harness",
    );
    await finish(legacy, b.runId);
  });

  it("cancels queued input durably before Pi consumes it", async () => {
    const f = await setup({ delayMs: 150 });
    const session = f.runtime.createSession(f.dir);
    const a = await f.runtime.startTurn(session.id, request("Write, run, read"));
    let cancelled: string | undefined;
    for await (const event of f.runtime.events(a.runId)) {
      if (event.type === "tool.result" && !cancelled) {
        const queued = await f.runtime.queueInput(session.id, {
          kind: "followUp",
          text: "NEVER DELIVERED",
        });
        cancelled = queued.entryId;
        expect(await f.runtime.cancelQueuedInput(session.id, queued.entryId)).toEqual({
          kind: "cancelled",
        });
        expect(await f.runtime.cancelQueuedInput(session.id, queued.entryId)).toEqual({
          kind: "not_found",
        });
      }
    }
    expect(f.runtime.getTurn(a.runId).status).toBe("completed");
    const bodies = f.upstream.state.messagesCalls.map((call) => JSON.stringify(call.body.messages));
    expect(bodies.some((body) => body.includes("NEVER DELIVERED"))).toBe(false);
    const events = f.runtime.getSession(session.id).turns[0]?.events ?? [];
    expect(ofType(events, "input.consumed").map((e) => e.payload)).toEqual([
      { entry_id: cancelled, kind: "followUp", delivered: false },
    ]);
    const storage = piStorage(f.dir, session.id);
    expect(
      (await storage.scanEntries({ type: "message" }, context)).some((e) => e.id === cancelled),
    ).toBe(false);
    await expect(f.runtime.cancelQueuedInput(session.id, "x")).rejects.toThrow("running turn");
  });

  it("keeps queued input durable across a runtime restart and delivers it once", async () => {
    const f = await setup({ delayMs: 200 });
    const session = f.runtime.createSession(f.dir);
    const a = await f.runtime.startTurn(session.id, request("Write, run, read"));
    let queued: { entryId: string } | undefined;
    for await (const event of f.runtime.events(a.runId)) {
      if (event.type === "tool.result") {
        queued = await f.runtime.queueInput(session.id, { kind: "steer", text: "SURVIVE" });
        break;
      }
    }
    await f.runtime.close();
    const reopened = new NimplexRuntime(f.options);
    cleanup.push(() => reopened.close());
    expect(reopened.getTurn(a.runId).error).toBe("runtime_interrupted");
    await reopened.resumeTurn(session.id);
    expect((await finish(reopened, a.runId)).status).toBe("completed");
    const bodies = f.upstream.state.messagesCalls.map((call) => JSON.stringify(call.body.messages));
    expect(bodies.some((body) => body.includes("SURVIVE"))).toBe(true);
    const storage = piStorage(f.dir, session.id);
    const messages = await storage.scanEntries({ type: "message" }, context);
    expect(messages.filter((e) => e.id === queued?.entryId)).toHaveLength(1);
    const events = reopened.getSession(session.id).turns[0]?.events ?? [];
    expect(ofType(events, "input.queued")).toHaveLength(1);
    expect(ofType(events, "input.consumed")).toHaveLength(1);
  });

  it("records each tool intent once even when cancellation rewrites Pi's operation state", async () => {
    const f = await setup({
      script: [{ name: "bash", input: { command: "sleep 2; echo late > /workspace/late.txt" } }],
    });
    const session = f.runtime.createSession(f.dir);
    const a = await f.runtime.startTurn(session.id, request("Slow tool"));
    for await (const event of f.runtime.events(a.runId)) {
      if (event.type === "tool.started") {
        await f.runtime.stopTurn(a.runId);
        break;
      }
    }
    const turn = f.runtime.getTurn(a.runId);
    expect(turn.status).toBe("canceled");
    const events = f.runtime.getSession(session.id).turns[0]?.events ?? [];
    const started = ofType(events, "tool.started").map((e) => (e.payload as { id: string }).id);
    expect(new Set(started).size).toBe(started.length);
    expect(started).toHaveLength(1);
    expect(f.runtime.files(a.runId)).toEqual([]);
  });

  it("kills a turn at its duration cap through Pi's durable cancellation", async () => {
    const f = await setup({ delayMs: 1_500 });
    const session = f.runtime.createSession(f.dir);
    const a = await f.runtime.startTurn(session.id, request("Slow", { timeout: 1 }));
    const turn = await finish(f.runtime, a.runId);
    expect(turn.status).toBe("killed");
    expect(turn.error).toBe("duration_exceeded");
    expect(f.runtime.files(a.runId)).toEqual([]);
    const storage = piStorage(f.dir, session.id);
    expect((await storage.getValue(operationResult(a.runId), context))?.value.status).toBe(
      "aborted",
    );
  });

  it("keeps a turn resumable across a graceful runtime shutdown", async () => {
    const f = await setup({ delayMs: 200 });
    const session = f.runtime.createSession(f.dir);
    const a = await f.runtime.startTurn(session.id, request("Shutdown mid-turn"));
    for await (const event of f.runtime.events(a.runId)) {
      if (event.type === "tool.result") break;
    }
    await f.runtime.close();
    const calls = f.upstream.state.messagesCalls.length;
    const reopened = new NimplexRuntime(f.options);
    cleanup.push(() => reopened.close());
    const interrupted = reopened.getTurn(a.runId);
    expect(interrupted.status).toBe("failed");
    expect(interrupted.error).toBe("runtime_interrupted");
    // Acceptance retry observes the interrupted turn; only explicit resume continues it.
    await expect(reopened.startTurn(session.id, request("Another"))).rejects.toThrow(
      "Resume the interrupted turn",
    );
    expect(f.upstream.state.messagesCalls).toHaveLength(calls);
    expect((await reopened.resumeTurn(session.id)).runId).toBe(a.runId);
    expect((await finish(reopened, a.runId)).status).toBe("completed");
    expect(text(reopened.readFile(a.runId, "/workspace/append.txt"))).toBe("once\n");
    const events = reopened.getSession(session.id).turns[0]?.events ?? [];
    expect(ofType(events, "model.call")).toHaveLength(4);
    expect(ofType(events, "run.resumed")).toHaveLength(1);
    expect(ofType(events, "spend.updated")).toHaveLength(ofType(events, "model.reserved").length);
  });

  it("isolates engines and Pi storage per session within one state root", async () => {
    const f = await setup();
    await f.runtime.close();
    const legacy = new NimplexRuntime({ ...f.options, engine: "pi-executor" });
    cleanup.push(() => legacy.close());
    const oldSession = legacy.createSession(f.dir);
    expect(oldSession.engine).toBeUndefined();
    const a = await legacy.startTurn(oldSession.id, request("Legacy"));
    expect((await finish(legacy, a.runId)).status).toBe("completed");
    await legacy.close();
    const mixed = new NimplexRuntime(f.options);
    cleanup.push(() => mixed.close());
    const first = mixed.createSession(f.dir);
    const second = mixed.createSession(f.dir);
    const [b, c] = await Promise.all([
      mixed.startTurn(first.id, request("One")),
      mixed.startTurn(second.id, request("Two")),
    ]);
    expect((await finish(mixed, b.runId)).status).toBe("completed");
    expect((await finish(mixed, c.runId)).status).toBe("completed");
    expect(mixed.getSession(oldSession.id).engine).toBeUndefined();
    expect(mixed.getSession(oldSession.id).turns).toHaveLength(1);
    const db = new DatabaseSync(join(f.dir, "runtime.sqlite"));
    cleanup.push(() => db.close());
    expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(3);
    const scopes = db
      .prepare("SELECT session_id FROM pi_store_sessions ORDER BY session_id")
      .all()
      .map((row) => row.session_id);
    expect(scopes).toEqual([first.id, second.id].sort());
    const one = await piStorage(f.dir, first.id).scanEntries({ type: "message" }, context);
    const two = await piStorage(f.dir, second.id).scanEntries({ type: "message" }, context);
    expect(JSON.stringify(one)).toContain("One");
    expect(JSON.stringify(one)).not.toContain("Two");
    expect(JSON.stringify(two)).toContain("Two");
  });
});
