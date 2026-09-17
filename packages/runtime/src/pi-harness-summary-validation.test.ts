import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { FakeAnthropicOptions } from "@nimplex/testkit";
import { afterEach, expect, it, vi } from "vitest";
import { piSummaryModels } from "./pi-summary-models.ts";
import { compositionFixture, deferred } from "./testing/pi-composition-fixture.ts";
import { context, getOrThrow, harnessFixture } from "./testing/pi-harness-fixture.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const messages = ["First ".repeat(100), "Second ".repeat(100), "Recent"].map((content, index) => ({
  role: "user" as const,
  content,
  timestamp: index + 1,
}));
const cases = ["compaction", "navigation"] as const;
type Kind = (typeof cases)[number];
const upstream = (invalid: "length" | "tool"): FakeAnthropicOptions => ({
  script:
    invalid === "tool"
      ? [{ name: "probe", input: { path: "/workspace/probe.txt", content: "must not execute" } }]
      : [],
  stopReasons: invalid === "length" ? ["max_tokens"] : undefined,
  inputTokens: 23,
  outputTokens: 5,
});
async function fixture(options: Parameters<typeof harnessFixture>[0]) {
  const f = await harnessFixture({ compatibility: true, ...options });
  cleanup.push(f.close);
  const opened = await f.open();
  const targets: string[] = [];
  for (const message of messages) targets.push(await opened.lane.appendMessage(message, context));
  const target = targets[0];
  if (!target) throw new Error("Missing summary target");
  const run = async (kind: Kind) =>
    kind === "compaction"
      ? getOrThrow(await opened.lane.compact(undefined, context)).compaction
      : getOrThrow(await opened.lane.navigateTree(target, { summarize: true }, context)).navigation;
  return { f, opened, run };
}

it.each(cases)("records that unguarded pinned %s accepts a truncated response", async (kind) => {
  const { f, opened, run } = await fixture({
    upstream: upstream("length"),
    rawSummaryModels: true,
  });
  expect((await run(kind)).status).toBe("completed");
  expect(
    (await opened.session.findEntries(undefined, context)).filter(
      (entry) => entry.type === "compaction" || entry.type === "branch_summary",
    ),
  ).toHaveLength(1);
  expect(f.upstream.state.messagesCalls).toHaveLength(1);
});

it.each(
  cases.flatMap((kind) => (["length", "tool"] as const).map((invalid) => ({ kind, invalid }))),
)(
  "matches baseline rejection of $invalid in $kind while settling usage",
  async ({ kind, invalid }) => {
    const baseline = await compositionFixture(undefined, upstream(invalid));
    cleanup.push(baseline.close);
    const ids = messages.map((message) => baseline.session.sessionManager.appendMessage(message));
    const target = ids[0];
    if (!target) throw new Error("Missing baseline target");
    const baselineBefore = baseline.session.sessionManager.getEntries();
    await expect(
      kind === "compaction"
        ? baseline.session.compact()
        : baseline.session.navigateTree(target, { summarize: true }),
    ).rejects.toThrow(invalid === "length" ? "token cap" : "tool");
    expect(baseline.session.sessionManager.getEntries()).toEqual(baselineBefore);
    expect(baseline.effects).toBe(0);
    const { f, opened, run } = await fixture({ upstream: upstream(invalid) });
    await opened.harness.setRetryPolicy({ enabled: true, maxRetries: 2, baseDelayMs: 1 }, context);
    const before = await opened.compatibility?.snapshot("main", context);
    const result = await run(kind);
    expect(result).toMatchObject({
      status: "failed",
      error: {
        code: "summarization_failed",
        message: expect.stringContaining(invalid === "length" ? "token cap" : "tool"),
      },
    });
    expect(await opened.compatibility?.snapshot("main", context)).toEqual(before);
    const usage = await opened.storage.scanUsage({}, context);
    expect(usage).toHaveLength(1);
    expect(usage[0]?.usage).toMatchObject({ input: 23, output: 5, totalTokens: 28 });
    expect((await opened.storage.getStats(context)).usage).toEqual(usage[0]?.usage);
    expect(f.upstream.state.messagesCalls).toHaveLength(1);
    expect(f.effects).toBe(0);
    await opened.harness.close(context);
    await opened.session.close(context);
    const restored = await f.open();
    expect(restored.open).toEqual([]);
    expect(await restored.lane.getResult(result.operationId, context)).toEqual(result);
    expect(await restored.storage.scanUsage({}, context)).toEqual(usage);
    expect(await restored.compatibility?.snapshot("main", context)).toEqual(before);
    expect(f.upstream.state.messagesCalls).toHaveLength(1);
  },
);

