// Scale and cost evidence for the Pi harness engine on the local SQLite host.
//
// Everything here runs against the fake Anthropic upstream with zero model latency, so
// the numbers measure nimplex's own durability overhead (Pi harness + atomic SQLite
// commits + workspace snapshots), not provider speed. Run with `pnpm bench`; pass
// `--json` for machine-readable output.
import { type ChildProcess, fork } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/pi-agent-core/harness/context";
import { insertEntry, setValue, value } from "@earendil-works/pi-agent-core/harness/session";
import { NimplexRuntime } from "@nimplex/runtime";
import { initializePiStorage } from "@nimplex/runtime/pi-storage/schema";
import { SqlitePiStorage } from "@nimplex/runtime/pi-storage/sqlite";
import { startFakeAnthropic } from "@nimplex/testkit";

const json = process.argv.includes("--json");
const TOOLS_PER_TURN = 6;
const script = Array.from({ length: TOOLS_PER_TURN }, (_, i) =>
  i % 3 === 0
    ? { name: "write", input: { path: `/workspace/file-${i}.txt`, content: `content ${i}\n` } }
    : i % 3 === 1
      ? { name: "bash", input: { command: `echo step ${i} >> /workspace/log.txt` } }
      : { name: "read", input: { path: `/workspace/file-${i - 2}.txt` } },
);
const cleanup: (() => void | Promise<void>)[] = [];
const results: Record<string, unknown> = {};
const now = () => performance.now();
const ms = (value: number) => Math.round(value * 100) / 100;
const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return ms(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0);
};

const rss = () => Math.round(process.memoryUsage().rss / 1024 / 1024);

async function turn(runtime: NimplexRuntime, sessionId: string, prompt: string) {
  const started = now();
  const { runId } = await runtime.startTurn(sessionId, {
    prompt,
    instructions: "Complete the task.",
    model: "claude-haiku-4-5",
    sandbox: "docker",
    timeout: 180,
    contextMode: "continue",
    executionMode: "build",
  });
  for await (const _event of runtime.events(runId)) {
    /* drain committed events */
  }
  const result = runtime.getTurn(runId);
  if (result.status !== "completed") throw new Error(`Turn ${result.status}: ${result.error}`);
  return { runId, wallMs: now() - started, result };
}

// 1. Sequential turns, one fresh session each, so every turn runs the full 6-tool script
//    (the fake upstream replays its script by counting tool results in the conversation).
async function sequential(turns: number) {
  const directory = mkdtempSync(join(tmpdir(), "nimplex-bench-seq-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const upstream = await startFakeAnthropic(0, { script, delayMs: 0 });
  cleanup.push(upstream.close);
  let commits = 0;
  let committedEvents = 0;
  const runtime = new NimplexRuntime({
    directory,
    engine: "pi-harness",
    credential: () => ({ apiKey: "fake-key", baseUrl: upstream.url }),
    afterCommit: (_turn, events) => {
      commits++;
      committedEvents += events.length;
    },
  });
  const walls: number[] = [];
  const started = now();
  for (let i = 0; i < turns; i++) {
    const session = runtime.createSession(directory);
    walls.push((await turn(runtime, session.id, `Task ${i}`)).wallMs);
  }
  const total = now() - started;
  const requests = upstream.state.messagesCalls.length;
  const firstPayloadBytes = Buffer.byteLength(
    JSON.stringify(upstream.state.messagesCalls[0]?.body ?? {}),
  );
  const lastPayloadBytes = Buffer.byteLength(
    JSON.stringify(upstream.state.messagesCalls[requests / turns - 1]?.body ?? {}),
  );
  const memory = rss();
  await runtime.close();
  // Storage growth is measured on the checkpointed main file, not the WAL.
  const db = new DatabaseSync(join(directory, "runtime.sqlite"));
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const count = (table: string) =>
    Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? 0);
  const rows = {
    events: count("events"),
    pi_entries: count("pi_store_entries"),
    pi_commits: count("pi_store_commits"),
    pi_usage: count("pi_store_usage"),
  };
  db.close();
  results.sequential = {
    turns,
    toolsPerTurn: TOOLS_PER_TURN,
    requestsPerTurn: requests / turns,
    commitsPerTurn: commits / turns,
    eventsPerTurn: committedEvents / turns,
    turnWallMs: { mean: ms(total / turns), p50: percentile(walls, 50), p95: percentile(walls, 95) },
    msPerCommit: ms(total / commits),
    turnsPerSecond: ms((turns * 1000) / total),
    storage: {
      bytesPerTurn: Math.round(statSync(join(directory, "runtime.sqlite")).size / turns),
      rowsPerTurn: Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, v / turns])),
    },
    payload: {
      firstRequestBytes: firstPayloadBytes,
      lastRequestBytesOfTurn: lastPayloadBytes,
      estimatedTokensPerFirstRequest: Math.round(firstPayloadBytes / 4),
    },
    rssMb: memory,
  };
}

