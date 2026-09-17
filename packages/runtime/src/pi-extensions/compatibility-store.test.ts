import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/pi-agent-core/harness/context";
import {
  branchTip,
  insertEntry,
  insertUsage,
  laneState,
  pendingEntry,
  setValue,
  value,
} from "@earendil-works/pi-agent-core/harness/session";
import { afterEach, expect, it } from "vitest";
import { SqlitePiStorage } from "../pi-storage/sqlite.ts";
import { PiCompatibilityStore } from "./compatibility-store.ts";
import { PiSessionView } from "./session-view.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
function fixture() {
  const db = new DatabaseSync(":memory:");
  let owns = true;
  const source = new SqlitePiStorage(db, { tenantId: "test", sessionId: "session" }, () => {
    if (!owns) throw new Error("Ownership lost");
  });
  const store = new PiCompatibilityStore(source, {
    id: "session",
    cwd: "/workspace",
    createdAt: 0,
  });
  cleanup.push(async () => {
    await store.storage.close(context);
    db.close();
  });
  return {
    db,
    source,
    store,
    loseOwnership() {
      owns = false;
    },
  };
}
const message = (id: string, parentId: string | null) =>
  insertEntry({
    type: "message",
    id,
    parentId,
    message: { role: "user", content: id, timestamp: 0 },
  });
const queuedCustom = () => [
  setValue(pendingEntry("custom"), {
    type: "custom",
    customType: "state",
    payload: { counter: 1 },
  }),
  setValue(laneState("main"), {
    currentOperationId: "run",
    lastOperationId: null,
    inbox: [{ entryId: "custom", kind: "write" }],
  }),
];

it("keeps accepted custom identity and parent stable while native placement and navigation advance", async () => {
  const { source, store } = fixture();
  await store.storage.commit([message("root", null), setValue(branchTip("main"), "root")], context);
  await store.storage.commit(queuedCustom(), context);
  const accepted = (await store.snapshot("main", context)).entries.find((e) => e.id === "custom");
  expect(accepted).toMatchObject({ id: "custom", parentId: "root", data: { counter: 1 } });
  await store.storage.commit(
    [message("response", "root"), setValue(branchTip("main"), "response")],
    context,
  );
  await store.storage.commit(
    [
      insertEntry({
        type: "custom",
        id: "custom",
        parentId: "response",
        customType: "state",
        data: { counter: 1 },
      }),
      message("next", "custom"),
      setValue(branchTip("main"), "next"),
    ],
    context,
  );
  const snapshot = await store.snapshot("main", context);
  const view = new PiSessionView(snapshot);
  expect(view.manager.getEntry("custom")).toEqual(accepted);
  expect(view.manager.getBranch().map((e) => e.id)).toEqual(["root", "custom", "response", "next"]);
  expect((await source.getEntries(["custom"], context)).get("custom")?.parentId).toBe("response");
  await store.storage.commit([setValue(branchTip("main"), "root")], context);
  await store.storage.commit(
    [message("branch", "root"), setValue(branchTip("main"), "branch")],
    context,
  );
  view.replace(await store.snapshot("main", context));
  expect(view.manager.getBranch().map((e) => e.id)).toEqual(["root", "branch"]);
  expect(view.manager.getEntry("custom")).toEqual(accepted);
});

it("commits raw records and compatibility records atomically", async () => {
  const { db, source, store } = fixture();
  db.exec(
    "CREATE TRIGGER reject_projection BEFORE INSERT ON pi_store_lists WHEN NEW.namespace='nimplex.pi.compat.entries' BEGIN SELECT RAISE(ABORT, 'projection rejected'); END;",
  );
  await expect(
    store.storage.commit([message("root", null), setValue(branchTip("main"), "root")], context),
  ).rejects.toThrow("projection rejected");
  expect(await source.scanEntries({}, context)).toEqual([]);
  expect(await source.readCommits()).toEqual([]);
  await expect(store.snapshot("main", context)).rejects.toThrow("header is missing");
  db.exec("DROP TRIGGER reject_projection");
  expect(
    (
      await store.storage.commit(
        [message("root", null), setValue(branchTip("main"), "root")],
        context,
      )
    ).firstSeq,
  ).toBe(1);
});

it("preserves both sides on rejection of a conflicting materialized custom entry", async () => {
  const { source, store } = fixture();
  await store.storage.commit([message("root", null), setValue(branchTip("main"), "root")], context);
  await store.storage.commit(queuedCustom(), context);
  const before = await store.snapshot("main", context),
    journal = await source.readCommits();
  await expect(
    store.storage.commit(
      [
        insertEntry({
          type: "custom",
          id: "custom",
          parentId: "root",
          customType: "state",
          data: { counter: 999 },
        }),
        setValue(branchTip("main"), "custom"),
      ],
      context,
    ),
  ).rejects.toThrow("identity conflict");
  expect(await source.getEntries(["custom"], context)).toEqual(new Map());
  expect(await store.snapshot("main", context)).toEqual(before);
  expect(await source.readCommits()).toEqual(journal);
});

