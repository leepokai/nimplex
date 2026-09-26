import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type SandboxUsageRecord, startTurnRequest } from "@nimplex/contracts";
import { lookupSandboxRate, roundUsdPrecise, type SandboxSize } from "@nimplex/core";
import { getSandboxProvider, registerSandboxProvider } from "@nimplex/sandbox";
import { type FakeSandboxOptions, fakeSandboxProvider, nativeExecutor } from "@nimplex/testkit";
import { afterEach, describe, expect, it } from "vitest";
import { NimplexRuntime } from "./runtime.ts";
import {
  inheritSandboxUsage,
  recordDiscardedSandbox,
  recordSandboxTransition,
  sandboxUsageSummary,
  startSandboxUsage,
} from "./sandbox-usage.ts";
import { RuntimeStore } from "./store.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "nimplex-sandbox-usage-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/** Expected estimate for `seconds` of running time at the provider's rate. */
const cost = (provider: string, seconds: number, size: SandboxSize = {}) => {
  const rate = lookupSandboxRate(provider, size);
  return rate ? roundUsdPrecise(seconds * rate.usdPerSecond) : null;
};

describe("sandbox rates", () => {
  it("prices E2B by allocated size, Docker at zero, and nothing it cannot size", () => {
    // Default sandbox: 2 vCPU × $0.000014 + 0.5 GiB × $0.0000045 per second.
    expect(lookupSandboxRate("e2b")?.usdPerSecond).toBeCloseTo(0.00003025, 12);
    expect(lookupSandboxRate("e2b")?.basis).toBe(
      "E2B list price for 2 vCPU / 512 MiB (default size)",
    );
    // A reported size wins over the default, including for custom templates.
    const large = { cpuCount: 8, memoryMB: 16384, customTemplate: true };
    expect(lookupSandboxRate("e2b", large)?.usdPerSecond).toBeCloseTo(
      8 * 0.000014 + 16 * 0.0000045,
      12,
    );
    expect(lookupSandboxRate("e2b", { customTemplate: true })).toBeNull();
    expect(lookupSandboxRate("docker", { customTemplate: true })?.usdPerSecond).toBe(0);
    expect(lookupSandboxRate("vercel")).toBeNull();
  });
});

