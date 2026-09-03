import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkBudget,
  durationExceeded,
  executionKind,
  isSandboxSessionState,
  isTerminal,
  settleSpend,
} from "@nimplex/core";
import {
  appendRunEvents,
  auditEvents,
  createDb,
  killRun,
  type RunRow,
  resolveHarness,
  runs,
  usageRecords,
  workItems,
} from "@nimplex/db";
import { getSandboxProvider, hasSandboxProvider } from "@nimplex/sandbox";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { executeHarnessRun } from "./harness-executor.ts";
import { executeManagedAgentRun } from "./managed-agent-executor.ts";
import { stubExecutor } from "./stub-executor.ts";

// 根目錄 .env（sandbox provider 的 API key、NIMPLEX_PUBLIC_URL 等）；已存在的環境變數優先。
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
for (const candidate of [resolve(process.cwd(), ".env"), resolve(repoRoot, ".env")]) {
  if (existsSync(candidate)) {
    process.loadEnvFile(candidate);
    break;
  }
}

const { db, client } = createDb();
const workerId = `worker-${process.pid}-${randomUUID().slice(0, 8)}`;
const LEASE_SECONDS = 60;
const POLL_MS = 300;
const REAP_INTERVAL_MS = 10_000;

/** Fence check failed: another worker took over the lease. Kept distinct from ordinary failures because the main loop must give up without touching run state. */
class LostLeaseError extends Error {
  constructor(itemId: string) {
    super(`lost lease on work item ${itemId}`);
    this.name = "LostLeaseError";
  }
}

interface ClaimedItem {
  id: string;
  run_id: string;
  kind: "model" | "tool" | "harness";
  payload: unknown;
  fence: number;
}

console.log(`nimplex worker ${workerId} started`);

// 硬殺的收尾：被砍掉的 run 若還留著沙箱，任何一個 worker 讀 sandbox_state 都能接回去銷毀。
const reaper = setInterval(() => {
  void reapOrphanSandboxes().catch((err) => console.error("[worker] reaper 失敗", err));
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
      console.warn(`[worker] ${err.message}；放棄本次結果，交給接手的 worker`);
      continue;
    }
    console.error(`work item ${item.id} failed:`, err);
    await markItemFailed(item);
    // executor 沒接住的例外：run 也要收尾，不能停在 running 讓呼叫端無限等
    const dangling = await db.query.runs.findFirst({ where: eq(runs.id, item.run_id) });
    if (dangling && !isTerminal(dangling.status)) {
      await failRun(dangling, err instanceof Error ? err.message : String(err)).catch((e) =>
        console.error(`failed to fail run ${item.run_id}:`, e),
      );
    }
  }
}

