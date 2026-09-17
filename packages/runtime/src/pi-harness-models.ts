import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  Models,
  ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { streamSimple as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { streamSimple as streamCodex } from "@earendil-works/pi-ai/api/openai-codex-responses";
import type { ModelReservation } from "@nimplex/contracts";

export interface BudgetedModelsOptions {
  model: Model<Api>;
  apiKey: string;
  /** API dispatch injects the budgeted output cap; subscription dispatch keeps the provider limit. */
  billing: "api" | "subscription";
  /** Commit a reservation before dispatch, or throw to deny the request. */
  reserve(inputTokenBound: number): ModelReservation;
  /** Observe a denied dispatch so the host can classify the terminal outcome. */
  onDenied(error: unknown): void;
  /** Pi stores structural (summary) usage without the response; the host settles it from here. */
  onStructural(reservation: ModelReservation, message: AssistantMessage): void;
}

/**
 * Enforced accounting boundary for the pinned AgentHarness. Its `before_request`
 * and `before_payload` hooks swallow rejections, so reservation lives inside the
 * Models port that every assistant and summary request must pass through. A denied
 * reservation surfaces as the provider-side error Pi settles without HTTP dispatch.
 * Deferred requests are not budgeted here and fail closed.
 */
export function budgetedModels(options: BudgetedModelsOptions): Models {
  const selected = options.model;
  const matches = (provider: string, id: string) =>
    provider === selected.provider && id === selected.id;
  const dispatch = (
    model: Model<Api>,
    context: Context,
    streamOptions: ModelsSimpleStreamOptions | undefined,
    onReserved: (reservation: ModelReservation) => void,
  ) => {
    if (!matches(model.provider, model.id))
      throw new Error("Harness dispatch requested a model outside the turn's selection");
    const shared = {
      ...streamOptions,
      apiKey: options.apiKey,
      // Hidden SDK retries and cache writes would spend outside the reservation;
      // Pi's durable retry policy owns retries and reserves each attempt.
      cacheRetention: "none" as const,
      maxRetries: 0,
      onPayload: async (payload: unknown, requestModel: Model<Api>) => {
        const next = (await streamOptions?.onPayload?.(payload, requestModel)) ?? payload;
        let reservation: ModelReservation;
        try {
          // Text-only messages and local tool schemas: one token per serialized UTF-8
          // byte, plus a framing allowance. Thinking and paid server tools are off.
          reservation = options.reserve(Buffer.byteLength(JSON.stringify(next), "utf8") + 4096);
        } catch (error) {
          options.onDenied(error);
          throw error;
        }
        onReserved(reservation);
        return options.billing === "subscription"
          ? next
          : { ...(next as object), max_tokens: reservation.max_output_tokens };
      },
    };
    if (selected.api === "anthropic-messages")
      return streamAnthropic(selected as Model<"anthropic-messages">, context, shared);
    if (selected.api === "openai-codex-responses")
      return streamCodex(selected as Model<"openai-codex-responses">, context, {
        ...shared,
        transport: "sse",
        reasoning: "low",
      });
    throw new Error(`Unsupported harness model API: ${selected.api}`);
  };
  const facade = {
    getModel(provider: string, id: string): Model<Api> | undefined {
      return matches(provider, id) ? selected : undefined;
    },
    streamSimple(model: Model<Api>, context: Context, streamOptions?: ModelsSimpleStreamOptions) {
      return dispatch(model, context, streamOptions, () => {});
    },
    async completeSimple(
      model: Model<Api>,
      context: Context,
      streamOptions?: ModelsSimpleStreamOptions,
    ) {
      let reserved: ModelReservation | undefined;
      const message = await dispatch(model, context, streamOptions, (reservation) => {
        reserved = reservation;
      }).result();
      if (reserved) options.onStructural(reserved, message);
      return message;
    },
  };
  return new Proxy(facade as unknown as Models, {
    get(target, property) {
      if (property in target) return Reflect.get(target, property, target);
      return () => {
        throw new Error(`Models.${String(property)} is not budgeted by the Pi harness engine`);
      };
    },
  });
}