it("settles both nested requests but publishes no summary when a turn-prefix response is truncated", async () => {
  const { f, opened, run } = await fixture({
    upstream: {
      script: [],
      stopReasons: ["end_turn", "max_tokens"],
      inputTokens: 23,
      outputTokens: 5,
    },
  });
  const assistant: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "Large assistant tail ".repeat(100) }],
    api: f.model.api,
    provider: f.model.provider,
    model: f.model.id,
    stopReason: "stop",
    timestamp: 4,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
  await opened.lane.appendMessage(assistant, context);
  let split = false;
  opened.harness.hooks.on("before_compaction", (event) => {
    split = event.preparation.isSplitTurn;
    return undefined;
  });
  const before = await opened.compatibility?.snapshot("main", context);
  expect((await run("compaction")).status).toBe("failed");
  expect(split).toBe(true);
  expect(f.upstream.state.messagesCalls).toHaveLength(2);
  expect(await opened.compatibility?.snapshot("main", context)).toEqual(before);
  expect((await opened.storage.scanUsage({}, context)).map((row) => row.usage.totalTokens)).toEqual(
    [28, 28],
  );
  // Seeded transcript messages do not create usage rows; only the two requests are charged.
  expect((await opened.storage.getStats(context)).usage.totalTokens).toBe(56);
});

it("awaits failed-summary usage settlement before acknowledging the failure", async () => {
  const { f, opened, run } = await fixture({ upstream: upstream("length") });
  const reached = deferred(),
    release = deferred();
  let acknowledged = false;
  f.beforeCommit = async (writes) => {
    if (!writes.some((write) => write.kind === "usage")) return;
    reached.resolve();
    await release.promise;
  };
  const pending = run("compaction").then((result) => {
    acknowledged = true;
    return result;
  });
  try {
    await reached.promise;
    expect(acknowledged).toBe(false);
    expect(await opened.storage.scanUsage({}, context)).toEqual([]);
    expect(await opened.storage.scanEntries({ type: "compaction" }, context)).toEqual([]);
  } finally {
    release.resolve();
  }
  expect((await pending).status).toBe("failed");
  expect(await opened.storage.scanUsage({}, context)).toHaveLength(1);
  expect(f.upstream.state.messagesCalls).toHaveLength(1);
});

it("faults on rejected usage settlement and prevents later model dispatch", async () => {
  const { f, opened, run } = await fixture({ upstream: upstream("length") });
  f.beforeCommit = async (writes) => {
    if (writes.some((write) => write.kind === "usage")) throw new Error("Usage commit rejected");
  };
  await expect(run("compaction")).rejects.toThrow();
  f.beforeCommit = undefined;
  await expect(opened.lane.prompt("must not run", undefined, context)).rejects.toThrow();
  expect(await opened.storage.scanUsage({}, context)).toEqual([]);
  expect(await opened.storage.scanEntries({ type: "compaction" }, context)).toEqual([]);
  expect(f.upstream.state.messagesCalls).toHaveLength(1);
});

it.each(["length", "tool"] as const)(
  "preserves %s responses on ordinary streaming calls",
  async (invalid) => {
    const { f } = await fixture({ upstream: upstream(invalid) });
    const models = piSummaryModels(f.models);
    expect(models.getModel(f.model.provider, f.model.id)).toEqual(
      f.models.getModel(f.model.provider, f.model.id),
    );
    const model = models.getModel(f.model.provider, f.model.id);
    if (!model) throw new Error("Missing fixture model");
    expect(model.baseUrl).toBe(f.upstream.url);
    const message = await models.streamSimple(model, { messages }, { maxRetries: 0 }).result();
    expect(message.stopReason).toBe(invalid === "length" ? "length" : "toolUse");
    expect(message.errorMessage).toBeUndefined();
    if (invalid === "tool")
      expect(message.content.some((block) => block.type === "toolCall")).toBe(true);
    expect(f.upstream.state.messagesCalls).toHaveLength(1);
  },
);

it("preserves cancellation during a live summary request", async () => {
  const { f, opened, run } = await fixture({ upstream: { script: [], delayMs: 500 } });
  const before = await opened.compatibility?.snapshot("main", context);
  const pending = run("compaction");
  await vi.waitFor(() => expect(f.upstream.state.messagesCalls).toHaveLength(1));
  getOrThrow(await opened.lane.abort(context));
  expect((await pending).status).toBe("aborted");
  expect(await opened.compatibility?.snapshot("main", context)).toEqual(before);
  expect(f.effects).toBe(0);
});
