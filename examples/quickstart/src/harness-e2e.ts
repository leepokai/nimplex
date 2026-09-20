// Self-contained harness acceptance suite. Uses a fresh local database and fake model calls.
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDb } from "@nimplex/db";
import { getSandboxProvider } from "@nimplex/sandbox";
import { Nimplex, NimplexError, type RunEvent } from "@nimplex/sdk";
import { startFakeAnthropic } from "@nimplex/testkit";

const root = fileURLToPath(new URL("../../../", import.meta.url));
if (process.env.NIMPLEX_E2E_SANDBOX === "e2b") process.loadEnvFile(resolve(root, ".env"));
const databaseName = `nimplex_e2e_${Date.now()}`;
const adminUrl = new URL(
  process.env.NIMPLEX_TEST_POSTGRES_URL ?? "postgres://nimplex:nimplex@localhost:5433/postgres",
);
const admin = createDb(adminUrl.toString());
const databaseUrl = new URL(adminUrl);
databaseUrl.pathname = `/${databaseName}`;
const port = await freePort();
const baseUrl = `http://localhost:${port}`;
const env = {
  ...process.env,
  DATABASE_URL: databaseUrl.toString(),
  PORT: String(port),
  NIMPLEX_PUBLIC_URL: baseUrl,
  NIMPLEX_TRUSTED_ORIGINS: baseUrl,
  NIMPLEX_DEV_EMAIL_AUTH: "1",
  NIMPLEX_MASTER_KEY: randomBytes(32).toString("base64"),
  NIMPLEX_LEASE_SECONDS: "3",
  NIMPLEX_CONTEXT_CHARS: "2000",
  BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
  GITHUB_CLIENT_ID: "",
  GOOGLE_CLIENT_ID: "",
};
const children: ChildProcess[] = [];
const upstreams: Awaited<ReturnType<typeof startFakeAnthropic>>[] = [];
let diagnostic = "";
let db: ReturnType<typeof createDb> | undefined;
let worker: ChildProcess;

