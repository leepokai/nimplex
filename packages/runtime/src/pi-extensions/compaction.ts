import type {
  AgentHarness,
  AgentLane,
  CompactionPreparation,
  CompactResult,
} from "@earendil-works/pi-agent-core";
import type { Context } from "@earendil-works/pi-agent-core/harness/context";
import type { JsonValue } from "@earendil-works/pi-agent-core/harness/session";
import {
  type CompactionResult,
  type ExtensionRunner,
  findCutPoint,
  type SessionBeforeCompactEvent,
  type SessionEntry,
  sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import { piExtensionCompaction } from "@nimplex/contracts";
import type { PiExtensionMutations } from "./mutations.ts";
import type { PiSessionView } from "./session-view.ts";

interface Options {
  harness: AgentHarness;
  lane: AgentLane;
  laneName: string;
  runner: ExtensionRunner;
  mutations: PiExtensionMutations;
  view: PiSessionView;
  refresh: () => Promise<void>;
  assertAuthority: () => void;
}

/** Reuse Pi's cut-point algorithm to expose stable legacy entry identities. */
function legacyPreparation(
  preparation: CompactionPreparation,
  entries: SessionEntry[],
): SessionBeforeCompactEvent["preparation"] {
  const previousIndex = entries.findLastIndex((entry) => entry.type === "compaction");
  const previous = entries[previousIndex];
  const keptIndex =
    previous?.type === "compaction"
      ? entries.findIndex((entry) => entry.id === previous.firstKeptEntryId)
      : 0;
  const start = keptIndex < 0 ? previousIndex + 1 : keptIndex;
  const cut = findCutPoint(entries, start, entries.length, preparation.settings.keepRecentTokens);
  const firstKept = entries[cut.firstKeptEntryIndex];
  if (!firstKept) throw new Error("Compaction has no legacy retention boundary");
  const { retainedTail: _tail, ...shared } = structuredClone(preparation);
  const messages = (start: number, end: number) =>
    entries
      .slice(start, end)
      .filter((entry) => entry.type !== "compaction")
      .flatMap(sessionEntryToContextMessages);
  return {
    ...shared,
    firstKeptEntryId: firstKept.id,
    previousSummary: previous?.type === "compaction" ? previous.summary : undefined,
    isSplitTurn: cut.isSplitTurn,
    messagesToSummarize: messages(
      start,
      cut.isSplitTurn ? cut.turnStartIndex : cut.firstKeptEntryIndex,
    ),
    turnPrefixMessages: cut.isSplitTurn
      ? messages(cut.turnStartIndex, cut.firstKeptEntryIndex)
      : [],
  };
}

function nativeResult(result: CompactionResult, entries: SessionEntry[]): CompactResult {
  const index = entries.findIndex((entry) => entry.id === result.firstKeptEntryId);
  if (index < 0) throw new Error("Compaction retention entry is outside the active branch");
  if (
    typeof result.summary !== "string" ||
    !Number.isFinite(result.tokensBefore) ||
    result.tokensBefore < 0
  )
    throw new Error("Invalid extension compaction result");
  // Legacy context retains every entry after this boundary, including prior
  // summaries. Materialize exactly that context for the native Storage contract.
  const retainedTail = entries.slice(index).flatMap(sessionEntryToContextMessages);
  const details =
    result.details === undefined
      ? undefined
      : (JSON.parse(
          JSON.stringify(result.details, (_key, item: unknown) => {
            if (typeof item === "number" && !Number.isFinite(item))
              throw new Error("Compaction details must contain finite JSON numbers");
            return item;
          }),
        ) as JsonValue);
  return {
    summary: result.summary,
    tokensBefore: result.tokensBefore,
    retainedTail,
    details: piExtensionCompaction.parse({
      kind: "nimplex.pi.extension.compaction",
      version: 1,
      firstKeptEntryId: result.firstKeptEntryId,
      ...(details === undefined ? {} : { details }),
    }),
    ...(result.usage === undefined ? {} : { usage: structuredClone(result.usage) }),
  };
}

/** Legacy compaction behavior over public hooks; Storage remains the commit authority. */
export function attachPiCompaction(options: Options) {
  const { harness, lane, laneName, runner, mutations, view, refresh, assertAuthority } = options;
  const fromExtension = new Map<string, boolean>();
  let disposed = false;
  const disposers = [
    harness.hooks.on("before_compaction", async (event, context) => {
      if (event.lane !== laneName) return undefined;
      try {
        await mutations.flush();
        assertAuthority();
        await refresh();
        if (!runner.hasHandlers("session_before_compact")) return undefined;
        const entries = view.manager.getBranch();
        const result = await runner.emit({
          type: "session_before_compact",
          preparation: legacyPreparation(event.preparation, entries),
          branchEntries: structuredClone(entries),
          customInstructions: event.customInstructions,
          reason: event.reason,
          willRetry: event.reason === "overflow",
          signal: context.abortSignal ?? new AbortController().signal,
        });
        await mutations.flush();
        assertAuthority();
        if (result?.cancel) return { decline: true };
        if (!result?.compaction) return undefined;
        const compaction = nativeResult(result.compaction, entries);
        fromExtension.set(event.runId, true);
        return { compaction };
      } catch (error) {
        return mutations.fail(error);
      }
    }),
    harness.events.on("compaction_end", (event) => {
      if (disposed || event.lane !== laneName) return;
      mutations.assertHealthy();
      const supplied = fromExtension.get(event.runId) ?? false;
      fromExtension.delete(event.runId);
      // Do not await on Pi's delivery queue: callbacks can invoke setters whose
      // own notifications need that queue. Commands/effects drain this task.
      void mutations.track(
        (async () => {
          await refresh();
          if (event.status === "completed") {
            const entry = view.manager.getEntry(event.entryId);
            if (entry?.type !== "compaction")
              throw new Error("Committed compaction entry is missing");
            await runner.emit({
              type: "session_compact",
              compactionEntry: entry,
              fromExtension: entry.fromHook ?? false,
              reason: event.reason,
              willRetry: event.reason === "overflow",
            });
          } else {
            await runner.emit({
              type: "session_compact_failed",
              reason: event.reason,
              aborted: event.status === "declined" || event.status === "aborted",
              errorMessage: event.status === "failed" ? event.error.message : undefined,
              willRetry: event.reason === "overflow",
              fromExtension: supplied,
            });
          }
        })(),
      );
    }),
    harness.hooks.on("before_drive", async (event) => {
      if (event.lane === laneName) await mutations.flush();
    }),
    harness.hooks.on("before_request", async (event) => {
      if (event.lane === laneName) await mutations.flush();
      return undefined;
    }),
  ];
  return {
    async compact(options: Parameters<AgentLane["compact"]>[0], context: Context) {
      await mutations.flush();
      assertAuthority();
      try {
        const result = await lane.compact(options, context);
        await mutations.flush();
        return result;
      } catch (error) {
        return mutations.fail(error);
      }
    },
    dispose() {
      disposed = true;
      for (const dispose of disposers) dispose();
      fromExtension.clear();
    },
  };
}
