import { afterEach, expect, it } from "vitest";
import { PiSessionView } from "./pi-extensions/session-view.ts";
import { deferred } from "./testing/pi-composition-fixture.ts";
import { context, getOrThrow, harnessFixture, hasMessage } from "./testing/pi-harness-fixture.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture(compatibility = false) {
  const f = await harnessFixture({ compatibility });
  cleanup.push(f.close);
  return f;
}

it.each([false, true])(
  "awaits metadata commits and faults the activation on a required metadata failure (projection: %s)",
  async (compatibility) => {
    const f = await fixture(compatibility),
      opened = await f.open();
    const reached = deferred(),
      release = deferred();
    f.beforeCommit = async () => {
      reached.resolve();
      await release.promise;
    };
    let acknowledged = false;
    const name = opened.harness.setName("persisted", context).then(() => {
      acknowledged = true;
    });
    try {
      await reached.promise;
      expect(acknowledged).toBe(false);
    } finally {
      release.resolve();
    }
    await name;
    f.beforeCommit = async () => {
      throw new Error("metadata transaction rejected");
    };
    await expect(opened.harness.setName("lost", context)).rejects.toThrow();
    f.beforeCommit = undefined;
    await expect(opened.lane.prompt("must not dispatch", undefined, context)).rejects.toThrow();
    expect(f.upstream.state.messagesCalls).toHaveLength(0);
    await opened.harness.close(context);
    await opened.session.close(context);
    const restored = await f.open();
    expect(await restored.harness.getName(context)).toBe("persisted");
    if (restored.compatibility) {
      const view = new PiSessionView(await restored.compatibility.snapshot("main", context));
      expect(view.manager.getSessionName()).toBe("persisted");
      expect(view.manager.getEntries().filter((e) => e.type === "session_info")).toEqual([
        expect.objectContaining({ name: "persisted" }),
      ]);
    }
  },
);

it("restores accepted operations and queued input identities before dispatch", async () => {
  const f = await fixture(),
    first = await f.open();
  const admitted = getOrThrow(
    await first.lane.accept(
      { kind: "prompt", operationId: "stable-operation", prompt: "Write once" },
      context,
    ),
  );
  expect(admitted.operationId).toBe("stable-operation");
  const steer = getOrThrow(await first.lane.steer("steering input", undefined, context));
  const followUp = getOrThrow(await first.lane.followUp("follow-up input", undefined, context));
  const next = getOrThrow(await first.lane.nextRun("next-run input", undefined, context));
  const before = (await first.lane.watch(context)).snapshot;
  expect(before.queues.map((q) => q.entryId)).toEqual([
    steer.entryId,
    followUp.entryId,
    next.entryId,
  ]);
  expect(f.upstream.state.messagesCalls).toHaveLength(0);
  await first.harness.close(context);
  await first.session.close(context);
  const second = await f.open();
  expect((await second.lane.watch(context)).snapshot.queues).toEqual(before.queues);
  expect(second.open.map((o) => o.operationId)).toEqual(["stable-operation"]);
  expect(getOrThrow(await second.lane.cancelQueued(next.entryId, context)).kind).toBe("cancelled");
  expect(getOrThrow(await second.lane.resume(context)).status).toBe("completed");
  const after = (await second.lane.watch(context)).snapshot;
  expect(after.queues).toEqual([]);
  const entries = await second.session.findEntries(undefined, context);
  for (const queued of [steer, followUp])
    expect(entries.filter((e) => e.id === queued.entryId)).toHaveLength(1);
  expect(entries.find((e) => e.id === next.entryId)).toBeUndefined();
});

it("preserves custom state, compaction, branch summaries, labels and lane settings across restart", async () => {
  const f = await fixture(),
    first = await f.open();
  first.harness.hooks.on("before_compaction", ({ preparation }) => ({
    compaction: {
      summary: "Synthetic history summary",
      retainedTail: preparation.retainedTail,
      tokensBefore: preparation.tokensBefore,
      details: { fixture: true },
    },
  }));
  first.harness.hooks.on("before_navigation", () => ({
    summary: {
      summary: "Synthetic branch summary",
      readFiles: [],
      modifiedFiles: ["/workspace/probe.txt"],
    },
  }));
  getOrThrow(await first.lane.prompt("Write once", undefined, context));
  const customId = await first.lane.appendCustomEntry("extension-state", { count: 1 }, context);
  await first.harness.setName("restored name", context);
  const entries = await first.session.findEntries(undefined, context);
  const target = entries.find((e) => e.type === "message");
  if (!target) throw new Error("Missing fixture message");
  expect(getOrThrow(await first.lane.compact(undefined, context)).compaction.status).toBe(
    "completed",
  );
  expect(
    getOrThrow(
      await first.lane.navigateTree(target.id, { summarize: true, label: "checkpoint" }, context),
    ).navigation.status,
  ).toBe("completed");
  await first.lane.setThinkingLevel("low", context);
  await first.lane.setActiveTools([], context);
  const before = await first.session.findEntries(undefined, context);
  expect(before.some((e) => e.type === "compaction")).toBe(true);
  expect(before.some((e) => e.type === "branch_summary")).toBe(true);
  expect(before.some((e) => e.id === customId && e.type === "custom")).toBe(true);
  const tip = await first.lane.getTipId(context);
  await first.harness.close(context);
  await first.session.close(context);
  const second = await f.open();
  expect(await second.session.findEntries(undefined, context)).toEqual(before);
  expect(await second.lane.getTipId(context)).toBe(tip);
  expect(await second.harness.getName(context)).toBe("restored name");
  expect(await second.harness.getLabel(target.id, context)).toBe("checkpoint");
  expect(await second.lane.getThinkingLevel(context)).toBe("low");
  expect(await second.lane.getActiveTools(context)).toEqual([]);
  expect(await second.bash.fs.readFile("/workspace/probe.txt")).toBe("ONCE");
});

it("keeps a failed activation faulted even after storage becomes available", async () => {
  const f = await fixture(),
    opened = await f.open();
  f.beforeCommit = async (writes) => {
    if (hasMessage(writes, "assistant")) throw new Error("storage failed");
  };
  await expect(opened.lane.prompt("Write once", undefined, context)).rejects.toThrow();
  f.beforeCommit = undefined;
  await expect(async () => opened.lane.resume(context)).rejects.toThrow();
  await expect(async () =>
    opened.lane.appendCustomEntry("must-not-commit", {}, context),
  ).rejects.toThrow();
  expect(f.effects).toBe(0);
  expect(f.upstream.state.messagesCalls).toHaveLength(1);
});

it("records that global resource configuration is not automatically durable", async () => {
  const f = await fixture(),
    first = await f.open();
  await first.harness.setSteeringMode("one-at-a-time", context);
  await first.harness.setFollowUpMode("one-at-a-time", context);
  const before = await first.storage.readCommits();
  await first.harness.setResources(
    { promptTemplates: [{ name: "fixture", content: "Pinned resource" }] },
    context,
  );
  expect(await first.storage.readCommits()).toEqual(before);
  await first.harness.close(context);
  await first.session.close(context);
  const second = await f.open();
  expect(await second.harness.getResources(context)).toEqual({});
  expect(await second.harness.getSteeringMode(context)).toBe("all");
  expect(await second.harness.getFollowUpMode(context)).toBe("all");
});
