import { createHash, randomUUID } from "node:crypto";
import type { ModelReservation } from "@nimplex/contracts";
import {
  checkWorkspaceLimits,
  type ExecutorRunContext,
  isTerminal,
  lookupRate,
  planReservation,
} from "@nimplex/core";
import {
  appendRunEvents,
  type Db,
  type DbExecutor,
  listRunEvents,
  modelCalls,
  type RunRow,
  runs,
  saveWorkspace,
  usageRecords,
  type WorkspaceFiles,
  workItems,
} from "@nimplex/db";
import { and, eq, sql } from "drizzle-orm";

export class LostLeaseError extends Error {
  constructor(id: string) {
    super(`lost lease on work item ${id}`);
    this.name = "LostLeaseError";
  }
}
export class BudgetExceededError extends Error {
  constructor() {
    super("budget_exceeded");
  }
}

export interface Lease {
  id: string;
  fence: number;
  owner: string;
}

/** Lock order is always work item, then run. Expired workers cannot extend their authority. */
export async function lockOwnedRun(
  tx: DbExecutor,
  lease: Lease,
  run: Pick<RunRow, "id" | "orgId">,
) {
  const [item] = await tx
    .select({ id: workItems.id })
    .from(workItems)
    .where(
      and(
        eq(workItems.id, lease.id),
        eq(workItems.runId, run.id),
        eq(workItems.leaseOwner, lease.owner),
        eq(workItems.fence, lease.fence),
        eq(workItems.status, "leased"),
        sql`${workItems.leaseExpiresAt} > now()`,
      ),
    )
    .for("update");
  if (!item) throw new LostLeaseError(lease.id);
  const [current] = await tx
    .select()
    .from(runs)
    .where(and(eq(runs.id, run.id), eq(runs.orgId, run.orgId)))
    .for("update");
  if (!current) throw new Error("run not found");
  return current;
}

