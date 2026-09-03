// nimplex 閘道：夾在 harness 與模型供應商之間的那條線。
//
// 為什麼整個產品的支點在這裡：
//   - 沙箱裡的 harness 只拿到 run token，使用者的真 key 永遠不進箱子
//   - 每一個 model call 都經過這裡 → 錶與 harness 無關（換 Claude Code、換 Codex 都照轉）
//   - 撞到上限時可以「不發下一個 call」（軟殺），而不是只能等 run 自己結束
//
// 這條線也是 BYOK 的落點：使用者自己提供 token，我們只做記帳與治理，不轉售。

import { modelProvider } from "@nimplex/contracts";
import { computeCost } from "@nimplex/core";
import type { Db } from "@nimplex/db";
import { Hono } from "hono";
import * as ledger from "./ledger.ts";
import { PROVIDER_ADAPTERS, UsageAccumulator } from "./providers.ts";

export * from "./ledger.ts";
export * from "./providers.ts";

/** 轉發時一定要丟掉的請求標頭：認證換成使用者的真 key，長度與編碼交給 fetch 重算。 */
const STRIPPED_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "accept-encoding",
  "authorization",
  "x-api-key",
]);

const STRIPPED_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
]);

export function createGateway(db: Db) {
  const app = new Hono();

  app.all("/:provider/:rest{.*}", async (c) => {
    const parsedProvider = modelProvider.safeParse(c.req.param("provider"));
    if (!parsedProvider.success) {
      return c.json({ error: { type: "unknown_provider", message: "未知的供應商" } }, 404);
    }
    const provider = parsedProvider.data;
    const adapter = PROVIDER_ADAPTERS[provider];

    const token = extractRunToken(c.req.raw.headers);
    if (!token) {
      return c.json(
        { error: { type: "missing_run_token", message: "缺少 nimplex run token" } },
        401,
      );
    }
    const authorized = await ledger.authorizeRun(db, token);
    if (!authorized) {
      return c.json({ error: { type: "invalid_run_token", message: "run token 無效" } }, 401);
    }
    const { run } = authorized;
    const method = c.req.method;
    const rest = c.req.param("rest") ?? "";

    // 控制面直通（Managed Agents 的 sessions / agents / environments）：只換 key、不預扣不結算。
    // run 已終態時只放行「收尾」操作——查詢、刪除 session、只含 user.interrupt 的 events——
    // 否則軟殺之後硬殺（刪 session）永遠到不了上游，session 會漏在那邊繼續計時。
    if (adapter.passthroughPaths?.some((re) => re.test(rest))) {
      // Passthrough is only for provider_reported runs (upstream reports spend and enforces the cap).
      // If an exact run could reach this branch, its run token would bypass reserve/settle and the
      // dollar cap entirely, so refuse.
      if (run.metering !== "provider_reported") {
        return c.json(
          {
            error: {
              type: "passthrough_forbidden",
              message: `控制面直通只給 metering=provider_reported 的 run；run ${run.id} 是 ${run.metering}，model call 請走計量端點`,
            },
          },
          403,
        );
      }
      const passBody = method === "GET" || method === "HEAD" ? undefined : await c.req.text();
      if (!ledger.gateCall(run).allowed && !isCleanupRequest(method, rest, passBody)) {
        return c.json(
          {
            error: {
              type: "run_not_active",
              message: `run ${run.id} 已結束（${run.status}），控制面只允許收尾操作（查詢／中斷／刪除 session）`,
            },
          },
          409,
        );
      }
      const passKey = await ledger.resolveProviderKey(db, run.orgId, run.endUserId, provider);
      if (!passKey) {
        return c.json(
          { error: { type: "no_provider_key", message: `org 沒有 ${provider} 的 BYOK 憑證` } },
          400,
        );
      }
      const headers = new Headers();
      for (const [name, value] of c.req.raw.headers) {
        if (!STRIPPED_REQUEST_HEADERS.has(name.toLowerCase())) headers.set(name, value);
      }
      for (const [name, value] of Object.entries(adapter.authHeaders(passKey.apiKey))) {
        headers.set(name, value);
      }
      let upstream: Response;
      try {
        upstream = await fetch(
          buildUpstreamUrl(
            passKey.baseUrl ?? adapter.defaultBaseUrl,
            rest,
            new URL(c.req.url).search,
          ),
          { method, headers, body: passBody },
        );
      } catch (err) {
        return c.json({ error: { type: "upstream_unreachable", message: String(err) } }, 502);
      }
      const responseHeaders = new Headers();
      for (const [name, value] of upstream.headers) {
        if (!STRIPPED_RESPONSE_HEADERS.has(name.toLowerCase())) responseHeaders.set(name, value);
      }
      return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
    }

    // 閘門一：發請求之前。這是「跑到一半也砍得掉」的軟殺路徑。
    const gate = ledger.gateCall(run);
    if (!gate.allowed) {
      if (gate.reason === "budget_exceeded") await ledger.killForBudget(db, run);
      return c.json(
        {
          error: {
            type: gate.reason,
            message:
              gate.reason === "budget_exceeded"
                ? `run ${run.id} 已達美元上限 $${run.budgetUsd}，閘道拒絕再發出 model call`
                : `run ${run.id} 不在可執行狀態（${run.status}）`,
          },
        },
        gate.reason === "budget_exceeded" ? 402 : 409,
      );
    }

    const key = await ledger.resolveProviderKey(db, run.orgId, run.endUserId, provider);
    if (!key) {
      return c.json(
        {
          error: {
            type: "no_provider_key",
            message: `org 沒有 ${provider} 的 BYOK 憑證，請先 PUT /v1/provider-keys`,
          },
        },
        400,
      );
    }

    let bodyText: string | undefined;
    let bodyJson: Record<string, unknown> | null = null;
    if (method !== "GET" && method !== "HEAD") {
      const raw = await c.req.text();
      bodyText = raw;
      if (raw) {
        try {
          const parsed: unknown = JSON.parse(raw);
          if (parsed && typeof parsed === "object") bodyJson = parsed as Record<string, unknown>;
        } catch {
          // 非 JSON body 原樣轉發
        }
      }
    }
    if (bodyJson) {
      bodyJson = adapter.rewriteBody(bodyJson);
      bodyText = JSON.stringify(bodyJson);
    }

    const requestedModel = typeof bodyJson?.model === "string" ? bodyJson.model : run.model;

    // 預留：先扣一筆估計值，回應回來再結算。沒有這步，併發呼叫會一起衝過上限。
    const reservedUsd = estimateReserve(
      provider,
      requestedModel,
      bodyText,
      bodyJson,
      gate.availableUsd,
    );
    await ledger.reserve(db, run.id, reservedUsd);

    const upstreamUrl = buildUpstreamUrl(
      key.baseUrl ?? adapter.defaultBaseUrl,
      rest,
      new URL(c.req.url).search,
    );

    const headers = new Headers();
    for (const [name, value] of c.req.raw.headers) {
      if (!STRIPPED_REQUEST_HEADERS.has(name.toLowerCase())) headers.set(name, value);
    }
    for (const [name, value] of Object.entries(adapter.authHeaders(key.apiKey))) {
      headers.set(name, value);
    }

    let upstream: Response;
    try {
      upstream = await fetch(upstreamUrl, { method, headers, body: bodyText });
    } catch (err) {
      await ledger.release(db, run.id, reservedUsd);
      return c.json(
        {
          error: {
            type: "upstream_unreachable",
            message: err instanceof Error ? err.message : String(err),
          },
        },
        502,
      );
    }

    const accumulator = new UsageAccumulator();
    const settle = async () => {
      const extract = accumulator.result();
      const meta = {
        http_status: upstream.status,
        path: `/${c.req.param("rest") ?? ""}`,
        key_scope: key.scope,
        key_last4: key.last4,
        input_tokens: extract.usage?.inputTokens ?? 0,
        output_tokens: extract.usage?.outputTokens ?? 0,
        cache_read_tokens: extract.usage?.cacheReadTokens ?? 0,
        cache_write_tokens: extract.usage?.cacheWriteTokens ?? 0,
      };

      if (!extract.usage && extract.reportedCostUsd === null) {
        await ledger.release(db, run.id, reservedUsd);
        // 只有成功的回應才算「錶瞎了」；4xx/5xx 本來就沒有 usage。
        if (upstream.ok) await ledger.recordMeteringGap(db, run, meta);
        return;
      }

      const usage = extract.usage ?? { inputTokens: 0, outputTokens: 0 };
      const computed = computeCost(provider, extract.model ?? requestedModel, usage);
      const costUsd = extract.reportedCostUsd ?? computed.costUsd;
      await ledger.settleCall(db, {
        run,
        costUsd,
        reservedUsd,
        provider,
        model: extract.model ?? requestedModel,
        estimated: extract.reportedCostUsd === null && computed.estimated,
        meta,
      });
    };

    const responseHeaders = new Headers();
    for (const [name, value] of upstream.headers) {
      if (!STRIPPED_RESPONSE_HEADERS.has(name.toLowerCase())) responseHeaders.set(name, value);
    }

    const isStream = (upstream.headers.get("content-type") ?? "").includes("text/event-stream");
    if (!isStream || !upstream.body) {
      const text = await upstream.text();
      try {
        accumulator.addObject(JSON.parse(text));
      } catch {
        // 非 JSON 回應：沒有 usage 可讀，會走 metering gap
      }
      await settle();
      return new Response(text, { status: upstream.status, headers: responseHeaders });
    }

    // 串流：一路原樣轉給 harness，同時分一份給錶。
    const [toClient, toMeter] = upstream.body.tee();
    void meterStream(toMeter, accumulator)
      .then(settle)
      .catch((err) => console.error("[gateway] 計量失敗", err));
    return new Response(toClient, { status: upstream.status, headers: responseHeaders });
  });

  return app;
}

