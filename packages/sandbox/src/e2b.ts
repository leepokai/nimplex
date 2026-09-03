// E2B provider：第一家遠端沙箱。worker 不需要 Docker daemon，只打 E2B 的 API——
// 這是 worker 能放到任何 PaaS 上的前提（架構文件 §9）。
//
// 對應關係（port → E2B SDK）：
//   create  → Sandbox.create(template, { envs, timeoutMs })   image ≈ template
//   resume  → Sandbox.connect(sandboxId)                       state 只存 sandboxId，任何 worker 都接得回去
//   delete  → Sandbox.kill(sandboxId)                          靜態呼叫、不需先 connect、找不到回 false（天然冪等）
//   exec    → sandbox.commands.run(cmd, { cwd, envs, timeoutMs, onStdout, onStderr, signal })
//
// 注意：E2B 的 sandbox 有自己的壽命（timeoutMs，到了自動銷毀）。port 沒有「預期壽命」這個參數，
// 所以用 NIMPLEX_E2B_LIFETIME_MS 給一個上限（預設 2 小時）；run 結束時 worker 本來就會 delete。
// 遠端沙箱要打回閘道，NIMPLEX_PUBLIC_URL 必須是 E2B 雲端連得到的位址（本機開發要開 tunnel）。

import type {
  ExecArgs,
  ExecResult,
  SandboxCreateArgs,
  SandboxProvider,
  SandboxSession,
  SandboxSessionState,
} from "@nimplex/core";
import { SANDBOX_SESSION_STATE_VERSION, shellQuote } from "@nimplex/core";
import { CommandExitError, Sandbox, TimeoutError } from "e2b";

export const E2B_BACKEND_ID = "e2b";

// E2B Hobby 方案的 sandbox 壽命上限是 1 小時（超過直接 400 "Timeout cannot be greater than 1 hours"）；
// Pro 可到 24 小時——要更長請自行設 NIMPLEX_E2B_LIFETIME_MS。
// Read env lazily: this module is imported before the worker loads .env, so a module-level read
// would see nothing.
function defaultLifetimeMs(): number {
  return Number(process.env.NIMPLEX_E2B_LIFETIME_MS ?? 60 * 60 * 1000);
}

interface E2bProviderState extends Record<string, unknown> {
  sandboxId: string;
  template: string | null;
}

function apiKey(): string | undefined {
  return process.env.E2B_API_KEY;
}

export class E2bSandboxSession implements SandboxSession {
  constructor(
    readonly state: SandboxSessionState,
    private readonly sandbox: Sandbox,
  ) {}

  async exec(args: ExecArgs): Promise<ExecResult> {
    const startedAt = Date.now();
    const wall = () => (Date.now() - startedAt) / 1000;
    const opts = {
      cwd: args.workdir ?? this.state.workdir,
      envs: { ...this.state.environment, ...args.env },
      // E2B 預設 60 秒就切斷；port 的語意是「沒給就不限」，0 = 不限
      timeoutMs: args.timeoutMs ?? 0,
      onStdout: args.onStdout,
      onStderr: args.onStderr,
      signal: args.signal,
    };
    try {
      if (args.stdin !== undefined) {
        // 要餵 stdin 得走 handle：start（stdin 開著）→ 送 → 關 → 等
        const handle = await this.sandbox.commands.run(args.cmd, {
          ...opts,
          background: true,
          stdin: true,
        });
        await handle.sendStdin(args.stdin);
        await handle.closeStdin();
        const result = await handle.wait();
        return {
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          wallTimeSeconds: wall(),
          timedOut: false,
        };
      }
      const result = await this.sandbox.commands.run(args.cmd, opts);
      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        wallTimeSeconds: wall(),
        timedOut: false,
      };
    } catch (err) {
      // 非零結束碼在 E2B 是 throw，port 的語意是「回傳 exitCode」——壓平
      if (err instanceof CommandExitError) {
        return {
          exitCode: err.exitCode,
          stdout: err.stdout,
          stderr: err.stderr,
          wallTimeSeconds: wall(),
          timedOut: false,
        };
      }
      if (err instanceof TimeoutError || args.signal?.aborted) {
        return {
          exitCode: null,
          stdout: "",
          stderr: err instanceof Error ? err.message : String(err),
          wallTimeSeconds: wall(),
          timedOut: true,
        };
      }
      throw err;
    }
  }

  async writeFile(path: string, contents: string): Promise<void> {
    await this.sandbox.files.write(path, contents);
  }

  async readFile(path: string): Promise<string> {
    return this.sandbox.files.read(path);
  }

  async stop(): Promise<void> {
    await this.sandbox.kill();
  }
}

export class E2bSandboxProvider implements SandboxProvider {
  readonly backendId = E2B_BACKEND_ID;

  unavailableReason(): string | null {
    return apiKey() ? null : "缺 E2B_API_KEY（e2b.dev 取得後設進環境變數）";
  }

  async create(args: SandboxCreateArgs): Promise<SandboxSession> {
    const workdir = args.workdir ?? "/workspace";
    // image 在 E2B 叫 template；snapshot 目前也對映到 template（E2B 沒有獨立的 snapshot 概念）
    const template = args.image ?? args.snapshot ?? process.env.NIMPLEX_E2B_TEMPLATE ?? null;
    const environment = args.environment ?? {};
    const opts = {
      apiKey: apiKey(),
      timeoutMs: defaultLifetimeMs(),
      envs: environment,
      metadata: { nimplex_label: args.label.slice(0, 64) },
    };
    // cpu / memoryMb：E2B 由 template 決定規格，port 的這兩個欄位在這家沒有對應，略過
    const sandbox = template ? await Sandbox.create(template, opts) : await Sandbox.create(opts);
    // 建箱之後任何一步失敗，箱子要自己收掉——否則沒人拿到 id、沒人砍，漏在雲端燒額度
    try {
      // E2B 預設使用者是非 root 的 `user`，在 / 底下開資料夾要 root；建完 chown 回去讓 harness 寫得進去
      const q = shellQuote(workdir);
      await sandbox.commands.run(`mkdir -p ${q} && chown -R user:user ${q}`, {
        user: "root",
        timeoutMs: 30_000,
      });
    } catch (err) {
      await sandbox.kill().catch(() => {});
      throw err;
    }

    return new E2bSandboxSession(
      {
        version: SANDBOX_SESSION_STATE_VERSION,
        backendId: this.backendId,
        providerState: { sandboxId: sandbox.sandboxId, template } satisfies E2bProviderState,
        workdir,
        environment,
      },
      sandbox,
    );
  }

  async resume(state: SandboxSessionState): Promise<SandboxSession> {
    const sandbox = await Sandbox.connect(sandboxIdOf(state), { apiKey: apiKey() });
    return new E2bSandboxSession(state, sandbox);
  }

  /** 靜態 kill：不需先 connect；找不到回 false，重複呼叫也不會炸——reaper 需要這個性質。 */
  async delete(state: SandboxSessionState): Promise<void> {
    await Sandbox.kill(sandboxIdOf(state), { apiKey: apiKey() });
  }
}

function sandboxIdOf(state: SandboxSessionState): string {
  const id = (state.providerState as E2bProviderState).sandboxId;
  if (typeof id !== "string") throw new Error("e2b sandbox state 缺少 sandboxId");
  return id;
}
