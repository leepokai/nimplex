// 假的 Anthropic 上游：讓整條錢的路徑（閘道 reserve/settle、預算殺、Managed Agents executor）
// 不用真 key、不花錢就能 e2e。掛法：BYOK 的 base_url 指過來，閘道其餘行為一律照真的走。
//
// 形狀對齊官方文件：
//   Messages API  ── 非串流回應 usage.{input_tokens,output_tokens,cache_*}；
//                    串流事件 message_start(message.usage) → content_block_* → message_delta(usage) → message_stop
//   Managed Agents ── /v1/environments、/v1/agents、/v1/sessions、/events、/events/stream（SSE 每筆帶 event: + data:）
//                    session.status_idle 帶 stop_reason.type ∈ {end_turn, budget_reached, …}
//                    session.usage 帶 list_cost {amount(分的整數字串), currency}
// 情境由 session budget 決定：一個 turn 固定花 sessionTurnCents；預算不夠 → budget_reached（含一個 request 的 overshoot）。

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

export interface FakeAnthropicOptions {
  /** Messages API 每次回應的 token 數（閘道據此用價目表算錢） */
  inputTokens?: number;
  outputTokens?: number;
  /** Managed Agents 一個 turn 的 list cost（分） */
  sessionTurnCents?: number;
  /** 串流事件間隔（ms） */
  eventDelayMs?: number;
}

interface FakeSession {
  id: string;
  status: "idle" | "running";
  budgetCents: number | null;
  started: boolean;
  interrupted: boolean;
  deleted: boolean;
  listCostCents: number;
}

export interface FakeAnthropicState {
  messagesCalls: { model: string; stream: boolean }[];
  sessions: Map<string, FakeSession>;
}

let counter = 0;
const nextId = (prefix: string) => `${prefix}_fake_${++counter}`;

