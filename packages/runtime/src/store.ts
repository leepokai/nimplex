import { chmodSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AcceptedTurnInput,
  RunEvent,
  RunResponse,
  StartTurnRequest,
  WorkspaceMetadata,
} from "@nimplex/contracts";
import { acceptedTurnInput } from "@nimplex/contracts";
import type { ExecutorEvent, SandboxSessionState } from "@nimplex/core";

/**
 * Execution engine that owns a session's authoritative history. Absent on records
 * written before schema version 3, which always used the default executor.
 */
export type SessionEngine = "pi-executor" | "pi-harness";

/** Local Pi storage scope: one tenant, one Pi session per nimplex session, one lane. */
export const PI_TENANT = "local";
export const PI_LANE = "main";

export interface StoredSession {
  id: string;
  cwd: string;
  title: string;
  updatedAt: string;
  turnIds: string[];
  parentSessionId?: string;
  sandboxState?: SandboxSessionState;
  sandboxProvider?: "docker" | "e2b";
  sandboxGeneration: number;
  engine?: SessionEngine;
}
export interface StoredTurn {
  sessionId: string;
  request: StartTurnRequest;
  config: {
    instructions: string;
    input: string;
    prior_messages: Record<string, unknown>[];
    execution_mode: "build" | "read_only";
    compact_context: boolean;
  };
  result: RunResponse;
}
export interface Workspace {
  files: Record<string, Uint8Array>;
  metadata: WorkspaceMetadata;
}

/** One owner per state root. SQLite's OS lock is released even after SIGKILL.
 * The ownership database is separate so application transactions stay short.
 */
export class RuntimeStore {
  readonly directory: string;
  private owner: DatabaseSync;
  /** Shared connection: engine adapters commit their rows inside `transaction`. */
  readonly db: DatabaseSync;
  private closed = false;
  constructor(directory: string) {
    this.directory = resolve(directory);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    chmodSync(this.directory, 0o700);
    const ownerPath = join(this.directory, "owner.sqlite");
    this.owner = new DatabaseSync(ownerPath);
    chmodSync(ownerPath, 0o600);
    try {
      this.owner.exec("BEGIN IMMEDIATE");
    } catch {
      this.owner.close();
      throw new Error(
        `A runtime already owns ${this.directory}. Close that terminal first, or choose a different --state-dir.`,
      );
    }
    let openedDb: DatabaseSync | undefined;
    try {
      const path = join(this.directory, "runtime.sqlite");
      this.db = openedDb = new DatabaseSync(path);
      chmodSync(path, 0o600);
      const version = Number(this.db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
      // Version 3 records the per-session engine; older readers must not run the
      // default executor against a harness-owned session.
      if (version > 3) {
        throw new Error(`Unsupported runtime database version: ${version}`);
      }
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
      this.transaction(() =>
        this.db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS turns (id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS events (turn_id TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(turn_id,seq));
        CREATE TABLE IF NOT EXISTS workspaces (turn_id TEXT PRIMARY KEY, files TEXT NOT NULL, metadata TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS accepted_inputs (
          session_id TEXT NOT NULL,
          request_id TEXT NOT NULL,
          data TEXT NOT NULL,
          PRIMARY KEY(session_id,request_id)
        );
        PRAGMA user_version=3;`),
      );
    } catch (error) {
      openedDb?.close();
      this.owner.close();
      throw error;
    }
  }
  transaction<T>(operation: () => T): T {
    if (this.closed) throw new Error("Runtime is closed.");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = operation();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private read<T>(table: "sessions" | "turns", id: string): T {
    const row = this.db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id);
    if (!row) throw new Error(`${table === "sessions" ? "Session" : "Turn"} not found: ${id}`);
    return JSON.parse(String(row.data)) as T;
  }
  session(id: string) {
    return this.read<StoredSession>("sessions", id);
  }
  turn(id: string) {
    return this.read<StoredTurn>("turns", id);
  }
  sessions(): StoredSession[] {
    return this.db
      .prepare("SELECT data FROM sessions")
      .all()
      .map((row) => JSON.parse(String(row.data)) as StoredSession);
  }
  turns(): StoredTurn[] {
    return this.db
      .prepare("SELECT data FROM turns")
      .all()
      .map((row) => JSON.parse(String(row.data)) as StoredTurn);
  }
  /** Only for sessions that own no turns; turn history is never deleted through this path. */
  deleteSession(id: string) {
    const session = this.session(id);
    if (session.turnIds.length) throw new Error("Sessions with turns cannot be deleted.");
    this.db.prepare("DELETE FROM sessions WHERE id=?").run(id);
  }
  saveSession(session: StoredSession) {
    this.db
      .prepare("INSERT INTO sessions VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data")
      .run(session.id, JSON.stringify(session));
  }
  saveTurn(turn: StoredTurn) {
    this.db
      .prepare("INSERT INTO turns VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data")
      .run(turn.result.id, JSON.stringify(turn));
  }
  acceptedInput(sessionId: string, requestId: string): AcceptedTurnInput | undefined {
    const row = this.db
      .prepare("SELECT data FROM accepted_inputs WHERE session_id=? AND request_id=?")
      .get(sessionId, requestId);
    return row ? acceptedTurnInput.parse(JSON.parse(String(row.data))) : undefined;
  }
  saveAcceptedInput(input: AcceptedTurnInput) {
    const value = acceptedTurnInput.parse(input);
    this.db
      .prepare("INSERT INTO accepted_inputs VALUES (?,?,?)")
      .run(value.sessionId, value.requestId, JSON.stringify(value));
  }
  events(id: string, after = -1): RunEvent[] {
    return this.db
      .prepare("SELECT data FROM events WHERE turn_id=? AND seq>? ORDER BY seq")
      .all(id, after)
      .map((row) => JSON.parse(String(row.data)) as RunEvent);
  }
  append(id: string, events: ExecutorEvent[]) {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(seq),-1) AS seq FROM events WHERE turn_id=?")
      .get(id);
    let seq = Number(row?.seq ?? -1);
    const insert = this.db.prepare("INSERT INTO events VALUES (?,?,?)");
    for (const event of events) {
      const record = { ...event, seq: ++seq, created_at: new Date().toISOString() };
      insert.run(id, seq, JSON.stringify(record));
    }
  }
  workspace(id?: string): Workspace {
    if (!id) return { files: {}, metadata: {} };
    const row = this.db.prepare("SELECT files,metadata FROM workspaces WHERE turn_id=?").get(id);
    if (!row) throw new Error(`Workspace not found: ${id}`);
    const encoded = JSON.parse(String(row.files)) as Record<string, string>;
    return {
      files: Object.fromEntries(
        Object.entries(encoded).map(([path, data]) => [
          path,
          new Uint8Array(Buffer.from(data, "base64")),
        ]),
      ),
      metadata: JSON.parse(String(row.metadata)),
    };
  }
  saveWorkspace(id: string, workspace: Workspace) {
    const files = Object.fromEntries(
      Object.entries(workspace.files).map(([path, data]) => [
        path,
        Buffer.from(data).toString("base64"),
      ]),
    );
    this.db
      .prepare(
        "INSERT INTO workspaces VALUES (?,?,?) ON CONFLICT(turn_id) DO UPDATE SET files=excluded.files,metadata=excluded.metadata",
      )
      .run(id, JSON.stringify(files), JSON.stringify(workspace.metadata));
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.close();
    } finally {
      this.owner.close();
    }
  }
}
