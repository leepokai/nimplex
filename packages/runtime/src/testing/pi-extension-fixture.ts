import { join } from "node:path";
import type { JsonValue } from "@earendil-works/pi-agent-core/harness/session";
import {
  DefaultResourceLoader,
  type ExtensionFactory,
  ExtensionRunner,
  ModelRegistry,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { attachPiCompaction } from "../pi-extensions/compaction.ts";
import { isPiEffectDispatch, PiExtensionModelChanges } from "../pi-extensions/model-change.ts";
import { PiExtensionMutations } from "../pi-extensions/mutations.ts";
import { PiSessionView } from "../pi-extensions/session-view.ts";
import { PiExtensionSettingsActions } from "../pi-extensions/settings-actions.ts";
import { extensionTools } from "../pi-extensions/tools.ts";
import { context, type harnessFixture } from "./pi-harness-fixture.ts";

/** Bounded qualification of registered tools, custom state and transformations. */
export async function attachQualificationExtension(
  fixture: Awaited<ReturnType<typeof harnessFixture>>,
  opened: Awaited<ReturnType<Awaited<ReturnType<typeof harnessFixture>>["open"]>>,
  factory: ExtensionFactory,
  options: { settings?: SettingsManager } = {},
) {
  const settings = options.settings ?? SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    cwd: fixture.directory,
    agentDir: join(fixture.directory, "extension-fixture"),
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [factory],
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  if (loaded.errors.length) throw new Error(JSON.stringify(loaded.errors));
  if (!opened.compatibility) throw new Error("Extension fixture requires the compatibility store");
  const compatibility = opened.compatibility;
  const view = new PiSessionView(await compatibility.snapshot("main", context));
  const mutations = new PiExtensionMutations();
  const modelChanges = new PiExtensionModelChanges(
    opened.session,
    opened.lane,
    fixture.models,
    context,
    fixture.assertAuthority,
  );
  const runner = new ExtensionRunner(
    loaded.extensions,
    loaded.runtime,
    "/workspace",
    view.manager,
    new ModelRegistry(fixture.models),
  );
  const errors: string[] = [];
  runner.onError((error) => errors.push(error.error));
  const previousCommit = fixture.beforeCommit;
  // These checks belong in Storage: Pi behavior hooks can swallow failures.
  fixture.beforeCommit = async (writes) => {
    if (isPiEffectDispatch(writes)) mutations.assertHealthy();
    else mutations.assertCommitHealthy();
    await modelChanges.guardDispatch(writes);
    await previousCommit?.(writes);
  };
  async function refreshView() {
    view.replace(await compatibility.snapshot("main", context));
  }
  const settingActions = await PiExtensionSettingsActions.create({
    harness: opened.harness,
    lane: opened.lane,
    runner,
    settings,
    modelChanges,
    mutations,
    view,
    refreshView,
    assertAuthority: fixture.assertAuthority,
    context,
  });
  async function refresh() {
    await settingActions.refresh();
    await refreshView();
  }
  runner.bindCore(
    {
      ...loaded.runtime,
      ...settingActions.actions,
      // Unused actions retain Pi's explicit unbound-action errors in this fixture.
      appendEntry: (customType, data) => {
        const frozen =
          data === undefined ? undefined : (JSON.parse(JSON.stringify(data)) as JsonValue);
        void mutations.stage(async () => {
          await opened.lane.appendCustomEntry(customType, frozen, context);
        });
      },
    },
    {
      getModel: () => settingActions.getModel(),
      getScopedModels: () => [],
      isIdle: () => true,
      isProjectTrusted: () => true,
      getSignal: () => undefined,
      abort: () => {
        throw new Error("Abort is outside this fixture's qualification scope");
      },
      hasPendingMessages: () => false,
      shutdown: () => {
        throw new Error("Shutdown is outside this fixture's qualification scope");
      },
      getContextUsage: () => undefined,
      compact: () => {
        throw new Error("Compaction is outside this fixture's qualification scope");
      },
      getSystemPrompt: () => "",
    },
  );
  const compaction = attachPiCompaction({
    harness: opened.harness,
    lane: opened.lane,
    laneName: "main",
    runner,
    mutations,
    view,
    refresh,
    assertAuthority: fixture.assertAuthority,
  });
  const disposers = [
    compaction.dispose,
    opened.harness.hooks.on("after_response", async ({ message }) => {
      await refresh();
      const replacement = await runner.emitMessageEnd({ type: "message_end", message });
      await mutations.flush();
      if (!replacement) return undefined;
      if (replacement.role !== "assistant" || replacement.stopReason === "pending")
        throw new Error("Invalid finalized assistant replacement");
      return { message: { ...replacement, stopReason: replacement.stopReason } };
    }),
    opened.harness.hooks.on("before_tool", async (event) => {
      await refresh();
      const input = structuredClone(event.args);
      const result = await runner.emitToolCall({
        type: "tool_call",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input,
      });
      await mutations.flush();
      return {
        args: input,
        ...(result?.block
          ? {
              block: {
                reason: result.reason ?? "Blocked by extension",
                terminate: result.terminate,
              },
            }
          : {}),
      };
    }),
    opened.harness.hooks.on("after_tool", async (event) => {
      await refresh();
      const result = await runner.emitToolResult({
        type: "tool_result",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: event.args,
        content: event.content,
        details: event.details,
        isError: event.isError,
      });
      await mutations.flush();
      return result
        ? {
            ...result,
            details:
              result.details === undefined
                ? undefined
                : (JSON.parse(JSON.stringify(result.details)) as JsonValue),
          }
        : undefined;
    }),
  ];
  await opened.harness.setTools(
    extensionTools(runner, mutations, fixture.assertAuthority),
    context,
  );
  await opened.lane.setActiveTools(
    (await opened.lane.getActiveTools(context)).filter((name) =>
      runner.getAllRegisteredTools().some((t) => t.definition.name === name),
    ),
    context,
  );
  await refresh();
  await runner.emit({ type: "session_start", reason: "startup" });
  await mutations.flush();
  let closing: Promise<void> | undefined;
  return {
    runner,
    mutations,
    view,
    errors,
    refresh,
    settingActions,
    modelChanges,
    compaction,
    close() {
      closing ??= (async () => {
        for (const dispose of disposers) dispose();
        try {
          await mutations.close();
        } finally {
          fixture.beforeCommit = previousCommit;
          view.invalidate();
          runner.invalidate();
        }
      })();
      return closing;
    },
  };
}