// 1b. One session, many turns: how the per-request payload grows with history.
async function history(turns: number) {
  const directory = mkdtempSync(join(tmpdir(), "nimplex-bench-hist-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const upstream = await startFakeAnthropic(0, { script, delayMs: 0 });
  cleanup.push(upstream.close);
  const runtime = new NimplexRuntime({
    directory,
    engine: "pi-harness",
    credential: () => ({ apiKey: "fake-key", baseUrl: upstream.url }),
  });
  cleanup.push(() => runtime.close());
  const session = runtime.createSession(directory);
  const walls: number[] = [];
  for (let i = 0; i < turns; i++)
    walls.push((await turn(runtime, session.id, `Follow-up ${i}`)).wallMs);
  const bytes = (index: number) =>
    Buffer.byteLength(JSON.stringify(upstream.state.messagesCalls.at(index)?.body ?? {}));
  return {
    turns,
    requests: upstream.state.messagesCalls.length,
    firstRequestBytes: bytes(0),
    lastRequestBytes: bytes(-1),
    followUpTurnWallMs: {
      p50: percentile(walls.slice(1), 50),
      p95: percentile(walls.slice(1), 95),
    },
  };
}

// 2. Concurrent sessions on one runtime process.
async function concurrent(sessions: number) {
  const directory = mkdtempSync(join(tmpdir(), "nimplex-bench-par-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const upstream = await startFakeAnthropic(0, { script, delayMs: 0 });
  cleanup.push(upstream.close);
  const runtime = new NimplexRuntime({
    directory,
    engine: "pi-harness",
    credential: () => ({ apiKey: "fake-key", baseUrl: upstream.url }),
  });
  cleanup.push(() => runtime.close());
  const ids = Array.from({ length: sessions }, () => runtime.createSession(directory).id);
  const started = now();
  const walls = await Promise.all(
    ids.map(async (id) => (await turn(runtime, id, "Parallel task")).wallMs),
  );
  const total = now() - started;
  return {
    sessions,
    totalMs: ms(total),
    turnsPerSecond: ms((sessions * 1000) / total),
    turnWallMs: {
      p50: percentile(walls, 50),
      p95: percentile(walls, 95),
      max: percentile(walls, 100),
    },
    rssMb: rss(),
  };
}

// 3. Real SIGKILL after a committed tool result, then resume in this process.
async function recovery(samples: number) {
  const child = fileURLToPath(
    new URL("../../../packages/runtime/src/testing/pi-harness-engine-child.ts", import.meta.url),
  );
  const measured: { reopenMs: number; resumeMs: number; requestsAfterRestart: number }[] = [];
  for (let i = 0; i < samples; i++) {
    const proc: ChildProcess = fork(child, ["after-tool"], {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    const exited = once(proc, "exit");
    const witness = await new Promise<{ directory: string; sessionId: string; runId: string }>(
      (resolve, reject) => {
        const seen: Record<string, unknown> = {};
        const timer = setTimeout(() => reject(new Error("Child boundary timeout")), 30_000);
        proc.on("message", (message: Record<string, unknown> & { stage: string }) => {
          Object.assign(seen, message);
          if (message.stage === "committed") {
            clearTimeout(timer);
            resolve(seen as never);
          }
        });
      },
    );
    proc.kill("SIGKILL");
    await exited;
    const upstream = await startFakeAnthropic(0, {
      script: [
        { name: "write", input: { path: "/workspace/a.txt", content: "first\n" } },
        { name: "bash", input: { command: "echo once >> /workspace/append.txt" } },
        { name: "read", input: { path: "/workspace/a.txt" } },
      ],
    });
    const reopenStarted = now();
    const runtime = new NimplexRuntime({
      directory: witness.directory,
      engine: "pi-harness",
      credential: () => ({ apiKey: "fake-key", baseUrl: upstream.url }),
    });
    if (runtime.getTurn(witness.runId).error !== "runtime_interrupted")
      throw new Error("Expected an interrupted turn after SIGKILL");
    const reopenMs = now() - reopenStarted;
    const resumeStarted = now();
    const resumed = await runtime.resumeTurn(witness.sessionId);
    for await (const _event of runtime.events(resumed.runId)) {
      /* drain */
    }
    const resumeMs = now() - resumeStarted;
    if (runtime.getTurn(resumed.runId).status !== "completed")
      throw new Error("Resumed turn did not complete");
    const append = new TextDecoder().decode(
      runtime.readFile(resumed.runId, "/workspace/append.txt"),
    );
    if (append !== "once\n") throw new Error(`Duplicate effect after recovery: ${append}`);
    measured.push({
      reopenMs,
      resumeMs,
      requestsAfterRestart: upstream.state.messagesCalls.length,
    });
    await runtime.close();
    await upstream.close();
    rmSync(witness.directory, { recursive: true, force: true });
  }
  return {
    samples,
    reopenMs: { mean: ms(measured.reduce((s, m) => s + m.reopenMs, 0) / samples) },
    resumeToCompletionMs: {
      mean: ms(measured.reduce((s, m) => s + m.resumeMs, 0) / samples),
      max: ms(Math.max(...measured.map((m) => m.resumeMs))),
    },
    requestsAfterRestart: measured.map((m) => m.requestsAfterRestart),
  };
}

// 4. Storage adapter commit latency with a representative commit: one 1 KiB message
//    entry plus one operation-state value, inside the host transaction.
function typicalCommit(index: number, parent: string | null) {
  const id = `entry-${index}`;
  return {
    id,
    writes: [
      insertEntry({
        id,
        parentId: parent,
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "x".repeat(1024) }],
          api: "anthropic-messages",
          provider: "anthropic",
          model: "claude-haiku-4-5",
          usage: {
            input: 100,
            output: 20,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 120,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: Date.now(),
        },
      } as never),
      setValue(value<{ index: number; at: string }>("bench.state"), { index, at: "tools" }),
    ],
  };
}
async function sqliteCommits(count: number) {
  const directory = mkdtempSync(join(tmpdir(), "nimplex-bench-sqlite-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const db = new DatabaseSync(join(directory, "bench.sqlite"));
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
  initializePiStorage(db);
  const transaction = <T>(operation: () => T): T => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const value = operation();
      db.exec("COMMIT");
      return value;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  const storage = new SqlitePiStorage(db, { tenantId: "bench", sessionId: "session" }, () => {}, {
    transaction,
  });
  const latencies: number[] = [];
  let parent: string | null = null;
  const started = now();
  for (let i = 0; i < count; i++) {
    const commit = typicalCommit(i, parent);
    const at = now();
    await storage.commit(commit.writes, context);
    latencies.push(now() - at);
    parent = commit.id;
  }
  const total = now() - started;
  db.close();
  return {
    commits: count,
    p50Ms: percentile(latencies, 50),
    p95Ms: percentile(latencies, 95),
    p99Ms: percentile(latencies, 99),
    commitsPerSecond: Math.round((count * 1000) / total),
    synchronous: "FULL (fsync per commit)",
  };
}

try {
  results.machine = {
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    cpus: (await import("node:os")).cpus().length,
    date: new Date().toISOString().slice(0, 10),
  };
  await sequential(20);
  results.history = await history(20);
  results.concurrent = [await concurrent(8), await concurrent(32)];
  results.recovery = await recovery(3);
  results.sqliteCommits = await sqliteCommits(1_000);
  if (json) console.log(JSON.stringify(results, null, 2));
  else {
    const s = results.sequential as Record<string, never>;
    console.log(
      `Sequential ${s.turns} turns × ${s.toolsPerTurn} tools (fake upstream, 0 ms model latency)`,
    );
    console.log(JSON.stringify(results, null, 2));
  }
} finally {
  for (const close of cleanup.splice(0).reverse()) await close();
}
