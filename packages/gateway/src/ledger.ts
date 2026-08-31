// 閘道的帳本：認票 → 找 key → 預留 → 結算 → 超額就殺。

import type { ModelProvider } from "@nimplex/contracts";
import { availableUsd, settleSpend } from "@nimplex/core";
import {
  adjustReserved,
  appendRunEvents,
  type Db,
  endUsers,
  hashToken,
  killRun,
  open,
  providerKeys,
  type RunRow,
  runs,
  usageRecords,
} from "@nimplex/db";
import { and, eq, isNull, or, sql } from "drizzle-orm";

export interface AuthorizedRun {
  run: RunRow;
  endUserExternalId: string;
}

export async function authorizeRun(db: Db, token: string): Promise<AuthorizedRun | null> {
  const hash = hashToken(token);
  const run = await db.query.runs.findFirst({
    where: or(eq(runs.runTokenHash, hash), eq(runs.sandboxTokenHash, hash)),
  });
  if (!run) return null;
  const endUser = await db.query.endUsers.findFirst({ where: eq(endUsers.id, run.endUserId) });
  return { run, endUserExternalId: endUser?.externalId ?? run.endUserId };
}

export interface ResolvedKey {
  apiKey: string;
  baseUrl: string | null;
  scope: "end_user" | "org";
  keyId: string;
  last4: string;
}

/**
 * 解析優先序 end_user > org。
 * 這是「同一個 org 底下每個終端使用者燒自己的帳」的實作點，
 * 也是 run 稽核裡「這次用了誰的 key」的來源。
 */
export async function resolveProviderKey(
  db: Db,
  orgId: string,
  endUserId: string,
  provider: ModelProvider,
): Promise<ResolvedKey | null> {
  const rows = await db
    .select()
    .from(providerKeys)
    .where(
      and(
        eq(providerKeys.orgId, orgId),
        eq(providerKeys.provider, provider),
        sql`(${providerKeys.endUserId} = ${endUserId} or ${providerKeys.endUserId} is null)`,
      ),
    );
  const forEndUser = rows.find((r) => r.endUserId === endUserId);
  const forOrg = rows.find((r) => r.endUserId === null);
  const chosen = forEndUser ?? forOrg;
  if (!chosen) return null;
  return {
    apiKey: open({ ciphertext: chosen.ciphertext, iv: chosen.iv, tag: chosen.tag }),
    baseUrl: chosen.baseUrl,
    scope: chosen.endUserId ? "end_user" : "org",
    keyId: chosen.id,
    last4: chosen.last4,
  };
}

export async function listProviderKeys(db: Db, orgId: string) {
  return db
    .select({
      id: providerKeys.id,
      provider: providerKeys.provider,
      endUserId: providerKeys.endUserId,
      last4: providerKeys.last4,
      baseUrl: providerKeys.baseUrl,
      createdAt: providerKeys.createdAt,
    })
    .from(providerKeys)
    .where(eq(providerKeys.orgId, orgId));
}

export async function findProviderKeyRow(
  db: Db,
  orgId: string,
  provider: ModelProvider,
  endUserId: string | null,
) {
  return db.query.providerKeys.findFirst({
    where: and(
      eq(providerKeys.orgId, orgId),
      eq(providerKeys.provider, provider),
      endUserId ? eq(providerKeys.endUserId, endUserId) : isNull(providerKeys.endUserId),
    ),
  });
}

export interface BudgetGate {
  allowed: boolean;
  availableUsd: number;
  reason?: "budget_exceeded" | "run_not_active";
}

/** 發請求**之前**的閘門。metering=none 的 run 沒有美元上限可查，一律放行。 */
export function gateCall(run: RunRow): BudgetGate {
  if (run.status !== "queued" && run.status !== "running" && run.status !== "awaiting_input") {
    // 已經因為超額被殺的 run，要讓 harness 看到真正的原因而不是籠統的「不在可執行狀態」
    const reason = run.error === "budget_exceeded" ? "budget_exceeded" : "run_not_active";
    return { allowed: false, availableUsd: 0, reason };
  }
  if (run.metering !== "exact" || run.budgetUsd === null) {
    return { allowed: true, availableUsd: Number.POSITIVE_INFINITY };
  }
  const available = availableUsd(run.spentUsd, run.reservedUsd, run.budgetUsd);
  if (available <= 0) return { allowed: false, availableUsd: available, reason: "budget_exceeded" };
  return { allowed: true, availableUsd: available };
}

export async function reserve(db: Db, runId: string, amountUsd: number): Promise<void> {
  if (amountUsd <= 0) return;
  await adjustReserved(db, runId, amountUsd);
}

export async function release(db: Db, runId: string, amountUsd: number): Promise<void> {
  if (amountUsd <= 0) return;
  await adjustReserved(db, runId, -amountUsd);
}

export interface SettleInput {
  run: RunRow;
  costUsd: number;
  reservedUsd: number;
  provider: ModelProvider;
  model: string;
  estimated: boolean;
  meta: Record<string, unknown>;
}

export interface SettleResult {
  spentUsd: number;
  exceeded: boolean;
}

/** 結算一次 model call：釋放預留、記帳、寫事件；超額就地軟殺。 */
export async function settleCall(db: Db, input: SettleInput): Promise<SettleResult> {
  const { run, costUsd, reservedUsd, provider, model, estimated, meta } = input;
  const spentUsd = settleSpend(run.spentUsd, costUsd);

  await db.transaction(async (tx) => {
    await tx
      .update(runs)
      .set({
        spentUsd: sql`${runs.spentUsd} + ${costUsd}`,
        reservedUsd: sql`greatest(0, ${runs.reservedUsd} - ${reservedUsd})`,
      })
      .where(eq(runs.id, run.id));
    await tx.insert(usageRecords).values({
      orgId: run.orgId,
      endUserId: run.endUserId,
      runId: run.id,
      kind: "model",
      amountUsd: costUsd,
      meta: { provider, model, estimated, ...meta },
    });
    await appendRunEvents(tx, run.id, [
      {
        type: "model.call",
        payload: { provider, model, cost_usd: costUsd, estimated, ...meta },
      },
    ]);
  });

  // 併發時 run.spentUsd 可能已經過期，超額判定一律看資料庫的當下值。
  const fresh = await db.query.runs.findFirst({
    where: eq(runs.id, run.id),
    columns: { spentUsd: true, budgetUsd: true, metering: true, status: true },
  });
  const currentSpent = fresh?.spentUsd ?? spentUsd;
  const exceeded =
    (fresh?.metering ?? run.metering) === "exact" &&
    (fresh?.budgetUsd ?? run.budgetUsd) !== null &&
    currentSpent >= (fresh?.budgetUsd ?? run.budgetUsd ?? Number.POSITIVE_INFINITY);
  if (exceeded) {
    await killRun(db, { ...run, spentUsd: currentSpent }, "budget_exceeded", "gateway");
  }
  return { spentUsd: currentSpent, exceeded };
}

/** 上游沒回報 usage —— 錶在這一刻是瞎的，必須留下痕跡而不是靜靜當成 $0。 */
export async function recordMeteringGap(
  db: Db,
  run: RunRow,
  detail: Record<string, unknown>,
): Promise<void> {
  await appendRunEvents(db, run.id, [{ type: "metering.gap", payload: detail }]);
}

export async function killForBudget(db: Db, run: RunRow): Promise<void> {
  await killRun(db, run, "budget_exceeded", "gateway");
}
