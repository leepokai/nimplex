import { sql } from "drizzle-orm";
import type { Db } from "./client.ts";
import { appendRunEvents } from "./events.ts";
import { auditEvents, runs } from "./schema.ts";

export type RunRow = typeof runs.$inferSelect;

/**
 * Persist a killed run and its event immediately.
 * The worker observes durable state and destroys the sandbox separately;
 * API cancellation must not depend on sandbox-provider availability.
 */
export async function killRun(
  db: Db,
  run: Pick<RunRow, "id" | "orgId" | "endUserId" | "spentUsd">,
  reason: string,
  actor: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    // The caller's run object is usually a snapshot from claim time and spent_usd has since been
    // advanced by gateway settlements. Events and audit rows must record the figures at the moment
    // of the kill, so always take them from UPDATE ... RETURNING.
    const [updated] = await tx
      .update(runs)
      .set({ status: "killed", error: reason, completedAt: new Date() })
      .where(
        sql`${runs.id} = ${run.id} and ${runs.orgId} = ${run.orgId} and ${runs.status} in ('queued','running','awaiting_input')`,
      )
      .returning({ id: runs.id, spentUsd: runs.spentUsd });
    if (!updated) return; // Already terminal; do not duplicate events.
    const spentUsd = updated.spentUsd;
    await appendRunEvents(tx, run, [
      { type: "run.killed", payload: { reason, spent_usd: spentUsd } },
    ]);
    await tx.insert(auditEvents).values({
      orgId: run.orgId,
      endUserId: run.endUserId,
      runId: run.id,
      actor,
      action: "run.killed",
      meta: { reason, spent_usd: spentUsd },
    });
  });
}
