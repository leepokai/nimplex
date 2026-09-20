import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunStatus } from "@nimplex/contracts";
import {
  checkWorkspaceLimits,
  durationExceeded,
  type ExecutorStepResult,
  isSandboxSessionState,
  isTerminal,
} from "@nimplex/core";
import {
  appendRunEvents,
  auditEvents,
  createDb,
  type DbExecutor,
  findProviderKeyRow,
  killRun,
  listRunEvents,
  loadWorkspace,
  modelCalls,
  open,
  type RunRow,
  runs,
  workItems,
} from "@nimplex/db";
import { piExecutor } from "@nimplex/runtime/pi-executor";
import { runHarnessTurn } from "@nimplex/runtime/pi-harness-engine";
import { getSandboxProvider, hasSandboxProvider } from "@nimplex/sandbox";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { createCheckpoints, LostLeaseError, lockOwnedRun } from "./checkpoints.ts";
import { createNativeBash } from "./native-bash.ts";
import { postgresHarnessHost } from "./pi-harness-host.ts";

// Root .env (sandbox provider keys, ...); existing env vars win.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
for (const candidate of [resolve(process.cwd(), ".env"), resolve(repoRoot, ".env")]) {
  if (existsSync(candidate)) {
    process.loadEnvFile(candidate);
    break;
  }
}

const { db, client } = createDb();
const workerId = `worker-${process.pid}-${randomUUID().slice(0, 8)}`;
const LEASE_SECONDS = Number(process.env.NIMPLEX_LEASE_SECONDS ?? 60);
if (!Number.isFinite(LEASE_SECONDS) || LEASE_SECONDS < 3) throw new Error("invalid lease duration");
const HEARTBEAT_MS = Math.min(1000, (LEASE_SECONDS * 1000) / 3);
const POLL_MS = 100;
const REAP_INTERVAL_MS = 10_000;

interface ClaimedItem {
  id: string;
  run_id: string;
  org_id: string;
  kind: "model" | "tool" | "harness";
  payload: unknown;
  fence: number;
  attempts: number;
}

/** How a turn ends, decided by the worker once the executor has returned. */
type Outcome =
  | { kind: "continue" }
  | { kind: "completed" }
  | { kind: "killed"; reason: string }
  | { kind: "failed"; error: string };

console.log(`nimplex worker ${workerId} started`);

// Hard-kill cleanup: any worker that reads a killed run's sandbox_state can reconnect and destroy it.
const reaper = setInterval(() => {
  void reapOrphanSandboxes().catch((err) => console.error("[worker] reaper failed", err));
}, REAP_INTERVAL_MS);
reaper.unref();

for (;;) {
  const item = await claimNext();
  if (!item) {
    await sleep(POLL_MS);
    continue;
  }
  try {
    await processItem(item);
  } catch (err) {
    if (err instanceof LostLeaseError) {
      // Another worker took the lease mid-execution (this worker stalled too long). That worker is
      // now running the same run, so writing anything here would mark someone else's live run failed.
      console.warn(`[worker] ${err.message}; dropping this result, the new lease owner continues`);
      continue;
    }
    console.error(`work item ${item.id} failed:`, err);
    const message = err instanceof Error ? err.message : String(err);
    await db
      .transaction(async (tx) => {
        const snapshot = await db.query.runs.findFirst({
          where: and(eq(runs.id, item.run_id), eq(runs.orgId, item.org_id)),
        });
        if (!snapshot) return;
        const current = await lockOwnedRun(
          tx,
          { id: item.id, owner: workerId, fence: item.fence },
          snapshot,
        );
        if (!isTerminal(current.status)) {
          const killed = message === "max_duration";
          await finishRun(tx, current, killed ? "killed" : "failed", message, {
            error: message,
            reason: message,
            spent_usd: current.spentUsd,
          });
        }
        await tx
          .update(workItems)
          .set({ status: "failed", completedAt: new Date() })
          .where(eq(workItems.id, item.id));
      })
      .catch((error) => console.error("[worker] could not finalize failed item", error));
  }
}

