import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  Models,
  ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ModelAttempt } from "@nimplex/contracts";
import type { ExecutorRunContext } from "@nimplex/core";

const providers = new Map(builtinProviders().map((provider) => [provider.id, provider]));

export interface DurableModelsOptions {
  model: Model<Api>;
  credential: ExecutorRunContext["credential"];
  /** A failed intent commit must prevent dispatch, including summary requests. */
  startModel(): ModelAttempt | Promise<ModelAttempt>;
  onDenied(error: unknown): void;
  /** Pi stores structural usage separately; retain the response for atomic settlement. */
  onStructural(attempt: ModelAttempt, message: AssistantMessage): void;
}

/**
 * Pi owns provider behavior and output/thinking defaults. The host owns the awaited
 * dispatch intent: harness event observers alone are not a durable commit barrier.
 */
export function durableModels(options: DurableModelsOptions): Models {
  const selected = options.model;
  const matches = (provider: string, id: string) =>
    provider === selected.provider && id === selected.id;
  const dispatch = (
    model: Model<Api>,
    context: Context,
    streamOptions: ModelsSimpleStreamOptions | undefined,
    onStarted: (attempt: ModelAttempt) => void,
  ) => {
    if (!matches(model.provider, model.id))
      throw new Error("Harness dispatch requested a model outside the turn's selection");
    const provider = providers.get(selected.provider);
    if (!provider) throw new Error(`Unsupported Pi provider: ${selected.provider}`);
    return provider.streamSimple(selected, context, {
      ...streamOptions,
      apiKey: options.credential.apiKey,
      headers: {
        ...provider.headers,
        ...selected.headers,
        ...options.credential.headers,
        ...streamOptions?.headers,
      },
      env: options.credential.env,
      // Every retry must pass through the durable Pi operation and receive its own ID.
      maxRetries: 0,
      cacheRetention: "none",
      ...(selected.api === "openai-codex-responses"
        ? { transport: "sse", reasoning: streamOptions?.reasoning ?? "low" }
        : {}),
      onPayload: async (payload, requestModel) => {
        const next = (await streamOptions?.onPayload?.(payload, requestModel)) ?? payload;
        try {
          streamOptions?.signal?.throwIfAborted();
          onStarted(await options.startModel());
          streamOptions?.signal?.throwIfAborted();
        } catch (error) {
          options.onDenied(error);
          throw error;
        }
        return next;
      },
    });
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
      let attempt: ModelAttempt | undefined;
      const message = await dispatch(model, context, streamOptions, (started) => {
        attempt = started;
      }).result();
      if (attempt) options.onStructural(attempt, message);
      return message;
    },
  };
  return new Proxy(facade as unknown as Models, {
    get(target, property) {
      if (property in target) return Reflect.get(target, property, target);
      return () => {
        throw new Error(`Models.${String(property)} has no durable dispatch adapter`);
      };
    },
  });
}
