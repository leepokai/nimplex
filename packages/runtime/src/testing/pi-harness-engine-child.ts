import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeAnthropic } from "@nimplex/testkit";
import { NimplexRuntime } from "../runtime.ts";

// Real process-death probe for the Pi harness engine. The parent kills this process
// once the selected boundary has been committed and reported; it never exits on its own.
const boundary = process.argv[2] ?? "after-tool";
const directory = mkdtempSync(join(tmpdir(), "nimplex-harness-crash-"));
const slow =
  boundary === "during-request" || boundary === "cancel-pending" || boundary === "during-summary";
const upstream = await startFakeAnthropic(0, {
  honorToolAvailability: true,
  delayMs: slow ? 3_000 : 100,
  script: [
    { name: "write", input: { path: "/workspace/a.txt", content: "first\n" } },
    { name: "bash", input: { command: "echo once >> /workspace/append.txt" } },
    { name: "read", input: { path: "/workspace/a.txt" } },
  ],
});
const hang = () => new Promise<void>(() => {});
let cancelRequested = false;
const runtime = new NimplexRuntime({
  directory,
  engine: "pi-harness",
  credential: () => ({ apiKey: "fake-key", baseUrl: upstream.url }),
  afterCommit: async (_turnId, events) => {
    if (boundary === "cancel-pending" && cancelRequested) {
      // The first commit after stopTurn is Pi's durable cancel request; die before reconciliation.
      process.send?.({ stage: "committed", requests: upstream.state.messagesCalls.length });
      await hang();
    }
    const reached =
      boundary === "after-response"
        ? events.some(
            (e) => e.type === "tool.call" && (e.payload as { name: string }).name === "bash",
          )
        : boundary === "after-tool"
          ? events.some(
              (e) => e.type === "tool.result" && (e.payload as { name: string }).name === "bash",
            )
          : false;
    if (!reached) return;
    process.send?.({ stage: "committed", requests: upstream.state.messagesCalls.length });
    await hang();
  },
});
const session = runtime.createSession(directory);
process.send?.({ stage: "ready", directory, upstreamUrl: upstream.url, sessionId: session.id });
const submit = (prompt: string, contextMode: "continue" | "compact" = "continue") =>
  runtime.startTurn(session.id, {
    prompt,
    instructions: "Complete the task.",
    model: "claude-haiku-4-5",
    sandbox: "docker",
    budget: 1,
    timeout: 180,
    contextMode,
    executionMode: "build",
  });
if (boundary === "during-summary") {
  // A slow upstream also slows the first turn; complete it, then die during the summary request.
  const first = await submit("Write, run, read");
  for await (const _event of runtime.events(first.runId)) {
    /* Drain the first turn. */
  }
  const second = await submit("Summarize then continue", "compact");
  process.send?.({ stage: "started", runId: second.runId, firstRunId: first.runId });
  for await (const event of runtime.events(second.runId)) {
    if (event.type === "model.reserved") {
      process.send?.({ stage: "committed", requests: upstream.state.messagesCalls.length });
      await hang();
    }
  }
}
const turn = await submit("Write, run, read");
process.send?.({ stage: "started", runId: turn.runId });
if (boundary === "cancel-pending") {
  for await (const event of runtime.events(turn.runId)) {
    if (event.type === "model.reserved") {
      cancelRequested = true;
      void runtime.stopTurn(turn.runId);
      break;
    }
  }
}
if (boundary === "during-request") {
  let reserved = 0;
  for await (const event of runtime.events(turn.runId)) {
    if (event.type === "model.reserved" && ++reserved === 2) {
      // The second request is in flight against a slow upstream; report and wait to be killed.
      process.send?.({ stage: "committed", requests: upstream.state.messagesCalls.length });
      await hang();
    }
  }
}
await hang();
