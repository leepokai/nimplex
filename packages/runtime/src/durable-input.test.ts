import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { startTurnRequest } from "@nimplex/contracts";
import { startFakeAnthropic } from "@nimplex/testkit";
import { afterEach, expect, it } from "vitest";
import { NimplexRuntime } from "./runtime.ts";
import { RuntimeStore } from "./store.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "nimplex-inbox-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const upstream = await startFakeAnthropic(0, { delayMs: 20 });
  cleanup.push(upstream.close);
  const options = { directory, credential: () => ({ apiKey: "synthetic", baseUrl: upstream.url }) };
  const runtime = new NimplexRuntime(options);
  cleanup.push(() => runtime.close());
  return { directory, upstream, options, runtime, session: runtime.createSession(directory) };
}
const request = (extra = {}) =>
  startTurnRequest.parse({
    prompt: "Work once",
    requestId: "client-request-1",
    sandbox: "docker",
    ...extra,
  });
async function finish(runtime: NimplexRuntime, id: string) {
  for await (const _event of runtime.events(id)) {
    // Consume until the accepted turn settles.
  }
}

it("deduplicates concurrent, completed and restarted submissions without repeating model calls", async () => {
  const f = await fixture();
  const [first, duplicate] = await Promise.all([
    f.runtime.startTurn(f.session.id, request()),
    f.runtime.startTurn(f.session.id, request()),
  ]);
  expect(duplicate).toEqual(first);
  await finish(f.runtime, first.runId);
  expect(await f.runtime.startTurn(f.session.id, request())).toEqual(first);
  expect(f.upstream.state.messagesCalls).toHaveLength(1);
  await f.runtime.close();
  const reopened = new NimplexRuntime(f.options);
  cleanup.push(() => reopened.close());
  expect(await reopened.startTurn(f.session.id, request())).toEqual(first);
  expect(reopened.getSession(f.session.id).turns).toHaveLength(1);
  expect(f.upstream.state.messagesCalls).toHaveLength(1);
  expect(
    reopened.getSession(f.session.id).turns[0]?.events.filter((e) => e.type === "input.accepted"),
  ).toHaveLength(1);
});

it("rejects conflicting content under an accepted ID and scopes deduplication to the owning session", async () => {
  const f = await fixture();
  const first = await f.runtime.startTurn(f.session.id, request());
  await expect(f.runtime.startTurn(f.session.id, request({ prompt: "Different" }))).rejects.toThrow(
    "different content",
  );
  await expect(f.runtime.startTurn(f.session.id, request({ timeout: 240 }))).rejects.toThrow(
    "different content",
  );
  await finish(f.runtime, first.runId);
  const branch = f.runtime.forkSession(f.session.id);
  const other = await f.runtime.startTurn(branch.id, request());
  expect(other.runId).not.toBe(first.runId);
  await finish(f.runtime, other.runId);
  expect(f.upstream.state.messagesCalls).toHaveLength(2);
});

it("rolls acceptance, turn, events and workspace back on storage failure before dispatch", async () => {
  const f = await fixture();
  const db = new DatabaseSync(join(f.directory, "runtime.sqlite"));
  cleanup.push(() => db.close());
  db.exec(`CREATE TRIGGER fail_acceptance BEFORE INSERT ON accepted_inputs
    BEGIN SELECT RAISE(ABORT, 'injected acceptance failure'); END;`);
  await expect(
    f.runtime.startTurn(
      f.session.id,
      request({ attachments: [{ path: "/workspace/new.txt", content: "new" }] }),
    ),
  ).rejects.toThrow("injected acceptance failure");
  expect(f.runtime.getSession(f.session.id).turns).toEqual([]);
  for (const table of ["accepted_inputs", "turns", "events", "workspaces"]) {
    expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count).toBe(0);
  }
  expect(f.upstream.state.messagesCalls).toHaveLength(0);
  db.exec("DROP TRIGGER fail_acceptance");
  const result = await f.runtime.startTurn(f.session.id, request());
  await finish(f.runtime, result.runId);
  expect(f.upstream.state.messagesCalls).toHaveLength(1);
});

