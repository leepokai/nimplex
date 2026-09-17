import { deleteValue, setValue } from "@earendil-works/pi-agent-core/harness/session";
import { afterEach, expect, it, vi } from "vitest";
import { summaryResponseAddress } from "./pi-storage/summary-responses.ts";
import { deferred } from "./testing/pi-composition-fixture.ts";
import { context, getOrThrow, harnessFixture } from "./testing/pi-harness-fixture.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture(truncate = false) {
  const f = await harnessFixture({
    compatibility: true,
    upstream: {
      script: [],
      inputTokens: 23,
      outputTokens: 5,
      ...(truncate ? { stopReasons: ["max_tokens"] } : {}),
    },
  });
  cleanup.push(f.close);
  const opened = await f.open();
  if (!opened.summaryResponses) throw new Error("Missing summary response boundary");
  for (const [index, content] of ["First ".repeat(100), "Second ".repeat(100), "Recent"].entries())
    await opened.lane.appendMessage({ role: "user", content, timestamp: index + 1 }, context);
  return { f, opened, responses: opened.summaryResponses };
}

it.each([false, true])(
  "atomically records the original response and delivered verdict (truncated: %s)",
  async (truncate) => {
    const { f, opened, responses } = await fixture(truncate);
    opened.harness.hooks.on("before_request", () => ({
      streamOptions: { metadata: { user_id: "summary-fixture" } },
    }));
    const result = getOrThrow(await opened.lane.compact(undefined, context)).compaction;
    expect(result.status).toBe(truncate ? "failed" : "completed");
    const records = await responses.read(context);
    const usage = await opened.storage.scanUsage({}, context);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      version: 1,
      operationId: result.operationId,
      lane: "main",
      kind: "compaction",
      attempt: 1,
      requestIndex: 0,
      usageId: usage[0]?.id,
      model: { provider: f.model.provider, modelId: f.model.id },
      response: {
        role: "assistant",
        stopReason: truncate ? "length" : "stop",
        content: [{ type: "text", text: expect.stringContaining("hello from the fake upstream") }],
        usage: usage[0]?.usage,
      },
      delivered: { stopReason: truncate ? "error" : "stop" },
    });
    expect(f.upstream.state.messagesCalls[0]?.body.metadata).toEqual({
      user_id: "summary-fixture",
    });
    const journal = await opened.storage.readCommits();
    const settled = journal.filter((commit) =>
      commit.writes.some(
        (write) =>
          typeof write === "object" &&
          write &&
          "namespace" in write &&
          write.namespace === "nimplex.pi.summary.response",
      ),
    );
    expect(settled).toHaveLength(1);
    expect(settled[0]?.writes).toContainEqual(
      expect.objectContaining({
        kind: "usage",
        id: records[0]?.usageId,
        usage: usage[0]?.usage,
      }),
    );
    expect(JSON.stringify(journal)).not.toContain("nimplex-summary-");
    expect(JSON.stringify(records)).not.toContain("synthetic-public-harness-key");
  },
);

it("keeps concurrent lanes and requests distinct", async () => {
  const { opened, responses, f } = await fixture();
  const other = await opened.harness.lane("other", context);
  for (const [index, content] of [
    "Other history ".repeat(100),
    "Other recent ".repeat(100),
    "Last",
  ].entries())
    await other.appendMessage({ role: "user", content, timestamp: index + 10 }, context);
  const [main, secondary] = await Promise.all([
    opened.lane.compact(undefined, context),
    other.compact(undefined, context),
  ]);
  const expected = new Map([
    ["main", getOrThrow(main).compaction.operationId],
    ["other", getOrThrow(secondary).compaction.operationId],
  ]);
  const records = await responses.read(context);
  expect(records).toHaveLength(2);
  expect(new Set(records.map((record) => record.usageId)).size).toBe(2);
  for (const record of records) {
    expect(record.operationId).toBe(expected.get(record.lane));
    expect(record.requestIndex).toBe(0);
  }
  expect(f.upstream.state.messagesCalls).toHaveLength(2);
  expect((await opened.storage.getStats(context)).usage.totalTokens).toBe(56);
});

