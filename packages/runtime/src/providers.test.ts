import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { startTurnRequest } from "@nimplex/contracts";
import { startFakeAnthropic } from "@nimplex/testkit";
import { afterEach, expect, it, vi } from "vitest";
import { NimplexRuntime } from "./runtime.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllGlobals();
});
type Call = { url: string; body: Record<string, unknown>; headers: Headers };
function responsesStream(item: Record<string, unknown>) {
  return new Response(
    [
      { type: "response.output_item.added", output_index: 0, item },
      { type: "response.output_item.done", output_index: 0, item },
      {
        type: "response.completed",
        response: {
          id: "resp_test",
          status: "completed",
          output: [item],
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            input_tokens_details: { cached_tokens: 10 },
          },
        },
      },
    ]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join(""),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}
function stubOpenAI(calls: Call[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      calls.push({
        url: String(url),
        headers,
        body: JSON.parse(
          headers.get("content-encoding") === "zstd"
            ? zstdDecompressSync(init.body as Uint8Array).toString()
            : String(init.body),
        ),
      });
      return calls.length === 1
        ? responsesStream({
            type: "function_call",
            id: "fc_test",
            call_id: "call_test",
            name: "write",
            arguments: JSON.stringify({ path: "/workspace/openai.txt", content: "from openai" }),
            status: "completed",
          })
        : responsesStream({
            type: "message",
            id: "msg_test",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "Done", annotations: [] }],
          });
    }),
  );
}
function runtime(engine: "pi-executor" | "pi-harness", anthropicUrl: string | null) {
  const directory = mkdtempSync(join(tmpdir(), "nimplex-providers-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const client = new NimplexRuntime({
    directory,
    engine,
    credential: (provider) =>
      provider === "openai"
        ? { apiKey: "sk-openai-test", baseUrl: null }
        : { apiKey: "fake-anthropic", baseUrl: anthropicUrl },
  });
  cleanup.push(() => client.close());
  return { client, directory };
}
async function finish(client: NimplexRuntime, id: string) {
  const events = [];
  for await (const event of client.events(id)) events.push(event);
  return { result: client.getTurn(id), events };
}
const request = (extra: Record<string, unknown>) =>
  startTurnRequest.parse({ prompt: "Write a file", sandbox: "docker", ...extra });

it("runs an OpenAI API model on the harness with priced settlement, Pi output defaults and thinking", async () => {
  const calls: Call[] = [];
  stubOpenAI(calls);
  const f = runtime("pi-harness", null);
  expect(f.client.models().some((m) => m.model === "openai/gpt-5.4-mini")).toBe(true);
  const session = f.client.createSession(f.directory);
  const run = await f.client.startTurn(
    session.id,
    request({ model: "openai/gpt-5.4-mini", thinking: "medium" }),
  );
  const { result, events } = await finish(f.client, run.runId);
  expect(result.status, result.error ?? undefined).toBe("completed");
  expect(result.model).toEqual({ provider: "openai", id: "gpt-5.4-mini" });
  expect(result.billing_mode).toBe("api");
  expect(calls).toHaveLength(2);
  expect(calls[0]?.url).toBe("https://api.openai.com/v1/responses");
  expect(calls[0]?.headers.get("authorization")).toBe("Bearer sk-openai-test");
  expect(calls[0]?.body).not.toHaveProperty("max_tokens");
  expect(calls[0]?.body.reasoning).toMatchObject({ effort: "medium" });
  const reserved = events.filter((e) => e.type === "model.started");
  expect(reserved).toHaveLength(2);
  expect(calls[0]?.body.max_output_tokens).toBeGreaterThan(4096);
  // gpt-5.4-mini: 90 uncached input at $0.75, 10 cached at 10%, 20 output at $4.50 per MTok.
  const settled = events.filter((e) => e.type === "model.call");
  expect(settled).toHaveLength(2);
  expect(settled[0]?.payload).toMatchObject({
    billing_mode: "api",
    usage: { input_tokens: 90, output_tokens: 20, cache_read_tokens: 10 },
  });
  expect((settled[0]?.payload as { cost_usd: number } | undefined)?.cost_usd).toBeCloseTo(
    0.00015825,
    9,
  );
  // The ledger settles each call rounded up to a micro-USD: 159 + 159.
  expect(result.spent_usd).toBeCloseTo(0.000318, 9);
  expect(result).not.toHaveProperty("reserved_usd");
  expect(f.client.readFile(run.runId, "/workspace/openai.txt")).toEqual(
    new TextEncoder().encode("from openai"),
  );
  expect(JSON.stringify(events)).not.toContain("sk-openai-test");
});

