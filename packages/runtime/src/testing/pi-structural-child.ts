import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { type ExtensionAPI, SettingsManager } from "@earendil-works/pi-coding-agent";
import { attachQualificationExtension } from "./pi-extension-fixture.ts";
import { context, getOrThrow, harnessFixture } from "./pi-harness-fixture.ts";
import { workspaceProbe } from "./pi-probe-extension.ts";

const kind = process.argv[2];
if (
  kind !== "compaction" &&
  kind !== "extension_compaction" &&
  kind !== "compaction_usage" &&
  kind !== "navigation_usage" &&
  kind !== "branch_summary" &&
  kind !== "metadata" &&
  kind !== "model_change"
)
  throw new Error("Unknown boundary");
const failedSummary = kind === "compaction_usage" || kind === "navigation_usage";
const fixture = await harnessFixture({
  compatibility: true,
  ...(failedSummary
    ? { upstream: { script: [], stopReasons: ["max_tokens"], inputTokens: 23, outputTokens: 5 } }
    : {}),
});
process.send?.({ stage: "ready", directory: fixture.directory });
const opened = await fixture.open();
const witness = { restored: 0, effects: 0 };
let api: ExtensionAPI | undefined;
const settings = SettingsManager.inMemory();
settings.setDefaultThinkingLevel("high");
await attachQualificationExtension(
  fixture,
  opened,
  (pi) => {
    api = pi;
    workspaceProbe(opened.bash, witness)(pi);
    if (kind === "extension_compaction")
      pi.on("session_before_compact", (event) => {
        pi.appendEntry("compaction-hook-state", { checkpoint: 1 });
        return {
          compaction: {
            summary: "Committed structural summary",
            firstKeptEntryId: event.preparation.firstKeptEntryId,
            tokensBefore: event.preparation.tokensBefore,
            details: { fixture: true },
          },
        };
      });
  },
  { settings },
);
if (failedSummary) {
  for (const [index, content] of ["First ".repeat(100), "Second ".repeat(100), "Recent"].entries())
    await opened.lane.appendMessage({ role: "user", content, timestamp: index + 1 }, context);
} else getOrThrow(await opened.lane.prompt("Write once", undefined, context));
const metadataTip = await opened.lane.getTipId(context);
const metadataModel = getBuiltinModels("anthropic").find(
  (m) => m.reasoning && m.id !== fixture.model.id,
);
if (!metadataModel) throw new Error("Missing alternate fixture model");
if (!failedSummary)
  opened.harness.hooks.on("before_compaction", ({ preparation }) => ({
    compaction: {
      summary: "Committed structural summary",
      retainedTail: [{ role: "user", content: "Retained replacement", timestamp: 10 }],
      tokensBefore: preparation.tokensBefore,
      details: { fixture: true },
    },
  }));
if (!failedSummary)
  opened.harness.hooks.on("before_navigation", () => ({
    summary: {
      summary: "Committed structural summary",
      readFiles: [],
      modifiedFiles: ["/workspace/probe.txt"],
    },
  }));
fixture.afterCommit = async (writes) => {
  const entry = writes.find(
    (w) =>
      w.kind === "entry" &&
      w.entry.type === (kind === "extension_compaction" ? "compaction" : kind),
  );
  const metadata =
    kind === "metadata" &&
    writes.some((w) => w.kind === "value" && w.namespace === "pi.entry.label");
  const modelChange =
    kind === "model_change" &&
    writes.some((w) => w.kind === "value" && w.namespace === "pi.lane.config");
  const summaryUsage = failedSummary && writes.some((w) => w.kind === "usage");
  if (entry?.kind !== "entry" && !metadata && !modelChange && !summaryUsage) return;
  process.send?.({
    stage: "committed",
    entryId: entry?.kind === "entry" ? entry.entry.id : metadataTip,
    model: { provider: metadataModel.provider, modelId: metadataModel.id },
    effects: witness.effects,
    requests: fixture.upstream.state.messagesCalls.length,
  });
  await new Promise<void>(() => {});
};
if (kind === "compaction" || kind === "extension_compaction" || kind === "compaction_usage")
  await opened.lane.compact(undefined, context);
else if (kind === "model_change") {
  if (!api) throw new Error("Missing extension API");
  await api.setModel(metadataModel);
} else if (kind === "metadata") {
  await opened.lane.setModel(
    { provider: metadataModel.provider, modelId: metadataModel.id },
    context,
  );
  await opened.lane.setThinkingLevel("high", context);
  await opened.harness.setName("Restored metadata", context);
  if (!metadataTip) throw new Error("Missing metadata target");
  await opened.harness.setLabel(metadataTip, "checkpoint", context);
} else {
  const target = (await opened.session.findEntries({ order: "asc" }, context)).find(
    (e) => e.type === "message",
  );
  if (!target) throw new Error("Missing branch target");
  await opened.lane.navigateTree(target.id, { summarize: true }, context);
}
throw new Error(`Operation finished without reaching the ${kind} commit boundary`);
