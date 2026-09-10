// One work item drives a Pi turn. Awaited persistence callbacks commit each model response
// and each tool result independently, so recovery skips all already committed operations.

import type {
  ContextCheckpoint,
  ModelProvider,
  ModelReservation,
  WorkspaceMetadata,
} from "@nimplex/contracts";
import type { ExecResult } from "./sandbox.ts";

export interface ExecutorEvent {
  type: string;
  payload?: unknown;
}

export interface ExecutorRunContext {
  id: string;
  orgId: string;
  modelProvider: ModelProvider;
  model: string;
  config: unknown;
  /** Full log so far, in seq order. The executor owns the projection back to its own state. */
  events: ExecutorEvent[];
  /** Tier 0 file tree at the start of this turn (absolute path -> bytes). */
  files: Record<string, Uint8Array>;
  workspaceMetadata: WorkspaceMetadata;
  /** BYOK credential resolved by the worker. Stays in this process; never enters any sandbox. */
  credential: { apiKey: string; baseUrl: string | null };
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
    reserveModel(inputTokenBound: number): Promise<ModelReservation>;
    commitModel(
      reservation: ModelReservation,
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
  /** Tier 0 file tree after this turn; the worker diffs it against the input and writes through. */
  files: Record<string, Uint8Array>;
  /**
   * Why the model stopped. "toolUse" = the run continues, "stop" = the run is complete; anything
   * else ("aborted", "length", "error", ...) is a failure the worker records after settling spend.
   */
  stopReason: string;
  errorMessage?: string;
}

/** Runs exactly one turn. Must honor `signal` (lease lost, run killed, duration cap) by aborting the model call. Throws only for infrastructure errors; model-side stops come back in the result so spend is never lost. */
export type RunExecutor = (
  run: ExecutorRunContext,
  signal: AbortSignal,
) => Promise<ExecutorStepResult>;