function child(cmd: string, args: string[], cwd = root, overrides: Record<string, string> = {}) {
  const process = spawn(cmd, args, {
    cwd,
    env: { ...env, ...overrides },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(process);
  const collect = (chunk: Buffer) => {
    diagnostic = (diagnostic + chunk.toString()).slice(-16000);
  };
  process.stdout?.on("data", collect);
  process.stderr?.on("data", collect);
  return process;
}
async function exited(process: ChildProcess) {
  if (process.exitCode !== null || process.signalCode !== null) return;
  await new Promise<void>((done, reject) => {
    process.once("exit", () => done());
    process.once("error", reject);
  });
}
function startWorker(pauseFault?: "reject" | "delay") {
  return child(
    process.execPath,
    [
      "--import",
      "tsx",
      ...(pauseFault ? ["--import", resolve(root, "examples/quickstart/src/pause-fault.ts")] : []),
      "src/index.ts",
    ],
    resolve(root, "apps/worker"),
    pauseFault ? { NIMPLEX_TEST_PAUSE_FAULT: pauseFault } : {},
  );
}
async function restartWorker() {
  worker.kill("SIGKILL");
  await exited(worker);
  worker = startWorker();
}

try {
  await admin.client.unsafe(`CREATE DATABASE "${databaseName}"`);
  const migration = child("pnpm", ["db:migrate"]);
  await exited(migration);
  assert.equal(migration.exitCode, 0, diagnostic);
  db = createDb(databaseUrl.toString());
  child(process.execPath, ["--import", "tsx", "src/index.ts"], resolve(root, "apps/api"));
  await until(async () => {
    try {
      return (await fetch(`${baseUrl}/v1/runs`)).status === 401;
    } catch {
      return false;
    }
  });
  worker = startWorker();

  const fake = await startFakeAnthropic(0, {
    delayMs: 150,
    script: [
      { name: "write", input: { path: "/workspace/a.txt", content: "first\n" } },
      { name: "read", input: { path: "/workspace/a.txt" } },
      { name: "edit", input: { path: "/workspace/a.txt", oldText: "first", newText: "second" } },
      {
        name: "bash",
        input: {
          command:
            "mv a.txt renamed.txt; echo AP8B | base64 -d > binary.dat; echo once >> append.txt; grep second renamed.txt",
        },
      },
    ],
  });
  upstreams.push(fake);
  const client = await tenant("tools", fake.url);
  const stream = await client
    .agent({
      model: { provider: "anthropic", id: "claude-haiku-4-5" },
      instructions: "Exercise the workspace tools",
    })
    .stream({ prompt: "go" });
  const events: RunEvent[] = [];
  for await (const event of client.runs.events(stream.runId, {
    signal: AbortSignal.timeout(60000),
  }))
    events.push(event);
  const run = await client.runs.get(stream.runId);
  assert.equal(run.status, "completed", `${run.error}\n${diagnostic}`);
  assert.equal(events.filter((e) => e.type === "tool.result").length, 4);
  assert.equal(await read(client, run.id, "/workspace/renamed.txt"), "second\n");
  assert.deepEqual([...(await client.runs.readFile(run.id, "/workspace/binary.dat"))], [0, 255, 1]);
  assert.equal(await read(client, run.id, "/workspace/append.txt"), "once\n");
  assert.ok(!(await client.runs.files(run.id)).some((f) => f.path === "/workspace/a.txt"));
  assert.equal(events.filter((e) => e.type === "model.call").length, 5);
  assert.equal(run.spent_usd, 0.0175);
  for (let i = 0; i < events.length; i++) assert.equal(events[i]?.seq, i);
  const tail: RunEvent[] = [];
  for await (const event of client.runs.events(run.id, {
    after: 4,
    signal: AbortSignal.timeout(10000),
  }))
    tail.push(event);
  assert.deepEqual(
    tail.map((e) => e.seq),
    events.filter((e) => e.seq > 4).map((e) => e.seq),
  );
  console.log(
    "PASS four tools, rename/delete/binary, cost settlement, contiguous and resumable SSE",
  );

  const compacted =
    await db.client`select payload from events where run_id = ${run.id} and type = 'context.checkpoint'`;
  assert.ok(compacted.length > 0, "long histories must create context checkpoints");
  const continued = await client
    .agent({
      model: { provider: "anthropic", id: "claude-haiku-4-5" },
      instructions: "Continue the conversation",
    })
    .generate({ prompt: "Now inspect the result", parentRunId: run.id });
  assert.equal(continued.run.status, "completed", diagnostic);
  assert.equal(await read(client, continued.run.id, "/workspace/renamed.txt"), "second\n");
  assert.deepEqual(
    [...(await client.runs.readFile(continued.run.id, "/workspace/binary.dat"))],
    [0, 255, 1],
  );
  assert.equal(
    continued.events.filter((e) => e.type === "tool.result").length,
    0,
    "historical tools must not execute again",
  );
  assert.equal(continued.run.spent_usd, 0.0035, "new run charges only new model calls");
  const branch = await client
    .agent({
      model: { provider: "anthropic", id: "claude-haiku-4-5" },
      instructions: "Branch the conversation",
    })
    .generate({
      prompt: "Use attached input",
      parentRunId: run.id,
      attachments: [{ path: "/workspace/renamed.txt", content: "branch only" }],
    });
  assert.equal(await read(client, branch.run.id, "/workspace/renamed.txt"), "branch only");
  assert.equal(
    await read(client, run.id, "/workspace/renamed.txt"),
    "second\n",
    "fork must not mutate its source",
  );
  const otherTenant = await tenant("fork-isolation", fake.url);
  await assert.rejects(
    () =>
      otherTenant
        .agent({
          model: { provider: "anthropic", id: "claude-haiku-4-5" },
          instructions: "cross tenant",
        })
        .stream({ parentRunId: run.id, prompt: "go" }),
    (error: unknown) => error instanceof NimplexError && error.status === 404,
  );
  const readOnly = await client
    .agent({
      model: { provider: "anthropic", id: "claude-haiku-4-5" },
      instructions: "Plan only",
    })
    .generate({ prompt: "Plan", executionMode: "read_only" });
  assert.equal(readOnly.run.status, "completed", diagnostic);
  assert.deepEqual(
    await client.runs.files(readOnly.run.id),
    [],
    "read-only mode must prevent all scripted write/edit/bash effects",
  );
  console.log(
    "PASS conversation continuation, binary workspace forks, tenant isolation and enforced read-only tools",
  );
  const archiveFake = await startFakeAnthropic(0, {
    script: [
      { name: "bash", input: { command: "printf '%050000d' 0" } },
      {
        name: "read_output",
        input: (messages) => {
          const blocks = (messages as { content: unknown }[]).flatMap((m) =>
            Array.isArray(m.content) ? m.content : [],
          );
          const prior = blocks.findLast((b: { type?: string }) => b.type === "tool_result");
          return { path: prior.tool_use_id, offset: 49990, limit: 20 };
        },
      },
    ],
  });
  upstreams.push(archiveFake);
  const archiveClient = await tenant("archive", archiveFake.url);
  const archived = await archiveClient
    .agent({
      model: { provider: "anthropic", id: "claude-haiku-4-5" },
      instructions: "Exercise large output paging",
    })
    .generate({ prompt: "go" });
  assert.equal(archived.run.status, "completed", diagnostic);
  const archivedResults = archived.events.filter((event) => event.type === "tool.result");
  const rawOutput = eventText(archivedResults[0]);
  assert.equal(rawOutput?.length, 50000, "raw log must retain full output");
  const secondRequest = JSON.stringify(archiveFake.state.messagesCalls[1]?.body);
  assert.ok(secondRequest.includes("Full output archived"));
  assert.ok(secondRequest.length < 25000, "model context must not contain the full large output");
  const page = JSON.parse(eventText(archivedResults[1]) ?? "null");
  assert.equal(page.text, "0000000000");
  assert.equal(page.next_offset, null);
  console.log("PASS context checkpoints and paginated durable output without host temp files");

  const fileEvent = events.find((event) => event.type === "file.changed")?.payload as {
    sha256?: string;
    content_base64?: string;
  };
  assert.match(fileEvent.sha256 ?? "", /^[a-f0-9]{64}$/);
  assert.equal(
    fileEvent.content_base64,
    undefined,
    "SSE must not retransmit archived binary bytes",
  );
  const [fileArchive] =
    await db.client`select payload from events where run_id = ${run.id} and type = 'file.changed' order by seq limit 1`;
  assert.equal(Buffer.from(fileArchive?.payload.content_base64, "base64").toString(), "first\n");
  console.log("PASS binary deltas stay archived while the transcript and SSE carry hashes");

  const callsBefore = fake.state.messagesCalls.length;
  const uncapped = await client
    .agent({
      model: { provider: "anthropic", id: "claude-haiku-4-5" },
      instructions: "Exercise the workspace tools without a spending limit",
    })
    .generate({ prompt: "go" });
  assert.equal(uncapped.run.status, "completed", uncapped.run.error ?? "unexpected run failure");
  assert.equal(uncapped.run.error, null);
  assert.ok(uncapped.run.spent_usd > 0);
  assert.ok(!("budget_usd" in uncapped.run));
  assert.ok(!("reserved_usd" in uncapped.run));
  assert.ok(fake.state.messagesCalls.length > callsBefore);
  console.log("PASS runs complete and settle usage without a budget parameter");

  for (const hasTruncatedTool of [false, true]) {
    const truncatedFake = await startFakeAnthropic(0, {
      stopReasons: ["max_tokens"],
      script: hasTruncatedTool
        ? [
            {
              name: "write",
              input: { path: "/workspace/should-not-exist.txt", content: "incomplete" },
            },
            {
              name: "write",
              input: { path: "/workspace/after-truncation.txt", content: "complete" },
            },
          ]
        : [],
    });
    upstreams.push(truncatedFake);
    const truncatedClient = await tenant(`truncated-${hasTruncatedTool}`, truncatedFake.url);
    const truncated = await truncatedClient
      .agent({
        model: { provider: "anthropic", id: "claude-haiku-4-5" },
        instructions: "Continue after a truncated response",
      })
      .generate({ prompt: "go" });
    assert.equal(truncated.run.status, "completed", diagnostic);
    assert.ok(truncatedFake.state.messagesCalls.length >= 2);
    assert.ok(
      !(await truncatedClient.runs.files(truncated.run.id)).some(
        (file) => file.path === "/workspace/should-not-exist.txt",
      ),
    );
    if (hasTruncatedTool)
      assert.equal(
        await read(truncatedClient, truncated.run.id, "/workspace/after-truncation.txt"),
        "complete",
      );
  }
  console.log(
    "PASS output truncation continues to completion and never executes incomplete tool calls",
  );

  const stranger = await tenant("stranger", fake.url);
  await assert.rejects(
    () => stranger.runs.readFile(run.id, "/workspace/renamed.txt"),
    (error: unknown) => error instanceof NimplexError && error.status === 404,
  );
  console.log("PASS workspace tenant isolation");

  const slow = await startFakeAnthropic(0, {
    delayMs: 1200,
    script: [
      { name: "bash", input: { command: "echo once >> durable.txt" } },
      { name: "bash", input: { command: "cat durable.txt" } },
    ],
  });
  upstreams.push(slow);
  const recovery = await tenant("recovery", slow.url);
  const crashing = await recovery
    .agent({
      model: { provider: "anthropic", id: "claude-haiku-4-5" },
      instructions: "Survive worker death",
    })
    .stream({ prompt: "go" });
  await until(async () => slow.state.messagesCalls.length === 2);
  await restartWorker();
  const recovered = await recovery.runs.wait(crashing.runId, AbortSignal.timeout(60000));
  assert.equal(recovered.status, "completed", `${recovered.error}\n${diagnostic}`);
  assert.equal(await read(recovery, recovered.id, "/workspace/durable.txt"), "once\n");
  const ledger =
    await db.client`select status, cost_usd from model_calls where run_id = ${recovered.id}`;
  assert.equal(ledger.filter((row) => row.status === "unknown").length, 1);
  assert.equal(ledger.filter((row) => row.status === "settled").length, 3);
  assert.ok(ledger.filter((row) => row.status === "unknown").every((row) => row.cost_usd === null));
  assert.ok(recovered.spent_usd > 0);
  console.log("PASS SIGKILL recovery, no duplicate append, unknown model outcomes retained");

  const batchFake = await startFakeAnthropic(0, {
    batchSize: 2,
    script: [
      { name: "bash", input: { command: "echo committed >> atomic.txt" } },
      { name: "bash", input: { command: "echo pending >> atomic.txt; sleep 3" } },
    ],
  });
  upstreams.push(batchFake);
  const batchClient = await tenant("batch", batchFake.url);
  const batchRun = await batchClient
    .agent({
      model: { provider: "anthropic", id: "claude-haiku-4-5" },
      instructions: "Recover between tools in one model response",
    })
    .stream({ prompt: "go" });
  await until(async () => {
    if (!db) return false;
    const rows =
      await db.client`select 1 from events where run_id = ${batchRun.runId} and type = 'tool.started'`;
    return rows.length === 2;
  });
  await restartWorker();
  assert.equal(
    (await batchClient.runs.wait(batchRun.runId, AbortSignal.timeout(60000))).status,
    "completed",
    diagnostic,
  );
  assert.equal(
    await read(batchClient, batchRun.runId, "/workspace/atomic.txt"),
    "committed\npending\n",
  );
  assert.equal(
    batchFake.state.messagesCalls.length,
    2,
    "committed assistant must not be requested again",
  );
  console.log(
    "PASS mid-VFS SIGKILL rolls back the uncommitted tool and skips the committed tool in one batch",
  );

  const contextFake = await startFakeAnthropic(0, { delayMs: 1200, toolCalls: 4 });
  upstreams.push(contextFake);
  const contextClient = await tenant("context-recovery", contextFake.url);
  const contextRun = await contextClient
    .agent({
      model: { provider: "anthropic", id: "claude-haiku-4-5" },
      instructions: "Recover from a compacted history",
    })
    .stream({ prompt: "go" });
  await until(async () => contextFake.state.messagesCalls.length === 4);
  await restartWorker();
  assert.equal(
    (await contextClient.runs.wait(contextRun.runId, AbortSignal.timeout(60000))).status,
    "completed",
    diagnostic,
  );
  for (let step = 1; step <= 4; step++)
    assert.equal(
      await read(contextClient, contextRun.runId, `/workspace/step-${step}.txt`),
      `fake step ${step}\n`,
    );
  const checkpointRows =
    await db.client`select 1 from events where run_id = ${contextRun.runId} and type = 'context.checkpoint'`;
  assert.ok(checkpointRows.length > 0);
  assert.equal(contextFake.state.messagesCalls.length, 6);
  console.log("PASS compaction checkpoint survives worker replacement and retains script progress");

  const duration = await recovery
    .agent({
      model: { provider: "anthropic", id: "claude-haiku-4-5" },
      instructions: "Stop at the wall-clock cap",
      maxDurationSeconds: 1,
    })
    .generate({ prompt: "go" });
  assert.equal(duration.run.status, "killed", diagnostic);
  assert.equal(duration.run.error, "max_duration");
  const completedAfterCancel = await client.runs.cancel(run.id);
  assert.equal(completedAfterCancel.status, "completed");
  console.log("PASS wall-clock cancellation and terminal cancel idempotence");

  const killed = await recovery
    .agent({
      model: { provider: "anthropic", id: "claude-haiku-4-5" },
      instructions: "Cancel while model is running",
    })
    .stream({ prompt: "go" });
  const prior = slow.state.messagesCalls.length;
  await until(async () => slow.state.messagesCalls.length > prior);
  await recovery.runs.kill(killed.runId);
  await until(async () => {
    if (!db) throw new Error("test database is closed");
    const [row] = await db.client`select status from work_items where run_id = ${killed.runId}`;
    return row?.status === "done" || row?.status === "failed";
  });
  assert.equal((await recovery.runs.get(killed.runId)).status, "killed");
  assert.equal((await recovery.runs.files(killed.runId)).length, 0);
  const uncertainRows =
    await db.client`select payload from events where run_id = ${killed.runId} and type = 'model.unknown'`;
  assert.ok(uncertainRows.length > 0, "aborted responses must be explicitly uncertain");
  const canceledModelCalls =
    await db.client`select 1 from events where run_id = ${killed.runId} and type = 'model.call'`;
  assert.equal(
    canceledModelCalls.length,
    0,
    "synthetic failure must not masquerade as a completed model call",
  );
  console.log("PASS in-flight cancellation preserves killed status and prevents tool writes");
  // Hold the run row so cancel reads an active status but its UPDATE races a terminal commit.
  worker.kill("SIGKILL");
  await exited(worker);
  const cancelRace = await client
    .agent({
      model: { provider: "anthropic", id: "claude-haiku-4-5" },
      instructions: "Terminal CAS fixture",
    })
    .stream({ prompt: "go" });
  let cancelResult: ReturnType<typeof client.runs.cancel> | undefined;
  await db.client.begin(async (sql) => {
    await sql`select id from runs where id = ${cancelRace.runId} for update`;
    cancelResult = client.runs.cancel(cancelRace.runId);
    await until(async () => {
      if (!db) return false;
      const rows =
        await db.client`select 1 from pg_stat_activity where datname = ${databaseName} and wait_event_type = 'Lock' and query like 'update "runs" set "status"%'`;
      return rows.length > 0;
    });
    const [completed] =
      await sql`update runs set status = 'completed', completed_at = now(), event_seq = event_seq + 1 where id = ${cancelRace.runId} returning event_seq`;
    await sql`insert into events (run_id, seq, type, payload) values (${cancelRace.runId}, ${Number(completed?.event_seq) - 1}, 'run.completed', '{}'::jsonb)`;
  });
  assert.equal((await cancelResult)?.status, "completed");
  const cancelEvents =
    await db.client`select type from events where run_id = ${cancelRace.runId} and type in ('run.completed','run.canceled')`;
  assert.deepEqual(
    cancelEvents.map((row) => row.type),
    ["run.completed"],
  );
  worker = startWorker();
  console.log("PASS cancel racing a terminal commit cannot overwrite completed");

  const fenceFake = await startFakeAnthropic(0, { delayMs: 800, toolCalls: 1 });
  upstreams.push(fenceFake);
  const fenceClient = await tenant("fence", fenceFake.url);
  const fenced = await fenceClient
    .agent({
      model: { provider: "anthropic", id: "claude-haiku-4-5" },
      instructions: "Old worker must not commit after takeover",
    })
    .stream({ prompt: "go" });
  await until(async () => fenceFake.state.messagesCalls.length === 1);
  const [leasedItem] =
    await db.client`select id from work_items where run_id = ${fenced.runId} and status = 'leased'`;
  const frozen = worker;
  frozen.kill("SIGSTOP");
  worker = startWorker();
  const fenceRun = await fenceClient.runs.wait(fenced.runId, AbortSignal.timeout(60000));
  assert.equal(fenceRun.status, "completed", diagnostic);
  frozen.kill("SIGCONT");
  await until(async () => diagnostic.includes(`lost lease on work item ${leasedItem?.id}`));
  frozen.kill("SIGKILL");
  await exited(frozen);
  const settled =
    await db.client`select id from model_calls where run_id = ${fenced.runId} and status = 'settled'`;
  assert.equal(settled.length, 2);
  const terminal =
    await db.client`select seq from events where run_id = ${fenced.runId} and type = 'run.completed'`;
  assert.equal(terminal.length, 1);
  console.log(
    "PASS SIGSTOP lease takeover rejects the old worker's late result without double settlement",
  );

  // ---- Pi harness engine on PostgreSQL: fenced commits, SIGKILL takeover, SIGSTOP fence ----
  const harnessFake = await startFakeAnthropic(0, {
    honorToolAvailability: true,
    delayMs: 150,
    script: [
      { name: "write", input: { path: "/workspace/h.txt", content: "first\n" } },
      { name: "bash", input: { command: "echo once >> /workspace/h-append.txt" } },
      { name: "read", input: { path: "/workspace/h.txt" } },
    ],
  });
  upstreams.push(harnessFake);
  const harnessClient = await tenant("harness", harnessFake.url);
  const harnessAgent = harnessClient.agent({
    model: { provider: "anthropic", id: "claude-haiku-4-5" },
    instructions: "Run on the Pi harness",
    engine: "pi-harness",
  });
  const harnessRun = await harnessAgent.generate({ prompt: "Write, run, read" });
  assert.equal(harnessRun.run.status, "completed", `${harnessRun.run.error}\n${diagnostic}`);
  assert.equal(await read(harnessClient, harnessRun.run.id, "/workspace/h.txt"), "first\n");
  assert.equal(await read(harnessClient, harnessRun.run.id, "/workspace/h-append.txt"), "once\n");
  const harnessTypes = harnessRun.events.map((e) => e.type);
  assert.equal(harnessTypes.filter((t) => t === "model.call").length, 4);
  assert.equal(harnessTypes.filter((t) => t === "tool.result").length, 3);
  assert.equal(harnessTypes.filter((t) => t === "workspace.committed").length, 3);
  assert.equal(harnessTypes.filter((t) => t === "spend.updated").length, 4);
  assert.ok(!("reserved_usd" in harnessRun.run));
  assert.ok(harnessRun.run.spent_usd > 0);
  const [harnessItem] =
    await db.client`select kind, status from work_items where run_id = ${harnessRun.run.id}`;
  assert.deepEqual(harnessItem, { kind: "harness", status: "done" });
  const harnessLedger =
    await db.client`select status from model_calls where run_id = ${harnessRun.run.id}`;
  assert.equal(harnessLedger.filter((row) => row.status === "settled").length, 4);
  const [piSession] =
    await db.client`select next_seq from pi_sessions where session_id = ${harnessRun.run.id}`;
  assert.ok(Number(piSession?.next_seq) > 1, "Pi session rows are scoped by org and run");
  // The legacy executor cannot honor thinking levels or OpenAI models; the API fails closed.
  await assert.rejects(
    () =>
      harnessClient
        .agent({
          model: { provider: "anthropic", id: "claude-haiku-4-5" },
          instructions: "legacy with thinking",
          thinking: "low",
        })
        .generate({ prompt: "Think" }),
    (error: unknown) =>
      error instanceof NimplexError &&
      error.status === 400 &&
      error.code === "thinking_requires_harness",
  );
  await harnessClient.providerKeys.put({
    provider: "openai",
    api_key: "fake-openai-local-only",
    base_url: harnessFake.url,
    scope: "org",
  });
  await assert.rejects(
    () =>
      harnessClient
        .agent({
          model: { provider: "openai", id: "gpt-5.4-mini" },
          instructions: "legacy with openai",
        })
        .generate({ prompt: "Route" }),
    (error: unknown) =>
      error instanceof NimplexError &&
      error.status === 400 &&
      error.code === "provider_requires_harness",
  );
  const [legacyRuns] = await db.client`select count(*)::int as count from runs where
    config->>'instructions' in ('legacy with thinking', 'legacy with openai')`;
  assert.equal(legacyRuns?.count, 0, "rejected runs are never created");
  console.log("PASS legacy engine fails closed for thinking levels and OpenAI models");

  // A scheduled run is durable at creation and waits in the queue until its start time.
  const scheduledAt = new Date(Date.now() + 4_000);
  const scheduledStarted = Date.now();
  const scheduled = await harnessAgent.stream({ prompt: "Write, run, read", startAt: scheduledAt });
  assert.equal(scheduled.run.status, "queued");
  const [scheduledItem] =
    await db.client`select status, available_at from work_items where run_id = ${scheduled.runId}`;
  assert.equal(scheduledItem?.status, "pending");
  assert.equal(new Date(String(scheduledItem?.available_at)).getTime(), scheduledAt.getTime());
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  assert.equal(
    (await harnessClient.runs.get(scheduled.runId)).status,
    "queued",
    "a scheduled run must not start early",
  );
  const scheduledRun = await scheduled.wait();
  assert.equal(scheduledRun.status, "completed", `${scheduledRun.error}`);
  assert.ok(
    Date.now() - scheduledStarted >= 3_500,
    "the worker claimed the scheduled run only after its start time",
  );
  await assert.rejects(
    () => harnessAgent.generate({ prompt: "bad time", startAt: "tomorrow" }),
    (error: unknown) => error instanceof NimplexError && error.status === 400,
  );
  console.log("PASS scheduled start waits durably in the queue until its time");
  const piMessages =
    await db.client`select count(*)::int as count from pi_entries where session_id = ${harnessRun.run.id} and type = 'message'`;
  assert.equal(piMessages[0]?.count, 1 + 4 + 3);
  // A continuation shares the parent's Pi session and stays on the harness engine.
  const harnessNext = await harnessAgent.generate({
    prompt: "Say hello",
    parentRunId: harnessRun.run.id,
  });
  assert.equal(harnessNext.run.status, "completed", `${harnessNext.run.error}\n${diagnostic}`);
  const harnessContinued = JSON.stringify(harnessFake.state.messagesCalls.at(-1)?.body.messages);
  assert.ok(
    harnessContinued.includes("Write, run, read") && harnessContinued.includes("Say hello"),
  );
  const [continuedItem] =
    await db.client`select kind from work_items where run_id = ${harnessNext.run.id}`;
  assert.equal(continuedItem?.kind, "harness");
  console.log("PASS Pi harness run on PostgreSQL: fenced commits, accounting, Pi session lineage");

  const harnessSlow = await startFakeAnthropic(0, {
    honorToolAvailability: true,
    delayMs: 400,
    script: [
      { name: "bash", input: { command: "echo once >> /workspace/durable.txt" } },
      { name: "bash", input: { command: "cat /workspace/durable.txt" } },
    ],
  });
  upstreams.push(harnessSlow);
  const harnessRecovery = await tenant("harness-recovery", harnessSlow.url);
  const crashingHarness = await harnessRecovery
    .agent({
      model: { provider: "anthropic", id: "claude-haiku-4-5" },
      instructions: "Survive worker death on the harness",
      engine: "pi-harness",
    })
    .stream({ prompt: "go" });
  await until(async () => harnessSlow.state.messagesCalls.length === 2);
  await restartWorker();
  const recoveredHarness = await harnessRecovery.runs.wait(
    crashingHarness.runId,
    AbortSignal.timeout(60000),
  );
  assert.equal(recoveredHarness.status, "completed", `${recoveredHarness.error}\n${diagnostic}`);
  assert.equal(
    await read(harnessRecovery, recoveredHarness.id, "/workspace/durable.txt"),
    "once\n",
  );
  const harnessRecoveryLedger =
    await db.client`select status from model_calls where run_id = ${recoveredHarness.id}`;
  assert.equal(harnessRecoveryLedger.filter((row) => row.status === "unknown").length, 1);
  assert.equal(harnessRecoveryLedger.filter((row) => row.status === "settled").length, 3);
  const recoveredEvents = [];
  for await (const event of harnessRecovery.runs.events(recoveredHarness.id)) {
    recoveredEvents.push(event);
    if (
      event.type.startsWith("run.") &&
      ["run.completed", "run.failed", "run.killed"].includes(event.type)
    )
      break;
  }
  const recoveredTypes = recoveredEvents.map((e) => e.type);
  assert.equal(recoveredTypes.filter((t) => t === "run.resumed").length, 1);
  assert.equal(recoveredTypes.filter((t) => t === "tool.result").length, 2);
  assert.equal(recoveredTypes.filter((t) => t === "model.call").length, 3);
  const harnessUnknown =
    await db.client`select status from model_calls where run_id = ${recoveredHarness.id} and status = 'unknown'`;
  assert.equal(harnessUnknown.length, 1);
  console.log(
    "PASS Pi harness SIGKILL takeover resumes the same Pi operation without repeating work",
  );

  const harnessFence = await startFakeAnthropic(0, {
    honorToolAvailability: true,
    delayMs: 800,
    toolCalls: 1,
  });
  upstreams.push(harnessFence);
  const harnessFenceClient = await tenant("harness-fence", harnessFence.url);
  const fencedHarness = await harnessFenceClient
    .agent({
      model: { provider: "anthropic", id: "claude-haiku-4-5" },
      instructions: "Old worker must not commit after takeover",
      engine: "pi-harness",
    })
    .stream({ prompt: "go" });
  await until(async () => harnessFence.state.messagesCalls.length === 1);
  const [harnessLeased] =
    await db.client`select id from work_items where run_id = ${fencedHarness.runId} and status = 'leased'`;
  const frozenHarness = worker;
  frozenHarness.kill("SIGSTOP");
  worker = startWorker();
  const fencedHarnessRun = await harnessFenceClient.runs.wait(
    fencedHarness.runId,
    AbortSignal.timeout(60000),
  );
  assert.equal(fencedHarnessRun.status, "completed", diagnostic);
  frozenHarness.kill("SIGCONT");
  await until(async () => diagnostic.includes(`lost lease on work item ${harnessLeased?.id}`));
  frozenHarness.kill("SIGKILL");
  await exited(frozenHarness);
  const fencedHarnessCalls =
    await db.client`select status from model_calls where run_id = ${fencedHarness.runId}`;
  // The frozen worker's in-flight request is unknown; the successor settled its own two.
  assert.equal(fencedHarnessCalls.filter((row) => row.status === "settled").length, 2);
  assert.equal(fencedHarnessCalls.filter((row) => row.status === "unknown").length, 1);
  const fencedTerminal =
    await db.client`select seq from events where run_id = ${fencedHarness.runId} and type = 'run.completed'`;
  assert.equal(fencedTerminal.length, 1);
  const fencedResults =
    await db.client`select count(*)::int as count from events where run_id = ${fencedHarness.runId} and type = 'tool.result'`;
  assert.equal(fencedResults[0]?.count, 1);
  console.log("PASS Pi harness SIGSTOP takeover: stale worker cannot commit, no double settlement");

  const beforeUnknown = harnessFake.state.messagesCalls.length;
  const unknownModel = await harnessClient
    .agent({
      model: { provider: "anthropic", id: "claude-unknown-for-accounting" },
      instructions: "Reject unpriced unknown models before dispatch",
    })
    .generate({ prompt: "hello" });
  assert.equal(unknownModel.run.status, "failed");
  assert.match(unknownModel.run.error ?? "", /Unsupported Anthropic model/);
  assert.equal(harnessFake.state.messagesCalls.length, beforeUnknown);
  const unknownLedger =
    await db.client`select id from model_calls where run_id = ${unknownModel.run.id}`;
  assert.equal(unknownLedger.length, 0);
  console.log("PASS unknown model is rejected before dispatch instead of recording free usage");

  const cancellationDb = db;
  for (const action of [
    "kill",
    "cancel",
    "duration",
    "kill-restart",
    "kill-tool",
    "kill-race",
  ] as const) {
    const slow = await startFakeAnthropic(
      0,
      action === "kill-tool"
        ? {
            script: [
              {
                name: "bash",
                input: { command: "echo partial > /workspace/canceled.txt; sleep 10" },
              },
            ],
          }
        : { toolCalls: 1, delayMs: action === "kill-race" ? 250 : 10_000 },
    );
    upstreams.push(slow);
    const stoppedClient = await tenant(`harness-${action}`, slow.url);
    const stopped = await stoppedClient
      .agent({
        model: { provider: "anthropic", id: "claude-haiku-4-5" },
        instructions: "Cancel without blocking the session lineage",
        engine: "pi-harness",
        ...(action === "duration" ? { maxDurationSeconds: 1 } : {}),
      })
      .stream({ prompt: "go" });
    await until(async () => slow.state.messagesCalls.length === 1);
    if (action === "kill-tool")
      await until(async () => {
        const rows =
          await cancellationDb.client`select seq from events where run_id = ${stopped.runId} and type = 'tool.started'`;
        return rows.length === 1;
      });
    const stopAt = Date.now();
    if (action === "kill-restart") worker.kill("SIGSTOP");
    if (action === "cancel") await stoppedClient.runs.cancel(stopped.runId);
    else if (action !== "duration") await stoppedClient.runs.kill(stopped.runId);
    if (action === "kill-restart") {
      await assert.rejects(
        () =>
          stoppedClient
            .agent({
              model: { provider: "anthropic", id: "claude-haiku-4-5" },
              instructions: "Wait for fenced cleanup",
              engine: "pi-harness",
            })
            .generate({ prompt: "Too early", parentRunId: stopped.runId }),
        (error: unknown) =>
          error instanceof NimplexError && error.code === "parent_run_cleanup_pending",
      );
      await restartWorker();
    }
    await until(async () => {
      const [item] =
        await cancellationDb.client`select status from work_items where run_id = ${stopped.runId}`;
      return item?.status === "done";
    });
    assert.ok(
      Date.now() - stopAt < 8_000,
      `abort must finish before the upstream response (${action})`,
    );
    const result = await stoppedClient.runs.get(stopped.runId);
    assert.equal(result.status, action === "cancel" ? "canceled" : "killed", diagnostic);
    const afterStop: { type: string }[] =
      await cancellationDb.client`select type from events where run_id = ${stopped.runId}`;
    assert.equal(
      afterStop.filter((row) => row.type === "tool.started").length,
      action === "kill-tool" ? 1 : 0,
    );
    assert.equal(afterStop.filter((row) => row.type === "workspace.committed").length, 0);
    const calls: { status: string }[] =
      await cancellationDb.client`select status from model_calls where run_id = ${stopped.runId}`;
    assert.deepEqual(
      calls.map((row) => row.status),
      [action === "kill-tool" ? "settled" : "unknown"],
    );
    assert.equal(slow.state.messagesCalls.length, 1);
    await stoppedClient.providerKeys.put({
      provider: "anthropic",
      api_key: "fake-only",
      base_url: harnessFake.url,
      scope: "org",
    });
    const continuation = await stoppedClient
      .agent({
        model: { provider: "anthropic", id: "claude-haiku-4-5" },
        instructions: "Continue after cancellation",
        engine: "pi-harness",
      })
      .generate({ prompt: "Continue", parentRunId: stopped.runId });
    assert.equal(continuation.run.status, "completed", `${continuation.run.error}\n${diagnostic}`);
    console.log(
      `PASS hosted Pi ${action}: prompt abort, no tool dispatch, durable settlement and continuation`,
    );
  }

  if (process.env.NIMPLEX_E2E_SANDBOX === "e2b") {
    assert.ok(process.env.E2B_API_KEY, "E2B_API_KEY is required for the cloud acceptance test");
    const cloudFake = await startFakeAnthropic(0, {
      delayMs: 1500,
      script: [
        {
          name: "bash",
          input: {
            command:
              "echo once >> native.txt; mkdir empty; ln -s native.txt link.txt; chmod 755 native.txt; sleep 4; node -e \"require('fs').writeFileSync('native.bin', Buffer.from([0,255,1])); require('fs').writeFileSync('secrets.txt', String(['ANTHROPIC_API_KEY','E2B_API_KEY','NIMPLEX_MASTER_KEY'].some(k => !!process.env[k])))\"",
          },
        },
        {
          name: "bash",
          input: {
            command:
              "node -e \"if(require('fs').readFileSync('link.txt','utf8') !== 'once\\n') process.exit(1)\"",
          },
        },
      ],
    });
    upstreams.push(cloudFake);
    const cloud = await tenant("e2b", cloudFake.url);
    const native = await cloud
      .agent({
        model: { provider: "anthropic", id: "claude-haiku-4-5" },
        sandbox: { provider: "e2b" },
        instructions: "Run native commands and survive worker death",
      })
      .stream({ prompt: "go" });
    await until(async () => {
      if (!db) return false;
      const rows =
        await db.client`select 1 from events where run_id = ${native.runId} and type = 'tier.escalated'`;
      return rows.length > 0;
    }, 60000);
    await new Promise((done) => setTimeout(done, 1500));
    await restartWorker();
    const cloudRun = await cloud.runs.wait(native.runId, AbortSignal.timeout(120000));
    assert.equal(cloudRun.status, "completed", `${cloudRun.error}\n${diagnostic}`);
    const toolDiagnostics =
      await db.client`select payload from events where run_id = ${cloudRun.id} and type = 'tool.result'`;
    assert.ok(
      toolDiagnostics.every((row) => !row.payload.is_error),
      JSON.stringify(toolDiagnostics),
    );
    assert.equal(await read(cloud, cloudRun.id, "/workspace/native.txt"), "once\n");
    assert.deepEqual(
      [...(await cloud.runs.readFile(cloudRun.id, "/workspace/native.bin"))],
      [0, 255, 1],
    );
    assert.equal(await read(cloud, cloudRun.id, "/workspace/secrets.txt"), "false");
    const nativeEvents: RunEvent[] = [];
    for await (const event of cloud.runs.events(native.runId, {
      signal: AbortSignal.timeout(10000),
    }))
      nativeEvents.push(event);
    assert.ok(nativeEvents.some((e) => e.type === "run.resumed"));
    assert.equal(nativeEvents.filter((e) => e.type === "tool.result").length, 2);
    assert.ok(
      nativeEvents
        .filter((e) => e.type === "tool.result")
        .every((e) => !(e.payload as { is_error: boolean }).is_error),
      JSON.stringify(nativeEvents.filter((e) => e.type === "tool.result")),
    );
    console.log(
      "PASS real E2B native execution, binary sync, credentials absent, SIGKILL reconnect without replay",
    );
    assert.ok(nativeEvents.some((event) => event.type === "sandbox.paused"));
    assert.ok(nativeEvents.some((event) => event.type === "sandbox.resumed"));
    console.log("PASS E2B pause and resume between native tools");

    const resetFake = await startFakeAnthropic(0, {
      delayMs: 1500,
      script: [
        {
          name: "bash",
          input: {
            command:
              "node -e \"require('fs').writeFileSync('persistent.txt', 'survives'); require('fs').mkdirSync('empty'); require('fs').symlinkSync('persistent.txt', 'link.txt')\"",
          },
        },
        {
          name: "bash",
          input: {
            command:
              "node -e \"require('fs').writeFileSync('recovered.txt', require('fs').readFileSync('link.txt'))\"",
          },
        },
      ],
    });
    upstreams.push(resetFake);
    const resetClient = await tenant("reset", resetFake.url);
    const resetting = await resetClient
      .agent({
        model: { provider: "anthropic", id: "claude-haiku-4-5" },
        sandbox: { provider: "e2b" },
        instructions: "Restore a lost environment",
      })
      .stream({ prompt: "go" });
    await until(async () => {
      if (!db) return false;
      const rows =
        await db.client`select 1 from events where run_id = ${resetting.runId} and type = 'tool.result'`;
      return rows.length > 0;
    }, 60000);
    const [beforeReset] =
      await db.client`select sandbox_state from runs where id = ${resetting.runId}`;
    const oldState = beforeReset?.sandbox_state as Parameters<
      ReturnType<typeof getSandboxProvider>["delete"]
    >[0];
    await getSandboxProvider("e2b").delete(oldState);
    const resetRun = await resetClient.runs.wait(resetting.runId, AbortSignal.timeout(120000));
    assert.equal(resetRun.status, "completed", diagnostic);
    assert.equal(await read(resetClient, resetRun.id, "/workspace/recovered.txt"), "survives");
    const resets =
      await db.client`select payload from events where run_id = ${resetting.runId} and type = 'environment.reset'`;
    assert.equal(resets.length, 1);
    assert.equal(resets[0]?.payload.generation, 2);
    console.log("PASS lost E2B environment is rebuilt from Tier 0 with a new generation");
    const nativeFenceFake = await startFakeAnthropic(0, {
      script: [{ name: "bash", input: { command: "echo once >> fenced.txt; sleep 7; node -v" } }],
    });
    upstreams.push(nativeFenceFake);
    const nativeFenceClient = await tenant("native-fence", nativeFenceFake.url);
    const nativeFenceRun = await nativeFenceClient
      .agent({
        model: { provider: "anthropic", id: "claude-haiku-4-5" },
        sandbox: { provider: "e2b" },
        instructions: "Keep the sandbox alive across lease takeover",
      })
      .stream({ prompt: "go" });
    await until(async () => {
      if (!db) return false;
      const rows =
        await db.client`select 1 from events where run_id = ${nativeFenceRun.runId} and type = 'tier.escalated'`;
      return rows.length > 0;
    }, 60000);
    await new Promise((done) => setTimeout(done, 1000));
    const staleNative = worker;
    staleNative.kill("SIGSTOP");
    worker = startWorker();
    await until(async () => {
      if (!db) return false;
      const rows =
        await db.client`select 1 from events where run_id = ${nativeFenceRun.runId} and type = 'run.resumed'`;
      return rows.length > 0;
    });
    staleNative.kill("SIGCONT");
    const nativeFenceDone = await nativeFenceClient.runs.wait(
      nativeFenceRun.runId,
      AbortSignal.timeout(90000),
    );
    assert.equal(nativeFenceDone.status, "completed", diagnostic);
    assert.equal(nativeFenceDone.sandbox_generation, 1);
    assert.equal(
      await read(nativeFenceClient, nativeFenceRun.runId, "/workspace/fenced.txt"),
      "once\n",
    );
    staleNative.kill("SIGKILL");
    await exited(staleNative);
    console.log("PASS stale native worker cannot delete the new lease owner's sandbox");

    const timeoutFake = await startFakeAnthropic(0, {
      script: [
        {
          name: "bash",
          input: {
            command:
              "node -e \"require('fs').mkdirSync('node_modules'); require('fs').writeFileSync('node_modules/cache', 'kept')\"; sleep 4",
            timeout: 1,
          },
        },
        {
          name: "bash",
          input: {
            command:
              "node -e \"require('fs').writeFileSync('cache.txt', require('fs').readFileSync('node_modules/cache'))\"",
          },
        },
      ],
    });
    upstreams.push(timeoutFake);
    const timeoutClient = await tenant("native-timeout", timeoutFake.url);
    const timeoutRun = await timeoutClient
      .agent({
        model: { provider: "anthropic", id: "claude-haiku-4-5" },
        sandbox: { provider: "e2b" },
        instructions: "Keep native caches after a command timeout",
      })
      .generate({ prompt: "go", signal: AbortSignal.timeout(90000) });
    assert.equal(timeoutRun.run.status, "completed", diagnostic);
    assert.equal(timeoutRun.run.sandbox_generation, 1);
    assert.equal(await read(timeoutClient, timeoutRun.run.id, "/workspace/cache.txt"), "kept");
    assert.ok(
      timeoutRun.events
        .filter((event) => event.type === "tool.result")
        .some((event) => (event.payload as { is_error: boolean }).is_error),
    );
    assert.ok(!timeoutRun.events.some((event) => event.type === "environment.reset"));
    console.log("PASS native command timeout kills only its process group and preserves caches");

    const killedNative = await nativeFenceClient
      .agent({
        model: { provider: "anthropic", id: "claude-haiku-4-5" },
        sandbox: { provider: "e2b" },
        instructions: "Stop native work when the API kills the run",
      })
      .stream({ prompt: "go" });
    await until(async () => {
      if (!db) return false;
      const rows =
        await db.client`select 1 from events where run_id = ${killedNative.runId} and type = 'tier.escalated'`;
      return rows.length > 0;
    }, 60000);
    await new Promise((done) => setTimeout(done, 1000));
    const [killedBox] =
      await db.client`select sandbox_state from runs where id = ${killedNative.runId}`;
    await nativeFenceClient.runs.kill(killedNative.runId);
    await until(async () => {
      if (!db) return false;
      const [row] =
        await db.client`select status from work_items where run_id = ${killedNative.runId} and status = 'leased'`;
      return !row;
    });
    await assert.rejects(
      () =>
        getSandboxProvider("e2b").resume(
          killedBox?.sandbox_state as Parameters<
            ReturnType<typeof getSandboxProvider>["resume"]
          >[0],
        ),
      (error: unknown) => error instanceof Error && error.name === "SandboxMissingError",
    );
    assert.equal((await nativeFenceClient.runs.get(killedNative.runId)).status, "killed");
    assert.equal((await nativeFenceClient.runs.files(killedNative.runId)).length, 0);
    console.log("PASS API kill stops the native sandbox and rejects its uncommitted workspace");

    const pauseFake = await startFakeAnthropic(0, {
      script: [
        {
          name: "bash",
          input: {
            command: "node -e \"require('fs').appendFileSync('pause-result.txt', 'once')\"",
          },
        },
      ],
    });
    upstreams.push(pauseFake);
    const pauseClient = await tenant("pause-fault", pauseFake.url);
    worker.kill("SIGKILL");
    await exited(worker);
    worker = startWorker("reject");
    const pauseRun = await pauseClient
      .agent({
        model: { provider: "anthropic", id: "claude-haiku-4-5" },
        sandbox: { provider: "e2b" },
        instructions: "Keep completed results if pause fails",
      })
      .generate({ prompt: "go", signal: AbortSignal.timeout(90000) });
    assert.equal(pauseRun.run.status, "completed", diagnostic);
    assert.equal(await read(pauseClient, pauseRun.run.id, "/workspace/pause-result.txt"), "once");
    assert.ok(pauseRun.events.some((event) => event.type === "sandbox.pause_failed"));
    assert.ok(
      pauseRun.events
        .filter((event) => event.type === "tool.result")
        .every((event) => !(event.payload as { is_error: boolean }).is_error),
    );
    console.log("PASS pause failure preserves a completed native result without replay");

    worker.kill("SIGKILL");
    await exited(worker);
    diagnostic = "";
    worker = startWorker("delay");
    const slowPause = await pauseClient
      .agent({
        model: { provider: "anthropic", id: "claude-haiku-4-5" },
        sandbox: { provider: "e2b" },
        instructions: "Allow kill while the provider pause API is slow",
      })
      .stream({ prompt: "go" });
    await until(async () => diagnostic.includes("E2E_PAUSE_ENTER"), 60000);
    const killStarted = Date.now();
    await pauseClient.runs.kill(slowPause.runId);
    assert.ok(
      Date.now() - killStarted < 2000,
      "provider IO must not block API kill behind a row lock",
    );
    await until(async () => {
      if (!db) return false;
      const rows =
        await db.client`select 1 from work_items where run_id = ${slowPause.runId} and status = 'leased'`;
      return rows.length === 0;
    });
    assert.equal((await pauseClient.runs.get(slowPause.runId)).status, "killed");
    assert.equal((await pauseClient.runs.files(slowPause.runId)).length, 0);
    console.log("PASS API kill remains responsive during a slow provider pause");
    await restartWorker();

    if (process.env.NIMPLEX_E2E_REAL_MODEL === "1") {
      assert.ok(
        process.env.ANTHROPIC_API_KEY,
        "ANTHROPIC_API_KEY is required for the real-model test",
      );
      const realClient = await tenant("real-model", cloudFake.url);
      await realClient.providerKeys.put({
        provider: "anthropic",
        api_key: process.env.ANTHROPIC_API_KEY,
        scope: "org",
        base_url: process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com",
      });
      const real = await realClient
        .agent({
          model: { provider: "anthropic", id: "claude-haiku-4-5" },
          sandbox: { provider: "e2b" },
          instructions:
            "Use bash to run exactly: node -e \"require('fs').writeFileSync('real-e2e.txt', 'native model verified')\". Then use read to verify /workspace/real-e2e.txt and finish. Do not install packages or access the network.",
        })
        .generate({ prompt: "Execute and verify now.", signal: AbortSignal.timeout(120000) });
      assert.equal(real.run.status, "completed", `${real.run.error}\n${diagnostic}`);
      assert.equal(
        await read(realClient, real.run.id, "/workspace/real-e2e.txt"),
        "native model verified",
      );
      assert.ok(real.events.some((event) => event.type === "tier.escalated"));
      console.log(`PASS real Haiku + E2B functional run ($${real.run.spent_usd})`);
    }
  }
} catch (error) {
  console.error(diagnostic);
  throw error;
} finally {
  for (const process of children)
    if (process.exitCode === null && process.signalCode === null) process.kill("SIGKILL");
  await Promise.all(children.map(exited));
  await Promise.all(upstreams.map((fake) => fake.close()));
  if (db) {
    const boxes = await db.client`select sandbox_state from runs where sandbox_state is not null`;
    for (const row of boxes) {
      const state = row.sandbox_state as Parameters<
        ReturnType<typeof getSandboxProvider>["delete"]
      >[0];
      await getSandboxProvider(state.backendId).delete(state);
    }
  }
  await db?.client.end();
  await admin.client.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  await admin.client.end();
}

async function until(predicate: () => Promise<boolean>, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`condition timed out\n${diagnostic}`);
    await new Promise((done) => setTimeout(done, 50));
  }
}
async function tenant(label: string, upstream: string) {
  const response = await fetch(`${baseUrl}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl },
    body: JSON.stringify({
      name: label,
      email: `${label}-${Date.now()}@example.com`,
      password: "password1234",
    }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  const cookie = response.headers
    .getSetCookie()
    .map((part) => part.split(";")[0])
    .join("; ");
  const key = await fetch(`${baseUrl}/v1/api-keys`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: label }),
  });
  assert.equal(key.status, 201, await key.clone().text());
  const client = new Nimplex({ baseUrl, apiKey: ((await key.json()) as { key: string }).key });
  await client.providerKeys.put({
    provider: "anthropic",
    api_key: "fake-local-only",
    base_url: upstream,
    scope: "org",
  });
  return client;
}
async function read(client: Nimplex, id: string, path: string) {
  return new TextDecoder().decode(await client.runs.readFile(id, path));
}
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((done, reject) =>
    server.close((error) => (error ? reject(error) : done())),
  );
  return port;
}

function eventText(event: RunEvent | undefined): string | undefined {
  return (event?.payload as { content?: { text?: string }[] } | undefined)?.content?.[0]?.text;
}