describe("sandbox usage ledger", () => {
  function store(status: "running" | "completed" = "running") {
    const s = new RuntimeStore(tempDir());
    cleanup.push(() => s.close());
    s.transaction(() => {
      s.saveSession({
        id: "s",
        cwd: "/",
        title: "t",
        updatedAt: new Date().toISOString(),
        turnIds: ["t1"],
        sandboxGeneration: 1,
        sandboxProvider: "e2b",
        sandboxState: {
          version: 1,
          backendId: "e2b",
          providerState: { sandboxId: "sbx" },
          workdir: "/workspace",
          environment: {},
        },
      });
      s.saveTurn({
        sessionId: "s",
        request: startTurnRequest.parse({ prompt: "x", sandbox: "e2b" }),
        config: {
          instructions: "",
          input: "x",
          prior_messages: [],
          execution_mode: "build",
          compact_context: false,
        },
        result: {
          id: "t1",
          status,
          external_user_id: null,
          model: { provider: "anthropic", id: "claude-haiku-4-5" },
          sandbox: { provider: "e2b" },
          sandbox_ref: null,
          spent_usd: 0,
          error: null,
          created_at: new Date().toISOString(),
          started_at: null,
          completed_at: null,
        },
      });
    });
    // A one-hour provider lifetime, like E2B's default.
    const move = (transition: Parameters<typeof recordSandboxTransition>[2], at: Date) =>
      s.transaction(() =>
        recordSandboxTransition(s, "s", transition, { turnId: "t1", at, maxRunMs: 3600_000 }),
      );
    return { s, move };
  }
  const at = (seconds: number) => new Date(Date.UTC(2026, 8, 25, 0, 0, 0) + seconds * 1000);

  it("settles each interval once and keeps the running total on the session", () => {
    const { s, move } = store();
    move("running", at(0));
    move("running", at(5)); // Already open: a sandbox that kept running keeps its start.
    move("paused", at(10));
    move("deleted", at(20)); // Nothing open: nothing recorded.
    move("running", at(30));
    move("paused", at(45));
    expect(s.sandboxUsage("s")).toEqual([
      expect.objectContaining({
        reason: "paused",
        seconds: 10,
        cost_usd: cost("e2b", 10),
        uncertain: false,
        turn_id: "t1",
        started_at: at(0).toISOString(),
        ended_at: at(10).toISOString(),
      }),
      expect.objectContaining({ reason: "paused", seconds: 15 }),
    ]);
    // A running turn records each settlement as an audit event too.
    expect(s.events("t1").filter((e) => e.type === "sandbox.usage")).toHaveLength(2);
    expect(s.session("s").sandboxUsage).toEqual({
      usd: cost("e2b", 25),
      seconds: 25,
      unpriced_seconds: 0,
      uncertain: false,
      free: false,
    });
    expect(s.session("s").sandboxRunningSince).toBeUndefined();
  });

  it("keeps metering a sandbox whose pause failed, and splits unobserved from observed time", () => {
    const { s, move } = store();
    move("running", at(0));
    move("unobserved", at(10));
    expect(s.sandboxUsage("s")).toEqual([]);
    // Reattaching proves it was still running; what follows is observed again.
    move("running", at(100));
    move("paused", at(110));
    expect(s.sandboxUsage("s")).toEqual([
      expect.objectContaining({ reason: "reconnected", seconds: 100, uncertain: true }),
      expect.objectContaining({ reason: "paused", seconds: 10, uncertain: false }),
    ]);
  });

  it("caps unobserved time at the provider lifetime", () => {
    const { s, move } = store();
    move("running", at(0));
    move("missing", at(3 * 24 * 3600));
    expect(s.sandboxUsage("s")).toEqual([
      expect.objectContaining({
        reason: "missing",
        seconds: 3600,
        ended_at: at(3600).toISOString(),
        cost_usd: cost("e2b", 3600),
        uncertain: true,
      }),
    ]);
  });

  it("never charges past the provider deadline, which each resume extends", () => {
    const { s, move } = store();
    move("running", at(0));
    move("running", at(3000)); // A resume extends the one-hour lifetime to 6600.
    move("paused", at(5000));
    move("running", at(8000));
    move("paused", at(20000)); // The provider stopped it at 11600, whatever we saw later.
    move("running", at(21000));
    move("unobserved", at(21100));
    move("missing", at(30000));
    expect(s.sandboxUsage("s").map((r) => [r.reason, r.seconds, r.uncertain])).toEqual([
      ["paused", 5000, false],
      ["paused", 3600, true],
      ["missing", 3600, true],
    ]);
  });

  it("reports an open interval with unobserved time as uncertain before it settles", () => {
    const { s, move } = store();
    move("running", at(0));
    expect(sandboxUsageSummary(s.session("s"))).toMatchObject({ uncertain: false });
    move("unobserved", at(10));
    expect(sandboxUsageSummary(s.session("s"))).toMatchObject({
      uncertain: true,
      running_since: at(0).toISOString(),
    });
  });

  it("never modifies a finished turn and counts unpriced time separately", () => {
    const { s, move } = store("completed");
    s.transaction(() => {
      const session = s.session("s");
      session.sandboxState = {
        version: 1,
        backendId: "e2b",
        providerState: { sandboxId: "x", template: "custom" },
        workdir: "/workspace",
        environment: {},
      };
      s.saveSession(session);
    });
    const before = JSON.stringify(s.turn("t1"));
    move("running", at(0));
    move("deleted", at(30));
    expect(s.events("t1")).toEqual([]);
    expect(JSON.stringify(s.turn("t1"))).toBe(before);
    expect(s.sandboxUsage("s")).toEqual([expect.objectContaining({ cost_usd: null })]);
    expect(s.session("s").sandboxUsage).toMatchObject({ usd: 0, unpriced_seconds: 30 });
  });

  it("charges a discarded sandbox to its stop, or up to its lifetime when stopping failed", () => {
    const { s } = store();
    const state = {
      version: 1,
      backendId: "e2b",
      providerState: { sandboxId: "d", cpuCount: 4, memoryMB: 1024 },
      workdir: "/workspace",
      environment: {},
    };
    const startedAt = new Date(Date.now() - 2000);
    s.transaction(() => {
      recordDiscardedSandbox(s, "s", {
        provider: "e2b",
        state,
        startedAt,
        stopped: true,
        turnId: "t1",
      });
      recordDiscardedSandbox(s, "s", {
        provider: "e2b",
        state,
        startedAt,
        stopped: false,
        turnId: "t1",
        maxRunMs: 3600_000,
      });
    });
    const [stopped, running] = s.sandboxUsage("s");
    expect(stopped).toMatchObject({ reason: "discarded", uncertain: false });
    expect(stopped?.seconds).toBeGreaterThanOrEqual(2);
    expect(stopped?.basis).toBe("E2B list price for 4 vCPU / 1024 MiB");
    expect(running).toMatchObject({ reason: "discarded", uncertain: true, seconds: 3600 });
  });

  it("ignores a transition that arrives after cleanup removed the sandbox", () => {
    const { s, move } = store();
    s.transaction(() => {
      const session = s.session("s");
      delete session.sandboxState;
      s.saveSession(session);
    });
    move("running", at(0));
    expect(sandboxUsageSummary(s.session("s"))).toBeUndefined();
  });

  it("rolls the ledger entry, audit event, total and interval back together", () => {
    const { s, move } = store();
    move("running", at(0));
    expect(() =>
      s.transaction(() => {
        recordSandboxTransition(s, "s", "paused", { turnId: "t1", at: at(5) });
        throw new Error("injected commit failure");
      }),
    ).toThrow("injected commit failure");
    expect(s.sandboxUsage("s")).toEqual([]);
    expect(s.events("t1")).toEqual([]);
    expect(s.session("s").sandboxUsage).toBeUndefined();
    expect(s.session("s").sandboxRunningSince).toBe(at(0).toISOString());
  });

  it("marks an interval left by a previous runtime unobserved, and expires one past the lifetime", async () => {
    const { s } = store();
    s.transaction(() => {
      s.saveSession({ ...s.session("s"), id: "old" });
      startSandboxUsage(s, "s", new Date(Date.now() - 10_000), 3600_000);
      startSandboxUsage(s, "old", new Date(Date.now() - 2 * 3600_000), 3600_000);
    });
    for (const session of s.sessions()) s.transaction(() => inheritSandboxUsage(s, session));
    expect(s.session("s")).toMatchObject({ sandboxRunningUncertain: true });
    expect(s.sandboxUsage("s")).toEqual([]);
    expect(s.session("old").sandboxRunningSince).toBeUndefined();
    expect(s.sandboxUsage("old")).toEqual([
      expect.objectContaining({ reason: "expired", seconds: 3600, uncertain: true }),
    ]);
  });
});

