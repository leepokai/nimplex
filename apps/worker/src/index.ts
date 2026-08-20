import { randomUUID } from "node:crypto";
import { checkBudget, isTerminal, settleSpend } from "@loopbox/core";
import { appendRunEvents, auditEvents, createDb, runs, usageRecords, workItems } from "@loopbox/db";
import { and, eq } from "drizzle-orm";
import { stubExecutor } from "./stub-executor.ts";

const { db, client } = createDb();
const workerId = `worker-${process.pid}-${randomUUID().slice(0, 8)}`;
const LEASE_SECONDS = 60;
const POLL_MS = 300;

interface ClaimedItem {
  id: string;
  run_id: string;
  kind: "model" | "tool";
  payload: unknown;
  fence: number;
}

console.log(`loopbox worker ${workerId} started`);

for (;;) {
  const item = await claimNext();
  if (!item) {
    await sleep(POLL_MS);
    continue;
  }
  try {
    await processItem(item);
  } catch (err) {
    console.error(`work item ${item.id} failed:`, err);
    await markItemFailed(item);
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

async function processItem(item: ClaimedItem) {
  const run = await db.query.runs.findFirst({ where: eq(runs.id, item.run_id) });
  if (!run || isTerminal(run.status)) {
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

  // W2：美元硬上限——執行前先查帳，超額即殺，不再發出任何工作。
  if (checkBudget(run.spentUsd, run.budgetUsd).exceeded) {
    await killRun(run.id, run.orgId, run.endUserId, run.spentUsd, run.budgetUsd, item);
    return;
  }

  const result = await stubExecutor.step(
    {
      id: run.id,
      orgId: run.orgId,
      endUserId: run.endUserId,
      config: run.config,
      spentUsd: run.spentUsd,
      budgetUsd: run.budgetUsd,
    },
    { id: item.id, kind: item.kind, payload: item.payload },
  );

  const newSpent = settleSpend(run.spentUsd, result.costUsd);
  const exceeded = checkBudget(newSpent, run.budgetUsd).exceeded;

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
    if (owned.length === 0) throw new Error(`lost lease on work item ${item.id}`);

    await appendRunEvents(tx, run.id, result.events);

    // 每一分錢都掛在 end_user 上（W2：可轉售計量的基礎）
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
      await tx
        .update(runs)
        .set({ status: "completed", completedAt: new Date() })
        .where(eq(runs.id, run.id));
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

async function killRun(
  runId: string,
  orgId: string,
  endUserId: string,
  spentUsd: number,
  budgetUsd: number,
  item: ClaimedItem,
) {
  await db.transaction(async (tx) => {
    await tx
      .update(runs)
      .set({ status: "killed", error: "budget_exceeded", completedAt: new Date() })
      .where(eq(runs.id, runId));
    await appendRunEvents(tx, runId, [
      {
        type: "run.killed",
        payload: { reason: "budget_exceeded", spent_usd: spentUsd, budget_usd: budgetUsd },
      },
    ]);
    await tx.insert(auditEvents).values({
      orgId,
      endUserId,
      runId,
      actor: "worker",
      action: "run.killed",
      meta: { spent_usd: spentUsd, budget_usd: budgetUsd },
    });
    await tx
      .update(workItems)
      .set({ status: "done", completedAt: new Date() })
      .where(eq(workItems.id, item.id));
  });
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
