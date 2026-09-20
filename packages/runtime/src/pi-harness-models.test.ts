import type { Context, Model } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import type { ModelAttempt } from "@nimplex/contracts";
import { startFakeAnthropic } from "@nimplex/testkit";
import { afterEach, expect, it, vi } from "vitest";
import { durableModels } from "./pi-harness-models.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const context: Context = {
  systemPrompt: "test",
  messages: [{ role: "user", content: "hello", timestamp: 0 }],
};
async function fixture() {
  const upstream = await startFakeAnthropic(0, {});
  cleanup.push(upstream.close);
  const known = getBuiltinModels("anthropic").find((m) => m.id === "claude-haiku-4-5");
  if (!known) throw new Error("Missing pinned model");
  const model: Model<"anthropic-messages"> = { ...known, baseUrl: upstream.url };
  return { upstream, model };
}
const attempt = (): ModelAttempt => ({
  call_id: "11111111-1111-4111-8111-111111111111",
});

it("records dispatch intent and preserves Pi defaults and the caller's payload hook", async () => {
  const f = await fixture();
  const starts: number[] = [];
  const structural: unknown[] = [];
  const models = durableModels({
    model: f.model,
    credential: { apiKey: "fake-key", baseUrl: null },
    startModel: () => {
      starts.push(1);
      return attempt();
    },
    onDenied: () => {
      throw new Error("must not be denied");
    },
    onStructural: (r, message) => structural.push([r, message]),
  });
  expect(models.getModel("anthropic", "claude-haiku-4-5")).toBe(f.model);
  expect(models.getModel("anthropic", "other")).toBeUndefined();
  const stream = models.streamSimple(f.model, context, {
    onPayload: (payload) => ({ ...(payload as object), metadata: { user_id: "hook" } }),
  });
  const message = await stream.result();
  expect(message.stopReason).toBe("stop");
  expect(starts).toHaveLength(1);
  const sent = f.upstream.state.messagesCalls[0];
  expect(sent?.maxTokens).toBeGreaterThan(4096);
  expect(sent?.body.metadata).toEqual({ user_id: "hook" });
  expect(starts).toEqual([1]);
  expect(structural).toEqual([]);
  // A structural completion reports its attempt and response for host settlement.
  const summary = await models.completeSimple(f.model, context);
  expect(summary.stopReason).toBe("stop");
  expect(structural).toEqual([[attempt(), summary]]);
  expect(starts).toHaveLength(2);
});

it("keeps the provider output limit while recording dispatch intent", async () => {
  const f = await fixture();
  let started = 0;
  const models = durableModels({
    model: f.model,
    credential: { apiKey: "fake-key", baseUrl: null },
    startModel: () => {
      started++;
      return attempt();
    },
    onDenied: () => {},
    onStructural: () => {},
  });
  const message = await models.streamSimple(f.model, context, { maxTokens: 12000 }).result();
  expect(message.stopReason).toBe("stop");
  expect(started).toBe(1);
  // The fake reports Pi's original request limit.
  expect(f.upstream.state.messagesCalls[0]?.maxTokens).toBe(12000);
});

it("turns a failed intent commit into an error without any provider dispatch", async () => {
  const f = await fixture();
  const denied: unknown[] = [];
  const models = durableModels({
    model: f.model,
    credential: { apiKey: "fake-key", baseUrl: null },
    startModel: () => {
      throw new Error("intent commit failed");
    },
    onDenied: (error) => denied.push(error),
    onStructural: () => {
      throw new Error("must not settle a denied request");
    },
  });
  const message = await models.streamSimple(f.model, context).result();
  expect(message.stopReason).toBe("error");
  expect(message.errorMessage).toBe("intent commit failed");
  expect(message.usage.totalTokens).toBe(0);
  expect(denied).toHaveLength(1);
  expect(f.upstream.state.messagesCalls).toHaveLength(0);
});

it("fails closed for unadapted Models members and foreign models", async () => {
  const f = await fixture();
  const models = durableModels({
    model: f.model,
    credential: { apiKey: "fake-key", baseUrl: null },
    startModel: () => attempt(),
    onDenied: () => {},
    onStructural: () => {},
  });
  expect(() => models.streamDeferred(f.model, { id: "x" } as never)).toThrow(
    "no durable dispatch adapter",
  );
  expect(() => models.getProviders()).toThrow("no durable dispatch adapter");
  expect(() => models.streamSimple({ ...f.model, id: "claude-opus-5" }, context)).toThrow(
    "outside the turn's selection",
  );
  expect(f.upstream.state.messagesCalls).toHaveLength(0);
});

