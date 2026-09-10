// 插槽 3：sandbox port。
//
// 形狀刻意對齊 OpenAI Agents SDK 的 `SandboxClient` / `SandboxSession`
// （@openai/agents-core 的 dist/sandbox/），因為它已經解掉一個我們一定會遇到的問題：
//
//   **session state 必須可序列化、可跨程序 resume。**
//
// nimplex 的 worker 是無狀態的（隨時可死、隨處可復原），
// 所以「誰砍得掉這個箱子」不能靠記憶體裡的 handle——
// 箱子的身分要寫進 runs.sandbox_state，任何一個 worker 讀到都能接回去砍。
// 這也是 budget kill-switch 的硬殺路徑能成立的前提。
//
// 同樣沿用它的兩個慣例：backendId 當 provider 身分、state 帶版本號可演進。
// 刻意**不**抄的：整套 Manifest / snapshot / pathGrants —— MVP 用不到。

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
  /** provider 身分，對應 SandboxProvider.backendId */
  backendId: string;
  /** provider 自己的欄位（容器 id、工作目錄…）；resume 只靠這裡 */
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
  /** 硬殺原語：整個箱子消失。刻意不提供「殺掉單一 process」。 */
  stop(): Promise<void>;
}

export interface SandboxCreateArgs {
  /** 取名與稽核用；provider 不一定會用到 */
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
   * 缺少必要設定（API key、docker 沒開…）時回傳原因。
   * API 在建 run 時就先問一次，讓錯誤出現在建立階段而不是跑到一半。
   */
  unavailableReason(): string | null | Promise<string | null>;
  create(args: SandboxCreateArgs): Promise<SandboxSession>;
  /** 用序列化的 state 接回既有箱子（換一個 worker 程序也接得回來） */
  resume(state: SandboxSessionState): Promise<SandboxSession>;
  /** Optional idle suspension. resume() must make a paused session executable again. */
  pause?(state: SandboxSessionState): Promise<void>;
  /** 不需要先 resume 就能砍掉——worker 看到 run 被殺時走這條 */
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
