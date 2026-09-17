import type {
  Api,
  AssistantMessage,
  Model,
  Models,
  ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";

export interface PiSummaryBoundary {
  begin(
    model: Model<Api>,
    options: ModelsSimpleStreamOptions | undefined,
  ): Promise<{
    options: ModelsSimpleStreamOptions | undefined;
    capture(original: AssistantMessage, delivered: AssistantMessage): void;
  }>;
}

function validateSummary(response: AssistantMessage): AssistantMessage {
  // Provider failures and cancellation retain their original outcome and retry semantics.
  if (response.stopReason === "error" || response.stopReason === "aborted") return response;
  const reason =
    response.stopReason === "length"
      ? "generation hit the token cap and the summary is incomplete"
      : response.content.some((block) => block.type === "toolCall")
        ? "the summary attempted to call a tool"
        : undefined;
  if (!reason) return response;
  // Return a failed response instead of throwing: Pi must still settle this
  // completed request's usage before publishing the failed structural operation.
  return { ...response, stopReason: "error", errorMessage: `Summary rejected: ${reason}` };
}

/**
 * Pinned AgentHarness 0.85.1 uses completeSimple only for structural summaries;
 * ordinary turns use streamSimple/streamDeferred. Preserve legacy Pi's summary
 * validation through this public Models facade, without altering those turns.
 * Requalify this dispatch distinction when upgrading Pi.
 */
export function piSummaryModels(source: Models, boundary?: PiSummaryBoundary): Models {
  const completeSimple: Models["completeSimple"] = async (model, context, options) => {
    const binding = await boundary?.begin(model, options);
    const original = await source.completeSimple(
      model,
      context,
      binding ? binding.options : options,
    );
    const delivered = validateSummary(original);
    binding?.capture(original, delivered);
    return delivered;
  };
  return new Proxy(source, {
    get(target, property) {
      if (property === "completeSimple") return completeSimple;
      const member = Reflect.get(target, property, target);
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
}