describe("sandbox usage through the runtime", () => {
  function setup(fakeOptions: Omit<FakeSandboxOptions, "root">, commands = 2) {
    const original = getSandboxProvider(fakeOptions.backendId);
    const fake = fakeSandboxProvider({ root: tempDir(), ...fakeOptions });
    registerSandboxProvider(fake.provider);
    cleanup.push(() => registerSandboxProvider(original));
    const directory = tempDir();
    const options = {
      directory,
      credential: () => ({ apiKey: "unused", baseUrl: null }),
      engine: "pi-executor" as const,
      executor: nativeExecutor(commands),
    };
    const runtime = new NimplexRuntime(options);
    cleanup.push(() => runtime.close());
    const start = (sessionId: string) =>
      runtime.startTurn(
        sessionId,
        startTurnRequest.parse({ prompt: "Native", sandbox: fakeOptions.backendId }),
      );
    const run = async (sessionId: string) => {
      const { runId } = await start(sessionId);
      for await (const _event of runtime.events(runId)) {
        /* Drain until the turn settles. */
      }
      return runId;
    };
    const ledger = (sessionId: string) => {
      const store = new RuntimeStore(directory);
      try {
        return { records: store.sandboxUsage(sessionId), session: store.session(sessionId) };
      } finally {
        store.close();
      }
    };
    const reopen = () => {
      const reopened = new NimplexRuntime(options);
      cleanup.push(() => reopened.close());
      return reopened;
    };
    return { runtime, run, start, fake, ledger, reopen };
  }
  const usageEvents = (runtime: NimplexRuntime, sessionId: string, turn: number) =>
    runtime
      .getSession(sessionId)
      .turns[turn]?.events.filter((e) => e.type === "sandbox.usage")
      .map((e) => e.payload as SandboxUsageRecord) ?? [];

  it("settles each running interval of a pausing sandbox inside the turn that ran it", async () => {
    const { runtime, run, fake } = setup({ backendId: "e2b", pause: true });
    const session = runtime.createSession("/");
    const turn = await run(session.id);
    expect(runtime.getTurn(turn).status).toBe("completed");
    // Created for the first command and paused; resumed for the second and paused.
    expect(usageEvents(runtime, session.id, 0).map((e) => e.reason)).toEqual(["paused", "paused"]);
    expect(fake.counters).toMatchObject({ create: 1, pause: 2 });
    const summary = runtime.getSession(session.id).sandbox;
    expect(summary?.seconds).toBeGreaterThan(0);
    const settled = usageEvents(runtime, session.id, 0);
    expect(summary?.usd).toBeCloseTo(
      settled.reduce((sum, e) => sum + (e.cost_usd ?? 0), 0),
      9,
    );
    for (const e of settled) expect(e.cost_usd).toBe(cost("e2b", e.seconds));
    expect(summary?.uncertain).toBe(false);
    // Deleting the paused sandbox at close charges no paused time.
    await runtime.close();
    expect(fake.counters.delete).toBe(1);
  });

  it("settles a sandbox that paused even when the turn was cancelled during the pause", async () => {
    let cancel: () => Promise<unknown> = async () => undefined;
    const { runtime, start, ledger } = setup(
      { backendId: "e2b", pause: true, onPause: () => void cancel() },
      1,
    );
    const session = runtime.createSession("/");
    const { runId } = await start(session.id);
    cancel = () => runtime.stopTurn(runId);
    for await (const _event of runtime.events(runId)) {
      /* Drain until the turn settles. */
    }
    expect(runtime.getTurn(runId).status).toBe("canceled");
    await runtime.close();
    // The interval closed at the pause; nothing stays open to be billed as running later.
    const { records, session: stored } = ledger(session.id);
    expect(stored.sandboxRunningSince).toBeUndefined();
    expect(records.map((r) => [r.reason, r.uncertain])).toEqual([["paused", false]]);
  });

  it("meters a sandbox created for a turn that was cancelled before it could be recorded", async () => {
    let cancel: () => Promise<unknown> = async () => undefined;
    const { runtime, start, fake, ledger } = setup(
      { backendId: "e2b", pause: true, createMs: 300 },
      1,
    );
    const session = runtime.createSession("/");
    const { runId } = await start(session.id);
    cancel = () => runtime.stopTurn(runId);
    await new Promise((done) => setTimeout(done, 100));
    await cancel();
    expect(runtime.getTurn(runId).status).toBe("canceled");
    expect(fake.counters.create).toBe(1);
    await runtime.close();
    expect(ledger(session.id).records).toEqual([
      expect.objectContaining({ reason: "discarded", provider: "e2b", turn_id: runId }),
    ]);
  });

  it("keeps metering a sandbox whose pause failed until it is deleted, marked uncertain", async () => {
    const { runtime, run, ledger } = setup({ backendId: "e2b", pause: "fail" });
    const session = runtime.createSession("/");
    const turn = await run(session.id);
    expect(runtime.getTurn(turn).status).toBe("completed");
    // The second command reattached, which ends the unobserved stretch of the first.
    expect(usageEvents(runtime, session.id, 0)).toEqual([
      expect.objectContaining({ reason: "reconnected", uncertain: true }),
    ]);
    expect(runtime.sandboxUsage(session.id)?.running_since).toBeDefined();
    await runtime.close();
    expect(ledger(session.id).records.map((r) => [r.reason, r.uncertain, r.turn_id])).toEqual([
      ["reconnected", true, turn],
      ["deleted", true, null],
    ]);
  });

  it("charges a non-pausing sandbox from creation to deletion without touching finished turns", async () => {
    const { runtime, run, ledger, reopen } = setup({ backendId: "docker", pause: false });
    const session = runtime.createSession("/");
    await run(session.id);
    await run(session.id);
    const before = JSON.stringify(runtime.getSession(session.id).turns);
    // The container keeps running between turns: nothing has settled, one interval is open.
    expect(runtime.getSession(session.id).sandbox).toEqual({
      usd: 0,
      seconds: 0,
      unpriced_seconds: 0,
      uncertain: false,
      free: true,
      running_since: expect.any(String),
    });
    await runtime.close();
    const { records, session: stored } = ledger(session.id);
    expect(records).toEqual([
      expect.objectContaining({ reason: "deleted", cost_usd: 0, uncertain: false, turn_id: null }),
    ]);
    expect(stored.sandboxUsage?.seconds).toBeGreaterThan(0);
    // Deletion after the turns finished is a session-level entry, not a turn event.
    const after = reopen().getSession(session.id);
    expect(JSON.stringify(after.turns)).toBe(before);
    expect(after.sandbox).toMatchObject({ usd: 0, uncertain: false });
  });

  it("stops metering a missing sandbox when it is detected, before its replacement starts", async () => {
    const { runtime, run, fake, ledger } = setup({ backendId: "docker", pause: false });
    const session = runtime.createSession("/");
    await run(session.id);
    fake.loseAll();
    const second = await run(session.id);
    expect(runtime.getTurn(second).status).toBe("completed");
    expect(fake.counters.create).toBe(2);
    expect(usageEvents(runtime, session.id, 1)).toEqual([
      expect.objectContaining({ reason: "missing", uncertain: true }),
    ]);
    await runtime.close();
    const [missing, deleted] = ledger(session.id).records;
    expect(deleted?.reason).toBe("deleted");
    // The replacement's creation time is charged once, to the new interval only.
    expect(Date.parse(missing?.ended_at ?? "")).toBeLessThanOrEqual(
      Date.parse(deleted?.started_at ?? ""),
    );
  });

  it("splits a sandbox that ran through a SIGKILL into unobserved and observed time", async () => {
    const root = tempDir();
    const directory = tempDir();
    const child = fork(
      fileURLToPath(new URL("./testing/sandbox-usage-child.ts", import.meta.url)),
      [root, directory],
      { execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"] },
    );
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const exited = once(child, "exit");
    const { sessionId } = await new Promise<{ sessionId: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`child timeout: ${stderr}`)), 60_000);
      child.on("message", (message: { stage: string; sessionId: string }) => {
        if (message.stage !== "launched") return;
        clearTimeout(timer);
        resolve(message);
      });
    });
    const killedAt = Date.now();
    child.kill("SIGKILL");
    await exited;
    await new Promise((done) => setTimeout(done, 500));
    const original = getSandboxProvider("e2b");
    const fake = fakeSandboxProvider({ root, backendId: "e2b", pause: true });
    registerSandboxProvider(fake.provider);
    cleanup.push(() => registerSandboxProvider(original));
    const runtime = new NimplexRuntime({
      directory,
      credential: () => ({ apiKey: "unused", baseUrl: null }),
      engine: "pi-executor",
      executor: nativeExecutor(1),
    });
    cleanup.push(() => runtime.close());
    const { runId } = await runtime.resumeTurn(sessionId);
    for await (const _event of runtime.events(runId)) {
      /* Drain until the resumed turn settles. */
    }
    expect(runtime.getTurn(runId).status).toBe("completed");
    // The resumed turn reattached to the same sandbox rather than creating one.
    expect(fake.counters.create).toBe(0);
    const intervals = usageEvents(runtime, sessionId, 0);
    // The stretch nobody watched ends when the new runtime reattaches; then it is observed.
    expect(intervals.map((i) => [i.reason, i.uncertain])).toEqual([
      ["reconnected", true],
      ["paused", false],
    ]);
    const [unobserved, observed] = intervals;
    expect(Date.parse(unobserved?.started_at ?? "")).toBeLessThan(killedAt);
    expect(Date.parse(unobserved?.ended_at ?? "")).toBeGreaterThan(killedAt + 500);
    expect(Date.parse(observed?.started_at ?? "")).toBeGreaterThanOrEqual(
      Date.parse(unobserved?.ended_at ?? ""),
    );
  }, 40_000);
});
