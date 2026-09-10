// Fake Anthropic upstream so the money path (per-call metering, budget kill) runs end to end
// without a real key. Point a BYOK provider key's base_url at it; everything else stays real.
//
// Shape follows the official Messages API:
//   non-streaming: usage.{input_tokens,output_tokens,cache_*}
//   streaming: message_start(message.usage) -> content_block_* -> message_delta(usage) -> message_stop

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

export interface FakeAnthropicOptions {
  /** Explicit tool sequence; inputs are passed through unchanged for adapter conformance. */
  script?: {
    name: string;
    input: Record<string, unknown> | ((messages: unknown) => Record<string, unknown>);
  }[];
  /** Scripted tools returned in one assistant message. Default 1. */
  batchSize?: number;
  /** Override stop reasons by request index to exercise truncation recovery. */
  stopReasons?: ("max_tokens" | "end_turn" | "tool_use")[];
  /** Token counts reported per response (the ledger prices them with the rate table) */
  inputTokens?: number;
  outputTokens?: number;
  /**
   * Reply with a `bash` tool_use until the conversation carries this many tool_result blocks,
   * then end_turn. Stateless per request, so concurrent runs do not interfere. Default 0.
   */
  toolCalls?: number;
  /** Latency added to every response, so a test can kill a worker mid-call. Default 0. */
  delayMs?: number;
}

export interface FakeAnthropicState {
  messagesCalls: {
    model: string;
    stream: boolean;
    maxTokens: number;
    body: Record<string, unknown>;
  }[];
}

let counter = 0;
const nextId = (prefix: string) => `${prefix}_fake_${++counter}`;

export function createFakeAnthropic(options: FakeAnthropicOptions = {}) {
  const inputTokens = options.inputTokens ?? 1_000;
  const outputTokens = options.outputTokens ?? 500;
  const toolCalls = options.toolCalls ?? 0;
  const delayMs = options.delayMs ?? 0;

  const state: FakeAnthropicState = { messagesCalls: [] };
  const app = new Hono();

  // Every endpoint requires x-api-key, exactly like the real thing.
  app.use("*", async (c, next) => {
    if (!c.req.header("x-api-key")) {
      return c.json(
        {
          type: "error",
          error: { type: "authentication_error", message: "invalid x-api-key" },
          request_id: nextId("req"),
        },
        401,
      );
    }
    await next();
  });

  app.post("/v1/messages", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const model = typeof body.model === "string" ? body.model : "claude-fake";
    const stream = body.stream === true;
    const maxTokens = typeof body.max_tokens === "number" ? body.max_tokens : outputTokens;
    state.messagesCalls.push({ model, stream, maxTokens, body });
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    const step = countToolResults(body.messages);
    // Each scripted step writes a file so Tier 0 (the durable workspace) has something to show.
    const scripted = options.script?.slice(step, step + (options.batchSize ?? 1));
    const toolUses = scripted
      ? scripted.map((tool, index) => ({
          id: `${nextId("toolu")}_step_${step + index + 1}`,
          name: tool.name,
          input: typeof tool.input === "function" ? tool.input(body.messages) : tool.input,
        }))
      : step < toolCalls
        ? [
            {
              id: `${nextId("toolu")}_step_${step + 1}`,
              name: "bash",
              input: { command: `echo "fake step ${step + 1}" > /workspace/step-${step + 1}.txt` },
            },
          ]
        : [];
    const stopReason =
      options.stopReasons?.[state.messagesCalls.length - 1] ??
      (toolUses.length ? "tool_use" : "end_turn");
    const text = toolUses.length
      ? `(fake anthropic) step ${step + 1} of ${toolCalls}`
      : "(fake anthropic) hello from the fake upstream";
    const usage = {
      input_tokens: inputTokens,
      output_tokens: Math.min(outputTokens, maxTokens),
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
        content: [
          { type: "text", text },
          ...toolUses.map((tool) => ({ type: "tool_use", ...tool })),
        ],
        stop_reason: stopReason,
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
      for (const [position, toolUse] of toolUses.entries()) {
        const index = position + 1;
        await emit("content_block_start", {
          index,
          content_block: { type: "tool_use", id: toolUse.id, name: toolUse.name, input: {} },
        });
        await emit("content_block_delta", {
          index,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(toolUse.input) },
        });
        await emit("content_block_stop", { index });
      }
      await emit("message_delta", {
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: Math.min(outputTokens, maxTokens) },
      });
      await emit("message_stop", {});
    });
  });

  return { app, state };
}

/** tool_result blocks across the whole conversation = how many tool turns already happened. */
function countToolResults(messages: unknown): number {
  if (!Array.isArray(messages)) return 0;
  let n = 0;
  let highestStep = 0;
  for (const m of messages as { content?: unknown }[]) {
    if (!Array.isArray(m.content)) continue;
    for (const block of m.content as { type?: string; tool_use_id?: string }[]) {
      if (block.type !== "tool_result") continue;
      n++;
      const match = block.tool_use_id?.match(/_step_(\d+)$/);
      if (match) highestStep = Math.max(highestStep, Number(match[1]));
    }
  }
  return highestStep || n;
}

/** Start the fake upstream in-process (e2e use). */
export async function startFakeAnthropic(port = 8790, options: FakeAnthropicOptions = {}) {
  const { app, state } = createFakeAnthropic(options);
  const server = serve({ fetch: app.fetch, port });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  return {
    url: `http://localhost:${(server.address() as { port: number }).port}`,
    state,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
