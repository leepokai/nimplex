import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/pi-agent-core/harness/context";
import {
  branchTip,
  deleteValue,
  entryLabel,
  insertEntry,
  laneConfig,
  sessionName,
  setValue,
  value,
  type Write,
} from "@earendil-works/pi-agent-core/harness/session";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it } from "vitest";
import { SqlitePiStorage } from "../pi-storage/sqlite.ts";
import { PiCompatibilityStore } from "./compatibility-store.ts";
import { PiSessionView } from "./session-view.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const initial = {
  model: { provider: "fixture", modelId: "one" },
  thinkingLevel: "off" as const,
  activeToolNames: ["probe"],
};
async function fixture() {
  const db = new DatabaseSync(":memory:");
  const source = new SqlitePiStorage(db, { tenantId: "test", sessionId: "session" }, () => {});
  const store = new PiCompatibilityStore(source, {
    id: "session",
    cwd: "/workspace",
    createdAt: 0,
  });
  cleanup.push(async () => {
    await store.storage.close(context);
    db.close();
  });
  const commit = (writes: Write[]) => store.storage.commit(writes, context);
  const view = async (lane = "main") =>
    new PiSessionView(await store.snapshot(lane, context)).manager;
  await commit([setValue(branchTip("main"), null), setValue(laneConfig("main"), initial)]);
  return { db, source, store, commit, view };
}

it("records model/thinking changes in order, preserves initial settings and ignores tool-list-only writes", async () => {
  const f = await fixture();
  const baseline = SessionManager.inMemory("/workspace");
  baseline.appendModelChange("fixture", "one");
  baseline.appendThinkingLevelChange("off");
  expect((await f.view()).buildSessionContext()).toEqual(baseline.buildSessionContext());
  const before = await f.store.snapshot("main", context);
  await f.commit([setValue(laneConfig("main"), { ...initial, activeToolNames: [] })]);
  expect(await f.store.snapshot("main", context)).toEqual(before);
  const low = { ...initial, thinkingLevel: "low" as const };
  const high = {
    ...initial,
    model: { provider: "second", modelId: "two" },
    thinkingLevel: "high" as const,
  };
  await f.commit([setValue(laneConfig("main"), low), setValue(laneConfig("main"), high)]);
  baseline.appendThinkingLevelChange("low");
  baseline.appendModelChange("second", "two");
  baseline.appendThinkingLevelChange("high");
  const actual = await f.view();
  expect(actual.buildSessionContext()).toEqual(baseline.buildSessionContext());
  const semantic = (manager: SessionManager) =>
    manager.getBranch().map(({ id: _id, parentId: _parent, timestamp: _time, ...rest }) => rest);
  expect(semantic(actual)).toEqual(semantic(baseline));
  expect((await f.source.getValue(laneConfig("main"), context))?.value).toEqual(high);
  expect(await f.source.scanEntries({}, context)).toEqual([]);
  const mappings = await f.source.scanValues(value("nimplex.pi.compat.metadata"), context);
  expect(mappings).toHaveLength(5);
  expect(mappings.map((m) => m.value)).toContainEqual(
    expect.objectContaining({ namespace: "pi.lane.config", key: "main", sourceWriteIndex: 1 }),
  );
});

it("preserves global names and labels, their clear operations and branch-local settings", async () => {
  const f = await fixture();
  await f.commit([
    insertEntry({
      type: "message",
      id: "user",
      parentId: null,
      message: { role: "user", content: "hello", timestamp: 1 },
    }),
    setValue(branchTip("main"), "user"),
  ]);
  const other = {
    ...initial,
    model: { provider: "fixture", modelId: "other" },
    thinkingLevel: "high" as const,
  };
  await f.commit([setValue(branchTip("other"), "user"), setValue(laneConfig("other"), other)]);
  const otherTip = (await f.view("other")).getLeafId();
  await f.commit([
    setValue(sessionName, "  named\nsession  "),
    setValue(entryLabel("user"), "bookmark"),
  ]);
  for (const lane of ["main", "other"]) {
    expect((await f.view(lane)).getSessionName()).toBe("named session");
    expect((await f.view(lane)).getLabel("user")).toBe("bookmark");
  }
  expect((await f.source.getValue(sessionName, context))?.value).toBe("  named\nsession  ");
  expect((await f.view("other")).getLeafId()).toBe(otherTip);
  expect((await f.view("other")).buildSessionContext().model).toEqual(other.model);
  expect((await f.view()).buildSessionContext().model).toEqual(initial.model);
  await f.commit([deleteValue(sessionName), deleteValue(entryLabel("user"))]);
  const cleared = await f.view();
  expect(cleared.getSessionName()).toBeUndefined();
  expect(cleared.getLabel("user")).toBeUndefined();
  expect(cleared.getEntries().filter((e) => e.type === "session_info")).toHaveLength(2);
  expect(cleared.getEntries().filter((e) => e.type === "label")).toHaveLength(2);
  expect(await f.source.getValue(sessionName, context)).toBeUndefined();
});

