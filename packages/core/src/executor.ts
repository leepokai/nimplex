// One executor step drives a Pi inference and tool batch. Persistence callbacks commit each model response
// and each tool result independently, so recovery skips all already committed operations.

import type {
  ContextCheckpoint,
  ModelAttempt,
  ModelProvider,
  WorkspaceMetadata,
} from "@nimplex/contracts";
import type { ExecResult } from "./sandbox.ts";

export interface ExecutorEvent {
  type: string;
  payload?: unknown;
}

export interface ExecutorRunContext {
  id: string;
  modelProvider: ModelProvider;
  model: string;
  config: unknown;
  /** Full log so far, in seq order. The executor owns the projection back to its own state. */
  events: ExecutorEvent[];
  /** Tier 0 file tree at the start of this turn (absolute path -> bytes). */
  files: Record<string, Uint8Array>;
  workspaceMetadata: WorkspaceMetadata;
  /** Model credential resolved by the host. Stays in this process; never enters any sandbox. */
  credential: {
    apiKey?: string;
    headers?: Record<string, string | null>;
    env?: Record<string, string>;
    baseUrl: string | null;
    billingMode?: "subscription";
  };
  nativeBash?: (
    id: string,
    command: string,
    files: Record<string, Uint8Array>,
    metadata: WorkspaceMetadata,
    signal: AbortSignal,
    timeoutMs: number,
  ) => Promise<{
    result: ExecResult;
    files: Record<string, Uint8Array>;
    metadata: WorkspaceMetadata;
  }>;
  /** Every callback is awaited before the next external operation can begin. */
  persistence: {
    readEvents(): Promise<ExecutorEvent[]>;
    checkpointContext(checkpoint: ContextCheckpoint): Promise<void>;
    startModel(): Promise<ModelAttempt>;
    commitModel(
      attempt: ModelAttempt,
      events: ExecutorEvent[],
      costUsd: number,
      uncertain: boolean,
    ): Promise<void>;
    startTool(id: string, name: string): Promise<void>;
    commitTool(
      events: ExecutorEvent[],
      files: Record<string, Uint8Array>,
      metadata: WorkspaceMetadata,
    ): Promise<void>;
  };
}

export interface ExecutorStepResult {
  events: ExecutorEvent[];
  costUsd: number;
  /** Tier 0 file tree after this turn; the host owns its durable commit. */
  files: Record<string, Uint8Array>;
  /**
   * Why the model stopped. "toolUse" = the run continues, "stop" = the run is complete; anything
   * else ("aborted", "length", "error", ...) is a failure the worker records after settling spend.
   */
  stopReason: string;
  errorMessage?: string;
}

/** Runs exactly one turn. Must honor `signal` (host shutdown, cancellation, ownership loss, duration cap) by aborting the model call. Throws only for infrastructure errors; model-side stops come back in the result so spend is never lost. */
export type RunExecutor = (
  run: ExecutorRunContext,
  signal: AbortSignal,
) => Promise<ExecutorStepResult>;
