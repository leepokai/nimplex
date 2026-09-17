import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/pi-agent-core/harness/context";
import {
  appendList,
  deleteList,
  insertEntry,
  list,
  setValue,
  value,
} from "@earendil-works/pi-agent-core/harness/session";
import { createStorageConformance } from "@earendil-works/pi-agent-core/harness/session/testing";
import { createDb } from "@nimplex/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type PiSqlExecutor, PostgresPiStorage } from "./pi-storage.ts";

// The hosted adapter needs a real PostgreSQL. Without one the cases are reported as
// skipped with the reason; they are not evidence of hosted qualification.
const adminUrl = new URL(
  process.env.NIMPLEX_TEST_POSTGRES_URL ?? "postgres://nimplex:nimplex@localhost:5433/postgres",
);
const root = fileURLToPath(new URL("../../../", import.meta.url));
const databaseName = `nimplex_pi_${Date.now()}`;
let unavailable: string | undefined;
let admin: ReturnType<typeof createDb> | undefined;
let handle: ReturnType<typeof createDb> | undefined;
let orgId = "";
let otherOrgId = "";
const stores: PostgresPiStorage[] = [];
const marker = value<string>("test.marker");
const inbox = list<string>("test.inbox");
const entry = (id: string, parentId: string | null = null) =>
  insertEntry({ id, parentId, type: "custom", customType: "test", data: { id } });

beforeAll(async () => {
  try {
    admin = createDb(adminUrl.toString());
    await Promise.race([
      admin.client`SELECT 1`,
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error("connection timeout")), 3_000),
      ),
    ]);
  } catch (error) {
    unavailable = `PostgreSQL unavailable at ${adminUrl.host}: ${error instanceof Error ? error.message : String(error)}`;
    await admin?.client.end({ timeout: 1 }).catch(() => {});
    admin = undefined;
    return;
  }
  await admin.client.unsafe(`CREATE DATABASE "${databaseName}"`);
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const migration = spawnSync("pnpm", ["db:migrate"], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: databaseUrl.toString() },
    encoding: "utf8",
  });
  if (migration.status !== 0) throw new Error(`Migration failed: ${migration.stderr}`);
  handle = createDb(databaseUrl.toString());
  const [org] = await handle.client`INSERT INTO orgs (name) VALUES ('pi') RETURNING id`;
  const [other] = await handle.client`INSERT INTO orgs (name) VALUES ('other') RETURNING id`;
  orgId = String(org?.id);
  otherOrgId = String(other?.id);
}, 60_000);
afterAll(async () => {
  for (const store of stores.splice(0)) await store.close(context).catch(() => {});
  await handle?.client.end({ timeout: 5 });
  if (admin) {
    await admin.client.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await admin.client.end({ timeout: 5 });
  }
});
function client() {
  if (!handle) throw new Error("PostgreSQL fixture is not ready");
  return handle.client;
}
async function open(
  tenantId: string = orgId,
  sessionId: string = randomUUID(),
  options: Parameters<typeof PostgresPiStorage.open>[2] = {},
) {
  const storage = await PostgresPiStorage.open(client(), { tenantId, sessionId }, options);
  stores.push(storage);
  return storage;
}

describe("Pi public Storage conformance: PostgreSQL", () => {
  // Real database round trips: the growth cases issue hundreds of commits.
  for (const test of createStorageConformance(async () => {
    const storage = await PostgresPiStorage.open(client(), {
      tenantId: orgId,
      sessionId: randomUUID(),
    });
    return {
      storage,
      async [Symbol.asyncDispose]() {
        await storage.close(context);
      },
    };
  }))
    it(`${test.group}: ${test.name}`, (ctx) => {
      if (unavailable) return ctx.skip(unavailable);
      return test.run();
    }, 60_000);
});

