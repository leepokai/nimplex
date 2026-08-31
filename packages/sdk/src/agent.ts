// Agent 介面刻意對齊 Vercel AI SDK v7 的 `Agent`（ai 套件的 dist/index.d.ts）：
//
//   readonly version: 'agent-v1'   ← 介面自帶版本號，之後才改得動又不破相容
//   readonly id
//   generate(options)  非串流
//   stream(options)    串流
//
// 它那句「You can implement your own Agent by implementing the `Agent` interface,
// or use the `ToolLoopAgent` class」正是我們要的形狀：**極小的介面 + 一個現成實作**。
// 差別只在跑的地方：AI SDK 的 agent 在你的程序裡跑一個 tool loop，
// nimplex 的 agent 是在雲端沙箱裡跑一整個 harness（Claude Code、Codex、你自己上傳的），
// 所以多了 budgetUsd（美元硬上限，跑到一半也砍得掉）。

import type {
  MeteringMode,
  ModelSpec,
  RunEvent,
  RunResponse,
  SandboxSpec,
} from "@nimplex/contracts";
import type { Transport } from "./http.ts";

export const NIMPLEX_AGENT_VERSION = "nimplex-agent-v1";

export interface AgentSettings {
  /** 給人看的識別字串，會寫進 run metadata */
  id?: string;
  /** harness slug：內建的（claude-code / codex / opencode）或自己上傳的 */
  harness: string;
  model: ModelSpec;
  sandbox?: SandboxSpec;
  instructions: string;
  /** metering="exact" 時的美元硬上限 */
  budgetUsd?: number;
  metering?: MeteringMode;
  maxDurationSeconds?: number;
}

export interface AgentCallOptions {
  /** 可選的歸因標籤：只進帳目與稽核，方便你自己 rollup；你的使用者由你自己管 */
  externalUserId?: string;
  prompt?: string;
  /** 逐次覆寫 agent 的預設值 */
  model?: ModelSpec;
  sandbox?: SandboxSpec;
  budgetUsd?: number;
  metadata?: Record<string, unknown>;
  clientNonce?: string;
  signal?: AbortSignal;
}

export interface GenerateResult {
  run: RunResponse;
  events: RunEvent[];
  /** harness 的文字輸出串起來 */
  text: string;
  spentUsd: number;
}

export interface StreamResult {
  runId: string;
  /** 建立當下的狀態（通常是 queued） */
  run: RunResponse;
  /** 只在建立時拿得到一次：自己跑 harness 的整合方用這張票打閘道 */
  runToken: string | null;
  events: AsyncGenerator<RunEvent>;
  /** 等到終態 */
  wait(): Promise<RunResponse>;
  kill(reason?: string): Promise<RunResponse>;
  cancel(): Promise<RunResponse>;
}

export interface Agent {
  readonly version: typeof NIMPLEX_AGENT_VERSION;
  readonly id: string | undefined;
  readonly harness: string;
  generate(options: AgentCallOptions): Promise<GenerateResult>;
  stream(options: AgentCallOptions): Promise<StreamResult>;
}

const TERMINAL: ReadonlySet<string> = new Set(["completed", "failed", "killed", "canceled"]);

/** 現成實作：一次呼叫＝在雲端沙箱裡跑一次 harness。 */
export class CloudAgent implements Agent {
  readonly version = NIMPLEX_AGENT_VERSION;

  constructor(
    private readonly transport: Transport,
    private readonly settings: AgentSettings,
  ) {}

  get id(): string | undefined {
    return this.settings.id;
  }

  get harness(): string {
    return this.settings.harness;
  }

  async generate(options: AgentCallOptions): Promise<GenerateResult> {
    const stream = await this.stream(options);
    const events: RunEvent[] = [];
    for await (const event of stream.events) events.push(event);
    const run = await stream.wait();
    return { run, events, text: extractText(events), spentUsd: run.spent_usd };
  }

  async stream(options: AgentCallOptions): Promise<StreamResult> {
    const created = await this.transport.request<RunResponse & { run_token: string | null }>(
      "POST",
      "/v1/runs",
      {
        signal: options.signal,
        body: {
          external_user_id: options.externalUserId,
          harness: this.settings.harness,
          model: options.model ?? this.settings.model,
          sandbox: options.sandbox ?? this.settings.sandbox ?? { provider: "docker" },
          instructions: this.settings.instructions,
          input: options.prompt,
          metering: this.settings.metering ?? "exact",
          budget_usd: options.budgetUsd ?? this.settings.budgetUsd,
          max_duration_seconds: this.settings.maxDurationSeconds,
          client_nonce: options.clientNonce,
          metadata: {
            ...(this.settings.id ? { agent_id: this.settings.id } : {}),
            ...options.metadata,
          },
        },
      },
    );

    const transport = this.transport;
    const runId = created.id;

    return {
      runId,
      run: created,
      runToken: created.run_token ?? null,
      events: streamRunEvents(transport, runId, options.signal),
      wait: () => waitForTerminal(transport, runId, options.signal),
      kill: (reason?: string) =>
        transport.request<RunResponse>("POST", `/v1/runs/${runId}/kill`, {
          query: { reason },
        }),
      cancel: () => transport.request<RunResponse>("POST", `/v1/runs/${runId}/cancel`, {}),
    };
  }
}

export async function* streamRunEvents(
  transport: Transport,
  runId: string,
  signal?: AbortSignal,
  after?: number,
): AsyncGenerator<RunEvent> {
  for await (const frame of transport.sse(`/v1/runs/${runId}/events`, { after, signal })) {
    try {
      yield JSON.parse(frame.data) as RunEvent;
    } catch {
      // 壞掉的 frame 不該讓整個串流死掉
    }
  }
}

export async function waitForTerminal(
  transport: Transport,
  runId: string,
  signal?: AbortSignal,
  intervalMs = 500,
): Promise<RunResponse> {
  for (;;) {
    const run = await transport.request<RunResponse>("GET", `/v1/runs/${runId}`, { signal });
    if (TERMINAL.has(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * 把事件流還原成一段文字。
 * 三種來源：內建 loop 的 message.delta、harness 的純文字 stdout、
 * 以及 stream-json harness（Claude Code 那類）吐的結構化訊息。
 */
export function extractText(events: RunEvent[]): string {
  const parts: string[] = [];
  for (const event of events) {
    const payload = event.payload;
    if (!payload || typeof payload !== "object") continue;
    const record = payload as Record<string, unknown>;
    if (event.type === "harness.stdout" && typeof record.text === "string") {
      parts.push(record.text);
    } else if (event.type === "message.delta" && typeof record.text === "string") {
      parts.push(record.text);
    } else if (event.type === "harness.event") {
      const text = textFromStreamJson(record);
      if (text) parts.push(text);
    }
  }
  return parts.join("\n");
}

function textFromStreamJson(record: Record<string, unknown>): string | null {
  const message = record.message;
  if (message && typeof message === "object") {
    const content = (message as Record<string, unknown>).content;
    if (Array.isArray(content)) {
      const texts = content
        .filter(
          (block): block is Record<string, unknown> => typeof block === "object" && block !== null,
        )
        .filter((block) => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text as string);
      if (texts.length > 0) return texts.join("");
    }
  }
  if (typeof record.result === "string") return record.result;
  return null;
}