export function createCheckpoints(
  db: Db,
  lease: Lease,
  run: RunRow,
  initialFiles: WorkspaceFiles,
): ExecutorRunContext["persistence"] {
  let files = initialFiles;
  const alive = (current: RunRow) => {
    if (isTerminal(current.status)) throw new Error(`run is ${current.status}`);
  };
  return {
    readEvents: () => listRunEvents(db, run.id, run.orgId, true),
    async checkpointContext(checkpoint) {
      await db.transaction(async (tx) => {
        alive(await lockOwnedRun(tx, lease, run));
        await appendRunEvents(tx, run, [{ type: "context.checkpoint", payload: checkpoint }]);
      });
    },
    async reserveModel(inputTokenBound) {
      const rate = lookupRate(run.modelProvider, run.model);
      if (!rate) throw new Error(`unpriced model cannot enforce a budget: ${run.model}`);
      return db.transaction(async (tx) => {
        const current = await lockOwnedRun(tx, lease, run);
        alive(current);
        const planned = planReservation(
          (current.budgetUsd ?? 0) - current.spentUsd - current.reservedUsd,
          inputTokenBound,
          rate,
        );
        if (!planned) throw new BudgetExceededError();
        const reservation: ModelReservation = {
          call_id: randomUUID(),
          input_token_bound: inputTokenBound,
          max_output_tokens: planned.maxOutputTokens,
          reserved_usd: planned.reservedUsd,
        };
        await tx.insert(modelCalls).values({
          id: reservation.call_id,
          orgId: run.orgId,
          runId: run.id,
          workItemId: lease.id,
          fence: lease.fence,
          status: "reserved",
          reservedUsd: planned.reservedUsd,
          inputTokenBound,
          maxOutputTokens: planned.maxOutputTokens,
        });
        await tx
          .update(runs)
          .set({ reservedUsd: sql`${runs.reservedUsd} + ${planned.reservedUsd}` })
          .where(and(eq(runs.id, run.id), eq(runs.orgId, run.orgId)));
        await appendRunEvents(tx, run, [{ type: "model.reserved", payload: reservation }]);
        return reservation;
      });
    },
    async commitModel(reservation, events, costUsd, uncertain) {
      if (!Number.isFinite(costUsd) || costUsd < 0) throw new Error("invalid model cost");
      const roundedCost = Math.ceil(costUsd * 1e6 - 1e-8) / 1e6;
      await db.transaction(async (tx) => {
        const current = await lockOwnedRun(tx, lease, run);
        const [call] = await tx
          .update(modelCalls)
          .set({ status: uncertain ? "unknown" : "settled", costUsd: roundedCost })
          .where(
            and(
              eq(modelCalls.id, reservation.call_id),
              eq(modelCalls.orgId, run.orgId),
              eq(modelCalls.runId, run.id),
              eq(modelCalls.status, "reserved"),
              eq(modelCalls.fence, lease.fence),
            ),
          )
          .returning();
        if (!call) return;
        // Unknown calls retain the unaccounted allowance, even if the stream reported partial usage.
        const released = uncertain ? Math.min(roundedCost, call.reservedUsd) : call.reservedUsd;
        const spent = Math.round((current.spentUsd + roundedCost) * 1e6) / 1e6;
        const reserved = Math.max(0, Math.round((current.reservedUsd - released) * 1e6) / 1e6);
        await tx
          .update(runs)
          .set({ spentUsd: spent, reservedUsd: reserved })
          .where(and(eq(runs.id, run.id), eq(runs.orgId, run.orgId)));
        if (!uncertain || roundedCost > 0)
          await tx.insert(usageRecords).values({
            orgId: run.orgId,
            endUserId: run.endUserId,
            runId: run.id,
            kind: "model",
            amountUsd: roundedCost,
            meta: { executor: "pi", model: run.model, call_id: call.id, uncertain },
          });
        await appendRunEvents(tx, run, [
          ...events,
          {
            type: "spend.updated",
            payload: {
              call_id: call.id,
              spent_usd: spent,
              reserved_usd: reserved,
              budget_usd: current.budgetUsd,
            },
          },
        ]);
        if (roundedCost > call.reservedUsd && !isTerminal(current.status)) {
          await tx
            .update(runs)
            .set({
              status: "failed",
              error: "provider_exceeded_reservation",
              completedAt: new Date(),
            })
            .where(and(eq(runs.id, run.id), eq(runs.orgId, run.orgId)));
          await appendRunEvents(tx, run, [
            { type: "run.failed", payload: { error: "provider_exceeded_reservation" } },
          ]);
        }
      });
    },
    async startTool(id, name) {
      await db.transaction(async (tx) => {
        alive(await lockOwnedRun(tx, lease, run));
        await appendRunEvents(tx, run, [
          { type: "tool.started", payload: { id, name, fence: lease.fence } },
        ]);
      });
    },
    async commitTool(events, after, metadata) {
      const exceeded = checkWorkspaceLimits(after, metadata);
      if (exceeded) throw new Error(exceeded);
      await db.transaction(async (tx) => {
        const current = await lockOwnedRun(tx, lease, run);
        alive(current);
        const changes = await saveWorkspace(tx, run.id, files, after, run.orgId);
        const revision = current.workspaceRevision + 1;
        await tx
          .update(runs)
          .set({ workspaceRevision: revision, workspaceMetadata: metadata })
          .where(and(eq(runs.id, run.id), eq(runs.orgId, run.orgId)));
        await appendRunEvents(tx, run, [
          ...events,
          ...changes.map((change) => ({
            type: "file.changed",
            payload: {
              ...change,
              revision,
              sha256:
                change.action === "write"
                  ? createHash("sha256")
                      .update(after[change.path] ?? new Uint8Array())
                      .digest("hex")
                  : undefined,
              content_base64:
                change.action === "write"
                  ? Buffer.from(after[change.path] ?? new Uint8Array()).toString("base64")
                  : undefined,
            },
          })),
          { type: "workspace.committed", payload: { revision, metadata } },
        ]);
      });
      files = after;
    },
  };
}