describe("PostgreSQL Pi storage durability and tenancy", () => {
  it("rolls back entries, journal, projections and sequence when a later write fails", async (ctx) => {
    if (unavailable) return ctx.skip(unavailable);
    const s = await open();
    await client().unsafe(`CREATE OR REPLACE FUNCTION reject_marker() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'write rejected'; END $$ LANGUAGE plpgsql;
      CREATE TRIGGER reject_marker BEFORE INSERT ON pi_values FOR EACH ROW EXECUTE FUNCTION reject_marker();`);
    try {
      await expect(s.commit([entry("root"), setValue(marker, "failed")], context)).rejects.toThrow(
        "write rejected",
      );
      expect(await s.readCommits()).toEqual([]);
      expect(await s.getEntries(["root"], context)).toEqual(new Map());
      expect((await s.getStats(context)).messageCount).toBe(0);
    } finally {
      await client().unsafe("DROP TRIGGER reject_marker ON pi_values");
    }
    expect((await s.commit([entry("root")], context)).firstSeq).toBe(1);
  });

  it("scopes every read, parent lookup and journal by organization and session", async (ctx) => {
    if (unavailable) return ctx.skip(unavailable);
    const sessionId = randomUUID();
    const a = await open(orgId, sessionId);
    const b = await open(otherOrgId, sessionId);
    const c = await open(orgId, randomUUID());
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
      await expect(other.commit([entry("child", "private-root")], context)).rejects.toThrow(
        "Missing parent",
      );
      expect((await other.commit([entry("same-id")], context)).firstSeq).toBe(1);
    }
    expect((await a.getEntries(["same-id"], context)).get("same-id")?.seq).toBe(2);
    await expect(
      PostgresPiStorage.open(client(), { tenantId: "not-a-uuid", sessionId }, {}),
    ).rejects.toThrow();
  });

  it("rebuilds projections from the immutable journal and rejects damaged history", async (ctx) => {
    if (unavailable) return ctx.skip(unavailable);
    const s = await open();
    await s.commit(
      [entry("root"), setValue(marker, "old"), appendList(inbox, "discarded")],
      context,
    );
    await s.commit(
      [
        entry("child", "root"),
        setValue(marker, "current"),
        deleteList(inbox),
        appendList(inbox, "pending"),
      ],
      context,
    );
    const before = await s.scanEntries({}, context);
    const journal = await s.readCommits();
    expect(journal.map((c) => c.firstSeq)).toEqual([1, 4]);
    const [tenant, session] = [s.scope.tenantId, s.scope.sessionId];
    for (const table of ["pi_entries", "pi_values", "pi_lists"])
      await client().unsafe(`DELETE FROM ${table} WHERE org_id=$1 AND session_id=$2`, [
        tenant,
        session,
      ]);
    expect((await s.rebuildProjections()).nextSeq).toBe(8);
    expect(await s.scanEntries({}, context)).toEqual(before);
    expect(await s.readCommits()).toEqual(journal);
    expect((await s.getValue(marker, context))?.value).toBe("current");
    expect(await s.readList(inbox, undefined, context)).toEqual([{ seq: 7, value: "pending" }]);
    await client().unsafe(
      "UPDATE pi_commits SET data='{}' WHERE org_id=$1 AND session_id=$2 AND first_seq=4",
      [tenant, session],
    );
    await expect(s.rebuildProjections()).rejects.toThrow("digest mismatch");
    expect(await s.scanEntries({}, context)).toEqual(before);
    await expect(s.readCommits()).rejects.toThrow("digest mismatch");
  });

  it("checks ownership before and after writes and rolls back on a stale owner", async (ctx) => {
    if (unavailable) return ctx.skip(unavailable);
    let owns = true;
    let checks = 0;
    let loseAfterWrite = false;
    const s = await open(orgId, randomUUID(), {
      assertOwnership: async () => {
        checks++;
        if (!owns || (loseAfterWrite && checks % 2 === 0)) throw new Error("stale owner");
      },
    });
    loseAfterWrite = true;
    checks = 0;
    await expect(s.commit([entry("lost")], context)).rejects.toThrow("stale owner");
    expect(await s.readCommits()).toEqual([]);
    expect(await s.getEntries(["lost"], context)).toEqual(new Map());
    loseAfterWrite = false;
    owns = false;
    await expect(s.commit([setValue(marker, "late")], context)).rejects.toThrow("stale owner");
    expect(await s.getValue(marker, context)).toBeUndefined();
  });

  it("commits host rows atomically inside a host-owned transaction", async (ctx) => {
    if (unavailable) return ctx.skip(unavailable);
    await client().unsafe("CREATE TABLE IF NOT EXISTS host_rows (id text PRIMARY KEY)");
    let failNext = false;
    const transaction = <T>(operation: (exec: PiSqlExecutor) => Promise<T>) =>
      client().begin(async (tx) => {
        const exec: PiSqlExecutor = async (query, params) =>
          (await tx.unsafe(query, params as never)) as unknown as Record<string, unknown>[];
        const result = await operation(exec);
        await tx.unsafe("INSERT INTO host_rows (id) VALUES ($1)", [randomUUID()]);
        if (failNext) throw new Error("host commit rejected");
        return result;
      }) as Promise<T>;
    const s = await open(orgId, randomUUID(), { transaction });
    const hostRows = async () =>
      Number((await client().unsafe("SELECT COUNT(*) AS count FROM host_rows"))[0]?.count);
    const base = await hostRows();
    await s.commit([entry("root")], context);
    expect(await hostRows()).toBe(base + 1);
    failNext = true;
    await expect(s.commit([entry("child", "root")], context)).rejects.toThrow(
      "host commit rejected",
    );
    expect(await hostRows()).toBe(base + 1);
    expect(await s.getEntries(["child"], context)).toEqual(new Map());
    expect((await s.readCommits()).map((c) => c.firstSeq)).toEqual([1]);
    failNext = false;
    expect((await s.commit([entry("child", "root")], context)).firstSeq).toBe(2);
    expect(await hostRows()).toBe(base + 2);
  });

  it("serializes admitted writes, freezes inputs and drains on close", async (ctx) => {
    if (unavailable) return ctx.skip(unavailable);
    const s = await open();
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
    const reopened = await open(s.scope.tenantId, s.scope.sessionId);
    expect((await reopened.getValue(address, context))?.value).toEqual({ items: ["accepted"] });
    expect((await reopened.getValue(marker, context))?.value).toBe("second");
  });
});
