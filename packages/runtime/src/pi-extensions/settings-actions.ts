import type { AgentHarness, AgentLane, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Context } from "@earendil-works/pi-agent-core/harness/context";
import type { Api, Model } from "@earendil-works/pi-ai";
import { clampThinkingLevel } from "@earendil-works/pi-ai/compat";
import type {
  ExtensionActions,
  ExtensionRunner,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { PiExtensionModelChanges } from "./model-change.ts";
import type { PiExtensionMutations } from "./mutations.ts";
import type { PiSessionView } from "./session-view.ts";

interface Options {
  harness: AgentHarness;
  lane: AgentLane;
  runner: ExtensionRunner;
  settings: Pick<SettingsManager, "getDefaultThinkingLevel" | "getModelThinkingLevel">;
  modelChanges: PiExtensionModelChanges;
  mutations: PiExtensionMutations;
  view: PiSessionView;
  refreshView: () => Promise<void>;
  assertAuthority: () => void;
  context: Context;
}
type Actions = Pick<
  ExtensionActions,
  | "setSessionName"
  | "getSessionName"
  | "setLabel"
  | "getAllTools"
  | "getActiveTools"
  | "setActiveTools"
  | "setThinkingLevel"
  | "getThinkingLevel"
  | "setModel"
>;

/** Legacy synchronous setters expose staged values; controlled effects must await mutations.flush(). */
export class PiExtensionSettingsActions {
  readonly actions: Actions;
  private model?: Model<Api>;
  private thinking: ThinkingLevel = "off";
  private tools: string[] = [];
  private name?: string;
  private nextThinkingIntent = 0;
  private projectedThinkingIntent = 0;

  private constructor(private readonly options: Options) {
    const { mutations, lane, harness, context, runner } = options;
    const admit = () => {
      mutations.assertHealthy();
      options.assertAuthority();
    };
    const notify = (committed: Promise<unknown>, event: Parameters<ExtensionRunner["emit"]>[0]) => {
      void mutations.track(
        committed.then(async () => {
          await options.refreshView();
          await runner.emit(event);
        }),
      );
    };
    this.actions = {
      getSessionName: () => {
        mutations.assertReadable();
        return this.name;
      },
      setSessionName: (name) => {
        admit();
        const normalized = name.replace(/[\r\n]+/g, " ").trim();
        this.name = normalized || undefined;
        notify(
          mutations.stage(() => harness.setName(normalized, context)),
          { type: "session_info_changed", name: this.name },
        );
      },
      setLabel: (entryId, label) => {
        admit();
        if (!options.view.manager.getEntry(entryId)) throw new Error(`Entry ${entryId} not found`);
        void mutations.track(
          mutations
            .stage(() => harness.setLabel(entryId, label, context))
            .then(options.refreshView),
        );
      },
      getAllTools: () => {
        mutations.assertReadable();
        return structuredClone(
          runner.getAllRegisteredTools().map(({ definition, sourceInfo }) => ({
            name: definition.name,
            description: definition.description,
            parameters: definition.parameters,
            promptGuidelines: definition.promptGuidelines,
            sourceInfo,
          })),
        );
      },
      getActiveTools: () => {
        mutations.assertReadable();
        return [...this.tools];
      },
      setActiveTools: (names) => {
        admit();
        const known = new Set(runner.getAllRegisteredTools().map((tool) => tool.definition.name));
        const selected = names.filter((name) => known.has(name));
        this.tools = selected;
        void mutations.stage(() => lane.setActiveTools(selected, context));
      },
      getThinkingLevel: () => {
        mutations.assertReadable();
        return this.thinking;
      },
      setThinkingLevel: (level) => {
        admit();
        const effective = this.model ? clampThinkingLevel(this.model, level) : "off";
        const previousLevel = this.thinking;
        if (previousLevel === effective) return;
        this.projectedThinkingIntent = ++this.nextThinkingIntent;
        this.thinking = effective;
        notify(
          mutations.stage(() => lane.setThinkingLevel(effective, context)),
          { type: "thinking_level_select", level: effective, previousLevel },
        );
      },
      setModel: (model) => {
        admit();
        const frozen = structuredClone(model) as Model<Api>;
        const intent = ++this.nextThinkingIntent;
        const committed = mutations.stage(async () => {
          const previousModel = await lane.getModel(context);
          const previousThinking = await lane.getThinkingLevel(context);
          const requested =
            options.settings.getModelThinkingLevel(frozen.provider, frozen.id) ??
            options.settings.getDefaultThinkingLevel() ??
            this.thinking;
          const thinking = clampThinkingLevel(frozen, requested);
          const applied = await options.modelChanges.set(frozen, thinking);
          if (applied) {
            this.model = frozen;
            if (intent >= this.projectedThinkingIntent) {
              this.thinking = thinking;
              this.projectedThinkingIntent = intent;
            }
          }
          return { applied, previousModel, previousThinking, thinking };
        });
        return mutations.track(
          committed.then(async ({ applied, previousModel, previousThinking, thinking }) => {
            if (!applied) return false;
            await options.refreshView();
            if (thinking !== previousThinking)
              await runner.emit({
                type: "thinking_level_select",
                level: thinking,
                previousLevel: previousThinking,
              });
            if (previousModel?.provider !== frozen.provider || previousModel.id !== frozen.id)
              await runner.emit({
                type: "model_select",
                model: frozen,
                previousModel,
                source: "set",
              });
            return true;
          }),
        );
      },
    };
  }

  static async create(options: Options) {
    const actions = new PiExtensionSettingsActions(options);
    await options.mutations.stage(() => options.modelChanges.recover());
    await actions.refresh();
    await options.refreshView();
    return actions;
  }

  getModel() {
    this.options.mutations.assertReadable();
    return this.model ? structuredClone(this.model) : undefined;
  }

  /** Host calls at a drained boundary after changing settings through other public APIs. */
  async refresh() {
    const { lane, harness, context } = this.options;
    const [model, thinking, tools, name] = await Promise.all([
      lane.getModel(context),
      lane.getThinkingLevel(context),
      lane.getActiveTools(context),
      harness.getName(context),
    ]);
    this.model = model;
    this.thinking = thinking;
    this.tools = [...tools];
    this.name = name?.replace(/[\r\n]+/g, " ").trim() || undefined;
  }
}