/** Atomic CAS claim: pending, or leased with an expired lease. Fence increments on every claim (double-write guard). */
async function claimNext(): Promise<ClaimedItem | null> {
  const rows = await client`
    update work_items set
      status = 'leased',
      lease_owner = ${workerId},
      lease_expires_at = now() + make_interval(secs => ${LEASE_SECONDS}),
      fence = fence + 1,
      attempts = attempts + 1
    where id = (
      select id from work_items
      where (status = 'pending' or (status = 'leased' and lease_expires_at < now()))
        and available_at <= now()
      order by available_at, created_at
      for update skip locked
      limit 1
    )
    returning id, run_id, kind, payload, fence, attempts,
      (select org_id from runs where runs.id = work_items.run_id) as org_id
  `;
  const row = rows[0];
  return row ? (row as unknown as ClaimedItem) : null;
}

async function processItem(item: ClaimedItem) {
  const run = await db.query.runs.findFirst({
    where: and(eq(runs.id, item.run_id), eq(runs.orgId, item.org_id)),
  });
  if (!run || isTerminal(run.status)) {
    if (run && item.kind === "harness") {
      await processHarness(item, run);
      return;
    }
    if (run) await destroySandbox(run);
    await releaseItem(item, "done");
    return;
  }

  if (run.status === "queued") {
    // CAS on queued: a kill that landed between the read above and this update must win.
    const started = await db.transaction(async (tx) => {
      await lockOwnedRun(tx, { id: item.id, owner: workerId, fence: item.fence }, run);
      const [row] = await tx
        .update(runs)
        .set({ status: "running", startedAt: new Date() })
        .where(and(eq(runs.id, run.id), eq(runs.orgId, run.orgId), eq(runs.status, "queued")))
        .returning({ id: runs.id });
      if (!row) return false;
      await appendRunEvents(tx, run, [{ type: "run.started", payload: { worker: workerId } }]);
      return true;
    });
    if (!started) {
      await releaseItem(item, "done");
      return;
    }
  } else if (item.attempts > 1) {
    // Re-claimed after the previous owner's lease expired (it died or stalled): this worker
    // continues from the log. The previous attempt's uncommitted turn is simply redone.
    await db.transaction(async (tx) => {
      await lockOwnedRun(tx, { id: item.id, owner: workerId, fence: item.fence }, run);
      const unknown = await tx
        .update(modelCalls)
        .set({ status: "unknown" })
        .where(
          and(
            eq(modelCalls.orgId, run.orgId),
            eq(modelCalls.runId, run.id),
            eq(modelCalls.workItemId, item.id),
            eq(modelCalls.status, "started"),
          ),
        )
        .returning({ id: modelCalls.id });
      await appendRunEvents(tx, run, [
        { type: "run.resumed", payload: { worker: workerId, attempt: item.attempts } },
        ...unknown.map((call) => ({
          type: "model.unknown",
          payload: { call_id: call.id },
        })),
      ]);
    });
  }

  // Wall-clock cap: checked before every step, and again by the lease heartbeat during it.
  if (durationExceeded(run.startedAt, run.maxDurationSeconds)) {
    await killRun(db, run, "max_duration", "worker");
    if (item.kind === "harness") {
      await processHarness(item, { ...run, status: "killed" });
      return;
    }
    await destroySandbox(run);
    await releaseItem(item, "done");
    return;
  }

  if (item.kind === "harness") await processHarness(item, run);
  else await processStep(item, run);
}

/**
 * One leased Pi harness operation. Pi commits every boundary through the fenced host;
 * this function only settles the run after the operation ends. Lease loss detaches so
 * the successor resumes the same operation from committed state.
 */
