// ComputeSDK adapter：一個轉接頭，把 ComputeSDK 支援的任何一家沙箱（Daytona / Vercel / Modal / Railway…）
// 變成 nimplex 的 SandboxProvider。關鍵幾家（docker、e2b）我們直接接；長尾走這裡。
//
// 對應關係（port → ComputeSDK）：
//   create  → provider.sandbox.create({ templateId, envs, timeout })   image ≈ templateId
//   resume  → provider.sandbox.getById(sandboxId)
//   delete  → provider.sandbox.destroy(sandboxId)                       找不到也吞掉（reaper 會重複呼叫）
//   exec    → sandbox.runCommand(cmd, { cwd, env, timeout, onStdout, onStderr })
//
// ComputeSDK 沒有的兩件事，這裡用繞法補：
//   stdin  → 先 writeFile 成暫存檔，再 `cmd < file`
//   signal → Promise.race 提前返回並標 timedOut（箱子裡的程序可能還在跑，跟 docker exec 殺 client 端同語意；
//            worker 之後的 stop()/delete() 會把整個箱子收掉）
// 每家在 conformance kit 上差幾條，跑一次就知道，不用猜。

import type {
  ExecArgs,
  ExecResult,
  SandboxCreateArgs,
  SandboxProvider,
  SandboxSession,
  SandboxSessionState,
} from "@nimplex/core";
import { SANDBOX_SESSION_STATE_VERSION, shellQuote } from "@nimplex/core";

/** 只依賴 ComputeSDK 介面的結構，不 import 它內部的型別路徑——任何 @computesdk/* 的 provider 都對得上。 */
export interface ComputeSdkSandbox {
  readonly sandboxId: string;
  runCommand(
    command: string,
    options?: {
      cwd?: string;
      env?: Record<string, string>;
      timeout?: number;
      background?: boolean;
      onStdout?: (data: string) => void;
      onStderr?: (data: string) => void;
    },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  readonly filesystem: {
    readFile(path: string): Promise<string>;
    writeFile(path: string, content: string): Promise<void>;
    mkdir(path: string): Promise<void>;
  };
  destroy(): Promise<void>;
}

export interface ComputeSdkBackend {
  readonly name: string;
  readonly sandbox: {
    create(options?: {
      templateId?: string;
      snapshotId?: string;
      envs?: Record<string, string>;
      timeout?: number;
      metadata?: Record<string, unknown>;
      name?: string;
    }): Promise<ComputeSdkSandbox>;
    getById(sandboxId: string): Promise<ComputeSdkSandbox | null>;
    destroy(sandboxId: string): Promise<void>;
  };
}

export interface ComputeSdkProviderOptions {
  /** 在 nimplex 這邊的 provider id（對應 contracts 的 SANDBOX_PROVIDERS） */
  backendId: string;
  /** 延遲建立：沒 key 時不要在 worker 啟動就炸 */
  backend: () => ComputeSdkBackend;
  /** 缺 key／設定時回原因；null 表示可用 */
  unavailableReason: () => string | null;
  defaultTemplate?: string;
  /** 沙箱壽命上限（ms）；run 結束時 worker 本來就會 delete */
  lifetimeMs?: number;
}

interface ComputeSdkProviderState extends Record<string, unknown> {
  sandboxId: string;
  backend: string;
}

const DEFAULT_LIFETIME_MS = 2 * 60 * 60 * 1000;

export class ComputeSdkSandboxSession implements SandboxSession {
  constructor(
    readonly state: SandboxSessionState,
    private readonly sandbox: ComputeSdkSandbox,
  ) {}

