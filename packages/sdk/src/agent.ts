// Follow Vercel AI SDK v7 Agent (ai dist/index.d.ts):
//
//   readonly version: 'agent-v1' keeps interface evolution explicit.
//   readonly id
//   generate(options): nonstreaming result.
//   stream(options): event stream.
//
// Same minimal shape ("implement the Agent interface, or use the ready-made class"); the only
// difference is where it runs: the nimplex loop runs in the worker against a cloud sandbox, so
// model usage is recorded per durable attempt.

import type { ModelSpec, RunEvent, RunResponse, SandboxSpec } from "@nimplex/contracts";
import type { Transport } from "./http.ts";

export const NIMPLEX_AGENT_VERSION = "nimplex-agent-v1";

export interface AgentSettings {
  /** Human-readable id, written into run metadata */
  id?: string;
  model: ModelSpec;
  sandbox?: SandboxSpec;
  instructions: string;
  /** Optional wall-clock execution limit in seconds. */
  maxDurationSeconds?: number;
  /** Execution engine for new runs; continuations inherit their parent's engine. */
  engine?: "pi-executor" | "pi-harness";
  /** Pi thinking level (harness engine). */
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}

export interface AgentCallOptions {
  parentRunId?: string;
  contextMode?: "continue" | "reset" | "compact";
  executionMode?: "build" | "read_only";
  attachments?: { path: string; content: string }[];
  /** Optional accounting/audit attribution; callers manage their own users and rollups. */
  externalUserId?: string;
  prompt?: string;
  /** Override agent defaults for this call. */
  model?: ModelSpec;
  sandbox?: SandboxSpec;
  metadata?: Record<string, unknown>;
  clientNonce?: string;
  /** Earliest start; the run is created immediately and stays queued until then. */
  startAt?: Date | string;
  signal?: AbortSignal;
}

export interface GenerateResult {
  run: RunResponse;
  events: RunEvent[];
  /** Text output of the run, concatenated */
  text: string;
  spentUsd: number;
}

export interface StreamResult {
  runId: string;
  /** State at creation time (usually queued) */
  run: RunResponse;
  events: AsyncGenerator<RunEvent>;
  /** Wait for terminal state. */
  wait(): Promise<RunResponse>;
  kill(reason?: string): Promise<RunResponse>;
  cancel(): Promise<RunResponse>;
}

export interface Agent {
  readonly version: typeof NIMPLEX_AGENT_VERSION;
  readonly id: string | undefined;
  generate(options: AgentCallOptions): Promise<GenerateResult>;
  stream(options: AgentCallOptions): Promise<StreamResult>;
}

const TERMINAL: ReadonlySet<string> = new Set(["completed", "failed", "killed", "canceled"]);

/** Ready-made implementation: one call = one cloud run. */
export class CloudAgent implements Agent {
  readonly version = NIMPLEX_AGENT_VERSION;

  constructor(
    private readonly transport: Transport,
    private readonly settings: AgentSettings,
  ) {}

  get id(): string | undefined {
    return this.settings.id;
  }

  async generate(options: AgentCallOptions): Promise<GenerateResult> {
    const stream = await this.stream(options);
    const events: RunEvent[] = [];
    for await (const event of stream.events) events.push(event);
    const run = await stream.wait();
    return { run, events, text: extractText(events), spentUsd: run.spent_usd };
  }

  async stream(options: AgentCallOptions): Promise<StreamResult> {
    const created = await this.transport.request<RunResponse>("POST", "/v1/runs", {
      signal: options.signal,
      body: {
        parent_run_id: options.parentRunId,
        start_at:
          options.startAt === undefined
            ? undefined
            : options.startAt instanceof Date
              ? options.startAt.toISOString()
              : options.startAt,
        context_mode: options.contextMode,
        execution_mode: options.executionMode,
        attachments: options.attachments,
        external_user_id: options.externalUserId,
        model: options.model ?? this.settings.model,
        sandbox: options.sandbox ?? this.settings.sandbox ?? { provider: "docker" },
        instructions: this.settings.instructions,
        input: options.prompt,
        max_duration_seconds: this.settings.maxDurationSeconds,
        engine: this.settings.engine,
        thinking: this.settings.thinking,
        client_nonce: options.clientNonce,
        metadata: {
          ...(this.settings.id ? { agent_id: this.settings.id } : {}),
          ...options.metadata,
        },
      },
    });

    const transport = this.transport;
    const runId = created.id;

    return {
      runId,
      run: created,
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
      // A malformed frame must not terminate the entire event stream.
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

/** Rebuild the run's text output from message.delta events. */
export function extractText(events: RunEvent[]): string {
  const parts: string[] = [];
  for (const event of events) {
    const payload = event.payload;
    if (!payload || typeof payload !== "object") continue;
    const record = payload as Record<string, unknown>;
    if (event.type === "message.delta" && typeof record.text === "string") {
      parts.push(record.text);
    }
  }
  return parts.join("\n");
}