async function meterStream(stream: ReadableStream<Uint8Array>, acc: UsageAccumulator) {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    acc.addSseChunk(decoder.decode(value, { stream: true }));
  }
  acc.addSseChunk(decoder.decode());
}

function extractRunToken(headers: Headers): string | null {
  const apiKey = headers.get("x-api-key");
  if (apiKey) return apiKey;
  const auth = headers.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return null;
}

function buildUpstreamUrl(baseUrl: string, rest: string, search: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const path = rest.replace(/^\/+/, "");
  return `${base}/${path}${search}`;
}

/** 粗估這一次呼叫最多花多少：body 長度換算 input，max_tokens 當 output 上限。 */
function estimateReserve(
  provider: Parameters<typeof computeCost>[0],
  model: string,
  bodyText: string | undefined,
  bodyJson: Record<string, unknown> | null,
  available: number,
): number {
  const inputTokens = Math.ceil((bodyText?.length ?? 0) / 4);
  const declared = bodyJson?.max_tokens ?? bodyJson?.max_output_tokens;
  const outputTokens = typeof declared === "number" && declared > 0 ? declared : 1024;
  const { costUsd } = computeCost(provider, model, { inputTokens, outputTokens });
  if (!Number.isFinite(available)) return costUsd;
  return Math.min(costUsd, Math.max(available, 0));
}

/**
 * Control-plane operations still allowed for a terminal run. The allowlist is exactly three:
 * read its own session, delete its own session, and send an events batch to its own session that
 * contains only user.interrupt. Arbitrary GET/DELETE must not pass: run tokens never expire, so a
 * leaked token from a finished run could otherwise delete org-shared environments/agents or list
 * the org's sessions.
 */
function isCleanupRequest(method: string, rest: string, body: string | undefined): boolean {
  if ((method === "GET" || method === "DELETE") && /^v1\/sessions\/[^/]+$/.test(rest)) return true;
  if (method !== "POST" || !/^v1\/sessions\/[^/]+\/events$/.test(rest) || !body) return false;
  try {
    const parsed = JSON.parse(body) as { events?: { type?: string }[] };
    return (
      Array.isArray(parsed.events) &&
      parsed.events.length > 0 &&
      parsed.events.every((ev) => ev?.type === "user.interrupt")
    );
  } catch {
    return false;
  }
}