it("does not resume interrupted work when a caller retries durable acceptance", async () => {
  const f = await fixture();
  const response = await f.runtime.startTurn(f.session.id, request());
  await f.runtime.close();
  const callsBefore = f.upstream.state.messagesCalls.length;
  const reopened = new NimplexRuntime(f.options);
  cleanup.push(() => reopened.close());
  expect(await reopened.startTurn(f.session.id, request())).toEqual(response);
  expect(reopened.getTurn(response.runId).error).toBe("runtime_interrupted");
  expect(f.upstream.state.messagesCalls).toHaveLength(callsBefore);
});

it("migrates version 1 additively, retaining old history without inventing accepted IDs", () => {
  const directory = mkdtempSync(join(tmpdir(), "nimplex-inbox-migrate-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const db = new DatabaseSync(join(directory, "runtime.sqlite"));
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE turns (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE events (turn_id TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(turn_id,seq));
    CREATE TABLE workspaces (turn_id TEXT PRIMARY KEY, files TEXT NOT NULL, metadata TEXT NOT NULL);
    PRAGMA user_version=1;`);
  const oldEvent = JSON.stringify({
    seq: 0,
    type: "run.started",
    created_at: "2026-09-15T00:00:00.000Z",
  });
  db.prepare("INSERT INTO events VALUES (?,?,?)").run("old-turn", 0, oldEvent);
  db.close();
  const store = new RuntimeStore(directory);
  cleanup.push(() => store.close());
  expect(store.events("old-turn")).toEqual([JSON.parse(oldEvent)]);
  expect(store.acceptedInput("old-session", "old-request")).toBeUndefined();
});

it("generates an acceptance ID that callers can reuse without changing legacy no-ID submissions", async () => {
  const f = await fixture();
  const input = request({ requestId: undefined });
  const first = await f.runtime.startTurn(f.session.id, input);
  expect(first.requestId).toMatch(/^[a-f0-9-]{36}$/);
  expect(await f.runtime.startTurn(f.session.id, { ...input, requestId: first.requestId })).toEqual(
    first,
  );
  await finish(f.runtime, first.runId);
  const next = await f.runtime.startTurn(f.session.id, input);
  expect(next.requestId).not.toBe(first.requestId);
  await finish(f.runtime, next.runId);
  expect(f.upstream.state.messagesCalls).toHaveLength(2);
});

it("rolls a failed schema migration back and releases the owner for a subsequent open", () => {
  const directory = mkdtempSync(join(tmpdir(), "nimplex-inbox-migration-failure-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const db = new DatabaseSync(join(directory, "runtime.sqlite"));
  cleanup.push(() => db.close());
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE INDEX accepted_inputs ON sessions(id);
    PRAGMA user_version=1;`);
  expect(() => new RuntimeStore(directory)).toThrow();
  expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(1);
  expect(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all(),
  ).toEqual([{ name: "sessions" }]);
  db.exec("DROP INDEX accepted_inputs");
  const store = new RuntimeStore(directory);
  cleanup.push(() => store.close());
  expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(4);
});

it("retries a legacy accepted request after upgrade without replaying its model call", async () => {
  const f = await fixture();
  const first = await f.runtime.startTurn(f.session.id, request());
  await finish(f.runtime, first.runId);
  await f.runtime.close();
  const db = new DatabaseSync(join(f.directory, "runtime.sqlite"));
  const row = db.prepare("SELECT data FROM accepted_inputs WHERE session_id=?").get(f.session.id);
  const legacy = JSON.parse(String(row?.data));
  legacy.request.budget = 0.2;
  db.prepare("UPDATE accepted_inputs SET data=? WHERE session_id=?").run(
    JSON.stringify(legacy),
    f.session.id,
  );
  db.exec("PRAGMA user_version=3");
  db.close();
  const reopened = new NimplexRuntime(f.options);
  cleanup.push(() => reopened.close());
  expect(await reopened.startTurn(f.session.id, request())).toEqual(first);
  expect(f.upstream.state.messagesCalls).toHaveLength(1);
  expect(reopened.getTurn(first.runId)).not.toHaveProperty("budget_usd");
});
