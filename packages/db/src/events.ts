import { eq, sql } from "drizzle-orm";
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
  runId: string,
  items: AppendableEvent[],
): Promise<number> {
  if (items.length === 0) return -1;
  const [row] = await executor
    .update(runs)
    .set({ eventSeq: sql`${runs.eventSeq} + ${items.length}` })
    .where(eq(runs.id, runId))
    .returning({ eventSeq: runs.eventSeq });
  if (!row) throw new Error(`run not found: ${runId}`);
  const start = row.eventSeq - items.length;
  await executor.insert(events).values(
    items.map((item, i) => ({
      runId,
      seq: start + i,
      type: item.type,
      payload: item.payload ?? null,
    })),
  );
  return start;
}
