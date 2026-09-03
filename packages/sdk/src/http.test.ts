// Transport 單元測試：不起 server、不用 mock 套件——
// Transport 本來就接受注入的 fetch，這個 seam 就是為了可測性留的。
import { describe, expect, it } from "vitest";
import { NimplexError, Transport } from "./http.ts";

type Call = { url: URL; init: RequestInit };

/** 假 fetch：記下每個請求，交給 handler 決定回什麼。 */
function fakeFetch(handler: (call: Call, index: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = (async (input: URL | string, init?: RequestInit) => {
    const url = input instanceof URL ? input : new URL(String(input));
    const call = { url, init: init ?? {} };
    calls.push(call);
    return handler(call, calls.length - 1);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * 把 SSE frame 字串串成 streaming body；abortMidway=true 時吐完才斷線（模擬網路中斷）。
 * 用 pull-based：error() 會丟棄佇列中未讀的 chunk，start() 裡一次 enqueue 完再 error
 * 的話 frame 根本到不了讀取端。
 */
function sseResponse(frames: string[], { abortMidway = false } = {}): Response {
  const encoder = new TextEncoder();
  let next = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const frame = frames[next];
      next += 1;
      if (frame !== undefined) controller.enqueue(encoder.encode(frame));
      else if (abortMidway) controller.error(new TypeError("network dropped"));
      else controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

const frame = (seq: number, type: string, payload: unknown) =>
  `id: ${seq}\nevent: ${type}\ndata: ${JSON.stringify({ seq, type, payload })}\n\n`;

describe("Transport.request", () => {
  it("帶上 Bearer key、組出正確 URL 與 query，undefined 的 query 會被丟掉", async () => {
    const { fn, calls } = fakeFetch(() => json({ runs: [] }));
    const t = new Transport({ baseUrl: "http://api.test", apiKey: "nmx_live_abc", fetch: fn });
    await t.request("GET", "/v1/runs", { query: { limit: "5", external_user_id: undefined } });

    const call = calls[0];
    if (!call) throw new Error("沒發出請求");
    expect(call.url.href).toBe("http://api.test/v1/runs?limit=5");
    const headers = call.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer nmx_live_abc");
  });

  it("有 body 時送 JSON 並帶 content-type", async () => {
    const { fn, calls } = fakeFetch(() => json({ ok: true }, 201));
    const t = new Transport({ baseUrl: "http://api.test", fetch: fn });
    await t.request("POST", "/v1/api-keys", { body: { name: "ci" } });

    const call = calls[0];
    if (!call) throw new Error("沒發出請求");
    expect(call.init.method).toBe("POST");
    expect(JSON.parse(String(call.init.body))).toEqual({ name: "ci" });
    expect((call.init.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });

  it("204 回 undefined", async () => {
    const { fn } = fakeFetch(() => new Response(null, { status: 204 }));
    const t = new Transport({ baseUrl: "http://api.test", fetch: fn });
    await expect(t.request("DELETE", "/v1/api-keys/x")).resolves.toBeUndefined();
  });

  it('平坦錯誤 {"error":"not_found"} → NimplexError(code, status)', async () => {
    const { fn } = fakeFetch(() => json({ error: "not_found" }, 404));
    const t = new Transport({ baseUrl: "http://api.test", fetch: fn });
    const err = await t.request("GET", "/v1/runs/nope").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NimplexError);
    expect((err as NimplexError).status).toBe(404);
    expect((err as NimplexError).code).toBe("not_found");
  });

  it("非 JSON 錯誤 body → http_error", async () => {
    const { fn } = fakeFetch(() => new Response("boom", { status: 502 }));
    const t = new Transport({ baseUrl: "http://api.test", fetch: fn });
    const err = await t.request("GET", "/v1/runs").catch((e: unknown) => e);
    expect((err as NimplexError).code).toBe("http_error");
    expect((err as NimplexError).status).toBe(502);
  });
});

describe("Transport.sse", () => {
  it("解析 frame、追蹤 id，伺服器乾淨關閉＝結束", async () => {
    const { fn, calls } = fakeFetch(() =>
      sseResponse([frame(0, "run.created", {}), frame(1, "message.delta", { text: "hi" })]),
    );
    const t = new Transport({ baseUrl: "http://api.test", fetch: fn });

    const events = [];
    for await (const ev of t.sse("/v1/runs/r1/events")) events.push(ev);

    expect(events.map((e) => e.event)).toEqual(["run.created", "message.delta"]);
    expect(events[1]?.id).toBe("1");
    expect(calls.length).toBe(1);
  });

  it("中途斷線會帶 Last-Event-ID 自動重連續傳（exclusive 語意）", async () => {
    const { fn, calls } = fakeFetch((_call, index) => {
      // 第一條連線：吐 seq 0..1 之後斷線；第二條：從 2 續傳後乾淨關閉
      if (index === 0) {
        return sseResponse([frame(0, "run.created", {}), frame(1, "message.delta", {})], {
          abortMidway: true,
        });
      }
      return sseResponse([frame(2, "run.completed", {})]);
    });
    const t = new Transport({ baseUrl: "http://api.test", fetch: fn });

    const seqs: (string | null)[] = [];
    for await (const ev of t.sse("/v1/runs/r1/events")) seqs.push(ev.id);

    expect(seqs).toEqual(["0", "1", "2"]);
    expect(calls.length).toBe(2);
    const retryHeaders = calls[1]?.init.headers as Record<string, string>;
    expect(retryHeaders["Last-Event-ID"]).toBe("1"); // 從斷點之後接，不重放
  });

  it("HTTP 層錯誤（401 等）不重試，直接拋 NimplexError", async () => {
    const { fn, calls } = fakeFetch(() => json({ error: "invalid_api_key" }, 401));
    const t = new Transport({ baseUrl: "http://api.test", fetch: fn });

    const err = await (async () => {
      for await (const _ of t.sse("/v1/runs/r1/events")) {
        // 不應該有事件
      }
    })().catch((e: unknown) => e);

    expect((err as NimplexError).code).toBe("invalid_api_key");
    expect(calls.length).toBe(1); // 沒有重試
  });

  it("options.after 會變成第一條連線的 Last-Event-ID", async () => {
    const { fn, calls } = fakeFetch(() => sseResponse([frame(8, "run.completed", {})]));
    const t = new Transport({ baseUrl: "http://api.test", fetch: fn });
    for await (const _ of t.sse("/v1/runs/r1/events", { after: 7 })) {
      // 消化完
    }
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers["Last-Event-ID"]).toBe("7");
  });
});
