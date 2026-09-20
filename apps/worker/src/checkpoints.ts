import { createHash, randomUUID } from "node:crypto";
import type { ModelAttempt } from "@nimplex/contracts";
import {
  checkWorkspaceLimits,
  type ExecutorEvent,
  type ExecutorRunContext,
  isTerminal,
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

export const alive = (current: RunRow) => {
  if (isTerminal(current.status)) throw new Error(`run is ${current.status}`);
};

/**
 * Transaction-free commit steps over a locked run row. `createCheckpoints` wraps each in
 * its own fenced transaction for the default executor; the Pi harness host applies them
 * inside the transaction that also commits Pi's session writes.
 */
export async function startModelIn(
  tx: DbExecutor,
  current: RunRow,
  lease: Lease,
  extra: Record<string, unknown> = {},
): Promise<ModelAttempt> {
  alive(current);
  const attempt: ModelAttempt = { call_id: randomUUID() };
  await tx.insert(modelCalls).values({
    id: attempt.call_id,
    orgId: current.orgId,
    runId: current.id,
    workItemId: lease.id,
    fence: lease.fence,
    status: "started",
  });
  await appendRunEvents(tx, current, [
    { type: "model.started", payload: { ...attempt, ...extra } },
  ]);
  return attempt;
}

export async function commitModelIn(
  tx: DbExecutor,
  current: RunRow,
  attempt: ModelAttempt,
  events: ExecutorEvent[],
  costUsd: number,
  uncertain: boolean,
) {
  if (!Number.isFinite(costUsd) || costUsd < 0) throw new Error("invalid model cost");
  const roundedCost = Math.ceil(costUsd * 1e6 - 1e-8) / 1e6;
  // Settlement is keyed by call id, not by the lease that started it: a successor worker
  // settles a predecessor's attempt after takeover under its own fenced transaction.
  const [call] = await tx
    .update(modelCalls)
    .set({ status: uncertain ? "unknown" : "settled", costUsd: roundedCost })
    .where(
      and(
        eq(modelCalls.id, attempt.call_id),
        eq(modelCalls.orgId, current.orgId),
        eq(modelCalls.runId, current.id),
        eq(modelCalls.status, "started"),
      ),
    )
    .returning();
  if (!call) return;
  const spent = Math.round((current.spentUsd + roundedCost) * 1e6) / 1e6;
  await tx
    .update(runs)
    .set({ spentUsd: spent })
    .where(and(eq(runs.id, current.id), eq(runs.orgId, current.orgId)));
  if (!uncertain || roundedCost > 0)
    await tx.insert(usageRecords).values({
      orgId: current.orgId,
      endUserId: current.endUserId,
      runId: current.id,
      kind: "model",
      amountUsd: roundedCost,
      meta: { executor: "pi", model: current.model, call_id: call.id, uncertain },
    });
  await appendRunEvents(tx, current, [
    ...events,
    {
      type: "spend.updated",
      payload: {
        call_id: call.id,
        spent_usd: spent,
        uncertain,
      },
    },
  ]);
  current.spentUsd = spent;
}

export async function commitToolIn(
  tx: DbExecutor,
  current: RunRow,
  events: ExecutorEvent[],
  before: WorkspaceFiles,
  after: WorkspaceFiles,
  metadata: RunRow["workspaceMetadata"],
) {
  alive(current);
  const exceeded = checkWorkspaceLimits(after, metadata);
  if (exceeded) throw new Error(exceeded);
  const changes = await saveWorkspace(tx, current.id, before, after, current.orgId);
  const revision = current.workspaceRevision + 1;
  await tx
    .update(runs)
    .set({ workspaceRevision: revision, workspaceMetadata: metadata })
    .where(and(eq(runs.id, current.id), eq(runs.orgId, current.orgId)));
  await appendRunEvents(tx, current, [
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
  current.workspaceRevision = revision;
  current.workspaceMetadata = metadata;
}

export function createCheckpoints(
  db: Db,
  lease: Lease,
  run: RunRow,
  initialFiles: WorkspaceFiles,
): ExecutorRunContext["persistence"] {
  let files = initialFiles;
  return {
    readEvents: () => listRunEvents(db, run.id, run.orgId, true),
    async checkpointContext(checkpoint) {
      await db.transaction(async (tx) => {
        alive(await lockOwnedRun(tx, lease, run));
        await appendRunEvents(tx, run, [{ type: "context.checkpoint", payload: checkpoint }]);
      });
    },
    startModel: () =>
      db.transaction(async (tx) => startModelIn(tx, await lockOwnedRun(tx, lease, run), lease)),
    async commitModel(attempt, events, costUsd, uncertain) {
      await db.transaction(async (tx) => {
        const current = await lockOwnedRun(tx, lease, run);
        // The default executor settles only its own lease's attempt.
        const [own] = await tx
          .select({ id: modelCalls.id })
          .from(modelCalls)
          .where(and(eq(modelCalls.id, attempt.call_id), eq(modelCalls.fence, lease.fence)));
        if (!own) return;
        await commitModelIn(tx, current, attempt, events, costUsd, uncertain);
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
      await db.transaction(async (tx) => {
        const current = await lockOwnedRun(tx, lease, run);
        await commitToolIn(tx, current, events, files, after, metadata);
      });
      files = after;
    },
  };
}
