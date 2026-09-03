// local provider：直接在主機上開一個暫存工作目錄跑指令。
//
// 只給開發用，預設關閉：使用者上傳的 harness 是任意 shell 指令，
// 在主機上跑等於沒有隔離。要打開必須明確設 NIMPLEX_ALLOW_LOCAL_SANDBOX=1。
//
// 已知限制（conformance kit 以 absolutePaths:false 宣告）：/workspace 只是虛擬映射——
// writeFile / readFile / exec 的 workdir 會轉到暫存目錄，但 shell 指令裡寫死的 /workspace/... 絕對路徑
// 在 host 上並不存在。會用絕對路徑讀寫的 harness（Claude Code 之類）在 local 上行為與 docker 不同。

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type {
  ExecArgs,
  ExecResult,
  SandboxCreateArgs,
  SandboxProvider,
  SandboxSession,
  SandboxSessionState,
} from "@nimplex/core";
import { SANDBOX_SESSION_STATE_VERSION } from "@nimplex/core";
import { spawnCollect } from "./spawn.ts";

export const LOCAL_BACKEND_ID = "local";

interface LocalProviderState extends Record<string, unknown> {
  workspaceRoot: string;
}

export class LocalSandboxSession implements SandboxSession {
  constructor(readonly state: SandboxSessionState) {}

  private get workspaceRoot(): string {
    const root = (this.state.providerState as LocalProviderState).workspaceRoot;
    if (typeof root !== "string") throw new Error("local sandbox state 缺少 workspaceRoot");
    return root;
  }

  /** 沙箱裡的路徑（/workspace/...）對映到主機暫存目錄，且不准逃出去。 */
  protected hostPath(path: string): string {
    const relative = isAbsolute(path)
      ? path.startsWith(this.state.workdir)
        ? path.slice(this.state.workdir.length).replace(/^\/+/, "")
        : path.replace(/^\/+/, "")
      : path;
    const full = resolve(this.workspaceRoot, relative);
    if (full !== this.workspaceRoot && !full.startsWith(`${this.workspaceRoot}/`)) {
      throw new Error(`路徑逃出工作區：${path}`);
    }
    return full;
  }

  async exec(args: ExecArgs): Promise<ExecResult> {
    const cwd = args.workdir ? this.hostPath(args.workdir) : this.workspaceRoot;
    return spawnCollect("/bin/sh", ["-lc", args.cmd], {
      cwd,
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: this.workspaceRoot,
        ...this.state.environment,
        ...args.env,
      },
      stdin: args.stdin,
      timeoutMs: args.timeoutMs,
      onStdout: args.onStdout,
      onStderr: args.onStderr,
      signal: args.signal,
    });
  }

  async writeFile(path: string, contents: string): Promise<void> {
    const target = this.hostPath(path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents, "utf8");
  }

  async readFile(path: string): Promise<string> {
    return readFile(this.hostPath(path), "utf8");
  }

  async stop(): Promise<void> {
    await rm(this.workspaceRoot, { recursive: true, force: true });
  }
}

export class LocalSandboxProvider implements SandboxProvider {
  readonly backendId = LOCAL_BACKEND_ID;

  unavailableReason(): string | null {
    if (process.env.NIMPLEX_ALLOW_LOCAL_SANDBOX === "1") return null;
    return "local sandbox 沒有隔離，預設關閉；開發環境請設 NIMPLEX_ALLOW_LOCAL_SANDBOX=1";
  }

  async create(args: SandboxCreateArgs): Promise<SandboxSession> {
    const workdir = args.workdir ?? "/workspace";
    const workspaceRoot = await mkdtemp(join(tmpdir(), "nimplex-"));
    return new LocalSandboxSession({
      version: SANDBOX_SESSION_STATE_VERSION,
      backendId: this.backendId,
      providerState: { workspaceRoot } satisfies LocalProviderState,
      workdir,
      environment: args.environment ?? {},
    });
  }

  async resume(state: SandboxSessionState): Promise<SandboxSession> {
    return new LocalSandboxSession(state);
  }

  async delete(state: SandboxSessionState): Promise<void> {
    await new LocalSandboxSession(state).stop();
  }
}
