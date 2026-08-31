import { eq, sql } from "drizzle-orm";
import type { Db, DbExecutor } from "./client.ts";
import { appendRunEvents } from "./events.ts";
import { auditEvents, runs } from "./schema.ts";

export type RunRow = typeof runs.$inferSelect;

/**
 * 軟殺：把 run 標成 killed 並寫事件。
 * 硬殺（destroy 沙箱）由 worker 看到狀態改變後執行——
 * 兩層刻意分開，因為閘道不見得跟沙箱在同一個程序裡。
 */
export async function killRun(
  db: Db,
  run: Pick<RunRow, "id" | "orgId" | "endUserId" | "budgetUsd" | "spentUsd">,
  reason: string,
  actor: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(runs)
      .set({ status: "killed", error: reason, completedAt: new Date() })
      .where(
        sql`${runs.id} = ${run.id} and ${runs.status} in ('queued','running','awaiting_input')`,
      )
      .returning({ id: runs.id });
    if (!updated) return; // 已經是終態，不重複寫事件
    await appendRunEvents(tx, run.id, [
      {
        type: "run.killed",
        payload: { reason, spent_usd: run.spentUsd, budget_usd: run.budgetUsd },
      },
    ]);
    await tx.insert(auditEvents).values({
      orgId: run.orgId,
      endUserId: run.endUserId,
      runId: run.id,
      actor,
      action: "run.killed",
      meta: { reason, spent_usd: run.spentUsd, budget_usd: run.budgetUsd },
    });
  });
}

/** 原子加減預留額度（併發保險）。 */
export async function adjustReserved(
  executor: DbExecutor,
  runId: string,
  deltaUsd: number,
): Promise<void> {
  await executor
    .update(runs)
    .set({ reservedUsd: sql`greatest(0, ${runs.reservedUsd} + ${deltaUsd})` })
    .where(eq(runs.id, runId));
}
