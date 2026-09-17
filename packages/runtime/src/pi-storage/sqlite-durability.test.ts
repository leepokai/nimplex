import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/pi-agent-core/harness/context";
import {
  appendList,
  deleteList,
  deleteValue,
  insertEntry,
  list,
  setValue,
  value,
} from "@earendil-works/pi-agent-core/harness/session";
import { afterEach, expect, it } from "vitest";
import { SqlitePiStorage } from "./sqlite.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "nimplex-pi-sqlite-"));
  const path = join(directory, "store.sqlite");
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
  const stores: SqlitePiStorage[] = [];
  const open = (tenantId = "tenant", sessionId = "session", owns: () => void = () => {}) => {
    const store = new SqlitePiStorage(db, { tenantId, sessionId }, owns);
    stores.push(store);
    return store;
  };
  cleanup.push(async () => {
    for (const s of stores) await s.close(context);
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { db, path, open };
}
const marker = value<string>("test.marker");
const inbox = list<string>("test.inbox");
const entry = (id: string, parentId: string | null = null) =>
  insertEntry({ id, parentId, type: "custom", customType: "test", data: { id } });

it("retains immutable mutations after deletion and reconstructs identity from a new connection", async () => {
  const f = fixture(),
    s = f.open();
  await s.commit([entry("root"), setValue(marker, "old"), appendList(inbox, "accepted")], context);
  await s.commit([entry("child", "root"), deleteValue(marker), deleteList(inbox)], context);
  const journal = await s.readCommits();
  expect(journal.map((c) => c.firstSeq)).toEqual([1, 4]);
  expect(journal[0]?.writes).toContainEqual(expect.objectContaining({ value: "old" }));
  expect(journal[1]?.writes).toContainEqual(
    expect.objectContaining({ op: "delete", namespace: marker.namespace }),
  );
  const db = new DatabaseSync(f.path);
  const reopened = new SqlitePiStorage(db, { tenantId: "tenant", sessionId: "session" }, () => {});
  try {
    expect(await reopened.readCommits()).toEqual(journal);
    expect(await reopened.getEntries(["root", "child"], context)).toEqual(
      await s.getEntries(["root", "child"], context),
    );
    expect(await reopened.getValue(marker, context)).toBeUndefined();
    expect(await reopened.readList(inbox, undefined, context)).toEqual([]);
    expect((await reopened.commit([setValue(marker, "next")], context)).firstSeq).toBe(7);
  } finally {
    await reopened.close(context);
    db.close();
  }
});

it("rolls back entries, journal, projections and sequence when a later write fails", async () => {
  const f = fixture(),
    s = f.open();
  f.db.exec(
    "CREATE TRIGGER reject_marker BEFORE INSERT ON pi_store_values BEGIN SELECT RAISE(ABORT, 'write rejected'); END;",
  );
  await expect(s.commit([entry("root"), setValue(marker, "failed")], context)).rejects.toThrow(
    "write rejected",
  );
  expect(await s.readCommits()).toEqual([]);
  expect(await s.getEntries(["root"], context)).toEqual(new Map());
  expect((await s.getStats(context)).messageCount).toBe(0);
  f.db.exec("DROP TRIGGER reject_marker");
  expect((await s.commit([entry("root")], context)).firstSeq).toBe(1);
});

it("checks authority before and after writes and rejects queued work after ownership loss", async () => {
  const f = fixture();
  let owns = true,
    checks = 0,
    loseAfterWrite = false;
  const s = f.open("tenant", "session", () => {
    checks++;
    if (!owns || (loseAfterWrite && checks === 2)) throw new Error("stale owner");
  });
  checks = 0;
  loseAfterWrite = true;
  await expect(s.commit([entry("lost")], context)).rejects.toThrow("stale owner");
  expect(await s.readCommits()).toEqual([]);
  expect(await s.getEntries(["lost"], context)).toEqual(new Map());
  loseAfterWrite = false;
  const pending = s.commit([setValue(marker, "late")], context);
  owns = false;
  await expect(pending).rejects.toThrow("stale owner");
  expect(await s.getValue(marker, context)).toBeUndefined();
});

it("scopes every storage read and parent lookup by tenant and session", async () => {
  const f = fixture(),
    a = f.open(),
    b = f.open("other"),
    c = f.open("tenant", "other");
  await a.commit(
    [
      entry("private-root"),
      entry("same-id"),
      setValue(marker, "secret"),
      appendList(inbox, "private"),
    ],
    context,
  );
  for (const other of [b, c]) {
    expect(await other.readCommits()).toEqual([]);
    expect(await other.getEntries(["same-id"], context)).toEqual(new Map());
    expect(await other.getValue(marker, context)).toBeUndefined();
    expect(await other.scanValues(marker, context)).toEqual([]);
    expect(await other.readList(inbox, undefined, context)).toEqual([]);
    expect(await other.scanEntries({}, context)).toEqual([]);
    expect(await other.scanUsage({}, context)).toEqual([]);
    await expect(other.scanBranch({ start: "same-id" }, context)).rejects.toThrow();
    await expect(other.scanBranchStructure({ start: "same-id" }, context)).rejects.toThrow();
    await expect(other.commit([entry("child", "private-root")], context)).rejects.toThrow(
      "Missing parent",
    );
    expect((await other.commit([entry("same-id")], context)).firstSeq).toBe(1);
  }
  expect((await a.getEntries(["same-id"], context)).get("same-id")?.seq).toBe(2);
});

it("serializes admitted writes, freezes inputs and drains on close", async () => {
  const f = fixture(),
    s = f.open();
  const payload = { items: ["accepted"] };
  const address = value<typeof payload>("payload");
  const first = s.commit([setValue(address, payload)], context);
  payload.items.push("too late");
  const second = s.commit([setValue(marker, "second")], context);
  const closing = s.close(context);
  await expect(s.commit([setValue(marker, "after close")], context)).rejects.toThrow("closed");
  expect((await first).firstSeq).toBe(1);
  expect((await second).firstSeq).toBe(2);
  await closing;
  const reopened = f.open();
  expect((await reopened.getValue(address, context))?.value).toEqual({ items: ["accepted"] });
  expect((await reopened.getValue(marker, context))?.value).toBe("second");
});

it("rejects unknown formats without leaving a transaction open or overwriting history", async () => {
  const f = fixture(),
    s = f.open();
  await s.commit([entry("original")], context);
  const before = await s.readCommits();
  f.db
    .prepare("UPDATE pi_store_sessions SET format=?")
    .run(JSON.stringify({ version: 99, engine: "pi-agent-harness", piVersion: "future" }));
  expect(() => f.open()).toThrow();
  expect(await s.readCommits()).toEqual(before);
  const independent = f.open("separate");
  expect((await independent.commit([entry("root")], context)).firstSeq).toBe(1);
});

it("detects corrupted history and validates commit pagination", async () => {
  const f = fixture(),
    s = f.open();
  await s.commit([entry("first"), setValue(marker, "one")], context);
  await s.commit([entry("second", "first")], context);
  expect((await s.readCommits(1, 1))[0]?.firstSeq).toBe(1);
  expect((await s.readCommits(2, 1))[0]?.firstSeq).toBe(3);
  await expect(s.readCommits(-1)).rejects.toThrow();
  await expect(s.readCommits(0, 1001)).rejects.toThrow();
  f.db.exec("UPDATE pi_store_commits SET data='{}' WHERE first_seq=1");
  await expect(s.readCommits()).rejects.toThrow("digest mismatch");
});

it("rebuilds projections from immutable history without changing entries, queues or other tenants", async () => {
  const f = fixture(),
    s = f.open(),
    other = f.open("other");
  await s.commit([entry("root"), setValue(marker, "old"), appendList(inbox, "discarded")], context);
  await s.commit(
    [
      entry("child", "root"),
      setValue(marker, "current"),
      deleteList(inbox),
      appendList(inbox, "pending"),
    ],
    context,
  );
  await other.commit([entry("root"), setValue(marker, "private")], context);
  const before = await s.scanEntries({}, context);
  const journal = await s.readCommits();
  f.db.exec(
    "DELETE FROM pi_store_entries WHERE tenant_id='tenant'; DELETE FROM pi_store_values WHERE tenant_id='tenant'; DELETE FROM pi_store_lists WHERE tenant_id='tenant'; UPDATE pi_store_sessions SET stats='{}' WHERE tenant_id='tenant';",
  );
  expect((await s.rebuildProjections()).nextSeq).toBe(8);
  expect(await s.scanEntries({}, context)).toEqual(before);
  expect(await s.readCommits()).toEqual(journal);
  expect((await s.getValue(marker, context))?.value).toBe("current");
  expect(await s.readList(inbox, undefined, context)).toEqual([{ seq: 7, value: "pending" }]);
  expect((await other.getValue(marker, context))?.value).toBe("private");
});

it("rolls back a rebuild when the journal is truncated or damaged", async () => {
  const f = fixture(),
    s = f.open();
  await s.commit([entry("root")], context);
  await s.commit([entry("child", "root")], context);
  const before = await s.scanEntries({}, context);
  f.db.exec("DELETE FROM pi_store_commits WHERE first_seq=2");
  await expect(s.rebuildProjections()).rejects.toThrow("high-water mismatch");
  expect(await s.scanEntries({}, context)).toEqual(before);
  f.db.exec("UPDATE pi_store_commits SET data='{}'");
  await expect(s.rebuildProjections()).rejects.toThrow("digest mismatch");
  expect(await s.scanEntries({}, context)).toEqual(before);
});

it("rejects non-finite persisted values rather than silently replacing them with null", async () => {
  const f = fixture(),
    s = f.open();
  await expect(
    s.commit([entry("rolled-back"), setValue(value("invalid"), { amount: Number.NaN })], context),
  ).rejects.toThrow("finite JSON");
  expect(await s.readCommits()).toEqual([]);
  expect(await s.scanEntries({}, context)).toEqual([]);
});

it("commits host rows atomically with Pi writes inside a host-owned transaction", async () => {
  const f = fixture();
  f.db.exec("CREATE TABLE host_rows (id TEXT PRIMARY KEY)");
  let failNext = false;
  const transaction = <T>(operation: () => T): T => {
    f.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      f.db.prepare("INSERT INTO host_rows VALUES (?)").run(`row-${Date.now()}-${Math.random()}`);
      if (failNext) throw new Error("host commit rejected");
      f.db.exec("COMMIT");
      return result;
    } catch (error) {
      f.db.exec("ROLLBACK");
      throw error;
    }
  };
  const s = new SqlitePiStorage(f.db, { tenantId: "tenant", sessionId: "session" }, () => {}, {
    transaction,
  });
  cleanup.push(() => s.close(context));
  const hostRows = () =>
    Number(f.db.prepare("SELECT COUNT(*) AS count FROM host_rows").get()?.count);
  // The constructor's session row committed through the host runner too.
  expect(hostRows()).toBe(1);
  await s.commit([entry("root")], context);
  expect(hostRows()).toBe(2);
  failNext = true;
  await expect(s.commit([entry("child", "root")], context)).rejects.toThrow("host commit rejected");
  expect(hostRows()).toBe(2);
  expect(await s.getEntries(["child"], context)).toEqual(new Map());
  expect((await s.readCommits()).map((c) => c.firstSeq)).toEqual([1]);
  failNext = false;
  expect((await s.commit([entry("child", "root")], context)).firstSeq).toBe(2);
  expect(hostRows()).toBe(3);
});
