import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { Context } from "@earendil-works/pi-agent-core/harness/context";
import {
  type CommittedWrite,
  createForkSnapshot,
  type Entry,
  type EntryScan,
  type EntryStructure,
  type ForkOptions,
  type ListElement,
  type ListReadOptions,
  prepareStorageCommit,
  resolveListReadOptions,
  type SessionStats,
  type Storage,
  type StorageBranchScan,
  type StoredValue,
  type UsageRow,
  type UsageScan,
  type Value,
  type ValueList,
  validateCommittedWrites,
  value,
  type Write,
} from "@earendil-works/pi-agent-core/harness/session";
import {
  type PiStorageScope,
  piStorageCommit,
  piStorageFormat,
  piStorageScope,
} from "@nimplex/contracts";
import { initializePiStorage } from "./schema.ts";

const FORMAT = { version: 1, engine: "pi-agent-harness", piVersion: "0.85.1" } as const;
const EMPTY_STATS: SessionStats = {
  messageCount: 0,
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
};

/**
 * Indexed storage for Pi's public async Storage port. The host owns the database
 * connection and supplies an ownership check that runs inside every transaction.
 * This adapter is qualified separately and does not select the runtime engine.
 */
export class SqlitePiStorage implements Storage {
  private readonly scope: PiStorageScope;
  private queue: Promise<void> = Promise.resolve();
  private closing?: Promise<void>;
  private readonly transaction: <T>(operation: () => T) => T;

