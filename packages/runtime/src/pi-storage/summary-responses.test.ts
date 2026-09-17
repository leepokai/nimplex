import { DatabaseSync } from "node:sqlite";
import type { HookHandler, HookInvocation, Hooks } from "@earendil-works/pi-agent-core";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/pi-agent-core/harness/context";
import {
  insertUsage,
  operationMeta,
  operationState,
  type SummaryEffectPendingOperation,
  setValue,
  value,
  type Write,
} from "@earendil-works/pi-agent-core/harness/session";
import type { AssistantMessage, ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { afterEach, expect, it, vi } from "vitest";
import { deferred } from "../testing/pi-composition-fixture.ts";
import { SqlitePiStorage } from "./sqlite.ts";
import { PiSummaryResponses, summaryResponseAddress } from "./summary-responses.ts";

const model = (() => {
  const model = getBuiltinModels("anthropic")[0];
  if (!model) throw new Error("Missing pinned model");
  return model;
})();
const selected = { provider: model.provider, modelId: model.id };
const usage = {
  input: 23,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 28,
  cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
};
const response: AssistantMessage = {
  role: "assistant",
  content: [{ type: "text", text: "Original summary" }],
  api: model.api,
  provider: model.provider,
  model: model.id,
  usage,
  stopReason: "stop",
  timestamp: 1,
};
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture() {
  const db = new DatabaseSync(":memory:");
  const source = new SqlitePiStorage(db, { tenantId: "tenant", sessionId: "session" }, () => {});
  let owns = true;
  const adapter = new PiSummaryResponses(source, context, () => {
    if (!owns) throw new Error("Stale owner");
  });
  let request: HookHandler<"before_request"> | undefined;
  const hooks: Hooks = {
    on(name, handler) {
      if (name === "before_request") request = handler as unknown as HookHandler<"before_request">;
      return () => {
        request = undefined;
      };
    },
  };
  const dispose = adapter.attach({ hooks, events: { on: () => () => {} } });
  const state: SummaryEffectPendingOperation = {
    at: "summary.effect_pending",
    control: { status: "running" },
    settings: {
      compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 10 },
      steeringMode: "all",
      followUpMode: "all",
      toolExecution: "sequential",
    },
    latestAssistantEntryId: null,
    task: { taskId: "task", reason: "manual", boundary: { kind: "finish" } },
    summaryContext: {
      configuration: { model: selected, thinkingLevel: "off", activeToolNames: [] },
      resultEntryId: "summary",
      streamOptions: {},
      retryPolicy: { maxAttempts: 1, baseDelayMs: 1 },
    },
    attempt: 1,
    request: { index: 0, usageId: "usage" },
    usageIds: [],
  };
  await source.commit(
    [
      setValue(operationState("operation"), state),
      setValue(operationMeta("operation"), {
        operationId: "operation",
        lane: "main",
        sourceTipId: null,
        startedAt: 0,
        intent: { kind: "compaction" },
      }),
    ],
    context,
  );
  cleanup.push(async () => {
    dispose();
    await adapter.storage.close(context);
    db.close();
  });
  async function options(overrides: Partial<HookInvocation<"before_request">> = {}) {
    if (!request) throw new Error("Missing before_request handler");
    const result = await request(
      {
        runId: "operation",
        lane: "main",
        model,
        step: "compaction",
        attempt: 1,
        streamOptions: {},
        ...overrides,
      },
      context,
    );
    return { metadata: result?.streamOptions?.metadata } as ModelsSimpleStreamOptions;
  }
  const settle = (): Write[] => [
    insertUsage({ id: "usage", usage: structuredClone(usage), adjustment: false }),
    setValue(operationState("operation"), { ...state, request: undefined, usageIds: ["usage"] }),
  ];
  async function capture() {
    const binding = await adapter.boundary.begin(model, await options());
    binding.capture(response, response);
    return binding;
  }
  async function unchanged(journal: Awaited<ReturnType<typeof source.readCommits>>) {
    expect(await source.readCommits()).toEqual(journal);
    expect(await source.scanUsage({}, context)).toEqual([]);
    expect(await adapter.read(context)).toEqual([]);
    expect((await source.getValue(operationState("operation"), context))?.value).toEqual(state);
  }
  return {
    db,
    source,
    adapter,
    state,
    options,
    settle,
    capture,
    unchanged,
    lose: () => {
      owns = false;
    },
  };
}

it.each(["lane", "attempt", "kind", "model"] as const)(
  "rejects mismatched %s before dispatch",
  async (field) => {
    const f = await fixture();
    const options = await f.options(
      field === "lane"
        ? { lane: "other" }
        : field === "attempt"
          ? { attempt: 2 }
          : field === "kind"
            ? { step: "branch_summary" }
            : {},
    );
    const before = await f.source.readCommits();
    await expect(
      f.adapter.boundary.begin(field === "model" ? { ...model, id: "other" } : model, options),
    ).rejects.toThrow("does not match its committed intent");
    await f.unchanged(before);
  },
);

it("rejects stale ownership and a reused binding without changing durable state", async () => {
  const f = await fixture(),
    options = await f.options();
  const before = await f.source.readCommits();
  f.lose();
  await expect(f.adapter.boundary.begin(model, options)).rejects.toThrow("Stale owner");
  await expect(f.adapter.boundary.begin(model, options)).rejects.toThrow(
    "missing its host binding",
  );
  await f.unchanged(before);
});

