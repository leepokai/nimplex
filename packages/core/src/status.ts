import type { RunStatus } from "@loopbox/contracts";

export const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set([
  "completed",
  "failed",
  "killed",
  "canceled",
]);

const TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  queued: ["running", "canceled"],
  running: ["awaiting_input", "completed", "failed", "killed", "canceled"],
  awaiting_input: ["running", "killed", "canceled"],
  completed: [],
  failed: [],
  killed: [],
  canceled: [],
};

export function canTransition(from: RunStatus, to: RunStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(status: RunStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}
