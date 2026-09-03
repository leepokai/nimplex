// Claude Managed Agents 執行路徑：agent loop 與容器都在 Anthropic 那邊，
// nimplex 這邊只做三件事——建 session（帶預算）、把事件流翻成 nimplex 事件、殺。
//
// 不變式 I1 守法：官方 SDK 的 baseURL 指向 nimplex 閘道、apiKey 用現鑄的 run token，
// 閘道在轉發那一刻才換成使用者的 BYOK key——真 key 從頭到尾不進 worker。
// 錶：花費由上游 session.usage 回報（metering=provider_reported），不是閘道實測。

import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import type { HarnessManifest } from "@nimplex/contracts";
import {
  durationExceeded,
  isTerminal,
  parseListCostUsd,
  publicUrl,
  translateManagedAgentEvent,
  usdToCents,
} from "@nimplex/core";
import {
  appendRunEvents,
  type Db,
  generateRunToken,
  hashToken,
  killRun,
  managedAgentRefs,
  type RunRow,
  runs,
  usageRecords,
} from "@nimplex/db";
import { and, eq } from "drizzle-orm";

export interface ManagedAgentExecutionResult {
  status: "completed" | "failed" | "killed";
  error: string | null;
}

export interface ManagedAgentExecutionDeps {
  db: Db;
  renewLease: () => Promise<boolean>;
}

const WATCHDOG_INTERVAL_MS = 5_000;
const CLEANUP_POLL_MS = 200;
const CLEANUP_POLL_MAX = 15;

