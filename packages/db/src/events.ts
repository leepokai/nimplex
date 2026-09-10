import { and, eq, sql } from "drizzle-orm";
import type { DbExecutor } from "./client.ts";
import { events, runs } from "./schema.ts";

export interface AppendableEvent {
  type: string;
  payload?: unknown;
}

/**
 * append-only 事件寫入：用 runs.event_seq 原子遞增分配序號，
 * 保證同一 run 的 seq 連續且不重複（SSE 以 seq 續傳）。
 */
export async function appendRunEvents(
  executor: DbExecutor,
  run: { id: string; orgId: string },
  items: AppendableEvent[],
): Promise<number> {
  if (items.length === 0) return -1;
  return executor.transaction(async (tx) => {
    const [row] = await tx
      .update(runs)
      .set({ eventSeq: sql`${runs.eventSeq} + ${items.length}` })
      .where(and(eq(runs.id, run.id), eq(runs.orgId, run.orgId)))
      .returning({ eventSeq: runs.eventSeq });
    if (!row) throw new Error(`run not found: ${run.id}`);
    const start = row.eventSeq - items.length;
    await tx.insert(events).values(
      items.map((item, i) => ({
        runId: run.id,
        seq: start + i,
        type: item.type,
        payload: item.payload ?? null,
      })),
    );
    return start;
  });
}

/** Binary deltas stay archived; the hot transcript/SSE path carries their hash and metadata. */
export const transcriptEventPayload = sql<unknown>`case when ${events.type} = 'file.changed' then ${events.payload} - 'content_base64' else ${events.payload} end`;

/** The log in seq order, optionally including archived binary deltas for explicit retrieval. */
export async function listRunEvents(
  executor: DbExecutor,
  runId: string,
  orgId: string,
  includeFileContent = false,
) {
  return executor
    .select({
      type: events.type,
      payload: includeFileContent ? events.payload : transcriptEventPayload,
    })
    .from(events)
    .innerJoin(runs, and(eq(runs.id, events.runId), eq(runs.orgId, orgId)))
    .where(eq(events.runId, runId))
    .orderBy(events.seq);
}
