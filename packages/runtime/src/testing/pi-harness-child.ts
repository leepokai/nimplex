import { attachQualificationExtension } from "./pi-extension-fixture.ts";
import { context, harnessFixture, hasMessage } from "./pi-harness-fixture.ts";
import { workspaceProbe } from "./pi-probe-extension.ts";

// Real process-death probe; the parent owns cleanup after SIGKILL.
const compatibility = process.argv[3] === "extension";
const fixture = await harnessFixture({ compatibility });
const role = process.argv[2] === "assistant" ? "assistant" : "toolResult";
process.send?.({ stage: "ready", directory: fixture.directory });
const opened = await fixture.open();
const witness = { restored: 0, effects: 0 };
if (compatibility)
  await attachQualificationExtension(fixture, opened, workspaceProbe(opened.bash, witness));
fixture.afterCommit = async (writes) => {
  if (!hasMessage(writes, role)) return;
  process.send?.({
    stage: "committed",
    effects: compatibility ? witness.effects : fixture.effects,
    requests: fixture.upstream.state.messagesCalls.length,
  });
  await new Promise<void>(() => {});
};
await opened.lane.prompt("Write once", undefined, context);