  async exec(args: ExecArgs): Promise<ExecResult> {
    const startedAt = Date.now();
    const wall = () => (Date.now() - startedAt) / 1000;

    let command = args.cmd;
    if (args.stdin !== undefined) {
      const stdinPath = `${this.state.workdir}/.nimplex-stdin-${startedAt}`;
      await this.sandbox.filesystem.writeFile(stdinPath, args.stdin);
      command = `${command} < ${shellQuote(stdinPath)}`;
    }

    const running = this.sandbox.runCommand(command, {
      cwd: args.workdir ?? this.state.workdir,
      env: { ...this.state.environment, ...args.env },
      timeout: args.timeoutMs,
      onStdout: args.onStdout,
      onStderr: args.onStderr,
    });
    const aborted = new Promise<never>((_, reject) => {
      if (!args.signal) return;
      const onAbort = () => reject(new Error("aborted"));
      if (args.signal.aborted) onAbort();
      else args.signal.addEventListener("abort", onAbort, { once: true });
    });

    try {
      const result = await (args.signal ? Promise.race([running, aborted]) : running);
      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        wallTimeSeconds: wall(),
        timedOut: false,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (args.signal?.aborted || /timed? ?out|timeout/i.test(message)) {
        return {
          exitCode: null,
          stdout: "",
          stderr: message,
          wallTimeSeconds: wall(),
          timedOut: true,
        };
      }
      throw err;
    }
  }

  async writeFile(path: string, contents: string): Promise<void> {
    const dir = path.slice(0, path.lastIndexOf("/"));
    if (dir) await this.sandbox.filesystem.mkdir(dir).catch(() => {});
    await this.sandbox.filesystem.writeFile(path, contents);
  }

  async readFile(path: string): Promise<string> {
    return this.sandbox.filesystem.readFile(path);
  }

  async stop(): Promise<void> {
    await this.sandbox.destroy();
  }
}

export class ComputeSdkSandboxProvider implements SandboxProvider {
  readonly backendId: string;
  private cached: ComputeSdkBackend | null = null;

  constructor(private readonly options: ComputeSdkProviderOptions) {
    this.backendId = options.backendId;
  }

  private backend(): ComputeSdkBackend {
    this.cached ??= this.options.backend();
    return this.cached;
  }

  unavailableReason(): string | null {
    return this.options.unavailableReason();
  }

  async create(args: SandboxCreateArgs): Promise<SandboxSession> {
    const workdir = args.workdir ?? "/workspace";
    const environment = args.environment ?? {};
    const templateId = args.image ?? args.snapshot ?? this.options.defaultTemplate;
    const sandbox = await this.backend().sandbox.create({
      ...(templateId ? { templateId } : {}),
      envs: environment,
      timeout: this.options.lifetimeMs ?? DEFAULT_LIFETIME_MS,
      metadata: { nimplex_label: args.label.slice(0, 64) },
    });
    try {
      await sandbox.filesystem.mkdir(workdir);
    } catch (err) {
      // 建箱後的 setup 失敗要自己收掉，不能把箱子漏在雲端
      await sandbox.destroy().catch(() => {});
      throw err;
    }
    return new ComputeSdkSandboxSession(
      {
        version: SANDBOX_SESSION_STATE_VERSION,
        backendId: this.backendId,
        providerState: {
          sandboxId: sandbox.sandboxId,
          backend: this.backend().name,
        } satisfies ComputeSdkProviderState,
        workdir,
        environment,
      },
      sandbox,
    );
  }

  async resume(state: SandboxSessionState): Promise<SandboxSession> {
    const sandbox = await this.backend().sandbox.getById(sandboxIdOf(state));
    if (!sandbox) throw new Error(`${this.backendId} 沙箱 ${sandboxIdOf(state)} 已不存在`);
    return new ComputeSdkSandboxSession(state, sandbox);
  }

  /** 冪等：找不到就當作已經刪掉（reaper 與重領都可能對同一個 state 呼叫兩次）。 */
  async delete(state: SandboxSessionState): Promise<void> {
    await this.backend()
      .sandbox.destroy(sandboxIdOf(state))
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        if (!/not found|404|does not exist|已不存在/i.test(message)) throw err;
      });
  }
}

function sandboxIdOf(state: SandboxSessionState): string {
  const id = (state.providerState as ComputeSdkProviderState).sandboxId;
  if (typeof id !== "string") throw new Error("computesdk sandbox state 缺少 sandboxId");
  return id;
}