/** 原子 CAS 領取：pending 或租約過期的 leased 都可領；fence 遞增（防雙寫） */
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
      where status = 'pending' or (status = 'leased' and lease_expires_at < now())
      order by created_at
      for update skip locked
      limit 1
    )
    returning id, run_id, kind, payload, fence
  `;
  const row = rows[0];
  return row ? (row as unknown as ClaimedItem) : null;
}

/** 長時間執行的 harness 要一直續租，否則 60 秒後會被別的 worker 搶走。 */
async function renewLease(item: ClaimedItem): Promise<boolean> {
  const updated = await db
    .update(workItems)
    .set({ leaseExpiresAt: new Date(Date.now() + LEASE_SECONDS * 1000) })
    .where(
      and(
        eq(workItems.id, item.id),
        eq(workItems.leaseOwner, workerId),
        eq(workItems.fence, item.fence),
      ),
    )
    .returning({ id: workItems.id });
  return updated.length > 0;
}

async function processItem(item: ClaimedItem) {
  const run = await db.query.runs.findFirst({ where: eq(runs.id, item.run_id) });
  if (!run || isTerminal(run.status)) {
    if (run) await destroySandbox(run);
    await finishItem(item, "done");
    return;
  }

  if (run.status === "queued") {
    await db.transaction(async (tx) => {
      await tx
        .update(runs)
        .set({ status: "running", startedAt: new Date() })
        .where(eq(runs.id, run.id));
      await appendRunEvents(tx, run.id, [{ type: "run.started", payload: { worker: workerId } }]);
    });
  }

  // 時間上限（metering=none 的唯一上限）——每一步開始前先看鐘
  if (durationExceeded(run.startedAt, run.maxDurationSeconds)) {
    await killRun(db, run, "max_duration", "worker");
    await destroySandbox(run);
    await finishItem(item, "done");
    return;
  }

  // 美元硬上限——執行前先查帳，超額即殺，不再發出任何工作。
  if (run.metering === "exact" && run.budgetUsd !== null) {
    if (checkBudget(run.spentUsd, run.budgetUsd).exceeded) {
      await killRun(db, run, "budget_exceeded", "worker");
      await destroySandbox(run);
      await finishItem(item, "done");
      return;
    }
  }

  if (item.kind === "harness") {
    await processHarnessItem(item, run);
    return;
  }
  await processBuiltinItem(item, run);
}

/** 插槽合體的那條路徑：任意 harness × 任意 sandbox × 使用者自己的 LLM 額度。 */
async function processHarnessItem(item: ClaimedItem, run: RunRow) {
  const harness = await resolveHarness(db, run.orgId, run.harness);
  if (!harness) {
    await failRun(run, `harness "${run.harness}" 已從註冊表消失`);
    await finishItem(item, "done");
    return;
  }
  const kind = executionKind(harness.manifest);
  if (kind === "sandbox" && !hasSandboxProvider(run.sandbox.provider)) {
    await failRun(run, `sandbox provider "${run.sandbox.provider}" 尚未註冊`);
    await finishItem(item, "done");
    return;
  }

  // managed-agent：不開箱，session 在 Anthropic；其餘走沙箱路徑
  const result =
    kind === "managed-agent"
      ? await executeManagedAgentRun(
          { db, renewLease: () => renewLease(item) },
          run,
          harness.manifest,
        )
      : await executeHarnessRun({ db, renewLease: () => renewLease(item) }, run, harness.manifest);

  const fresh = await db.query.runs.findFirst({ where: eq(runs.id, run.id) });
  const alreadyTerminal = fresh ? isTerminal(fresh.status) : false;

  if (!alreadyTerminal) {
    if (result.status === "completed") {
      await db.transaction(async (tx) => {
        const [completed] = await tx
          .update(runs)
          .set({ status: "completed", completedAt: new Date(), sandboxState: null })
          .where(
            sql`${runs.id} = ${run.id} and ${runs.status} in ('queued','running','awaiting_input')`,
          )
          .returning({ id: runs.id });
        if (!completed) return; // 最後一刻被殺：保留 killed，不蓋成 completed
        await appendRunEvents(tx, run.id, [
          { type: "run.completed", payload: { spent_usd: fresh?.spentUsd ?? run.spentUsd } },
        ]);
        await tx.insert(auditEvents).values({
          orgId: run.orgId,
          endUserId: run.endUserId,
          runId: run.id,
          actor: "worker",
          action: "run.completed",
          meta: { harness: run.harness, spent_usd: fresh?.spentUsd ?? run.spentUsd },
        });
      });
    } else {
      await failRun(run, result.error ?? "harness 執行失敗");
    }
  } else {
    // 已經被閘道或 API 軟殺了，這裡只負責把沙箱狀態清乾淨
    await db.update(runs).set({ sandboxState: null }).where(eq(runs.id, run.id));
  }

  await finishItem(item, "done");
}

/** 零設定的內建 loop：不開沙箱、不需要 BYOK，用來驗證計量與 kill-switch。 */
async function processBuiltinItem(item: ClaimedItem, run: RunRow) {
  const result = await stubExecutor.step(
    {
      id: run.id,
      orgId: run.orgId,
      endUserId: run.endUserId,
      config: run.config,
      spentUsd: run.spentUsd,
      budgetUsd: run.budgetUsd ?? Number.POSITIVE_INFINITY,
    },
    { id: item.id, kind: item.kind === "harness" ? "model" : item.kind, payload: item.payload },
  );

  const newSpent = settleSpend(run.spentUsd, result.costUsd);
  const exceeded =
    run.metering === "exact" &&
    run.budgetUsd !== null &&
    checkBudget(newSpent, run.budgetUsd).exceeded;

  await db.transaction(async (tx) => {
    // fence：確認租約仍屬於本 worker，否則整筆放棄（防止卡住又醒來的雙寫）
    const owned = await tx
      .update(workItems)
      .set({ status: "done", completedAt: new Date() })
      .where(
        and(
          eq(workItems.id, item.id),
          eq(workItems.leaseOwner, workerId),
          eq(workItems.fence, item.fence),
        ),
      )
      .returning({ id: workItems.id });
    if (owned.length === 0) throw new LostLeaseError(item.id);

    await appendRunEvents(tx, run.id, result.events);

    // 每一分錢都掛在 end_user 上
    await tx.insert(usageRecords).values({
      orgId: run.orgId,
      endUserId: run.endUserId,
      runId: run.id,
      kind: item.kind,
      amountUsd: result.costUsd,
      meta: { executor: stubExecutor.id },
    });
    await tx.update(runs).set({ spentUsd: newSpent }).where(eq(runs.id, run.id));

    if (result.next.kind === "complete") {
      const [completed] = await tx
        .update(runs)
        .set({ status: "completed", completedAt: new Date() })
        .where(
          sql`${runs.id} = ${run.id} and ${runs.status} in ('queued','running','awaiting_input')`,
        )
        .returning({ id: runs.id });
      // 最後一步進行中被殺：保留 killed，不寫 completed
      if (completed) {
        await appendRunEvents(tx, run.id, [
          { type: "run.completed", payload: { spent_usd: newSpent } },
        ]);
        await tx.insert(auditEvents).values({
          orgId: run.orgId,
          endUserId: run.endUserId,
          runId: run.id,
          actor: "worker",
          action: "run.completed",
          meta: { spent_usd: newSpent },
        });
      }
    } else if (exceeded) {
      // kill-switch：結帳後發現超額，當場終結，不發下一個 work item。
      await tx
        .update(runs)
        .set({ status: "killed", error: "budget_exceeded", completedAt: new Date() })
        .where(eq(runs.id, run.id));
      await appendRunEvents(tx, run.id, [
        {
          type: "run.killed",
          payload: { reason: "budget_exceeded", spent_usd: newSpent, budget_usd: run.budgetUsd },
        },
      ]);
      await tx.insert(auditEvents).values({
        orgId: run.orgId,
        endUserId: run.endUserId,
        runId: run.id,
        actor: "worker",
        action: "run.killed",
        meta: { spent_usd: newSpent, budget_usd: run.budgetUsd },
      });
    } else if (result.next.kind === "continue") {
      await tx.insert(workItems).values({
        runId: run.id,
        kind: result.next.nextItem.kind,
        payload: result.next.nextItem.payload,
      });
    } else {
      await tx.update(runs).set({ status: "awaiting_input" }).where(eq(runs.id, run.id));
      await appendRunEvents(tx, run.id, [{ type: "run.awaiting_input" }]);
    }
  });
}

async function failRun(run: RunRow, error: string) {
  await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(runs)
      .set({ status: "failed", error, completedAt: new Date(), sandboxState: null })
      .where(
        sql`${runs.id} = ${run.id} and ${runs.status} not in ('completed','failed','killed','canceled')`,
      )
      .returning({ id: runs.id });
    if (!updated) return;
    await appendRunEvents(tx, run.id, [{ type: "run.failed", payload: { error } }]);
    await tx.insert(auditEvents).values({
      orgId: run.orgId,
      endUserId: run.endUserId,
      runId: run.id,
      actor: "worker",
      action: "run.failed",
      meta: { error },
    });
  });
}

async function destroySandbox(run: Pick<RunRow, "id" | "sandboxState">) {
  const state = run.sandboxState;
  if (!isSandboxSessionState(state)) return;
  if (!hasSandboxProvider(state.backendId)) return;
  try {
    await getSandboxProvider(state.backendId).delete(state);
    await appendRunEvents(db, run.id, [
      { type: "sandbox.destroyed", payload: { provider: state.backendId, reason: "run_terminal" } },
    ]);
  } catch (err) {
    console.error(`[worker] 銷毀 run ${run.id} 的沙箱失敗`, err);
  } finally {
    await db.update(runs).set({ sandboxState: null }).where(eq(runs.id, run.id));
  }
}

/** 終態但沙箱還在的 run —— 通常是被閘道軟殺後、原本的 worker 掛掉了。 */
async function reapOrphanSandboxes() {
  const orphans = await db
    .select({ id: runs.id, sandboxState: runs.sandboxState })
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

async function finishItem(item: ClaimedItem, status: "done" | "failed") {
  await db
    .update(workItems)
    .set({ status, completedAt: new Date() })
    .where(eq(workItems.id, item.id));
}

async function markItemFailed(item: ClaimedItem) {
  await finishItem(item, "failed").catch((err) => {
    console.error(`failed to mark item ${item.id} as failed:`, err);
  });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
