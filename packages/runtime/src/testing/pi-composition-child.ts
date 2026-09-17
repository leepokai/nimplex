import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { compositionFixture } from "./pi-composition-fixture.ts";

// Executed only by the SIGKILL qualification fixture in a separate process.
const fixture = await compositionFixture();
const boundary = process.argv[2];
process.send?.({ stage: "ready", directory: fixture.directory });
const listener = async (event: { type: string; message?: AgentMessage }) => {
  if (event.type !== "message_end" || event.message?.role !== "assistant") return;
  process.send?.({ stage: "commit-pending" });
  await new Promise<void>(() => {});
  writeFileSync(join(fixture.directory, "committed-response.json"), JSON.stringify(event.message));
};
if (boundary === "agent") fixture.session.agent.subscribe(listener);
else fixture.session.subscribe(listener);
fixture.session.subscribe((event) => {
  if (event.type === "message_end" && event.message.role === "toolResult") {
    process.send?.({ stage: "effect-completed" });
  }
});
await fixture.session.prompt("Write a probe file.");
// Keep the IPC handle live until the parent kills this process.