it("admits only one concurrent request for the same committed usage identity", async () => {
  const f = await fixture(),
    reached = deferred(),
    bothRead = deferred(),
    release = deferred();
  let reads = 0;
  const read = f.source.getValue.bind(f.source);
  vi.spyOn(f.source, "getValue").mockImplementation(async (address, ctx) => {
    const result = await read(address, ctx);
    if (address.namespace === summaryResponseAddress("").namespace) {
      if (++reads === 2) bothRead.resolve();
      reached.resolve();
      await release.promise;
    }
    return result;
  });
  const first = f.adapter.boundary.begin(model, await f.options());
  await reached.promise;
  const second = f.adapter.boundary.begin(model, await f.options());
  await bothRead.promise;
  release.resolve();
  const outcomes = await Promise.allSettled([first, second]);
  expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
  const rejected = outcomes.find((outcome) => outcome.status === "rejected");
  expect(rejected?.reason).toMatchObject({ message: "Summary request identity was already used" });
});

it.each([
  "missing response",
  "usage mismatch",
  "missing transition",
  "wrong attempt",
  "wrong task",
  "retained request",
  "lost usage",
  "duplicate transition",
] as const)("rolls back settlement with %s", async (fault) => {
  const f = await fixture();
  if (fault !== "missing response") await f.capture();
  const writes = f.settle();
  if (fault === "usage mismatch" && writes[0]?.kind === "usage") writes[0].row.usage.input++;
  if (fault === "missing transition") writes.pop();
  const next = writes[1];
  if (next?.kind === "value" && next.op === "set") {
    const state = next.value as SummaryEffectPendingOperation;
    if (fault === "wrong attempt") state.attempt++;
    if (fault === "wrong task") state.task = { ...state.task, taskId: "different" };
    if (fault === "retained request") state.request = f.state.request;
    if (fault === "lost usage") state.usageIds = [];
    if (fault === "duplicate transition") writes.push(structuredClone(next));
  }
  const before = await f.source.readCommits();
  await expect(f.adapter.storage.commit(writes, context)).rejects.toThrow(
    fault === "missing response"
      ? "no matching captured response"
      : fault === "usage mismatch"
        ? "does not match its original response"
        : fault === "missing transition"
          ? "missing its native settlement transition"
          : "invalid native settlement transition",
  );
  await f.unchanged(before);
});

it("freezes captured responses and isolates records by tenant and session", async () => {
  const f = await fixture();
  const original = structuredClone(response);
  const binding = await f.adapter.boundary.begin(model, await f.options());
  binding.capture(original, original);
  original.content = [{ type: "text", text: "too late" }];
  await f.adapter.storage.commit(f.settle(), context);
  expect((await f.adapter.read(context))[0]?.response).toEqual(response);
  for (const scope of [
    { tenantId: "other", sessionId: "session" },
    { tenantId: "tenant", sessionId: "other" },
  ]) {
    const source = new SqlitePiStorage(f.db, scope, () => {});
    const other = new PiSummaryResponses(source, context, () => {});
    try {
      expect(await other.read(context)).toEqual([]);
      expect(await source.scanUsage({}, context)).toEqual([]);
      await expect(other.boundary.begin(model, await f.options())).rejects.toThrow(
        "missing its host binding",
      );
    } finally {
      await other.storage.close(context);
    }
  }
});

it("rejects a second capture even after the first response has committed", async () => {
  const f = await fixture(),
    binding = await f.capture();
  expect(() => binding.capture(response, response)).toThrow("captured twice");
  await f.adapter.storage.commit(f.settle(), context);
  const before = await f.source.readCommits();
  expect(() => binding.capture(response, response)).toThrow("captured twice");
  expect(await f.source.readCommits()).toEqual(before);
  expect(await f.adapter.read(context)).toHaveLength(1);
});

it("rejects non-finite response usage instead of recording a fabricated null", async () => {
  const f = await fixture();
  const binding = await f.adapter.boundary.begin(model, await f.options());
  const invalid = { ...response, usage: { ...response.usage, input: Number.NaN } };
  const before = await f.source.readCommits();
  expect(() => binding.capture(invalid, invalid)).toThrow("finite JSON");
  await expect(f.adapter.storage.commit(f.settle(), context)).rejects.toThrow(
    "no matching captured response",
  );
  await f.unchanged(before);
});

it("rejects redispatch of a committed response even if an old request intent reappears", async () => {
  const f = await fixture();
  await f.capture();
  await f.adapter.storage.commit(f.settle(), context);
  await f.source.commit([setValue(operationState("operation"), f.state)], context);
  const before = await f.source.readCommits();
  await expect(f.adapter.boundary.begin(model, await f.options())).rejects.toThrow(
    "identity was already used",
  );
  expect(await f.source.readCommits()).toEqual(before);
  expect(await f.source.scanUsage({}, context)).toHaveLength(1);
  expect(await f.adapter.read(context)).toHaveLength(1);
});

it("drains admitted writes on close and rejects later captures and commits", async () => {
  const f = await fixture(),
    binding = await f.capture();
  const pending = f.adapter.storage.commit(f.settle(), context);
  const closing = f.adapter.storage.close(context);
  expect(f.adapter.storage.close(context)).toBe(closing);
  expect(() => binding.capture(response, response)).toThrow("closed");
  expect(() => f.adapter.storage.commit([setValue(value("late"), true)], context)).toThrow(
    "closed",
  );
  await pending;
  await closing;
  const reopened = new SqlitePiStorage(
    f.db,
    { tenantId: "tenant", sessionId: "session" },
    () => {},
  );
  try {
    expect(
      (await reopened.getValue(summaryResponseAddress("usage"), context))?.value.response,
    ).toEqual(response);
    expect(await reopened.scanUsage({}, context)).toHaveLength(1);
  } finally {
    await reopened.close(context);
  }
});