it("preserves OpenAI Responses reasoning and provider output defaults", async () => {
  const openai = getBuiltinModels("openai").find((m) => m.id === "gpt-5.4-mini");
  if (!openai) throw new Error("Missing pinned OpenAI model");
  const starts: number[] = [];
  const calls: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  const { zstdDecompressSync } = await import("node:zlib");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      calls.push({
        url: String(url),
        headers,
        body: JSON.parse(
          headers.get("content-encoding") === "zstd"
            ? zstdDecompressSync(init.body as Uint8Array).toString()
            : String(init.body),
        ),
      });
      const item = {
        type: "message",
        id: "msg_1",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "Done", annotations: [] }],
      };
      return new Response(
        [
          { type: "response.output_item.added", output_index: 0, item },
          { type: "response.output_item.done", output_index: 0, item },
          {
            type: "response.completed",
            response: {
              id: "resp_1",
              status: "completed",
              output: [item],
              usage: { input_tokens: 10, output_tokens: 2 },
            },
          },
        ]
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join(""),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    }),
  );
  cleanup.push(async () => {
    vi.unstubAllGlobals();
  });
  const models = durableModels({
    model: { ...openai, baseUrl: "https://openai.test/v1" },
    credential: { apiKey: "sk-openai-test", baseUrl: null },
    startModel: () => {
      starts.push(1);
      return attempt();
    },
    onDenied: () => {
      throw new Error("must not be denied");
    },
    onStructural: () => {},
  });
  const message = await models
    .streamSimple(openai, context, { reasoning: "medium", maxTokens: 8192 })
    .result();
  expect(message.stopReason).toBe("stop");
  expect(starts).toEqual([1]);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.url).toBe("https://openai.test/v1/responses");
  expect(calls[0]?.headers.get("authorization")).toBe("Bearer sk-openai-test");
  expect(calls[0]?.body.max_output_tokens).toBe(8192);
  expect(calls[0]?.body).not.toHaveProperty("max_tokens");
  expect(calls[0]?.body.reasoning).toMatchObject({ effort: "medium" });
});

it("preserves Anthropic high thinking without a monetary output cap", async () => {
  const f = await fixture();
  const models = durableModels({
    model: f.model,
    credential: { apiKey: "fake-key", baseUrl: null },
    startModel: () => attempt(),
    onDenied: () => {
      throw new Error("must not be denied");
    },
    onStructural: () => {},
  });
  const message = await models.streamSimple(f.model, context, { reasoning: "high" }).result();
  expect(message.stopReason).toBe("stop");
  const sent = f.upstream.state.messagesCalls[0];
  expect(sent?.maxTokens).toBeGreaterThan(16384);
  expect(sent?.body.thinking).toMatchObject({ type: "enabled", budget_tokens: 16384 });
});

it.each([false, true])(
  "awaits the intent commit before HTTP dispatch (cancel=%s)",
  async (cancel) => {
    const f = await fixture();
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    let commit!: (attempt: ModelAttempt) => void;
    const committed = new Promise<ModelAttempt>((resolve) => {
      commit = resolve;
    });
    const controller = new AbortController();
    const denied: unknown[] = [];
    const models = durableModels({
      model: f.model,
      credential: { apiKey: "fake-key", baseUrl: null },
      startModel: () => {
        enter();
        return committed;
      },
      onDenied: (error) => denied.push(error),
      onStructural: () => {},
    });
    const response = models.streamSimple(f.model, context, { signal: controller.signal }).result();
    await entered;
    expect(f.upstream.state.messagesCalls).toHaveLength(0);
    if (cancel) controller.abort(new Error("cancel during commit"));
    commit(attempt());
    const message = await response;
    expect(f.upstream.state.messagesCalls).toHaveLength(cancel ? 0 : 1);
    expect(denied).toHaveLength(cancel ? 1 : 0);
    expect(message.stopReason).toBe(cancel ? "aborted" : "stop");
  },
);
