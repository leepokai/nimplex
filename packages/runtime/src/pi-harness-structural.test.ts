import { value } from "@earendil-works/pi-agent-core/harness/session";
import type { PiCompatibilityCompaction } from "@nimplex/contracts";
import { afterEach, expect, it } from "vitest";
import { PiSessionView } from "./pi-extensions/session-view.ts";
import { SqlitePiStorage } from "./pi-storage/sqlite.ts";
import { deferred } from "./testing/pi-composition-fixture.ts";
import { attachQualificationExtension } from "./testing/pi-extension-fixture.ts";
import { context, getOrThrow, harnessFixture } from "./testing/pi-harness-fixture.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const f = await harnessFixture({ compatibility: true });
  cleanup.push(f.close);
  const opened = await f.open();
  getOrThrow(await opened.lane.prompt("Write once", undefined, context));
  return { f, opened };
}

it("restores compaction, replaced tails and branch summaries into a fresh extension context", async () => {
  const { f, opened } = await fixture();
  const original = await opened.session.findEntries(undefined, context);
  const user = original.find((e) => e.type === "message" && e.message.role === "user");
  if (!user) throw new Error("Missing user entry");
  const dispose = opened.harness.hooks.on("before_compaction", ({ preparation }) => ({
    compaction: {
      summary: "Retained original context",
      retainedTail: preparation.retainedTail,
      tokensBefore: preparation.tokensBefore,
      details: { extension: { checkpoint: 1 } },
    },
  }));
  expect(getOrThrow(await opened.lane.compact(undefined, context)).compaction.status).toBe(
    "completed",
  );
  dispose();
  await opened.lane.appendMessage({ role: "user", content: "Next turn", timestamp: 9 }, context);
  const replaced = [{ role: "user" as const, content: "Rewritten by extension", timestamp: 10 }];
  opened.harness.hooks.on("before_compaction", () => ({
    compaction: {
      summary: "Replacement",
      retainedTail: replaced,
      tokensBefore: 10,
      details: { checkpoint: 2 },
    },
  }));
  expect(getOrThrow(await opened.lane.compact(undefined, context)).compaction.status).toBe(
    "completed",
  );
  const rawBefore = await opened.session.findEntries(undefined, context);
  const tip = await opened.lane.getTipId(context);
  if (!tip || !opened.compatibility) throw new Error("Missing compatibility state");
  const snapshot = await opened.compatibility.snapshot("main", context);
  const view = new PiSessionView(snapshot);
  expect(view.manager.buildSessionContext().messages.slice(1)).toEqual(replaced);
  const mapping = await opened.storage.getValue(
    value<PiCompatibilityCompaction>("nimplex.pi.compat.compaction", tip),
    context,
  );
  expect(mapping?.value.derivedEntryIds).toHaveLength(1);
  expect(rawBefore.filter((e) => mapping?.value.derivedEntryIds.includes(e.id))).toEqual([]);
  await opened.harness.close(context);
  await opened.session.close(context);
  const maintenance = new SqlitePiStorage(
    f.db,
    { tenantId: "test", sessionId: "session" },
    f.assertAuthority,
  );
  try {
    await maintenance.rebuildProjections();
  } finally {
    await maintenance.close(context);
  }
  const recovered = await f.open();
  let observed: unknown;
  const bridge = await attachQualificationExtension(f, recovered, (pi) => {
    pi.on("session_start", (_event, ctx) => {
      observed = ctx.sessionManager.buildContextEntries();
    });
  });
  cleanup.push(bridge.close);
  expect(observed).toEqual(view.manager.buildContextEntries());
  expect(await recovered.session.findEntries(undefined, context)).toEqual(rawBefore);
  expect(await recovered.compatibility?.snapshot("main", context)).toEqual(snapshot);
  recovered.harness.hooks.on("before_navigation", () => ({
    summary: {
      summary: "Abandoned branch",
      readFiles: [],
      modifiedFiles: ["/workspace/probe.txt"],
    },
  }));
  expect(
    getOrThrow(await recovered.lane.navigateTree(user.id, { summarize: true }, context)).navigation
      .status,
  ).toBe("completed");
  await bridge.refresh();
  const nativeTip = await recovered.lane.getTipId(context);
  expect(bridge.view.manager.getLeafId()).toBe(nativeTip);
  expect(bridge.view.manager.getLeafEntry()).toMatchObject({
    type: "branch_summary",
    parentId: user.id,
    fromId: tip,
    summary: "Abandoned branch",
    fromHook: true,
  });
  expect(bridge.view.manager.getBranch().map((e) => e.type)).toEqual([
    "model_change",
    "thinking_level_change",
    "message",
    "branch_summary",
  ]);
  expect(await recovered.bash.fs.readFile("/workspace/probe.txt")).toBe("ONCE");
});

it("awaits the structural commit and exposes no summary when the transaction is rejected", async () => {
  const { f, opened } = await fixture();
  opened.harness.hooks.on("before_compaction", ({ preparation }) => ({
    compaction: {
      summary: "Must commit",
      retainedTail: preparation.retainedTail,
      tokensBefore: preparation.tokensBefore,
    },
  }));
  const before = await opened.compatibility?.snapshot("main", context);
  const reached = deferred(),
    release = deferred();
  f.beforeCommit = async (writes) => {
    if (!writes.some((w) => w.kind === "entry" && w.entry.type === "compaction")) return;
    reached.resolve();
    await release.promise;
    throw new Error("Structural commit rejected");
  };
  let acknowledged = false;
  const pending = opened.lane.compact(undefined, context).then(() => {
    acknowledged = true;
  });
  const rejected = expect(pending).rejects.toThrow();
  try {
    await reached.promise;
    expect(acknowledged).toBe(false);
    expect(
      (await opened.session.findEntries(undefined, context)).some((e) => e.type === "compaction"),
    ).toBe(false);
  } finally {
    release.resolve();
  }
  await rejected;
  expect(await opened.compatibility?.snapshot("main", context)).toEqual(before);
  expect(
    (await opened.session.findEntries(undefined, context)).some((e) => e.type === "compaction"),
  ).toBe(false);
  const requests = f.upstream.state.messagesCalls.length;
  await expect(opened.lane.prompt("must not run", undefined, context)).rejects.toThrow();
  expect(f.upstream.state.messagesCalls).toHaveLength(requests);
});
