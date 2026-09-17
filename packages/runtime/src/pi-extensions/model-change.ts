import { randomUUID } from "node:crypto";
import type { AgentLane } from "@earendil-works/pi-agent-core";
import type { Context } from "@earendil-works/pi-agent-core/harness/context";
import { type Session, value, type Write } from "@earendil-works/pi-agent-core/harness/session";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { type PiExtensionModelChange, piExtensionModelChange } from "@nimplex/contracts";

export const modelChangeAddress = (lane: string) =>
  value<PiExtensionModelChange>("nimplex.pi.extension.model-change", lane);

export function isPiEffectDispatch(writes: Write[]) {
  return writes.some((write) => {
    if (write.kind !== "value" || write.op !== "set" || write.namespace !== "pi.op.state")
      return false;
    const state = write.value as { at?: string; batch?: { calls?: { status: string }[] } };
    return (
      state.at === "assistant.effect_pending" ||
      state.at === "deferred.effect_pending" ||
      state.at === "summary.effect_pending" ||
      (state.at === "tools" && state.batch?.calls?.some((call) => call.status === "effect_pending"))
    );
  });
}

/** Public Pi setters are separate commits; this intent makes their combination recoverable. */
export class PiExtensionModelChanges {
  constructor(
    private readonly session: Session,
    private readonly lane: AgentLane,
    private readonly models: ModelRuntime,
    private readonly context: Context,
    private readonly assertAuthority: () => void,
  ) {}

  private async apply(change: PiExtensionModelChange) {
    this.assertAuthority();
    if (!this.models.getModel(change.model.provider, change.model.modelId))
      throw new Error("The accepted model change requires its pinned model catalog");
    await this.lane.setModel(change.model, this.context);
    this.assertAuthority();
    await this.lane.setThinkingLevel(change.thinkingLevel, this.context);
    this.assertAuthority();
    await this.session.setValue(
      modelChangeAddress(this.lane.name),
      { ...change, status: "applied" },
      this.context,
    );
  }

  async recover() {
    const stored = await this.session.getValue(modelChangeAddress(this.lane.name), this.context);
    if (!stored) return;
    const change = piExtensionModelChange.parse(stored.value);
    if (change.status === "accepted") await this.apply(change);
  }

  async set(model: Model<Api>, thinkingLevel: PiExtensionModelChange["thinkingLevel"]) {
    this.assertAuthority();
    if (!this.models.hasConfiguredAuth(model.provider)) return false;
    if (!(await this.models.checkAuth(model.provider)))
      throw new Error(`No configured auth for ${model.provider}`);
    if (!this.models.getModel(model.provider, model.id))
      throw new Error("Register the model in the host catalog before selecting it");
    const previous = await this.session.getValue(modelChangeAddress(this.lane.name), this.context);
    if (previous && piExtensionModelChange.parse(previous.value).status === "accepted")
      throw new Error("An accepted model change must be recovered first");
    const change = piExtensionModelChange.parse({
      version: 1,
      id: randomUUID(),
      status: "accepted",
      model: { provider: model.provider, modelId: model.id },
      thinkingLevel,
    });
    await this.session.setValue(modelChangeAddress(this.lane.name), change, this.context);
    await this.apply(change);
    return true;
  }

  /** Call in the enforced Storage path, not a swallowable Pi behavior hook. */
  async guardDispatch(writes: Write[]) {
    if (!isPiEffectDispatch(writes)) return;
    const stored = await this.session.getValue(modelChangeAddress(this.lane.name), this.context);
    if (stored && piExtensionModelChange.parse(stored.value).status === "accepted")
      throw new Error("Pending model change must be recovered before dispatch");
  }
}
