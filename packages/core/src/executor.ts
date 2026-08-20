// 分岔一的回頭路：MVP 的 builtin loop 與未來的箱內 harness（sandbox + stdio ACP）
// 都是 RunExecutor 的實作。每個 step 對應 work_items 裡的一個 work item——
// worker 進程不持有任何狀態（Omnara 模式：the log is the agent）。

export interface ExecutorRunContext {
  id: string;
  orgId: string;
  endUserId: string;
  config: unknown;
  spentUsd: number;
  budgetUsd: number;
}

export interface ExecutorWorkItem {
  id: string;
  kind: "model" | "tool";
  payload: unknown;
}

export interface ExecutorEvent {
  type: string;
  payload?: unknown;
}

export type ExecutorNext =
  | { kind: "continue"; nextItem: { kind: "model" | "tool"; payload: unknown } }
  | { kind: "complete" }
  | { kind: "await_input" };

export interface ExecutorStepResult {
  events: ExecutorEvent[];
  costUsd: number;
  next: ExecutorNext;
}

export interface RunExecutor {
  /** executor id，對應 runs.harness 欄位（"builtin"、未來 "sandbox:opencode"…） */
  id: string;
  step(run: ExecutorRunContext, item: ExecutorWorkItem): Promise<ExecutorStepResult>;
}