it("keeps both lanes' tips when one transaction changes multiple data-only branches", async () => {
  const f = await fixture();
  await f.commit([
    setValue(branchTip("main"), null),
    setValue(branchTip("other"), null),
    setValue(laneConfig("other"), initial),
  ]);
  expect((await f.view()).getBranch()).toEqual([]);
  expect((await f.view("other")).getBranch().map((e) => e.type)).toEqual([
    "model_change",
    "thinking_level_change",
  ]);
});

it("rolls back native metadata, history, mapping and tip when a projection transaction fails", async () => {
  const f = await fixture();
  const before = await f.store.snapshot("main", context),
    journal = await f.source.readCommits();
  f.db.exec(
    "CREATE TRIGGER reject_metadata BEFORE INSERT ON pi_store_values WHEN NEW.namespace='nimplex.pi.compat.metadata' BEGIN SELECT RAISE(ABORT, 'metadata projection rejected'); END;",
  );
  const writes = [
    setValue(laneConfig("main"), { ...initial, thinkingLevel: "high" as const }),
    setValue(sessionName, "uncommitted"),
  ];
  await expect(f.commit(writes)).rejects.toThrow("metadata projection rejected");
  expect(await f.store.snapshot("main", context)).toEqual(before);
  expect(await f.source.readCommits()).toEqual(journal);
  expect((await f.source.getValue(laneConfig("main"), context))?.value).toEqual(initial);
  expect(await f.source.getValue(sessionName, context)).toBeUndefined();
  f.db.exec("DROP TRIGGER reject_metadata");
  await f.commit(writes);
  expect((await f.view()).getSessionName()).toBe("uncommitted");
  expect((await f.view()).buildSessionContext().thinkingLevel).toBe("high");
});

it("preserves original transaction order when configuration, messages and global metadata interleave", async () => {
  const f = await fixture();
  await f.commit([
    setValue(laneConfig("main"), { ...initial, thinkingLevel: "low" }),
    insertEntry({
      type: "message",
      id: "user",
      parentId: null,
      message: { role: "user", content: "hello", timestamp: 1 },
    }),
    setValue(branchTip("main"), "user"),
    setValue(sessionName, "between settings"),
    setValue(laneConfig("main"), { ...initial, thinkingLevel: "high" }),
  ]);
  const branch = (await f.view()).getBranch();
  expect(branch.map((e) => e.type)).toEqual([
    "model_change",
    "thinking_level_change",
    "thinking_level_change",
    "message",
    "session_info",
    "thinking_level_change",
  ]);
  expect(
    branch.filter((e) => e.type === "thinking_level_change").map((e) => e.thinkingLevel),
  ).toEqual(["off", "low", "high"]);
  expect((await f.source.getEntries(["user"], context)).get("user")?.parentId).toBeNull();
  expect((await f.view()).buildSessionContext().messages).toEqual([
    { role: "user", content: "hello", timestamp: 1 },
  ]);
});

it.each([
  { name: "missing label target", write: setValue(entryLabel("missing"), "label") },
  { name: "invalid name", write: setValue(value("pi.session.name"), 7) },
  { name: "invalid configuration", write: setValue(value("pi.lane.config", "main"), {}) },
  { name: "lane deletion", write: deleteValue(laneConfig("main")) },
])("rejects $name without partial metadata", async ({ write }) => {
  const f = await fixture();
  const before = await f.store.snapshot("main", context),
    journal = await f.source.readCommits();
  await expect(f.commit([setValue(sessionName, "must roll back"), write])).rejects.toThrow();
  expect(await f.store.snapshot("main", context)).toEqual(before);
  expect(await f.source.readCommits()).toEqual(journal);
});

it.each([1, 2, 999])(
  "rejects projection version %s without silently upgrading its history",
  async (version) => {
    const f = await fixture();
    const header = await f.source.getValue(
      value<Record<string, unknown>>("nimplex.pi.compat.header"),
      context,
    );
    if (!header) throw new Error("Missing fixture header");
    await f.source.commit(
      [setValue(value("nimplex.pi.compat.header"), { ...header.value, version })],
      context,
    );
    const journal = await f.source.readCommits();
    await expect(f.store.snapshot("main", context)).rejects.toThrow("explicit migration required");
    await expect(f.commit([setValue(sessionName, "must not commit")])).rejects.toThrow(
      "explicit migration required",
    );
    expect(await f.source.readCommits()).toEqual(journal);
    expect((await f.source.getValue(laneConfig("main"), context))?.value).toEqual(initial);
  },
);