  constructor(
    private readonly db: DatabaseSync,
    scope: PiStorageScope,
    private readonly assertOwnership: () => void,
    options: {
      /**
       * Host-owned transaction runner sharing this connection. The host commits its
       * own rows in the same SQLite transaction and performs its own ownership checks.
       */
      transaction?: <T>(operation: () => T) => T;
    } = {},
  ) {
    this.scope = piStorageScope.parse(scope);
    this.transaction = options.transaction ?? ((operation) => this.ownTransaction(operation));
    this.transaction(() => {
      initializePiStorage(db);
      const current = db
        .prepare("SELECT format FROM pi_store_sessions WHERE tenant_id=? AND session_id=?")
        .get(...this.keys);
      if (current) piStorageFormat.parse(JSON.parse(String(current.format)));
      else
        db.prepare("INSERT INTO pi_store_sessions VALUES (?,?,?,?,?)").run(
          ...this.keys,
          JSON.stringify(FORMAT),
          1,
          JSON.stringify(EMPTY_STATS),
        );
    });
  }
  get keys(): [string, string] {
    return [this.scope.tenantId, this.scope.sessionId];
  }
  private assertOpen() {
    if (this.closing) throw new Error("Pi storage is closed");
  }
  private validate(writes: CommittedWrite[], firstSeq: number) {
    const entry = this.db.prepare(
      "SELECT 1 FROM pi_store_entries WHERE tenant_id=? AND session_id=? AND id=?",
    );
    const usage = this.db.prepare(
      "SELECT 1 FROM pi_store_usage WHERE tenant_id=? AND session_id=? AND id=?",
    );
    validateCommittedWrites(writes, firstSeq, {
      hasEntryId: (id) => Boolean(entry.get(...this.keys, id)),
      hasEntryOrUsageId: (id) =>
        Boolean(entry.get(...this.keys, id) || usage.get(...this.keys, id)),
    });
  }
  private ownTransaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.assertOwnership();
      const result = operation();
      this.assertOwnership();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  async commit(writes: Write[], _context: Context) {
    this.assertOpen();
    const input = structuredClone(writes);
    const result = this.queue.then(() => this.transaction(() => this.commitSync(input)));
    this.queue = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  /**
   * Apply one commit batch on the current connection. The caller must already hold
   * a transaction and must serialize commits; `commit` does both for ordinary use.
   * A host that owns the transaction can commit its own rows atomically with Pi's.
   */
  commitSync(writes: Write[]) {
    const row = this.sessionRow();
    const prepared = prepareStorageCommit(writes, row.nextSeq, Date.now());
    return this.applyCommitted(row, prepared.writes, prepared.result.timestamp);
  }
  private sessionRow() {
    const row = this.db
      .prepare("SELECT next_seq,stats FROM pi_store_sessions WHERE tenant_id=? AND session_id=?")
      .get(...this.keys);
    if (!row) throw new Error("Pi storage session is missing");
    return {
      nextSeq: Number(row.next_seq),
      stats: JSON.parse(String(row.stats)) as SessionStats,
    };
  }
  /** Journal and project already sequenced writes; the caller holds the transaction. */
  private applyCommitted(
    row: { nextSeq: number; stats: SessionStats },
    writes: CommittedWrite[],
    timestamp: number,
  ) {
    this.validate(writes, row.nextSeq);
    const stats = row.stats;
    if (writes.length) {
      const envelope = piStorageCommit.parse({
        version: 1,
        format: FORMAT,
        scope: this.scope,
        commitId: randomUUID(),
        committedAt: timestamp,
        firstSeq: row.nextSeq,
        // Optional Pi fields are absent in the persisted JSON representation.
        writes: JSON.parse(
          JSON.stringify(writes, (_key, item: unknown) => {
            if (typeof item === "number" && !Number.isFinite(item))
              throw new Error("Pi records must contain finite JSON numbers");
            return item;
          }),
        ),
      });
      const data = JSON.stringify(envelope);
      this.db
        .prepare("INSERT INTO pi_store_commits VALUES (?,?,?,?,?,?,?)")
        .run(
          ...this.keys,
          envelope.commitId,
          envelope.firstSeq,
          envelope.firstSeq + envelope.writes.length - 1,
          createHash("sha256").update(data).digest("hex"),
          data,
        );
    }
    for (const write of writes) this.apply(write, stats);
    this.db
      .prepare("UPDATE pi_store_sessions SET next_seq=?,stats=? WHERE tenant_id=? AND session_id=?")
      .run(row.nextSeq + writes.length, JSON.stringify(stats), ...this.keys);
    return {
      firstSeq: row.nextSeq,
      seqs: writes.map((write) => write.seq),
      timestamp,
      stats,
    };
  }
  /**
   * Copy a Pi session path into this empty scope using Pi's fork policy. Entries keep
   * their identity and timestamps; sequence numbers are reassigned contiguously so the
   * journal stays rebuildable. The caller holds the transaction that also creates the
   * destination's host records.
   */
  importForkSync(source: SqlitePiStorage, options: ForkOptions) {
    const row = this.sessionRow();
    if (row.nextSeq !== 1) throw new Error("Pi fork destination must be empty");
    const entries: Entry[] = this.db
      .prepare("SELECT data FROM pi_store_entries WHERE tenant_id=? AND session_id=? ORDER BY seq")
      .all(...source.keys)
      .map((entry) => JSON.parse(String(entry.data)));
    const scalarValues: StoredValue<unknown>[] = this.db
      .prepare(
        "SELECT namespace,key,seq,data FROM pi_store_values WHERE tenant_id=? AND session_id=? ORDER BY seq",
      )
      .all(...source.keys)
      .map((stored) => ({
        address: value(String(stored.namespace), String(stored.key)),
        seq: Number(stored.seq),
        value: JSON.parse(String(stored.data)),
      }));
    const snapshot = createForkSnapshot({ entries, scalarValues }, options);
    const ordered: CommittedWrite[] = [
      ...[...snapshot.entries.values()].map((entry) => ({ kind: "entry" as const, ...entry })),
      ...snapshot.scalarValues.map((stored) => ({
        kind: "value" as const,
        op: "set" as const,
        seq: stored.seq,
        namespace: stored.address.namespace,
        key: stored.address.key,
        value: stored.value,
      })),
    ].sort((left, right) => left.seq - right.seq);
    const writes = ordered.map(
      (write, index) => ({ ...write, seq: row.nextSeq + index }) as CommittedWrite,
    );
    return this.applyCommitted(row, writes, Date.now());
  }
  private apply(write: CommittedWrite, stats: SessionStats) {
    if (write.kind === "entry") {
      const { kind: _kind, ...entry } = write;
      this.db
        .prepare("INSERT INTO pi_store_entries VALUES (?,?,?,?,?,?,?,?,?)")
        .run(
          ...this.keys,
          entry.id,
          entry.parentId,
          entry.seq,
          entry.timestamp,
          entry.type,
          entry.customType ?? null,
          JSON.stringify(entry),
        );
      if (entry.type === "message") stats.messageCount++;
    } else if (write.kind === "usage") {
      const { kind: _kind, ...usage } = write;
      this.db
        .prepare("INSERT INTO pi_store_usage VALUES (?,?,?,?,?)")
        .run(...this.keys, usage.id, usage.seq, JSON.stringify(usage));
      for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const)
        stats.usage[key] += usage.usage[key];
      for (const key of ["cacheWrite1h", "reasoning"] as const) {
        if (usage.usage[key] !== undefined)
          stats.usage[key] = (stats.usage[key] ?? 0) + usage.usage[key];
      }
      for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const)
        stats.usage.cost[key] += usage.usage.cost[key];
    } else {
      const table = write.kind === "value" ? "pi_store_values" : "pi_store_lists";
      if (write.op === "delete") {
        this.db
          .prepare(
            `DELETE FROM ${table} WHERE tenant_id=? AND session_id=? AND namespace=? AND key=?`,
          )
          .run(...this.keys, write.namespace, write.key);
      } else {
        const data = JSON.stringify(write.value);
        if (data === undefined) throw new Error("Pi values must be JSON serializable");
        this.db
          .prepare(
            `INSERT INTO ${table} VALUES (?,?,?,?,?,?) ${write.kind === "value" ? "ON CONFLICT(tenant_id,session_id,namespace,key) DO UPDATE SET seq=excluded.seq,data=excluded.data" : ""}`,
          )
          .run(...this.keys, write.namespace, write.key, write.seq, data);
      }
    }
  }
  async getEntries(ids: string[], _context: Context): Promise<Map<string, Entry>> {
    this.assertOpen();
    const statement = this.db.prepare(
      "SELECT data FROM pi_store_entries WHERE tenant_id=? AND session_id=? AND id=?",
    );
    const found = new Map<string, Entry>();
    for (const id of ids) {
      const row = statement.get(...this.keys, id);
      if (row) found.set(id, JSON.parse(String(row.data)));
    }
    return found;
  }
  async getValue<T>(address: Value<T>, _context: Context): Promise<StoredValue<T> | undefined> {
    this.assertOpen();
    const row = this.db
      .prepare(
        "SELECT seq,data FROM pi_store_values WHERE tenant_id=? AND session_id=? AND namespace=? AND key=?",
      )
      .get(...this.keys, address.namespace, address.key);
    return row
      ? { address: { ...address }, seq: Number(row.seq), value: JSON.parse(String(row.data)) }
      : undefined;
  }
  async scanValues<T>(prefix: Value<T>, _context: Context): Promise<StoredValue<T>[]> {
    this.assertOpen();
    return this.db
      .prepare(
        "SELECT key,seq,data FROM pi_store_values WHERE tenant_id=? AND session_id=? AND namespace=? AND substr(key,1,length(?))=? ORDER BY key COLLATE BINARY",
      )
      .all(...this.keys, prefix.namespace, prefix.key, prefix.key)
      .map((row) => ({
        address: value<T>(prefix.namespace, String(row.key)),
        seq: Number(row.seq),
        value: JSON.parse(String(row.data)),
      }));
  }
  async readList<T>(
    address: ValueList<T>,
    options: ListReadOptions | undefined,
    _context: Context,
  ): Promise<ListElement<T>[]> {
    this.assertOpen();
    const opts = resolveListReadOptions(options);
    const direction = opts.order === "asc" ? "ASC" : "DESC";
    return this.db
      .prepare(
        `SELECT seq,data FROM pi_store_lists WHERE tenant_id=? AND session_id=? AND namespace=? AND key=? ${opts.cursor ? `AND seq ${opts.order === "asc" ? ">" : "<"} ?` : ""} ORDER BY seq ${direction} LIMIT ?`,
      )
      .all(
        ...this.keys,
        address.namespace,
        address.key,
        ...(opts.cursor ? [opts.cursor.seq] : []),
        opts.limit,
      )
      .map((row) => ({ seq: Number(row.seq), value: JSON.parse(String(row.data)) }));
  }
  private branchRows(query: StorageBranchScan, includeData: boolean) {
    const rows = this.db
      .prepare(`WITH RECURSIVE path AS (
      SELECT * FROM pi_store_entries WHERE tenant_id=? AND session_id=? AND id=?
      UNION ALL SELECT e.* FROM pi_store_entries e JOIN path p ON e.tenant_id=p.tenant_id AND e.session_id=p.session_id AND e.id=p.parent_id
    ) SELECT id,parent_id,seq,timestamp,type,custom_type ${includeData ? ",data" : ""} FROM path ORDER BY seq ${query.order === "oldestFirst" ? "ASC" : "DESC"}`)
      .all(...this.keys, query.start);
    if (!rows.length) throw new Error(`Unknown branch start: ${query.start}`);
    const root = query.order === "oldestFirst" ? rows[0] : rows.at(-1);
    if (root?.parent_id !== null) throw new Error("Corrupt branch: missing parent");
    const stopped = rows.findIndex(
      (row) => row.id === query.stopAtId || row.type === query.stopAtType,
    );
    const path = stopped < 0 ? rows : rows.slice(0, stopped + 1);
    const selected = path.filter(
      (row) =>
        (query.type === undefined || row.type === query.type) &&
        (query.customType === undefined || row.custom_type === query.customType) &&
        (query.cursor === undefined ||
          (query.order === "oldestFirst"
            ? Number(row.seq) > query.cursor.seq
            : Number(row.seq) < query.cursor.seq)),
    );
    return query.limit === undefined ? selected : selected.slice(0, Math.max(0, query.limit));
  }
  async scanBranch(query: StorageBranchScan, _context: Context): Promise<Entry[]> {
    this.assertOpen();
    return this.branchRows(query, true).map((row) => JSON.parse(String(row.data)));
  }
  async scanBranchStructure(
    query: StorageBranchScan,
    _context: Context,
  ): Promise<EntryStructure[]> {
    this.assertOpen();
    return this.branchRows(query, false).map((row) => ({
      id: String(row.id),
      parentId: row.parent_id === null ? null : String(row.parent_id),
      seq: Number(row.seq),
      timestamp: Number(row.timestamp),
      type: row.type as EntryStructure["type"],
      ...(row.custom_type === null ? {} : { customType: String(row.custom_type) }),
    }));
  }
  private scan(table: "pi_store_entries" | "pi_store_usage", query: EntryScan | UsageScan) {
    const conditions = ["tenant_id=?", "session_id=?"];
    const params: SQLInputValue[] = this.keys;
    for (const [key, operator] of [
      ["fromSeq", ">="],
      ["toSeq", "<="],
    ] as const) {
      if (query[key] !== undefined) {
        conditions.push(`seq ${operator} ?`);
        params.push(query[key]);
      }
    }
    if ("type" in query && query.type !== undefined) {
      conditions.push("type=?");
      params.push(query.type);
    }
    if ("customType" in query && query.customType !== undefined) {
      conditions.push("custom_type=?");
      params.push(query.customType);
    }
    if (query.limit !== undefined) params.push(Math.max(0, Math.trunc(query.limit)));
    return this.db
      .prepare(
        `SELECT data FROM ${table} WHERE ${conditions.join(" AND ")} ORDER BY seq ${query.order === "desc" ? "DESC" : "ASC"} ${query.limit === undefined ? "" : "LIMIT ?"}`,
      )
      .all(...params)
      .map((row) => JSON.parse(String(row.data)));
  }
  async scanEntries(query: EntryScan, _context: Context): Promise<Entry[]> {
    this.assertOpen();
    return this.scan("pi_store_entries", query);
  }
  async scanUsage(query: UsageScan, _context: Context): Promise<UsageRow[]> {
    this.assertOpen();
    return this.scan("pi_store_usage", query);
  }
  async getStats(_context: Context): Promise<SessionStats> {
    this.assertOpen();
    const row = this.db
      .prepare("SELECT stats FROM pi_store_sessions WHERE tenant_id=? AND session_id=?")
      .get(...this.keys);
    if (!row) throw new Error("Pi storage session is missing");
    return JSON.parse(String(row.stats));
  }
  private decodeCommit(row: Record<string, unknown>) {
    const data = String(row.data);
    if (createHash("sha256").update(data).digest("hex") !== row.digest)
      throw new Error("Pi commit digest mismatch");
    const commit = piStorageCommit.parse(JSON.parse(data));
    if (
      commit.scope.tenantId !== this.scope.tenantId ||
      commit.scope.sessionId !== this.scope.sessionId
    )
      throw new Error("Pi commit scope mismatch");
    return commit;
  }
  /** Rebuild only under exclusive ownership, with no attached live harness. */
  async rebuildProjections() {
    this.assertOpen();
    const result = this.queue.then(() =>
      this.transaction(() => {
        const row = this.db
          .prepare(
            "SELECT format,next_seq FROM pi_store_sessions WHERE tenant_id=? AND session_id=?",
          )
          .get(...this.keys);
        if (!row) throw new Error("Pi storage session is missing");
        piStorageFormat.parse(JSON.parse(String(row.format)));
        for (const table of [
          "pi_store_entries",
          "pi_store_usage",
          "pi_store_values",
          "pi_store_lists",
        ])
          this.db
            .prepare(`DELETE FROM ${table} WHERE tenant_id=? AND session_id=?`)
            .run(...this.keys);
        const stats = structuredClone(EMPTY_STATS);
        let nextSeq = 1;
        const journal = this.db.prepare(
          "SELECT first_seq,last_seq,digest,data FROM pi_store_commits WHERE tenant_id=? AND session_id=? ORDER BY first_seq",
        );
        for (const record of journal.iterate(...this.keys)) {
          const commit = this.decodeCommit(record);
          if (
            commit.firstSeq !== nextSeq ||
            Number(record.first_seq) !== nextSeq ||
            Number(record.last_seq) !== nextSeq + commit.writes.length - 1
          )
            throw new Error("Pi commit sequence gap");
          // Only replay this adapter's checksummed writes for the exact pinned format.
          // This is not an importer for arbitrary external Pi JSONL.
          const writes = commit.writes as unknown as CommittedWrite[];
          if (writes.some((write, index) => write.seq !== nextSeq + index))
            throw new Error("Pi write sequence gap");
          this.validate(writes, nextSeq);
          for (const write of writes) this.apply(write, stats);
          nextSeq += writes.length;
        }
        if (nextSeq !== Number(row.next_seq)) throw new Error("Pi journal high-water mismatch");
        this.db
          .prepare("UPDATE pi_store_sessions SET stats=? WHERE tenant_id=? AND session_id=?")
          .run(JSON.stringify(stats), ...this.keys);
        return { nextSeq, stats };
      }),
    );
    this.queue = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  /** Immutable commit batches include deleted values/queues, unlike their projections. */
  async readCommits(afterSeq = 0, limit = 100) {
    this.assertOpen();
    if (
      !Number.isSafeInteger(afterSeq) ||
      afterSeq < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 1000
    )
      throw new Error("Invalid Pi commit page");
    return this.db
      .prepare(
        "SELECT digest,data FROM pi_store_commits WHERE tenant_id=? AND session_id=? AND last_seq>? ORDER BY first_seq LIMIT ?",
      )
      .all(...this.keys, afterSeq, limit)
      .map((row) => this.decodeCommit(row));
  }
  close(_context: Context): Promise<void> {
    this.closing ??= this.queue;
    return this.closing;
  }
}
