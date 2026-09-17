// Sandbox provider port.
//
// Follows OpenAI Agents SDK SandboxClient/SandboxSession
// (@openai/agents-core dist/sandbox) for a shared requirement:
//
// Session state must serialize and resume across processes.
//
// Workers are replaceable, so cleanup must not rely on an in-memory handle.
// Persist sandbox identity in runs.sandbox_state so another worker can reconnect
// and destroy the environment after reading durable state.
// Budget cancellation depends on this hard-kill path.
//
// Also retain backendId provider identity and versioned state.
// Omit the broader Manifest/snapshot/pathGrants machinery until needed.

export const SANDBOX_SESSION_STATE_VERSION = 1;

/** A provider has positively confirmed the environment no longer exists. */
export class SandboxMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxMissingError";
  }
}

export interface SandboxSessionState {
  version: number;
  /** Provider identity matching SandboxProvider.backendId. */
  backendId: string;
  /** Provider-specific container IDs, directories, and other resume data. */
  providerState: Record<string, unknown>;
  workdir: string;
  environment: Record<string, string>;
}

export interface ExecArgs {
  cmd: string;
  workdir?: string;
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs?: number;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  signal?: AbortSignal;
}

export interface ExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  wallTimeSeconds: number;
  timedOut: boolean;
}

export interface SandboxSession {
  readonly state: SandboxSessionState;
  exec(args: ExecArgs): Promise<ExecResult>;
  writeFile(path: string, contents: string): Promise<void>;
  readFile(path: string): Promise<string>;
  /** Hard-kill primitive: destroy the entire sandbox, not a single process. */
  stop(): Promise<void>;
}

export interface SandboxCreateArgs {
  /** Naming/audit label; providers may ignore it. */
  label: string;
  image?: string;
  cpu?: number;
  memoryMb?: number;
  snapshot?: string;
  environment?: Record<string, string>;
  workdir?: string;
}

export interface SandboxProvider {
  readonly backendId: string;
  /**
   * Return a reason for missing configuration, credentials, or infrastructure.
   * The API checks availability during creation to fail before execution.
   */
  unavailableReason(): string | null | Promise<string | null>;
  create(args: SandboxCreateArgs): Promise<SandboxSession>;
  /** Reconnect to an existing sandbox from serialized state on any worker. */
  resume(state: SandboxSessionState): Promise<SandboxSession>;
  /** Optional idle suspension. resume() must make a paused session executable again. */
  pause?(state: SandboxSessionState): Promise<void>;
  /** Delete without first resuming; used by terminal-run cleanup. */
  delete(state: SandboxSessionState): Promise<void>;
}

export function isSandboxSessionState(value: unknown): value is SandboxSessionState {
  if (typeof value !== "object" || value === null) return false;
  const state = value as Record<string, unknown>;
  return (
    typeof state.version === "number" &&
    typeof state.backendId === "string" &&
    typeof state.workdir === "string" &&
    typeof state.providerState === "object" &&
    state.providerState !== null
  );
}