it("rejects stale ownership and mismatched session identity without modifying either projection", async () => {
  const f = fixture();
  await f.store.storage.commit(
    [message("root", null), setValue(branchTip("main"), "root")],
    context,
  );
  const before = await f.store.snapshot("main", context);
  const wrong = new PiCompatibilityStore(f.source, {
    id: "different",
    cwd: "/workspace",
    createdAt: 0,
  });
  await expect(wrong.storage.commit([], context)).rejects.toThrow("identity mismatch");
  await expect(wrong.snapshot("main", context)).rejects.toThrow("identity mismatch");
  f.loseOwnership();
  await expect(f.store.storage.commit(queuedCustom(), context)).rejects.toThrow("Ownership lost");
  expect(await f.store.snapshot("main", context)).toEqual(before);
});

it("requires explicit migration before wrapping an existing unprojected session", async () => {
  const { source, store } = fixture();
  await source.commit(
    [message("existing", null), setValue(branchTip("main"), "existing")],
    context,
  );
  const original = await source.readCommits();
  await expect(store.storage.commit([], context)).rejects.toThrow(
    "explicit compatibility migration",
  );
  expect(await source.readCommits()).toEqual(original);
  await expect(store.snapshot("main", context)).rejects.toThrow("header is missing");
});

it("rejects malformed structural metadata before acknowledging raw persistence", async () => {
  const { source, store } = fixture();
  await expect(
    store.storage.commit(
      [
        insertEntry({
          id: "compaction",
          parentId: null,
          type: "compaction",
          summary: "summary",
          retainedTail: [],
          tokensBefore: -1,
          fromHook: false,
        }),
        setValue(branchTip("main"), "compaction"),
      ],
      context,
    ),
  ).rejects.toThrow();
  expect(await source.readCommits()).toEqual([]);
});

it("rolls back summary, usage, derived tail and mapping when a structural projection write fails", async () => {
  const { db, source, store } = fixture();
  await store.storage.commit([message("root", null), setValue(branchTip("main"), "root")], context);
  const before = await store.snapshot("main", context),
    journal = await source.readCommits(),
    stats = await source.getStats(context);
  const usage = {
    input: 3,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 5,
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 },
  };
  const writes = [
    insertUsage({ id: "summary-usage", entryId: "summary", usage, adjustment: false }),
    insertEntry({
      id: "summary",
      parentId: "root",
      type: "compaction",
      summary: "Summary",
      retainedTail: [{ role: "user", content: "New retained content", timestamp: 0 }],
      tokensBefore: 3,
      usage,
      fromHook: true,
    }),
    setValue(branchTip("main"), "summary"),
  ];
  db.exec(
    "CREATE TRIGGER reject_structural BEFORE INSERT ON pi_store_lists WHEN NEW.namespace='nimplex.pi.compat.entries' BEGIN SELECT RAISE(ABORT, 'structural projection rejected'); END;",
  );
  await expect(store.storage.commit(writes, context)).rejects.toThrow(
    "structural projection rejected",
  );
  expect(await store.snapshot("main", context)).toEqual(before);
  expect(await source.readCommits()).toEqual(journal);
  expect(await source.getStats(context)).toEqual(stats);
  expect(
    await source.getValue(value("nimplex.pi.compat.compaction", "summary"), context),
  ).toBeUndefined();
  db.exec("DROP TRIGGER reject_structural");
  await store.storage.commit(writes, context);
  const after = new PiSessionView(await store.snapshot("main", context));
  expect(after.manager.getLeafEntry()).toMatchObject({ type: "compaction", id: "summary", usage });
  expect(await source.scanUsage({}, context)).toHaveLength(1);
  expect((await source.getStats(context)).usage).toEqual(usage);
});

it.each(["Summary from root", ""])(
  "preserves branch summaries from the root with content %j",
  async (summary) => {
    const { source, store } = fixture();
    await store.storage.commit(
      [
        message("target", null),
        setValue(branchTip("main"), "target"),
        insertEntry({
          type: "branch_summary",
          id: "summary",
          parentId: "target",
          fromId: null,
          summary,
          fromHook: false,
          details: { readFiles: ["a"], modifiedFiles: [] },
        }),
        setValue(branchTip("main"), "summary"),
      ],
      context,
    );
    const view = new PiSessionView(await store.snapshot("main", context));
    expect(view.manager.getLeafId()).toBe("summary");
    expect(view.manager.getLeafEntry()).toMatchObject({
      fromId: "root",
      summary,
      details: { readFiles: ["a"], modifiedFiles: [] },
    });
    expect((await source.getEntries(["summary"], context)).get("summary")).toMatchObject({
      fromId: null,
    });
    expect(view.manager.buildSessionContext().messages).toHaveLength(summary ? 2 : 1);
    await store.storage.commit(
      [setValue(branchTip("main"), "target"), setValue(branchTip("main"), null)],
      context,
    );
    view.replace(await store.snapshot("main", context));
    expect(view.manager.getBranch()).toEqual([]);
  },
);
