// CloudAgent 單元測試：用「路由表」假 fetch 模擬控制面，驗證
// (1) create run 的 body 是 settings 與 call options 的正確合併
// (2) generate() 全流程：建立 → 吃事件流 → 等終態 → 還原文字
import { describe, expect, it } from "vitest";
import { CloudAgent, extractText } from "./agent.ts";
import { Transport } from "./http.ts";

type Handler = (init: RequestInit) => Response;

function routedFetch(routes: Record<string, Handler>) {
  const bodies: Record<string, unknown> = {};
  const fn = (async (input: URL | string, init?: RequestInit) => {
    const url = input instanceof URL ? input : new URL(String(input));
    const key = `${(init?.method ?? "GET").toUpperCase()} ${url.pathname}`;
    const handler = routes[key];
    if (!handler) return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    if (init?.body) bodies[key] = JSON.parse(String(init.body));
    return handler(init ?? {});
  }) as unknown as typeof fetch;
  return { fn, bodies };
}

const RUN = {
  id: "r1",
  status: "queued",
  external_user_id: null,
  model: { provider: "anthropic", id: "claude-sonnet-5" },
  sandbox: { provider: "local" },
  sandbox_ref: null,
  budget_usd: 1,
  spent_usd: 0,
  error: null,
  created_at: "2026-09-02T00:00:00Z",
  started_at: null,
  completed_at: null,
};

function sse(frames: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (const f of frames) c.enqueue(new TextEncoder().encode(f));
      c.close();
    },
  });
  return new Response(stream, { status: 200 });
}

const frame = (seq: number, type: string, payload: unknown) =>
  `id: ${seq}\nevent: ${type}\ndata: ${JSON.stringify({ seq, type, payload, created_at: "" })}\n\n`;

describe("CloudAgent", () => {
  it("generate()：建立 → 串事件 → 等終態，per-call 覆寫贏過 agent 預設", async () => {
    const { fn, bodies } = routedFetch({
      "POST /v1/runs": () => new Response(JSON.stringify(RUN), { status: 201 }),
      "GET /v1/runs/r1/events": () =>
        sse([
          frame(0, "run.created", {}),
          frame(1, "message.delta", { text: "哈囉" }),
          frame(2, "message.delta", { text: "世界" }),
        ]),
      "GET /v1/runs/r1": () =>
        new Response(JSON.stringify({ ...RUN, status: "completed", spent_usd: 0.6 }), {
          status: 200,
        }),
    });

    const agent = new CloudAgent(new Transport({ baseUrl: "http://api.test", fetch: fn }), {
      id: "unit-test",
      model: { provider: "anthropic", id: "claude-sonnet-5" },
      instructions: "測試",
      budgetUsd: 1,
    });

    const result = await agent.generate({ prompt: "hi", budgetUsd: 0.5 });

    const body = bodies["POST /v1/runs"] as Record<string, unknown>;
    expect(body.input).toBe("hi");
    expect(body.budget_usd).toBe(0.5); // per-call 覆寫贏
    expect((body.metadata as Record<string, unknown>).agent_id).toBe("unit-test");

    expect(result.run.status).toBe("completed");
    expect(result.spentUsd).toBe(0.6);
    expect(result.text).toBe("哈囉\n世界");
    expect(result.events.length).toBe(3);
  });
});

describe("extractText", () => {
  const ev = (type: string, payload: unknown) => ({ seq: 0, type, payload, created_at: "" });

  it("rebuilds text from message.delta events", () => {
    expect(extractText([ev("message.delta", { text: "增量" })])).toBe("增量");
  });

  it("非文字 payload 安靜跳過，不炸", () => {
    expect(extractText([ev("tool.call", { name: "bash" }), ev("run.completed", null)])).toBe("");
  });
});
