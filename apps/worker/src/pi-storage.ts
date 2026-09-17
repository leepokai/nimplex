import { createHash, randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/pi-agent-core/harness/context";
import {
  type CommittedWrite,
  type Entry,
  type EntryScan,
  type EntryStructure,
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
import type { DbHandle } from "@nimplex/db";

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

type Row = Record<string, unknown>;
/** Parameterized query runner bound to one connection or transaction. */
export type PiSqlExecutor = (query: string, params: unknown[]) => Promise<Row[]>;

export interface PostgresPiStorageOptions {
  /**
   * Host-owned transaction runner. The host commits its own rows in the same
   * transaction and performs its own ownership checks (for example lease fencing).
   */
  transaction?: <T>(operation: (exec: PiSqlExecutor) => Promise<T>) => Promise<T>;
  /** Ownership check run inside every adapter-owned transaction, before and after writes. */
  assertOwnership?: (exec: PiSqlExecutor) => Promise<void>;
}

/**
 * Hosted implementation of Pi's public async Storage port on PostgreSQL. Every row
 * carries the owning organization and Pi session; the immutable commit journal can
 * rebuild the indexed projections, mirroring the local SQLite adapter.
 */
export class PostgresPiStorage implements Storage {
  private queue: Promise<void> = Promise.resolve();
  private closing?: Promise<void>;
  private readonly runTransaction: <T>(
    operation: (exec: PiSqlExecutor) => Promise<T>,
  ) => Promise<T>;

  private constructor(
    private readonly client: DbHandle["client"],
    readonly scope: PiStorageScope,
    options: PostgresPiStorageOptions,
  ) {
    this.runTransaction =
      options.transaction ??
      ((operation) =>
        this.client.begin(async (tx) => {
          const exec: PiSqlExecutor = async (query, params) =>
            (await tx.unsafe(query, params as never)) as unknown as Row[];
          await options.assertOwnership?.(exec);
          const result = await operation(exec);
          await options.assertOwnership?.(exec);
          return result;
        }) as Promise<never>);
  }

  /** Open or create the scoped session row; a session written by another format is rejected. */
  static async open(
    client: DbHandle["client"],
    scope: PiStorageScope,
    options: PostgresPiStorageOptions = {},
  ) {
    const storage = new PostgresPiStorage(client, piStorageScope.parse(scope), options);
    await storage.runTransaction(async (exec) => {
      const [current] = await exec(
        "SELECT format FROM pi_sessions WHERE org_id=$1 AND session_id=$2 FOR UPDATE",
        storage.keys,
      );
      if (current) piStorageFormat.parse(JSON.parse(String(current.format)));
      else
        await exec(
          "INSERT INTO pi_sessions (org_id,session_id,format,next_seq,stats) VALUES ($1,$2,$3,1,$4)",
          [...storage.keys, JSON.stringify(FORMAT), JSON.stringify(EMPTY_STATS)],
        );
    });
    return storage;
  }

  private get keys(): [string, string] {
    return [this.scope.tenantId, this.scope.sessionId];
  }
  private read: PiSqlExecutor = async (query, params) =>
    (await this.client.unsafe(query, params as never)) as unknown as Row[];
  private assertOpen() {
    if (this.closing) throw new Error("Pi storage is closed");
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  async commit(writes: Write[], _context: Context) {
    this.assertOpen();
    const input = structuredClone(writes);
    return this.serialize(() => this.runTransaction((exec) => this.commitIn(exec, input)));
  }
  /** Apply one commit batch inside the caller's transaction (serialized by the caller). */
  async commitIn(exec: PiSqlExecutor, writes: Write[]) {
    const row = await this.sessionRow(exec);
    const prepared = prepareStorageCommit(writes, row.nextSeq, Date.now());
    return this.applyCommitted(exec, row, prepared.writes, prepared.result.timestamp);
  }
  private async sessionRow(exec: PiSqlExecutor) {
    const [row] = await exec(
      "SELECT next_seq,stats FROM pi_sessions WHERE org_id=$1 AND session_id=$2 FOR UPDATE",
      this.keys,
    );
    if (!row) throw new Error("Pi storage session is missing");
    return { nextSeq: Number(row.next_seq), stats: JSON.parse(String(row.stats)) as SessionStats };
  }
  private async validate(exec: PiSqlExecutor, writes: CommittedWrite[], firstSeq: number) {
    const ids = new Set<string>();
    for (const write of writes) {
      if (write.kind === "entry") {
        ids.add(write.id);
        if (write.parentId !== null) ids.add(write.parentId);
      }
      if (write.kind === "usage") ids.add(write.id);
    }
    const list = [...ids];
    const entries = new Set(
      (
        await exec(
          "SELECT id FROM pi_entries WHERE org_id=$1 AND session_id=$2 AND id = ANY($3::text[])",
          [...this.keys, list],
        )
      ).map((row) => String(row.id)),
    );
    const usage = new Set(
      (
        await exec(
          "SELECT id FROM pi_usage WHERE org_id=$1 AND session_id=$2 AND id = ANY($3::text[])",
          [...this.keys, list],
        )
      ).map((row) => String(row.id)),
    );
    validateCommittedWrites(writes, firstSeq, {
      hasEntryId: (id) => entries.has(id),
      hasEntryOrUsageId: (id) => entries.has(id) || usage.has(id),
    });
  }
  private async applyCommitted(
    exec: PiSqlExecutor,
    row: { nextSeq: number; stats: SessionStats },
    writes: CommittedWrite[],
    timestamp: number,
  ) {
    await this.validate(exec, writes, row.nextSeq);
    const stats = row.stats;
    if (writes.length) {
      const envelope = piStorageCommit.parse({
        version: 1,
        format: FORMAT,
        scope: this.scope,
        commitId: randomUUID(),
        committedAt: timestamp,
        firstSeq: row.nextSeq,
        writes: JSON.parse(
          JSON.stringify(writes, (_key, item: unknown) => {
            if (typeof item === "number" && !Number.isFinite(item))
              throw new Error("Pi records must contain finite JSON numbers");
            return item;
          }),
        ),
      });
      const data = JSON.stringify(envelope);
      await exec(
        "INSERT INTO pi_commits (org_id,session_id,commit_id,first_seq,last_seq,digest,data) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [
          ...this.keys,
          envelope.commitId,
          envelope.firstSeq,
          envelope.firstSeq + envelope.writes.length - 1,
          createHash("sha256").update(data).digest("hex"),
          data,
        ],
      );
    }
    await this.applyAll(exec, writes, stats);
    await exec("UPDATE pi_sessions SET next_seq=$3,stats=$4 WHERE org_id=$1 AND session_id=$2", [
      ...this.keys,
      row.nextSeq + writes.length,
      JSON.stringify(stats),
    ]);
    return { firstSeq: row.nextSeq, seqs: writes.map((write) => write.seq), timestamp, stats };
  }
  /**
   * Apply writes in order. Consecutive inserts of one kind share a single multi-row
   * statement; value upserts and deletes stay sequential so a later write to the
   * same address wins within the batch.
   */
  private async applyAll(exec: PiSqlExecutor, writes: CommittedWrite[], stats: SessionStats) {
    let kind: "entry" | "usage" | "list" | undefined;
    let rows: unknown[][] = [];
    const flush = async () => {
      if (!rows.length) return;
      const column = (index: number) => rows.map((row) => row[index]);
      if (kind === "entry")
        await exec(
          `INSERT INTO pi_entries (org_id,session_id,id,parent_id,seq,timestamp,type,custom_type,data)
           SELECT $1,$2,t.id,t.parent_id,t.seq,t.ts,t.type,t.custom_type,t.data
           FROM unnest($3::text[],$4::text[],$5::int[],$6::bigint[],$7::text[],$8::text[],$9::text[])
             AS t(id,parent_id,seq,ts,type,custom_type,data)`,
          [...this.keys, ...[0, 1, 2, 3, 4, 5, 6].map(column)],
        );
      else if (kind === "usage")
        await exec(
          `INSERT INTO pi_usage (org_id,session_id,id,seq,data)
           SELECT $1,$2,t.id,t.seq,t.data FROM unnest($3::text[],$4::int[],$5::text[]) AS t(id,seq,data)`,
          [...this.keys, ...[0, 1, 2].map(column)],
        );
      else if (kind === "list")
        await exec(
          `INSERT INTO pi_lists (org_id,session_id,namespace,key,seq,data)
           SELECT $1,$2,t.namespace,t.key,t.seq,t.data
           FROM unnest($3::text[],$4::text[],$5::int[],$6::text[]) AS t(namespace,key,seq,data)`,
          [...this.keys, ...[0, 1, 2, 3].map(column)],
        );
      rows = [];
      kind = undefined;
    };
    const push = async (next: NonNullable<typeof kind>, row: unknown[]) => {
      if (kind !== next) await flush();
      kind = next;
      rows.push(row);
    };
    for (const write of writes) {
      if (write.kind === "entry") {
        const { kind: _kind, ...entry } = write;
        await push("entry", [
          entry.id,
          entry.parentId,
          entry.seq,
          entry.timestamp,
          entry.type,
          entry.customType ?? null,
          JSON.stringify(entry),
        ]);
        if (entry.type === "message") stats.messageCount++;
      } else if (write.kind === "usage") {
        const { kind: _kind, ...usage } = write;
        await push("usage", [usage.id, usage.seq, JSON.stringify(usage)]);
        for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const)
          stats.usage[key] += usage.usage[key];
        for (const key of ["cacheWrite1h", "reasoning"] as const) {
          if (usage.usage[key] !== undefined)
            stats.usage[key] = (stats.usage[key] ?? 0) + usage.usage[key];
        }
        for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const)
          stats.usage.cost[key] += usage.usage.cost[key];
      } else if (write.kind === "list" && write.op === "append") {
        const data = JSON.stringify(write.value);
        if (data === undefined) throw new Error("Pi values must be JSON serializable");
        await push("list", [write.namespace, write.key, write.seq, data]);
      } else {
        await flush();
        const table = write.kind === "value" ? "pi_values" : "pi_lists";
        if (write.op === "delete") {
          await exec(
            `DELETE FROM ${table} WHERE org_id=$1 AND session_id=$2 AND namespace=$3 AND key=$4`,
            [...this.keys, write.namespace, write.key],
          );
        } else {
          const data = JSON.stringify(write.value);
          if (data === undefined) throw new Error("Pi values must be JSON serializable");
          await exec(
            "INSERT INTO pi_values (org_id,session_id,namespace,key,seq,data) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (org_id,session_id,namespace,key) DO UPDATE SET seq=EXCLUDED.seq,data=EXCLUDED.data",
            [...this.keys, write.namespace, write.key, write.seq, data],
          );
        }
      }
    }
    await flush();
  }

  async getEntries(ids: string[], _context: Context): Promise<Map<string, Entry>> {
    this.assertOpen();
    const rows = await this.read(
      "SELECT id,data FROM pi_entries WHERE org_id=$1 AND session_id=$2 AND id = ANY($3::text[])",
      [...this.keys, ids],
    );
    return new Map(rows.map((row) => [String(row.id), JSON.parse(String(row.data)) as Entry]));
  }
  async getValue<T>(address: Value<T>, _context: Context): Promise<StoredValue<T> | undefined> {
    this.assertOpen();
    const [row] = await this.read(
      "SELECT seq,data FROM pi_values WHERE org_id=$1 AND session_id=$2 AND namespace=$3 AND key=$4",
      [...this.keys, address.namespace, address.key],
    );
    return row
      ? { address: { ...address }, seq: Number(row.seq), value: JSON.parse(String(row.data)) }
      : undefined;
  }
  async scanValues<T>(prefix: Value<T>, _context: Context): Promise<StoredValue<T>[]> {
    this.assertOpen();
    const rows = await this.read(
      'SELECT key,seq,data FROM pi_values WHERE org_id=$1 AND session_id=$2 AND namespace=$3 AND left(key,length($4::text))=$4 ORDER BY key COLLATE "C"',
      [...this.keys, prefix.namespace, prefix.key],
    );
    return rows.map((row) => ({
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
    const rows = await this.read(
      `SELECT seq,data FROM pi_lists WHERE org_id=$1 AND session_id=$2 AND namespace=$3 AND key=$4 ${
        opts.cursor ? `AND seq ${opts.order === "asc" ? ">" : "<"} $6` : ""
      } ORDER BY seq ${direction} LIMIT $5`,
      [
        ...this.keys,
        address.namespace,
        address.key,
        opts.limit,
        ...(opts.cursor ? [opts.cursor.seq] : []),
      ],
    );
    return rows.map((row) => ({ seq: Number(row.seq), value: JSON.parse(String(row.data)) }));
  }
  private async branchRows(query: StorageBranchScan, includeData: boolean) {
    const rows = await this.read(
      `WITH RECURSIVE path AS (
        SELECT * FROM pi_entries WHERE org_id=$1 AND session_id=$2 AND id=$3
        UNION ALL SELECT e.* FROM pi_entries e JOIN path p ON e.org_id=p.org_id AND e.session_id=p.session_id AND e.id=p.parent_id
      ) SELECT id,parent_id,seq,timestamp,type,custom_type ${includeData ? ",data" : ""} FROM path ORDER BY seq ${
        query.order === "oldestFirst" ? "ASC" : "DESC"
      }`,
      [...this.keys, query.start],
    );
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
    return (await this.branchRows(query, true)).map((row) => JSON.parse(String(row.data)));
  }
  async scanBranchStructure(
    query: StorageBranchScan,
    _context: Context,
  ): Promise<EntryStructure[]> {
    this.assertOpen();
    return (await this.branchRows(query, false)).map((row) => ({
      id: String(row.id),
      parentId: row.parent_id === null ? null : String(row.parent_id),
      seq: Number(row.seq),
      timestamp: Number(row.timestamp),
      type: row.type as EntryStructure["type"],
      ...(row.custom_type === null ? {} : { customType: String(row.custom_type) }),
    }));
  }
  private async scan(table: "pi_entries" | "pi_usage", query: EntryScan | UsageScan) {
    const conditions = ["org_id=$1", "session_id=$2"];
    const params: unknown[] = [...this.keys];
    const add = (condition: string, param: unknown) => {
      params.push(param);
      conditions.push(`${condition} $${params.length}`);
    };
    if (query.fromSeq !== undefined) add("seq >=", query.fromSeq);
    if (query.toSeq !== undefined) add("seq <=", query.toSeq);
    if ("type" in query && query.type !== undefined) add("type =", query.type);
    if ("customType" in query && query.customType !== undefined)
      add("custom_type =", query.customType);
    let limit = "";
    if (query.limit !== undefined) {
      params.push(Math.max(0, Math.trunc(query.limit)));
      limit = `LIMIT $${params.length}`;
    }
    const rows = await this.read(
      `SELECT data FROM ${table} WHERE ${conditions.join(" AND ")} ORDER BY seq ${
        query.order === "desc" ? "DESC" : "ASC"
      } ${limit}`,
      params,
    );
    return rows.map((row) => JSON.parse(String(row.data)));
  }
  async scanEntries(query: EntryScan, _context: Context): Promise<Entry[]> {
    this.assertOpen();
    return this.scan("pi_entries", query);
  }
  async scanUsage(query: UsageScan, _context: Context): Promise<UsageRow[]> {
    this.assertOpen();
    return this.scan("pi_usage", query);
  }
  async getStats(_context: Context): Promise<SessionStats> {
    this.assertOpen();
    const [row] = await this.read(
      "SELECT stats FROM pi_sessions WHERE org_id=$1 AND session_id=$2",
      this.keys,
    );
    if (!row) throw new Error("Pi storage session is missing");
    return JSON.parse(String(row.stats));
  }
  private decodeCommit(row: Row) {
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
    return this.serialize(() =>
      this.runTransaction(async (exec) => {
        const [row] = await exec(
          "SELECT format,next_seq FROM pi_sessions WHERE org_id=$1 AND session_id=$2 FOR UPDATE",
          this.keys,
        );
        if (!row) throw new Error("Pi storage session is missing");
        piStorageFormat.parse(JSON.parse(String(row.format)));
        for (const table of ["pi_entries", "pi_usage", "pi_values", "pi_lists"])
          await exec(`DELETE FROM ${table} WHERE org_id=$1 AND session_id=$2`, this.keys);
        const stats = structuredClone(EMPTY_STATS);
        let nextSeq = 1;
        const journal = await exec(
          "SELECT first_seq,last_seq,digest,data FROM pi_commits WHERE org_id=$1 AND session_id=$2 ORDER BY first_seq",
          this.keys,
        );
        for (const record of journal) {
          const commit = this.decodeCommit(record);
          if (
            commit.firstSeq !== nextSeq ||
            Number(record.first_seq) !== nextSeq ||
            Number(record.last_seq) !== nextSeq + commit.writes.length - 1
          )
            throw new Error("Pi commit sequence gap");
          // Only replay this adapter's checksummed writes for the exact pinned format.
          const writes = commit.writes as unknown as CommittedWrite[];
          if (writes.some((write, index) => write.seq !== nextSeq + index))
            throw new Error("Pi write sequence gap");
          await this.validate(exec, writes, nextSeq);
          await this.applyAll(exec, writes, stats);
          nextSeq += writes.length;
        }
        if (nextSeq !== Number(row.next_seq)) throw new Error("Pi journal high-water mismatch");
        await exec("UPDATE pi_sessions SET stats=$3 WHERE org_id=$1 AND session_id=$2", [
          ...this.keys,
          JSON.stringify(stats),
        ]);
        return { nextSeq, stats };
      }),
    );
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
    const rows = await this.read(
      "SELECT digest,data FROM pi_commits WHERE org_id=$1 AND session_id=$2 AND last_seq>$3 ORDER BY first_seq LIMIT $4",
      [...this.keys, afterSeq, limit],
    );
    return rows.map((row) => this.decodeCommit(row));
  }
  close(_context: Context): Promise<void> {
    this.closing ??= this.queue;
    return this.closing;
  }
}
