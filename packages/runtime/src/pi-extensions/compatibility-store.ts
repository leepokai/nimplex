import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/pi-agent-core/harness/context";
import {
  appendList,
  list,
  type Storage,
  setValue,
  value,
  type Write,
} from "@earendil-works/pi-agent-core/harness/session";
import {
  type PiCompatibilityCompaction,
  type PiCompatibilityEntry,
  type PiCompatibilityHeader,
  piCompatibilityEntry,
  piCompatibilityHeader,
  piCompatibilityMetadata,
} from "@nimplex/contracts";
import { projectMetadata } from "./metadata-projection.ts";
import type { PiSessionViewSnapshot } from "./session-view.ts";
import { projectCompaction } from "./structural-projection.ts";

const headerAddress = value<PiCompatibilityHeader>("nimplex.pi.compat.header");
const entriesAddress = list<PiCompatibilityEntry>("nimplex.pi.compat.entries");
const entryAddress = (id: string) => value<PiCompatibilityEntry>("nimplex.pi.compat.entry", id);
const compactionAddress = (id: string) =>
  value<PiCompatibilityCompaction>("nimplex.pi.compat.compaction", id);
type Position = { nativeTip: string | null; visibleTip: string | null };
const positionAddress = (lane: string) => value<Position>("nimplex.pi.compat.position", lane);

function parseHeader(input: unknown): PiCompatibilityHeader {
  const parsed = piCompatibilityHeader.safeParse(input);
  if (!parsed.success)
    throw new Error(
      "Unsupported or invalid Pi compatibility projection; explicit migration required",
      { cause: parsed.error },
    );
  return parsed.data;
}

/**
 * An atomic, versioned Pi-facing projection. A custom entry receives its visible
 * identity/parent when accepted, not when the harness later drains its inbox.
 * Raw harness writes and this projection share the underlying Storage transaction.
 * The single-owner host must use this wrapper for every write to the session.
 */
export class PiCompatibilityStore {
  readonly storage: Storage;
  private queue: Promise<void> = Promise.resolve();
  private closing = false;