it("cancels during the response-identity read without dispatching or faulting the lane", async () => {
  const { f, opened, responses } = await fixture();
  const reached = deferred(),
    release = deferred(),
    cancelled = deferred();
  let signal: AbortSignal | undefined;
  const begin = responses.boundary.begin.bind(responses.boundary);
  vi.spyOn(responses.boundary, "begin").mockImplementation((model, options) => {
    signal = options?.signal;
    return begin(model, options);
  });
  f.afterCommit = async (writes) => {
    if (
      writes.some(
        (write) =>
          write.kind === "value" &&
          write.op === "set" &&
          write.namespace === "pi.op.state" &&
          (write.value as { control?: { status?: string } }).control?.status === "cancel_requested",
      )
    )
      cancelled.resolve();
  };
  const read = opened.storage.getValue.bind(opened.storage);
  const spy = vi.spyOn(opened.storage, "getValue").mockImplementation(async (address, ctx) => {
    if (address.namespace === summaryResponseAddress("").namespace) {
      reached.resolve();
      await release.promise;
    }
    return read(address, ctx);
  });
  const pending = opened.lane.compact(undefined, context);
  let abort: ReturnType<typeof opened.lane.abort> | undefined;
  try {
    await reached.promise;
    abort = opened.lane.abort(context);
    await cancelled.promise;
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
  } finally {
    release.resolve();
  }
  expect(getOrThrow(await pending).compaction.status).toBe("aborted");
  if (!abort) throw new Error("Abort was not requested");
  getOrThrow(await abort);
  expect(f.upstream.state.messagesCalls).toHaveLength(0);
  expect(await responses.read(context)).toEqual([]);
  expect(await opened.storage.scanUsage({}, context)).toEqual([]);
  spy.mockRestore();
  expect(getOrThrow(await opened.lane.compact(undefined, context)).compaction.status).toBe(
    "completed",
  );
  expect(f.upstream.state.messagesCalls).toHaveLength(1);
});

it("awaits the combined response and usage commit before failure acknowledgement", async () => {
  const { f, opened, responses } = await fixture(true);
  const reached = deferred(),
    release = deferred();
  f.beforeCommit = async (writes) => {
    if (
      !writes.some(
        (write) => write.kind === "value" && write.namespace === "nimplex.pi.summary.response",
      )
    )
      return;
    reached.resolve();
    await release.promise;
  };
  let acknowledged = false;
  const pending = opened.lane.compact(undefined, context).then((result) => {
    acknowledged = true;
    return result;
  });
  try {
    await reached.promise;
    expect(acknowledged).toBe(false);
    expect(await responses.read(context)).toEqual([]);
    expect(await opened.storage.scanUsage({}, context)).toEqual([]);
  } finally {
    release.resolve();
  }
  expect(getOrThrow(await pending).compaction.status).toBe("failed");
  expect(await responses.read(context)).toHaveLength(1);
  expect(await opened.storage.scanUsage({}, context)).toHaveLength(1);
});

it("rolls back usage when the raw-response write fails inside SQLite", async () => {
  const { f, opened, responses } = await fixture();
  f.db.exec(
    "CREATE TRIGGER reject_summary_response BEFORE INSERT ON pi_store_values WHEN NEW.namespace='nimplex.pi.summary.response' BEGIN SELECT RAISE(ABORT, 'summary response rejected'); END;",
  );
  const before = await opened.compatibility?.snapshot("main", context);
  await expect(opened.lane.compact(undefined, context)).rejects.toThrow();
  expect(await responses.read(context)).toEqual([]);
  expect(await opened.storage.scanUsage({}, context)).toEqual([]);
  expect(await opened.compatibility?.snapshot("main", context)).toEqual(before);
  await expect(opened.lane.prompt("must not dispatch", undefined, context)).rejects.toThrow();
  expect(f.upstream.state.messagesCalls).toHaveLength(1);
});

it("rejects missing request bindings before any provider call", async () => {
  const { f, opened, responses } = await fixture();
  opened.harness.hooks.on("before_request", () => ({ streamOptions: { metadata: undefined } }));
  await expect(opened.lane.compact(undefined, context)).rejects.toThrow();
  expect(f.upstream.state.messagesCalls).toHaveLength(0);
  expect(await responses.read(context)).toEqual([]);
  expect(await opened.storage.scanUsage({}, context)).toEqual([]);
});

it("rejects record overwrite/deletion and unsupported versions", async () => {
  const { opened, responses } = await fixture();
  getOrThrow(await opened.lane.compact(undefined, context));
  const records = await responses.read(context),
    record = records[0];
  if (!record) throw new Error("Missing original response");
  const address = summaryResponseAddress(record.usageId);
  await expect(responses.storage.commit([deleteValue(address)], context)).rejects.toThrow(
    "immutable",
  );
  await expect(responses.storage.commit([setValue(address, record)], context)).rejects.toThrow(
    "immutable",
  );
  expect(await responses.read(context)).toEqual(records);
  await opened.storage.commit(
    [{ ...setValue(address, record), value: { ...record, version: 99 } }],
    context,
  );
  await expect(responses.read(context)).rejects.toThrow();
});