async function processHarness(item: ClaimedItem, run: RunRow) {
  const key = await findProviderKeyRow(db, run.orgId, run.modelProvider, null);
  if (!key) throw new Error(`no ${run.modelProvider} provider key for org ${run.orgId}`);
  const lease = { id: item.id, owner: workerId, fence: item.fence };
  const abort = new AbortController();
  if (isTerminal(run.status)) abort.abort(new Error(`run ${run.id} is ${run.status}`));
  let ticking = false;
  const heartbeat = setInterval(() => {
    if (ticking) return;
    ticking = true;
    void extendLease(item, abort).finally(() => {
      ticking = false;
    });
  }, HEARTBEAT_MS);
  let outcome: Exclude<Outcome, { kind: "continue" }>;
  try {
    const host = await postgresHarnessHost({
      db,
      client,
      lease,
      run,
      credential: { apiKey: open(key), baseUrl: key.baseUrl },
      nativeBash: createNativeBash(db, lease, run),
      signal: abort.signal,
      onTerminal: () => abort.abort(new Error(`run ${run.id} is terminal`)),
    });
    const result = await runHarnessTurn(host);
    outcome =
      result.status === "completed"
        ? { kind: "completed" }
        : { kind: "failed", error: result.error };
  } catch (error) {
    if (abort.signal.reason instanceof LostLeaseError) throw abort.signal.reason;
    if (error instanceof LostLeaseError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (abort.signal.reason === "max_duration")
      outcome = { kind: "killed", reason: "max_duration" };
    // A durable cancellation only follows an API kill or cancel; the run is already terminal.
    else if (message === "canceled") outcome = { kind: "failed", error: "aborted" };
    else outcome = { kind: "failed", error: message };
  } finally {
    clearInterval(heartbeat);
  }
  await db.transaction(async (tx) => {
    const current = await lockOwnedRun(tx, lease, run);
    await tx
      .update(workItems)
      .set({ status: "done", completedAt: new Date() })
      .where(eq(workItems.id, item.id));
    if (isTerminal(current.status)) return;
    switch (outcome.kind) {
      case "completed":
        await finishRun(tx, current, "completed", null, { spent_usd: current.spentUsd });
        break;
      case "killed":
        await finishRun(tx, current, "killed", outcome.reason, {
          reason: outcome.reason,
          spent_usd: current.spentUsd,
        });
        break;
      case "failed":
        await finishRun(tx, current, "failed", outcome.error, { error: outcome.error });
    }
  });
  if (outcome.kind !== "completed") await destroySandbox(run);
}

/** Model and tool boundaries commit while Pi runs; this transaction only schedules the next turn. */
async function processStep(item: ClaimedItem, run: RunRow) {
  const [events, files, key] = await Promise.all([
    listRunEvents(db, run.id, run.orgId),
    loadWorkspace(db, run.id, run.orgId),
    findProviderKeyRow(db, run.orgId, run.modelProvider, null),
  ]);
  if (!key) throw new Error(`no ${run.modelProvider} provider key for org ${run.orgId}`);
  const lease = { id: item.id, owner: workerId, fence: item.fence };
  const abort = new AbortController();
  let ticking = false;
  const heartbeat = setInterval(() => {
    if (ticking) return;
    ticking = true;
    void extendLease(item, abort).finally(() => {
      ticking = false;
    });
  }, HEARTBEAT_MS);
  let result: ExecutorStepResult;
  try {
    result = await piExecutor(
      {
        id: run.id,
        modelProvider: run.modelProvider,
        model: run.model,
        config: run.config,
        workspaceMetadata: run.workspaceMetadata,
        events,
        files,
        credential: { apiKey: open(key), baseUrl: key.baseUrl },
        persistence: createCheckpoints(db, lease, run, files),
        nativeBash: createNativeBash(db, lease, run),
      },
      abort.signal,
    );
  } finally {
    clearInterval(heartbeat);
  }
  if (abort.signal.reason instanceof LostLeaseError) throw abort.signal.reason;
  await db.transaction(async (tx) => {
    const current = await lockOwnedRun(tx, lease, run);
    await tx
      .update(workItems)
      .set({ status: "done", completedAt: new Date() })
      .where(eq(workItems.id, item.id));
    if (isTerminal(current.status)) return;
    const outcome = decideOutcome(result, abort.signal.reason);
    switch (outcome.kind) {
      case "continue":
        await tx.insert(workItems).values({ runId: run.id, kind: "model" });
        break;
      case "completed":
        await finishRun(tx, current, "completed", null, { spent_usd: current.spentUsd });
        break;
      case "killed":
        await finishRun(tx, current, "killed", outcome.reason, {
          reason: outcome.reason,
          spent_usd: current.spentUsd,
        });
        break;
      case "failed":
        await finishRun(tx, current, "failed", outcome.error, { error: outcome.error });
    }
  });
}

function decideOutcome(result: ExecutorStepResult, abortReason: unknown): Outcome {
  const tooLarge = checkWorkspaceLimits(result.files);
  if (tooLarge) return { kind: "failed", error: tooLarge };
  switch (result.stopReason) {
    case "stop":
      return { kind: "completed" };
    case "toolUse":
    case "length":
      return { kind: "continue" };
    case "aborted":
      // Either the heartbeat saw the duration cap, or the run was killed / canceled (then the
      // status is already terminal and this outcome is a no-op).
      return abortReason === "max_duration"
        ? { kind: "killed", reason: "max_duration" }
        : { kind: "failed", error: "aborted" };
    default:
      return {
        kind: "failed",
        error: `model stopped: ${result.stopReason}${result.errorMessage ? `: ${result.errorMessage}` : ""}`,
      };
  }
}

/**
 * Terminal transition with CAS. A run that already ended (kill / cancel from the API, or another
 * path in this worker) keeps its status and reason; returns false in that case.
 */
async function finishRun(
  tx: DbExecutor,
  run: Pick<RunRow, "id" | "orgId" | "endUserId">,
  status: "completed" | "killed" | "failed",
  error: string | null,
  payload: Record<string, unknown>,
): Promise<boolean> {
  const [row] = await tx
    .update(runs)
    .set({ status, error, completedAt: new Date() })
    .where(
      sql`${runs.id} = ${run.id} and ${runs.orgId} = ${run.orgId} and ${runs.status} in ('queued','running','awaiting_input')`,
    )
    .returning({ id: runs.id });
  if (!row) return false;
  await appendRunEvents(tx, run, [{ type: `run.${status}`, payload }]);
  await tx.insert(auditEvents).values({
    orgId: run.orgId,
    endUserId: run.endUserId,
    runId: run.id,
    actor: "worker",
    action: `run.${status}`,
    meta: payload,
  });
  return true;
}

/** Lease heartbeat. Aborts the in-flight turn when the lease is gone, the run ended, or the duration cap hit. */
async function extendLease(item: ClaimedItem, abort: AbortController) {
  try {
    const rows = await client`
      update work_items w
      set lease_expires_at = now() + make_interval(secs => ${LEASE_SECONDS})
      from runs r
      where w.id = ${item.id} and w.lease_owner = ${workerId} and w.fence = ${item.fence}
        and r.id = w.run_id and r.org_id = ${item.org_id} and w.status = 'leased' and w.lease_expires_at > now()
      returning r.status, r.started_at, r.max_duration_seconds
    `;
    const row = rows[0] as
      | { status: RunStatus; started_at: Date | null; max_duration_seconds: number | null }
      | undefined;
    if (!row) abort.abort(new LostLeaseError(item.id));
    else if (isTerminal(row.status)) abort.abort(new Error(`run ${item.run_id} is ${row.status}`));
    else if (durationExceeded(row.started_at, row.max_duration_seconds))
      abort.abort("max_duration");
  } catch (err) {
    console.error(`[worker] lease heartbeat failed for ${item.id}`, err);
    abort.abort(new LostLeaseError(item.id));
  }
}

async function destroySandbox(run: Pick<RunRow, "id" | "orgId" | "sandboxState">) {
  const state = run.sandboxState;
  if (!isSandboxSessionState(state)) return;
  if (!hasSandboxProvider(state.backendId)) return;
  try {
    await getSandboxProvider(state.backendId).delete(state);
    await appendRunEvents(db, run, [
      { type: "sandbox.destroyed", payload: { provider: state.backendId, reason: "run_terminal" } },
    ]);
  } catch (err) {
    console.error(`[worker] failed to destroy sandbox for run ${run.id}`, err);
    return;
  }
  await db
    .update(runs)
    .set({ sandboxState: null })
    .where(
      and(
        eq(runs.id, run.id),
        eq(runs.orgId, run.orgId),
        sql`${runs.sandboxState} = ${JSON.stringify(state)}::jsonb`,
      ),
    );
}

/** Terminal runs that still own a sandbox: usually soft-killed while the original worker died. */
async function reapOrphanSandboxes() {
  const orphans = await db
    .select({ id: runs.id, orgId: runs.orgId, sandboxState: runs.sandboxState })
    .from(runs)
    .where(
      and(
        isNotNull(runs.sandboxState),
        sql`${runs.status} in ('completed','failed','killed','canceled')`,
      ),
    )
    .limit(20);
  for (const orphan of orphans) await destroySandbox(orphan);
}

/** Release our lease on the item. False = the lease is no longer ours (another worker claimed it). */
async function releaseItem(item: ClaimedItem, status: "done" | "failed"): Promise<boolean> {
  try {
    const rows = await db
      .update(workItems)
      .set({ status, completedAt: new Date() })
      .where(
        and(
          eq(workItems.id, item.id),
          eq(workItems.leaseOwner, workerId),
          eq(workItems.fence, item.fence),
        ),
      )
      .returning({ id: workItems.id });
    return rows.length > 0;
  } catch (err) {
    console.error(`failed to release item ${item.id}:`, err);
    return false;
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
