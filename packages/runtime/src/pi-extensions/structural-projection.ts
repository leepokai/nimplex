import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { NewEntry } from "@earendil-works/pi-agent-core/harness/session";
import { type SessionEntry, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import {
  type PiCompatibilityCompaction,
  type PiCompatibilityEntry,
  piCompatibilityEntry,
  piExtensionCompaction,
} from "@nimplex/contracts";

/** Converts the pinned harness's materialized tail without rewriting its original records. */
export function projectCompaction(
  raw: Extract<NewEntry, { type: "compaction" }>,
  parentId: string | null,
  timestamp: string,
  path: PiCompatibilityEntry[],
): { entries: PiCompatibilityEntry[]; mapping: PiCompatibilityCompaction } {
  // Match the Storage journal's JSON representation, including optional Pi fields.
  raw = JSON.parse(
    JSON.stringify(raw, (_key, item: unknown) => {
      if (typeof item === "number" && !Number.isFinite(item))
        throw new Error("Pi records must contain finite JSON numbers");
      return item;
    }),
  ) as typeof raw;
  if (
    raw.details &&
    typeof raw.details === "object" &&
    "kind" in raw.details &&
    raw.details.kind === "nimplex.pi.extension.compaction"
  ) {
    const envelope = piExtensionCompaction.parse(raw.details);
    const index = path.findIndex((entry) => entry.id === envelope.firstKeptEntryId);
    if (
      index < 0 ||
      !isDeepStrictEqual(
        path.slice(index).flatMap((entry) => sessionEntryToContextMessages(entry as SessionEntry)),
        raw.retainedTail,
      )
    )
      throw new Error(
        "Extension compaction retention boundary does not match its materialized tail",
      );
    const { details: _envelope, ...entry } = raw;
    return {
      entries: [
        piCompatibilityEntry.parse({
          ...entry,
          parentId,
          timestamp,
          firstKeptEntryId: envelope.firstKeptEntryId,
          ...(envelope.details === undefined ? {} : { details: envelope.details }),
        }),
      ],
      mapping: {
        version: 1,
        nativeEntryId: raw.id,
        firstKeptEntryId: envelope.firstKeptEntryId,
        derivedEntryIds: [],
      },
    };
  }
  // An empty tail uses the new compaction itself as the first-kept boundary:
  // Pi's reader retains no pre-compaction records in this case.
  let firstKeptEntryId = raw.id;
  const derived: PiCompatibilityEntry[] = [];
  if (raw.retainedTail.length) {
    const suffix: unknown[] = [];
    let matched = false;
    for (let index = path.length - 1; index >= 0; index--) {
      const entry = path[index];
      if (!entry) continue;
      const messages = sessionEntryToContextMessages(entry as SessionEntry);
      suffix.unshift(...messages);
      if (messages.length && isDeepStrictEqual(suffix, raw.retainedTail)) {
        firstKeptEntryId = entry.id;
        matched = true;
        break;
      }
      if (suffix.length >= raw.retainedTail.length) break;
    }
    if (!matched) {
      // Extensions may replace/reorder the retained messages. A first-kept ID
      // alone cannot express that; create explicitly mapped projection nodes.
      for (const [index, message] of raw.retainedTail.entries()) {
        const id = `nimplex-tail-${createHash("sha256")
          .update(JSON.stringify([raw.id, index]))
          .digest("hex")}`;
        derived.push(
          piCompatibilityEntry.parse({ type: "message", id, parentId, timestamp, message }),
        );
        parentId = id;
      }
      firstKeptEntryId = derived[0]?.id ?? raw.id;
    }
  }
  const entry = piCompatibilityEntry.parse({ ...raw, parentId, timestamp, firstKeptEntryId });
  return {
    entries: [...derived, entry],
    mapping: {
      version: 1,
      nativeEntryId: raw.id,
      firstKeptEntryId,
      derivedEntryIds: derived.map((entry) => entry.id),
    },
  };
}
