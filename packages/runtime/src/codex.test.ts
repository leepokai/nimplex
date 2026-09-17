import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { startTurnRequest } from "@nimplex/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { CODEX_BASE_URL, DEFAULT_CODEX_MODEL } from "./models.ts";
import { NimplexRuntime } from "./runtime.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllGlobals();
});
const token = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } })).toString("base64url")}.signature`;
function setup(baseUrl = CODEX_BASE_URL, engine: "pi-executor" | "pi-harness" = "pi-executor") {
  const directory = mkdtempSync(join(tmpdir(), "nimplex-codex-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const credential = vi.fn(async (_provider: string, _signal?: AbortSignal) => ({
    apiKey: token,
    baseUrl,
    billingMode: "subscription" as const,
  }));
  const runtime = new NimplexRuntime({ directory, credential, engine });
  cleanup.push(() => runtime.close());
  return { runtime, directory, credential };
}
async function finish(runtime: NimplexRuntime, id: string) {
  const events = [];
  for await (const event of runtime.events(id)) events.push(event);
  return { result: runtime.getTurn(id), events };
}
const request = (prompt = "Write a file", extra = {}) =>
  startTurnRequest.parse({
    prompt,
    model: DEFAULT_CODEX_MODEL,
    sandbox: "docker",
    budget: 0.000001,
    ...extra,
  });
function response(item: Record<string, unknown>) {
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
    {
      headers: { "Content-Type": "text/event-stream" },
    },
  );
}
const message = {
  type: "message",
  id: "msg_test",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text: "Done", annotations: [] }],
};

it("runs the real Codex adapter with nimplex tools, records quota usage, and resumes durable history", async () => {
  const calls: { url: string; body: Record<string, unknown>; headers: Headers }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({
        url: String(url),
        body: JSON.parse(
          new Headers(init.headers).get("content-encoding") === "zstd"
            ? zstdDecompressSync(init.body as Uint8Array).toString()
            : String(init.body),
        ),
        headers: new Headers(init.headers),
      });
      return calls.length === 1
        ? response({
            type: "function_call",
            id: "fc_test",
            call_id: "call_test",
            name: "write",
            arguments: JSON.stringify({
              path: "/workspace/subscription.txt",
              content: "persisted",
            }),
            status: "completed",
          })
        : response(message);
    }),
  );
  const f = setup();
  const session = f.runtime.createSession(f.directory);
  const run = await f.runtime.startTurn(session.id, request());
  const { result, events } = await finish(f.runtime, run.runId);
  expect(result.status, result.error ?? undefined).toBe("completed");
  expect(result).toMatchObject({
    billing_mode: "subscription",
    spent_usd: 0,
    reserved_usd: 0,
    budget_usd: null,
  });
  expect(calls).toHaveLength(2);
  expect(calls[0]?.url).toBe(`${CODEX_BASE_URL}/codex/responses`);
  expect(calls[0]?.headers.get("Authorization")).toBe(`Bearer ${token}`);
  expect(calls[0]?.headers.get("chatgpt-account-id")).toBe("test-account");
  expect(calls[0]?.body).not.toHaveProperty("max_tokens");
  expect(calls[0]?.body).toMatchObject({ store: false });
  expect(JSON.stringify(calls[1]?.body)).toContain("function_call_output");
  expect(f.runtime.readFile(run.runId, "/workspace/subscription.txt")).toEqual(
    new TextEncoder().encode("persisted"),
  );
  const model = events.find((e) => e.type === "model.call");
  expect(model?.payload).toMatchObject({
    billing_mode: "subscription",
    cost_usd: 0,
    usage: { input_tokens: 90, output_tokens: 20, cache_read_tokens: 10 },
  });
  expect(JSON.stringify(events)).not.toContain(token);
  expect(f.credential.mock.calls[0]?.[0]).toBe("openai-codex");
  await f.runtime.close();
  const reopened = new NimplexRuntime({ directory: f.directory, credential: f.credential });
  cleanup.push(() => reopened.close());
  const next = await reopened.startTurn(session.id, request("Read what you wrote"));
  expect((await finish(reopened, next.runId)).result.status).toBe("completed");
  expect(JSON.stringify(calls.at(-1)?.body)).toContain("subscription.txt");
  const branch = reopened.forkSession(session.id);
  expect(branch.turns).toHaveLength(2);
});

it("rejects an alternate subscription endpoint before sending credentials", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const f = setup("https://untrusted.invalid");
  const session = f.runtime.createSession(f.directory);
  const run = await f.runtime.startTurn(session.id, request());
  expect((await finish(f.runtime, run.runId)).result.error).toContain(
    "bound to the ChatGPT endpoint",
  );
  expect(fetch).not.toHaveBeenCalled();
});

it("reports subscription limits without retrying or falling back to API billing", async () => {
  const fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({ error: { code: "usage_limit_reached", message: "Limit reached" } }),
        { status: 429 },
      ),
  );
  vi.stubGlobal("fetch", fetch);
  const f = setup();
  const run = await f.runtime.startTurn(f.runtime.createSession(f.directory).id, request());
  const { result, events } = await finish(f.runtime, run.runId);
  expect(result.status).toBe("failed");
  expect(result.error).toContain("usage limit");
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(events.some((e) => e.type === "model.unknown")).toBe(true);
  expect(result.spent_usd).toBe(0);
});

it("keeps read-only tools and stops a blocked subscription request on cancellation", async () => {
  let dispatched!: () => void;
  const ready = new Promise<void>((resolve) => {
    dispatched = resolve;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(
        new Headers(init.headers).get("content-encoding") === "zstd"
          ? zstdDecompressSync(init.body as Uint8Array).toString()
          : String(init.body),
      );
      dispatched();
      expect(body.tools.map((t: { name: string }) => t.name).sort()).toEqual([
        "read",
        "read_log",
        "read_output",
      ]);
      dispatched();
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(new DOMException("Aborted", "AbortError"));
        if (init.signal?.aborted) abort();
        else init.signal?.addEventListener("abort", abort, { once: true });
      });
    }),
  );
  const f = setup();
  const run = await f.runtime.startTurn(
    f.runtime.createSession(f.directory).id,
    request("Read", { executionMode: "read_only" }),
  );
  await ready;
  await f.runtime.stopTurn(run.runId);
  expect(f.runtime.getTurn(run.runId).status).toBe("canceled");
  expect(f.runtime.files(run.runId)).toEqual([]);
});

it("runs the Codex adapter on the Pi harness engine with zero-dollar reservations", async () => {
  const calls: { url: string; body: Record<string, unknown>; headers: Headers }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({
        url: String(url),
        body: JSON.parse(
          new Headers(init.headers).get("content-encoding") === "zstd"
            ? zstdDecompressSync(init.body as Uint8Array).toString()
            : String(init.body),
        ),
        headers: new Headers(init.headers),
      });
      return calls.length === 1
        ? response({
            type: "function_call",
            id: "fc_test",
            call_id: "call_test",
            name: "write",
            arguments: JSON.stringify({
              path: "/workspace/subscription.txt",
              content: "persisted",
            }),
            status: "completed",
          })
        : response(message);
    }),
  );
  const f = setup(CODEX_BASE_URL, "pi-harness");
  const session = f.runtime.createSession(f.directory);
  expect(session.engine).toBe("pi-harness");
  const run = await f.runtime.startTurn(session.id, request());
  const { result, events } = await finish(f.runtime, run.runId);
  expect(result.status, result.error ?? undefined).toBe("completed");
  expect(result).toMatchObject({
    billing_mode: "subscription",
    spent_usd: 0,
    reserved_usd: 0,
    budget_usd: null,
  });
  expect(calls).toHaveLength(2);
  expect(calls[0]?.url).toBe(`${CODEX_BASE_URL}/codex/responses`);
  expect(calls[0]?.headers.get("Authorization")).toBe(`Bearer ${token}`);
  expect(calls[0]?.body).not.toHaveProperty("max_tokens");
  expect(calls[0]?.body).toMatchObject({ store: false });
  expect(f.runtime.readFile(run.runId, "/workspace/subscription.txt")).toEqual(
    new TextEncoder().encode("persisted"),
  );
  const reserved = events.filter((e) => e.type === "model.reserved");
  expect(reserved).toHaveLength(2);
  for (const event of reserved)
    expect((event.payload as { reserved_usd: number }).reserved_usd).toBe(0);
  const models = events.filter((e) => e.type === "model.call");
  expect(models).toHaveLength(2);
  expect(models[0]?.payload).toMatchObject({
    billing_mode: "subscription",
    cost_usd: 0,
    usage: { input_tokens: 90, output_tokens: 20, cache_read_tokens: 10 },
  });
  expect(JSON.stringify(events)).not.toContain(token);
  expect(events.filter((e) => e.type === "spend.updated")).toHaveLength(2);
});
