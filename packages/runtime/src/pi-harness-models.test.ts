import type { Context, Model } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import type { ModelReservation } from "@nimplex/contracts";
import { startFakeAnthropic } from "@nimplex/testkit";
import { afterEach, expect, it } from "vitest";
import { budgetedModels } from "./pi-harness-models.ts";

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
const reservation = (maxOutput: number): ModelReservation => ({
  call_id: "11111111-1111-4111-8111-111111111111",
  input_token_bound: 1,
  max_output_tokens: maxOutput,
  reserved_usd: 0.01,
});

it("reserves from the final payload, caps max_tokens and preserves the caller's payload hook", async () => {
  const f = await fixture();
  const bounds: number[] = [];
  const structural: unknown[] = [];
  const models = budgetedModels({
    model: f.model,
    apiKey: "fake-key",
    billing: "api",
    reserve: (bound) => {
      bounds.push(bound);
      return reservation(77);
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
  expect(bounds).toHaveLength(1);
  const sent = f.upstream.state.messagesCalls[0];
  expect(sent?.maxTokens).toBe(77);
  expect(sent?.body.metadata).toEqual({ user_id: "hook" });
  // The bound covers the payload the hook produced, not only the original request.
  expect(bounds[0]).toBeGreaterThan(Buffer.byteLength(JSON.stringify(sent?.body)) - 4096);
  expect(structural).toEqual([]);
  // A structural completion reports its reservation and response for host settlement.
  const summary = await models.completeSimple(f.model, context);
  expect(summary.stopReason).toBe("stop");
  expect(structural).toEqual([[reservation(77), summary]]);
  expect(bounds).toHaveLength(2);
});

it("keeps the provider output limit for subscription dispatch while still reserving", async () => {
  const f = await fixture();
  let reserved = 0;
  const models = budgetedModels({
    model: f.model,
    apiKey: "fake-key",
    billing: "subscription",
    reserve: () => {
      reserved++;
      return { ...reservation(9), reserved_usd: 0 };
    },
    onDenied: () => {},
    onStructural: () => {},
  });
  const message = await models.streamSimple(f.model, context).result();
  expect(message.stopReason).toBe("stop");
  expect(reserved).toBe(1);
  // No budgeted cap is injected; the fake reports the request's own limit.
  expect(f.upstream.state.messagesCalls[0]?.maxTokens).not.toBe(9);
});

it("turns a denied reservation into a settled error without any provider dispatch", async () => {
  const f = await fixture();
  const denied: unknown[] = [];
  const models = budgetedModels({
    model: f.model,
    apiKey: "fake-key",
    billing: "api",
    reserve: () => {
      throw new Error("budget_exceeded");
    },
    onDenied: (error) => denied.push(error),
    onStructural: () => {
      throw new Error("must not settle a denied request");
    },
  });
  const message = await models.streamSimple(f.model, context).result();
  expect(message.stopReason).toBe("error");
  expect(message.errorMessage).toBe("budget_exceeded");
  expect(message.usage.totalTokens).toBe(0);
  expect(denied).toHaveLength(1);
  expect(f.upstream.state.messagesCalls).toHaveLength(0);
});

it("fails closed for unbudgeted Models members and foreign models", async () => {
  const f = await fixture();
  const models = budgetedModels({
    model: f.model,
    apiKey: "fake-key",
    billing: "api",
    reserve: () => reservation(1),
    onDenied: () => {},
    onStructural: () => {},
  });
  expect(() => models.streamDeferred(f.model, { id: "x" } as never)).toThrow("not budgeted");
  expect(() => models.getProviders()).toThrow("not budgeted");
  expect(() => models.streamSimple({ ...f.model, id: "claude-opus-5" }, context)).toThrow(
    "outside the turn's selection",
  );
  expect(f.upstream.state.messagesCalls).toHaveLength(0);
});
