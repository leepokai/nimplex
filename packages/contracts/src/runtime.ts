import { z } from "zod";
import { thinkingLevel } from "./engine.ts";
import type { RunEvent, RunResponse } from "./index.ts";

/** Local session commands are independent of HTTP, organizations, and work queues. */
export const startTurnRequest = z.object({
  /** Stable caller identity for retries. Reuse with different content is rejected. */
  requestId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9._:-]+$/)
    .optional(),
  prompt: z.string().min(1),
  instructions: z.string().default("Complete the user's task in /workspace."),
  model: z.string().min(1).default("claude-haiku-4-5"),
  sandbox: z.enum(["e2b", "docker"]).default("e2b"),
  timeout: z.number().int().min(1).max(86400).default(180),
  contextMode: z.enum(["continue", "reset", "compact"]).default("continue"),
  executionMode: z.enum(["build", "read_only"]).default("build"),
  /** Pi thinking level for the turn's model requests; thinking output is billed as output tokens. */
  thinking: thinkingLevel.optional(),
  attachments: z
    .array(z.object({ path: z.string().max(1024), content: z.string().max(131072) }))
    .max(16)
    .optional(),
});
export type StartTurnRequest = z.infer<typeof startTurnRequest>;

/** Committed acceptance; the corresponding turn owns execution and recovery. */
export const acceptedTurnInput = z.object({
  version: z.literal(1),
  sessionId: z.string().min(1),
  requestId: z.string().min(1).max(128),
  turnId: z.string().min(1),
  acceptedAt: z.string().datetime(),
  request: startTurnRequest,
});
export type AcceptedTurnInput = z.infer<typeof acceptedTurnInput>;

/** Durable in-flight input for the active turn: steering interrupts, follow-ups queue after it. */
export const queueInputRequest = z.object({
  kind: z.enum(["steer", "followUp"]),
  text: z.string().min(1).max(131072),
});
export type QueueInputRequest = z.infer<typeof queueInputRequest>;

export const queueInputResponse = z.object({ entryId: z.string().min(1) });
export type QueueInputResponse = z.infer<typeof queueInputResponse>;

/** Outcome of cancelling queued input: consumed items are already part of the history. */
export const cancelQueuedInputResponse = z.object({
  kind: z.enum(["cancelled", "already_consumed", "not_found"]),
});
export type CancelQueuedInputResponse = z.infer<typeof cancelQueuedInputResponse>;

export const startTurnResponse = z.object({
  runId: z.string().min(1),
  requestId: z.string().min(1).max(128),
});
export type StartTurnResponse = z.infer<typeof startTurnResponse>;

export interface SessionTurn {
  prompt: string;
  runId?: string;
  events: RunEvent[];
  result?: RunResponse;
}

/** Read projection shared by TUI and headless clients; mutations go through the runtime. */
export interface SessionSnapshot {
  version: 1;
  id: string;
  title: string;
  cwd: string;
  updatedAt: string;
  turns: SessionTurn[];
  headRunId?: string;
  parentSessionId?: string;
  /** Execution engine owning this session's history; absent on records written before 2026-09-25 means the legacy executor. */
  engine?: "pi-executor" | "pi-harness";
  /** Estimated sandbox compute settled so far; absent until a sandbox interval settles. */
  sandbox?: SandboxUsageSummary;
}

/**
 * One settled sandbox running interval, stored in the session ledger and, while its turn
 * is running, as the payload of a `sandbox.usage` event. `cost_usd` is an estimate and is
 * null when the sandbox's rate or size is unknown.
 */
export interface SandboxUsageRecord {
  provider: string;
  /**
   * `reconnected`: an unobserved interval ended when a runtime reattached to the still
   * running sandbox; `expired`: an abandoned interval passed the provider lifetime;
   * `discarded`: a sandbox created for a turn that was cancelled before it could be used.
   */
  reason: "paused" | "deleted" | "missing" | "reconnected" | "expired" | "discarded";
  started_at: string;
  ended_at: string;
  seconds: number;
  cost_usd: number | null;
  /**
   * Part of the interval was not observed (a runtime restart, a failed pause, a sandbox
   * found missing), so the time is an upper bound capped at the provider's lifetime.
   */
  uncertain: boolean;
  basis: string;
  /** The turn that was running when the interval settled; null for session cleanup. */
  turn_id: string | null;
}

/**
 * A session's settled sandbox running time. `usd` is an estimate: seconds times the
 * provider's list rate. Intervals without a rate count only toward `unpriced_seconds`.
 */
export interface SandboxUsageSummary {
  usd: number;
  seconds: number;
  unpriced_seconds: number;
  /** True when any interval's end was not observed, such as a failed pause. */
  uncertain: boolean;
  /** Start of the interval that is still running and not yet included above. */
  running_since?: string;
  /** Every sandbox so far has a zero rate (local Docker), so there is nothing to estimate. */
  free: boolean;
}