export async function executeManagedAgentRun(
  { db, renewLease }: ManagedAgentExecutionDeps,
  run: RunRow,
  manifest: HarnessManifest,
): Promise<ManagedAgentExecutionResult> {
  // 這條連線用的票是現鑄的，跟建立 run 時回傳給整合方的那張不同。
  const token = generateRunToken();
  await db
    .update(runs)
    .set({ sandboxTokenHash: hashToken(token) })
    .where(eq(runs.id, run.id));

  const client = new Anthropic({
    apiKey: token,
    baseURL: `${publicUrl()}/gw/anthropic`,
    maxRetries: 2,
  });

  const config = run.config as { instructions?: string; input?: string | null };
  const instructions = config.instructions ?? "";
  const task = config.input && config.input.length > 0 ? config.input : instructions;
  const controller = new AbortController();

  // MA 的錢不經閘道，只有這裡知道花了多少：除了覆寫 runs.spent_usd，還要把「增量」記進 usage_records，
  // 帳務 rollup（GET /v1/usage）看的是逐筆記帳。增量以資料庫當下的值為基準（不是記憶體裡的上一個值），
  // worker 重領同一個 run 也不會重複記；花費只增不減，回報變小就忽略。
  // Returns whether nimplex's own budget_usd has been reached: provider_reported spend never passes
  // the gateway's gateCall, and the upstream max_list_cost is a rounded-up list price, so this is
  // the only place nimplex can hit the brakes.
  const recordSpend = async (
    spent: number,
    source: "session" | "stream",
    sourceSessionId: string,
  ): Promise<boolean> => {
    await db.transaction(async (tx) => {
      const [row] = await tx
        .select({ spentUsd: runs.spentUsd })
        .from(runs)
        .where(eq(runs.id, run.id))
        .for("update");
      const previous = row?.spentUsd ?? 0;
      if (spent <= previous) return;
      await tx.update(runs).set({ spentUsd: spent }).where(eq(runs.id, run.id));
      await tx.insert(usageRecords).values({
        orgId: run.orgId,
        endUserId: run.endUserId,
        runId: run.id,
        kind: "managed_agent",
        amountUsd: spent - previous,
        meta: { source, session_id: sourceSessionId },
      });
    });
    return run.budgetUsd !== null && spent >= run.budgetUsd;
  };

  // Re-lease (the previous worker died mid-run): the session it left behind keeps running upstream on
  // the BYOK key and burns up to its own cap unless someone interrupts it. Sync its spend, interrupt,
  // delete, then start fresh, the same reclaim the sandbox path does in harness-executor.ts.
  if (run.sandboxRef) {
    const previousSessionId = run.sandboxRef;
    await client.beta.sessions.events
      .send(previousSessionId, { events: [{ type: "user.interrupt" }] })
      .catch(() => {});
    try {
      const s = await client.beta.sessions.retrieve(previousSessionId);
      const spent = parseListCostUsd((s as { usage?: { list_cost?: unknown } }).usage?.list_cost);
      if (spent !== null) await recordSpend(spent, "session", previousSessionId);
    } catch {
      // Not retrievable: fine, the cleanup below retries the delete anyway
    }
    await cleanupSession(client, previousSessionId).catch((err) =>
      console.error(`[worker] 清理前次 managed-agent session ${previousSessionId} 失敗`, err),
    );
    await appendRunEvents(db, run.id, [
      { type: "harness.session_reclaimed", payload: { previous_session_id: previousSessionId } },
    ]);
  }

  // setup 階段任何一步失敗（最常見：BYOK key 無效 → 上游 401）都要以 failed 收尾，
  // 不能把例外丟回主迴圈讓 run 懸空。
  let sessionId: string | null = null;
  let setup: {
    sessionId: string;
    agentId: string;
    environmentId: string;
    stream: AsyncIterable<unknown>;
  };
  try {
    setup = await setupSession();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (sessionId) {
      await cleanupSession(client, sessionId).catch(() => {});
    }
    await appendRunEvents(db, run.id, [
      { type: "harness.event", payload: { type: "managed_agent.setup_failed", error: message } },
    ]);
    return { status: "failed", error: message };
  }
  const { stream } = setup;

  async function setupSession() {
    // Anthropic 要求 agent / environment 建一次用多次：以 org 為單位快取遠端 id
    const createEnvironment = async () => {
      const env = await client.beta.environments.create({
        name: "nimplex",
        description: "由 nimplex 建立；每個 run 一個 session",
        config: { type: "cloud", networking: { type: "unrestricted" } },
      });
      return env.id;
    };
    const agentKey = `${run.model}:${sha256(instructions)}`;
    const createAgent = async () => {
      const agent = await client.beta.agents.create({
        name: `nimplex ${manifest.slug} ${run.model}`.slice(0, 256),
        description: "由 nimplex 建立的 agent 設定（model × instructions 一組一個）",
        model: run.model,
        ...(instructions ? { system: instructions } : {}),
        tools: [{ type: "agent_toolset_20260401", default_config: { enabled: true } }],
      });
      return agent.id;
    };
    let environmentId = await ensureRef(db, run.orgId, "environment", "cloud", createEnvironment);
    let agentId = await ensureRef(db, run.orgId, "agent", agentKey, createAgent);

    const createSession = (agent: string, environment: string) =>
      client.beta.sessions.create({
        agent,
        environment_id: environment,
        title: `nimplex run ${run.id}`,
        metadata: { nimplex_run_id: run.id },
        ...(run.budgetUsd !== null
          ? {
              budget: {
                type: "limit",
                max_list_cost: { amount: usdToCents(run.budgetUsd), currency: "USD" },
              },
            }
          : {}),
      });

    let session: Awaited<ReturnType<typeof createSession>>;
    try {
      session = await createSession(agentId, environmentId);
    } catch (err) {
      if (!isNotFound(err)) throw err;
      // The cached environment / agent no longer exists upstream (BYOK key or base_url changed, or it
      // was deleted in the console). Drop this org's cache and rebuild once, otherwise every
      // managed-agent run for the org ends in 404 from now on.
      await db.delete(managedAgentRefs).where(eq(managedAgentRefs.orgId, run.orgId));
      await appendRunEvents(db, run.id, [
        { type: "harness.event", payload: { type: "managed_agent.refs_invalidated" } },
      ]);
      environmentId = await ensureRef(db, run.orgId, "environment", "cloud", createEnvironment);
      agentId = await ensureRef(db, run.orgId, "agent", agentKey, createAgent);
      session = await createSession(agentId, environmentId);
    }
    // Record the id immediately: if any later step (DB write, opening the stream) fails, the catch
    // block can only delete the session if it knows the id
    sessionId = session.id;

    await db.update(runs).set({ sandboxRef: session.id }).where(eq(runs.id, run.id));
    await appendRunEvents(db, run.id, [
      {
        type: "harness.session",
        payload: {
          provider: "anthropic-managed-agents",
          session_id: session.id,
          agent_id: agentId,
          environment_id: environmentId,
          budget_cents: run.budgetUsd === null ? null : usdToCents(run.budgetUsd),
          trace_url: `https://platform.claude.com/workspaces/default/sessions/${session.id}`,
        },
      },
    ]);

    // stream-first：先開串流再送第一則訊息，否則開頭的事件會漏
    const stream = await client.beta.sessions.events.stream(session.id, undefined, {
      signal: controller.signal,
    });
    await client.beta.sessions.events.send(session.id, {
      events: [{ type: "user.message", content: [{ type: "text", text: task }] }],
    });
    return { sessionId: session.id, agentId, environmentId, stream };
  }

  const liveSessionId = setup.sessionId;

  // 花費以 session 物件的 usage.list_cost 為權威（官方文件），不只靠串流的 session.usage——
  // SDK 的 SSE 白名單可能落後於 API（0.123.0 就沒有 session.usage），串流那筆會被靜默丟掉。
  let lastSpentUsd: number | null = null;

  let budgetHit = false;
  const hitBudget = async () => {
    if (budgetHit) return;
    budgetHit = true;
    await client.beta.sessions.events
      .send(liveSessionId, { events: [{ type: "user.interrupt" }] })
      .catch(() => {});
    controller.abort();
  };

  const syncUsage = async () => {
    const s = await client.beta.sessions.retrieve(liveSessionId);
    const usage = (s as { usage?: { list_cost?: unknown } }).usage;
    const spent = parseListCostUsd(usage?.list_cost);
    if (spent === null || spent === lastSpentUsd) return;
    lastSpentUsd = spent;
    const exceeded = await recordSpend(spent, "session", liveSessionId);
    await appendRunEvents(db, run.id, [
      { type: "spend.updated", payload: { spent_usd: spent, source: "session" } },
    ]);
    if (exceeded) await hitBudget();
  };

  // 看門狗：續租 + 同步花費 + 監看 run 是否已被 API／閘道軟殺 → 打斷 session 並中止串流
  let killedExternally = false;
  const watchdog = setInterval(() => {
    void (async () => {
      await renewLease();
      await syncUsage().catch(() => {});
      const current = await db.query.runs.findFirst({
        where: eq(runs.id, run.id),
        columns: { status: true, startedAt: true, maxDurationSeconds: true },
      });
      if (
        current &&
        !isTerminal(current.status) &&
        durationExceeded(current.startedAt, current.maxDurationSeconds)
      ) {
        await killRun(db, run, "max_duration", "worker");
      }
      if (current && isTerminal(current.status) && !killedExternally) {
        killedExternally = true;
        await client.beta.sessions.events
          .send(liveSessionId, { events: [{ type: "user.interrupt" }] })
          .catch(() => {});
        controller.abort();
      }
    })().catch((err) => console.error("[worker] managed-agent 看門狗失敗", err));
  }, WATCHDOG_INTERVAL_MS);

  let status: ManagedAgentExecutionResult["status"] = "failed";
  let error: string | null = null;

  try {
    consume: for await (const event of stream) {
      const translated = translateManagedAgentEvent(event);
      if (translated.events.length > 0) await appendRunEvents(db, run.id, translated.events);
      if (translated.spentUsd !== undefined) {
        lastSpentUsd = translated.spentUsd;
        if (await recordSpend(translated.spentUsd, "stream", liveSessionId)) {
          await hitBudget();
          status = "killed";
          break;
        }
      }
      switch (translated.outcome.kind) {
        case "continue":
          break;
        case "completed":
        case "terminated":
          status = "completed";
          break consume;
        case "budget_exceeded":
          // 上游把 session 暫停在預算上限；nimplex v1 語意是殺（roadmap：paused 可續跑）
          budgetHit = true;
          status = "killed";
          break consume;
        case "requires_action":
          error = "managed agent 在等 custom tool 結果，但 nimplex 尚未配置 custom tool";
          await client.beta.sessions.events
            .send(liveSessionId, { events: [{ type: "user.interrupt" }] })
            .catch(() => {});
          break consume;
        case "failed":
          error = translated.outcome.error;
          break consume;
      }
    }
  } catch (err) {
    if (!killedExternally && !budgetHit) error = err instanceof Error ? err.message : String(err);
  } finally {
    clearInterval(watchdog);
  }

  if (killedExternally || budgetHit) status = "killed";

  // 最終花費以 session 物件為準；殺之前先同步，帳才對得上
  await syncUsage().catch((err) => console.error("[worker] managed-agent usage 同步失敗", err));
  if (budgetHit) {
    const fresh = await db.query.runs.findFirst({ where: eq(runs.id, run.id) });
    await killRun(db, fresh ?? run, "budget_exceeded", "worker");
  }

  // 硬殺／收尾：session 是拋棄式的——刪掉釋放容器、避免帳號堆一堆殭屍 session
  //（runtime 費用只按 active_seconds 算，idle 不計時；刪除是衛生，不是省錢）
  await cleanupSession(client, liveSessionId).catch((err) =>
    console.error(`[worker] 刪除 managed-agent session ${liveSessionId} 失敗`, err),
  );
  await appendRunEvents(db, run.id, [
    { type: "harness.session_closed", payload: { session_id: liveSessionId, status } },
  ]);

  return { status, error };
}

/** 串流的 idle 事件會比 session 狀態早一拍；直接刪會 400，先等它不再 running。 */
async function cleanupSession(client: Anthropic, sessionId: string) {
  for (let i = 0; i < CLEANUP_POLL_MAX; i += 1) {
    const s = await client.beta.sessions.retrieve(sessionId);
    if (s.status !== "running") break;
    await new Promise((r) => setTimeout(r, CLEANUP_POLL_MS));
  }
  await client.beta.sessions.delete(sessionId);
}

async function ensureRef(
  db: Db,
  orgId: string,
  kind: "environment" | "agent",
  key: string,
  create: () => Promise<string>,
): Promise<string> {
  const existing = await db.query.managedAgentRefs.findFirst({
    where: and(
      eq(managedAgentRefs.orgId, orgId),
      eq(managedAgentRefs.kind, kind),
      eq(managedAgentRefs.key, key),
    ),
  });
  if (existing) return existing.remoteId;
  const remoteId = await create();
  await db.insert(managedAgentRefs).values({ orgId, kind, key, remoteId }).onConflictDoNothing();
  return remoteId;
}

/** Upstream 404 (the SDK's NotFoundError or any error carrying status=404). */
function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { status?: unknown }).status === 404;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
