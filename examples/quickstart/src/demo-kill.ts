/**
 * Demo: kill -9 the worker mid-run, another worker resumes from the log + Tier 0, spend stays capped.
 *
 *   pnpm --filter @nimplex/example-quickstart exec tsx src/demo-kill.ts
 *
 * Needs api (:8787) running with NIMPLEX_DEV_EMAIL_AUTH=1 and NO worker of your own: this script
 * spawns worker A, SIGKILLs it after the 2nd model call, then spawns worker B. Without
 * ANTHROPIC_API_KEY the fake upstream scripts 4 slow bash steps (1.5s each); with a key it is Haiku.
 */
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Nimplex, type RunEvent } from "@nimplex/sdk";
import { startFakeAnthropic } from "@nimplex/testkit";
import { API, freshApiKey, ok } from "./lib.ts";

const REAL_KEY = process.env.ANTHROPIC_API_KEY;
const fake = REAL_KEY ? null : await startFakeAnthropic(8790, { toolCalls: 4, delayMs: 1500 });
if (fake) ok(`fake Anthropic upstream ${fake.url} (no-key mode, 1.5s per call)`);

const workerDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../apps/worker");
function spawnWorker(label: string): ChildProcess {
  // node --import tsx: one process, so SIGKILL really kills the loop (pnpm/tsx wrappers would not).
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: workerDir,
    stdio: ["ignore", "pipe", "inherit"],
  });
  child.stdout?.on("data", (d: Buffer) => process.stdout.write(`    [${label}] ${d}`));
  return child;
}

const nimplex = new Nimplex({ baseUrl: API, apiKey: await freshApiKey("demo") });
await nimplex.providerKeys.put({
  provider: "anthropic",
  api_key: REAL_KEY || "sk-ant-fake-demo",
  scope: "org",
  base_url: fake ? fake.url : process.env.ANTHROPIC_BASE_URL,
});
const workerA = spawnWorker("worker A");
let workerB: ChildProcess | undefined;

const stream = await nimplex
  .agent({
    model: { provider: "anthropic", id: "claude-haiku-4-5" },
    sandbox: { provider: "local" },
    instructions:
      "Create /workspace/hello.txt containing today's date (use the date command), then grep it for the digit 2. Reply DONE when finished.",
  })
  .stream({ prompt: "go" });
console.log(`run ${stream.runId} created`);

const events: RunEvent[] = [];
let modelCalls = 0;
for await (const event of stream.events) {
  events.push(event);
  const p = (event.payload ?? {}) as Record<string, unknown>;
  if (event.type === "model.call") modelCalls++;
  if (
    [
      "run.started",
      "run.resumed",
      "model.call",
      "tool.call",
      "run.completed",
      "run.killed",
    ].includes(event.type)
  ) {
    console.log(`  #${event.seq} ${event.type} ${summarize(event.type, p)}`);
  }
  if (event.type === "model.call" && modelCalls === 2 && !workerB) {
    workerA.kill("SIGKILL");
    console.log(
      "  >>> kill -9 worker A (mid-run). Lease expires within 60s, then worker B takes over.",
    );
    workerB = spawnWorker("worker B");
  }
}

const run = await stream.wait();
workerB?.kill();
await fake?.close();

console.log(`\nrun ${run.status}, spent $${run.spent_usd}`);
const files = await nimplex.runs.files(run.id);
for (const f of files) {
  const body = new TextDecoder().decode(await nimplex.runs.readFile(run.id, f.path)).trim();
  console.log(`  Tier 0 ${f.path} (${f.bytes} B): ${body.slice(0, 60)}`);
}

assert.equal(run.status, "completed", `run ended ${run.status}: ${run.error}`);
assert.ok(run.spent_usd <= 0.2, "spend must stay under the cap");
assert.equal(events.filter((e) => e.type === "run.resumed").length, 1, "worker B must resume once");
assert.ok(files.length > 0, "Tier 0 must hold the files the agent wrote");
if (fake) {
  assert.equal(modelCalls, 5, `expected 5 model calls in the log, got ${modelCalls}`);
  assert.equal(files.length, 4, "4 scripted steps write 4 files");
  assert.ok(Math.abs(run.spent_usd - 0.0175) < 1e-9, `expected $0.0175, got ${run.spent_usd}`);
}
console.log("\ndemo passed: the run survived kill -9 of its worker");

function summarize(type: string, p: Record<string, unknown>): string {
  if (type === "run.started" || type === "run.resumed") return `by ${p.worker}`;
  if (type === "model.call") return `${p.stop_reason} $${p.cost_usd}`;
  if (type === "tool.call") return `${p.name} ${JSON.stringify(p.input).slice(0, 60)}`;
  if (type === "run.completed" || type === "run.killed") return `spent $${p.spent_usd}`;
  return "";
}