  constructor(
    private readonly source: Storage,
    private readonly identity: {
      id: string;
      cwd: string;
      createdAt: number;
      metadataLane?: string;
    },
  ) {
    this.storage = new Proxy(source, {
      get: (target, key) => {
        if (key === "commit")
          return (writes: Write[], context: Context) => {
            const frozen = structuredClone(writes);
            return this.serialize(() => this.commit(frozen, context));
          };
        if (key === "close")
          return async (context: Context) => {
            this.closing = true;
            await this.queue;
            await source.close(context);
          };
        const member = Reflect.get(target, key);
        return typeof member === "function" ? member.bind(target) : member;
      },
    });
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error("Pi compatibility store is closed"));
    const pending = this.queue.then(operation);
    this.queue = pending.then(
      () => {},
      () => {},
    );
    return pending;
  }

  private async commit(writes: Write[], context: Context) {
    const extra: Write[] = [];
    const storedHeader = await this.source.getValue(headerAddress, context);
    if (storedHeader) {
      const metadata = parseHeader(storedHeader.value);
      if (metadata.header.id !== this.identity.id || metadata.header.cwd !== this.identity.cwd)
        throw new Error("Pi compatibility identity mismatch");
    } else {
      if (
        (await this.source.scanEntries({ limit: 1 }, context)).length ||
        (await this.source.scanValues(value("pi.branch.tip"), context)).length ||
        (await this.source.scanValues(value("pi.pending.entry"), context)).length ||
        (await this.source.scanValues(value("pi.lane.config"), context)).length ||
        (await this.source.scanValues(value("pi.session.name"), context)).length ||
        (await this.source.scanValues(value("pi.entry.label"), context)).length
      )
        throw new Error("Existing Pi history requires an explicit compatibility migration");
      extra.push(
        setValue(
          headerAddress,
          piCompatibilityHeader.parse({
            version: 3,
            piVersion: "0.85.1",
            header: {
              type: "session",
              version: 3,
              id: this.identity.id,
              cwd: this.identity.cwd,
              timestamp: new Date(this.identity.createdAt).toISOString(),
            },
          }),
        ),
      );
    }
    const positions = new Map<string, Position>();
    const seen = new Map<string, PiCompatibilityEntry>();
    const positionFor = async (lane: string) => {
      let position = positions.get(lane);
      if (!position) {
        position = (await this.source.getValue(positionAddress(lane), context))?.value ?? {
          nativeTip: null,
          visibleTip: null,
        };
        positions.set(lane, position);
      }
      return position;
    };
    const laneNames = new Set(
      writes.flatMap((write) =>
        write.kind === "value" &&
        write.op === "set" &&
        (write.namespace === "pi.lane.state" || write.namespace === "pi.branch.tip")
          ? [write.key]
          : [],
      ),
    );
    const records = writes.filter(
      (write) =>
        write.kind === "entry" ||
        (write.kind === "value" &&
          write.op === "set" &&
          write.namespace === "pi.pending.entry" &&
          (write.value as { type?: string }).type === "custom"),
    );
    if (laneNames.size > 1 && records.length)
      throw new Error("A Pi compatibility commit must identify one lane");
    const lane = [...laneNames][0];
    if (records.length && lane === undefined) throw new Error("Pi compatibility entry has no lane");
    const materialized = new Set<string>();
    const projectRecord = async (write: Write) => {
      if (lane === undefined) throw new Error("Pi compatibility entry has no lane");
      const position = await positionFor(lane);
      const raw = write.kind === "entry" ? write.entry : undefined;
      const pending =
        write.kind === "value" && write.op === "set"
          ? (write.value as { type: "custom"; customType: string; payload?: unknown })
          : undefined;
      const id = raw?.id ?? (write.kind === "value" ? write.key : "");
      if (raw) materialized.add(id);
      const existing =
        seen.get(id) ?? (await this.source.getValue(entryAddress(id), context))?.value;
      if (existing) {
        // Materializing a previously accepted custom entry does not move its
        // visible parent or duplicate it in the extension-facing history.
        if (
          raw?.type !== "custom" ||
          existing.type !== "custom" ||
          raw.customType !== existing.customType ||
          JSON.stringify(raw.data) !== JSON.stringify(existing.data)
        )
          throw new Error(`Pi compatibility entry identity conflict: ${id}`);
        position.nativeTip = raw.id;
        return;
      }
      const parentId =
        !raw || raw.parentId === position.nativeTip ? position.visibleTip : raw.parentId;
      if (
        parentId !== null &&
        !seen.has(parentId) &&
        !(await this.source.getValue(entryAddress(parentId), context))
      )
        throw new Error(`Missing Pi compatibility parent: ${parentId}`);
      const candidate = raw
        ? {
            ...raw,
            parentId,
            ...(raw.type === "branch_summary" ? { fromId: raw.fromId ?? "root" } : {}),
          }
        : {
            type: "custom",
            id,
            parentId,
            customType: pending?.customType,
            data: pending?.payload,
          };
      const timestamp = new Date().toISOString();
      let projected: PiCompatibilityEntry[];
      if (raw?.type === "compaction") {
        const path: PiCompatibilityEntry[] = [];
        const visited = new Set<string>();
        let ancestorId = parentId;
        while (ancestorId !== null) {
          if (visited.has(ancestorId)) throw new Error("Cyclic Pi compatibility ancestry");
          visited.add(ancestorId);
          const ancestor =
            seen.get(ancestorId) ??
            (await this.source.getValue(entryAddress(ancestorId), context))?.value;
          if (!ancestor) throw new Error(`Missing Pi compatibility parent: ${ancestorId}`);
          path.push(ancestor);
          ancestorId = ancestor.parentId;
        }
        const result = projectCompaction(raw, parentId, timestamp, path.reverse());
        projected = result.entries;
        extra.push(setValue(compactionAddress(id), result.mapping));
      } else {
        projected = [
          piCompatibilityEntry.parse(JSON.parse(JSON.stringify({ ...candidate, timestamp }))),
        ];
      }
      for (const entry of projected) {
        if (seen.has(entry.id) || (await this.source.getValue(entryAddress(entry.id), context)))
          throw new Error(`Pi compatibility entry identity conflict: ${entry.id}`);
        seen.set(entry.id, entry);
        extra.push(setValue(entryAddress(entry.id), entry), appendList(entriesAddress, entry));
      }
      position.visibleTip = id;
      if (raw) position.nativeTip = id;
    };
    const metadata = await projectMetadata(
      writes,
      this.source,
      laneNames.size === 1 ? (lane ?? "main") : (this.identity.metadataLane ?? "main"),
      context,
    );
    const projectMetadataEntry = async ({ fields, mapping }: (typeof metadata)[number]) => {
      if (
        fields.type === "label" &&
        !seen.has(fields.targetId) &&
        !(await this.source.getValue(entryAddress(fields.targetId), context))
      )
        throw new Error(`Missing Pi label target: ${fields.targetId}`);
      const position = await positionFor(mapping.lane);
      const entry = piCompatibilityEntry.parse({
        ...fields,
        id: `nimplex-meta-${randomUUID()}`,
        parentId: position.visibleTip,
        timestamp: new Date().toISOString(),
      });
      seen.set(entry.id, entry);
      extra.push(
        setValue(entryAddress(entry.id), entry),
        appendList(entriesAddress, entry),
        setValue(
          value("nimplex.pi.compat.metadata", entry.id),
          piCompatibilityMetadata.parse({ version: 1, entryId: entry.id, ...mapping }),
        ),
      );
      position.visibleTip = entry.id;
    };
    const recordSet = new Set(records);
    // Preserve value/entry ordering within the original transaction. In particular,
    // navigation writes a target tip before its summary and a final tip afterwards.
    for (const [index, write] of writes.entries()) {
      if (recordSet.has(write)) await projectRecord(write);
      if (write.kind === "value" && write.op === "set" && write.namespace === "pi.branch.tip") {
        const position = await positionFor(write.key);
        const next = write.value as string | null;
        if (next === null || write.key !== lane || !materialized.has(next))
          position.visibleTip = next;
        position.nativeTip = next;
      }
      for (const entry of metadata) {
        if (entry.mapping.sourceWriteIndex === index) await projectMetadataEntry(entry);
      }
    }
    for (const [lane, position] of positions) extra.push(setValue(positionAddress(lane), position));
    return this.source.commit([...writes, ...extra], context);
  }

  snapshot(lane: string, context: Context): Promise<PiSessionViewSnapshot> {
    return this.serialize(async () => {
      const stored = await this.source.getValue(headerAddress, context);
      if (!stored) throw new Error("Pi compatibility header is missing");
      const metadata = parseHeader(stored.value);
      if (metadata.header.id !== this.identity.id || metadata.header.cwd !== this.identity.cwd)
        throw new Error("Pi compatibility identity mismatch");
      const entries: PiCompatibilityEntry[] = [];
      let cursor: { seq: number } | undefined;
      while (true) {
        const page = await this.source.readList(
          entriesAddress,
          { order: "asc", limit: 1000, ...(cursor ? { cursor } : {}) },
          context,
        );
        if (!page.length) break;
        entries.push(...page.map((row) => piCompatibilityEntry.parse(row.value)));
        cursor = { seq: page[page.length - 1]?.seq ?? 0 };
      }
      const position = await this.source.getValue(positionAddress(lane), context);
      return {
        header: metadata.header,
        // Payloads originate in the pinned Pi Storage port; the contract keeps
        // them JSON-only without making SDK clients depend on Pi's message types.
        entries: entries as unknown as PiSessionViewSnapshot["entries"],
        leafId: position?.value.visibleTip ?? null,
      };
    });
  }
}