export function createFakeAnthropic(options: FakeAnthropicOptions = {}) {
  const inputTokens = options.inputTokens ?? 1_000;
  const outputTokens = options.outputTokens ?? 500;
  const turnCents = options.sessionTurnCents ?? 42;
  const delayMs = options.eventDelayMs ?? 30;

  const state: FakeAnthropicState = { messagesCalls: [], sessions: new Map() };
  const app = new Hono();

  const authError = () =>
    Response.json(
      {
        type: "error",
        error: { type: "authentication_error", message: "invalid x-api-key" },
        request_id: nextId("req"),
      },
      { status: 401 },
    );

  // 所有端點都要有 x-api-key（閘道會把 BYOK 換進來）；沒有就 401，跟真的一樣
  app.use("*", async (c, next) => {
    if (!c.req.header("x-api-key")) return authError();
    await next();
  });

  // ---- Messages API ----
  app.post("/v1/messages", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const model = typeof body.model === "string" ? body.model : "claude-fake";
    const stream = body.stream === true;
    state.messagesCalls.push({ model, stream });
    const text = "（fake anthropic）hello from the fake upstream";
    const usage = {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };
    const id = nextId("msg");

    if (!stream) {
      return c.json({
        id,
        type: "message",
        role: "assistant",
        model,
        content: [{ type: "text", text }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage,
      });
    }

    return streamSSE(c, async (s) => {
      const emit = (event: string, data: unknown) =>
        s.writeSSE({ event, data: JSON.stringify({ type: event, ...(data as object) }) });
      await emit("message_start", {
        message: {
          id,
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          usage: { ...usage, output_tokens: 1 },
        },
      });
      await emit("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
      await emit("content_block_delta", { index: 0, delta: { type: "text_delta", text } });
      await emit("content_block_stop", { index: 0 });
      await emit("message_delta", {
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: outputTokens },
      });
      await emit("message_stop", {});
    });
  });

  // ---- Managed Agents：environments / agents ----
  app.post("/v1/environments", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    return c.json({
      id: nextId("env"),
      type: "environment",
      name: body.name ?? "fake",
      config: body.config ?? { type: "cloud" },
      created_at: new Date().toISOString(),
    });
  });

  app.post("/v1/agents", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    return c.json({
      id: nextId("agent"),
      type: "agent",
      version: 1,
      name: body.name ?? "fake",
      model: body.model ?? "claude-fake",
      created_at: new Date().toISOString(),
    });
  });

  // ---- Managed Agents：sessions ----
  app.post("/v1/sessions", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const budget = body.budget as { max_list_cost?: { amount?: string } } | undefined;
    const amount = budget?.max_list_cost?.amount;
    const session: FakeSession = {
      id: nextId("sesn"),
      status: "idle",
      budgetCents: typeof amount === "string" ? Number(amount) : null,
      started: false,
      interrupted: false,
      deleted: false,
      listCostCents: 0,
    };
    state.sessions.set(session.id, session);
    return c.json(sessionJson(session, body));
  });

  app.get("/v1/sessions/:id", (c) => {
    const session = state.sessions.get(c.req.param("id"));
    if (!session || session.deleted) return notFound(c);
    return c.json(sessionJson(session));
  });

  app.delete("/v1/sessions/:id", (c) => {
    const session = state.sessions.get(c.req.param("id"));
    if (!session || session.deleted) return notFound(c);
    if (session.status === "running") {
      return c.json(
        {
          type: "error",
          error: { type: "invalid_request_error", message: "cannot delete while running" },
        },
        400,
      );
    }
    session.deleted = true;
    return c.json({ id: session.id, type: "session_deleted" });
  });

  app.post("/v1/sessions/:id/events", async (c) => {
    const session = state.sessions.get(c.req.param("id"));
    if (!session || session.deleted) return notFound(c);
    const body = (await c.req.json().catch(() => ({}))) as { events?: { type?: string }[] };
    for (const ev of body.events ?? []) {
      if (ev.type === "user.message") session.started = true;
      if (ev.type === "user.interrupt") session.interrupted = true;
    }
    return c.json({
      events: (body.events ?? []).map((ev) => ({ ...ev, id: nextId("sevt"), processed_at: now() })),
    });
  });

  app.get("/v1/sessions/:id/events/stream", (c) => {
    const session = state.sessions.get(c.req.param("id"));
    if (!session || session.deleted) return notFound(c);

    return streamSSE(c, async (s) => {
      const emit = async (type: string, data: Record<string, unknown> = {}) => {
        await s.writeSSE({
          event: type,
          data: JSON.stringify({ type, id: nextId("sevt"), processed_at: now(), ...data }),
        });
        await s.sleep(delayMs);
      };
      const interrupted = () => session.interrupted;

      // 等第一則 user.message（stream-first 模式下串流會先開）
      for (let i = 0; i < 500 && !session.started && !interrupted(); i += 1) await s.sleep(20);
      if (!session.started) {
        await emit("session.status_idle", { stop_reason: { type: "end_turn" } });
        return;
      }

      session.status = "running";
      await emit("session.status_running");
      await emit("span.model_request_start");
      if (interrupted()) return finish(emit, session, "end_turn");
      await emit("agent.message", {
        content: [{ type: "text", text: "（fake managed agent）收到任務，開始處理" }],
      });
      await emit("agent.tool_use", {
        id: "tu_fake_1",
        name: "bash",
        input: { command: "echo hi" },
      });
      if (interrupted()) return finish(emit, session, "end_turn");
      await emit("agent.tool_result", {
        tool_use_id: "tu_fake_1",
        content: [{ type: "text", text: "hi" }],
        is_error: false,
      });
      await emit("span.model_request_end", {
        is_error: false,
        model_usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      });

      const overBudget = session.budgetCents !== null && session.budgetCents < turnCents;
      if (overBudget) {
        // 官方語意：越線那個 request 跑完才停，所以會超出上限一點點
        session.listCostCents = (session.budgetCents ?? 0) + 3;
        await emit("session.usage", usageJson(session));
        return finish(emit, session, "budget_reached");
      }
      await emit("agent.message", { content: [{ type: "text", text: "任務完成。" }] });
      session.listCostCents = turnCents;
      await emit("session.usage", usageJson(session));
      return finish(emit, session, "end_turn");
    });
  });

  return { app, state };
}

async function finish(
  emit: (type: string, data?: Record<string, unknown>) => Promise<void>,
  session: FakeSession,
  reason: string,
) {
  session.status = "idle";
  await emit("session.status_idle", { stop_reason: { type: reason } });
}

function usageJson(session: FakeSession) {
  return {
    list_cost: { amount: String(session.listCostCents), currency: "USD" },
    active_seconds: 3,
    ...(session.budgetCents === null
      ? {}
      : {
          budget: {
            type: "limit",
            max_list_cost: { amount: String(session.budgetCents), currency: "USD" },
          },
        }),
  };
}

function sessionJson(session: FakeSession, create: Record<string, unknown> = {}) {
  return {
    id: session.id,
    type: "session",
    status: session.status,
    agent: create.agent ?? null,
    environment_id: create.environment_id ?? null,
    title: create.title ?? null,
    usage: usageJson(session),
    created_at: now(),
  };
}

function notFound(c: { json: (body: unknown, status: 404) => Response }) {
  return c.json(
    { type: "error", error: { type: "not_found_error", message: "session not found" } },
    404,
  );
}

const now = () => new Date().toISOString();

/** 在程序內起一個假上游（e2e 用）。 */
export async function startFakeAnthropic(port = 8790, options: FakeAnthropicOptions = {}) {
  const { app, state } = createFakeAnthropic(options);
  const server = serve({ fetch: app.fetch, port });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  return {
    url: `http://localhost:${port}`,
    state,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