it("passes the thinking level into Anthropic requests on the harness and settles them", async () => {
  const upstream = await startFakeAnthropic(0, { toolCalls: 1 });
  cleanup.push(upstream.close);
  const f = runtime("pi-harness", upstream.url);
  const session = f.client.createSession(f.directory);
  const run = await f.client.startTurn(session.id, request({ thinking: "low" }));
  const { result } = await finish(f.client, run.runId);
  expect(result.status, result.error ?? undefined).toBe("completed");
  expect(upstream.state.messagesCalls.length).toBeGreaterThan(0);
  for (const call of upstream.state.messagesCalls) {
    expect(call.body.thinking).toMatchObject({ type: "enabled", budget_tokens: 2048 });
    expect(call.maxTokens).toBeGreaterThan(2048);
  }
  expect(result.spent_usd).toBeGreaterThan(0);
  expect(result).not.toHaveProperty("reserved_usd");
  // Without a level, the lane returns to no thinking (Pi sends an explicit disabled block).
  const plain = await f.client.startTurn(session.id, request({ prompt: "Again" }));
  expect((await finish(f.client, plain.runId)).result.status).toBe("completed");
  const disabled = upstream.state.messagesCalls.at(-1)?.body.thinking as
    | { type: string }
    | undefined;
  expect(disabled === undefined || disabled.type === "disabled").toBe(true);
  // A later turn may switch models within the same Pi session.
  const switched = await f.client.startTurn(
    session.id,
    request({ prompt: "Switch", model: "claude-sonnet-4-6", thinking: "minimal" }),
  );
  const outcome = await finish(f.client, switched.runId);
  expect(outcome.result.status, outcome.result.error ?? undefined).toBe("completed");
  expect(outcome.result.model).toEqual({ provider: "anthropic", id: "claude-sonnet-4-6" });
  expect(upstream.state.messagesCalls.at(-1)?.model).toBe("claude-sonnet-4-6");
  // Pi drives newer Claude models with adaptive thinking; the level still reaches the request.
  expect(upstream.state.messagesCalls.at(-1)?.body.thinking).toMatchObject({ type: "adaptive" });
  expect(JSON.stringify(upstream.state.messagesCalls.at(-1)?.body.messages)).toContain("Again");
});

it("refuses OpenAI models and thinking levels on the legacy executor before any request", async () => {
  const calls: Call[] = [];
  stubOpenAI(calls);
  const upstream = await startFakeAnthropic(0, {});
  cleanup.push(upstream.close);
  const f = runtime("pi-executor", upstream.url);
  const session = f.client.createSession(f.directory);
  await expect(
    f.client.startTurn(session.id, request({ model: "openai/gpt-5.4-mini" })),
  ).rejects.toThrow("supports only Anthropic and Codex models");
  await expect(f.client.startTurn(session.id, request({ thinking: "low" }))).rejects.toThrow(
    "legacy executor, which has no thinking levels",
  );
  await expect(
    f.client.startTurn(session.id, request({ model: "openai/gpt-4o-2024-05-13" })),
  ).rejects.toThrow("supports only Anthropic and Codex models");
  expect(f.client.getSession(session.id).turns).toHaveLength(0);
  expect(calls).toHaveLength(0);
  expect(upstream.state.messagesCalls).toHaveLength(0);
  vi.unstubAllGlobals();
  // An explicit thinking "off" is accepted everywhere.
  const run = await f.client.startTurn(session.id, request({ thinking: "off" }));
  expect((await finish(f.client, run.runId)).result.status).toBe("completed");
});

it("dispatches a Pi OpenAI-compatible provider outside the old allowlist with durable model commits", async () => {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init.body)),
        headers: new Headers(init.headers),
      });
      const chunk = {
        id: "chatcmpl-test",
        object: "chat.completion.chunk",
        created: 0,
        model: "llama-3.3-70b-versatile",
        choices: [
          { index: 0, delta: { role: "assistant", content: "Done" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
        headers: { "Content-Type": "text/event-stream" },
      });
    }),
  );
  const f = runtime("pi-harness", "https://groq.test/openai/v1");
  const session = f.client.createSession(f.directory);
  const run = await f.client.startTurn(
    session.id,
    request({ model: "groq/llama-3.3-70b-versatile" }),
  );
  const { result, events } = await finish(f.client, run.runId);
  expect(result.status, result.error ?? undefined).toBe("completed");
  expect(result.model.provider).toBe("groq");
  expect(calls).toHaveLength(1);
  expect(calls[0]?.url).toBe("https://groq.test/openai/v1/chat/completions");
  expect(events.filter((event) => event.type === "model.started")).toHaveLength(1);
  expect(events.filter((event) => event.type === "model.call")).toHaveLength(1);
  expect(events.filter((event) => event.type === "spend.updated")).toHaveLength(1);
  expect(result.spent_usd).toBeGreaterThan(0);
  expect(JSON.stringify(events)).not.toContain("fake-anthropic");
});

it("runs Google native requests and tools through the same durable boundary", async () => {
  const { piModels } = await import("./models.ts");
  const model = piModels().find(
    (candidate) => candidate.provider === "google" && candidate.api === "google-generative-ai",
  );
  if (!model) throw new Error("Missing Google model in Pi catalog");
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      calls.push({
        url: request.url,
        body: JSON.parse(await request.text()),
        headers: request.headers,
      });
      const parts =
        calls.length === 1
          ? [
              {
                functionCall: {
                  name: "write",
                  args: { path: "/workspace/google.txt", content: "from google" },
                },
              },
            ]
          : [{ text: "Done" }];
      return new Response(
        `data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts }, finishReason: "STOP", index: 0 }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 } })}\n\n`,
        { headers: { "Content-Type": "text/event-stream" } },
      );
    }),
  );
  const f = runtime("pi-harness", null);
  const session = f.client.createSession(f.directory);
  const run = await f.client.startTurn(session.id, request({ model: `google/${model.id}` }));
  const { result, events } = await finish(f.client, run.runId);
  expect(result.status, result.error ?? undefined).toBe("completed");
  expect(calls).toHaveLength(2);
  expect(calls[0]?.url).toContain(":streamGenerateContent");
  expect(events.filter((event) => event.type === "model.started")).toHaveLength(2);
  expect(events.filter((event) => event.type === "tool.result")).toHaveLength(1);
  expect(f.client.readFile(run.runId, "/workspace/google.txt")).toEqual(
    new TextEncoder().encode("from google"),
  );
  expect(JSON.stringify(events)).not.toContain("fake-anthropic");
});
