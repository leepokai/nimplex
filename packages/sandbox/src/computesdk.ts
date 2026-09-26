// ComputeSDK adapter for providers such as Daytona, Vercel, Modal, and Railway.
// Docker and E2B integrate directly; additional providers share this adapter.
//
// Port to ComputeSDK mapping:
//   create  → provider.sandbox.create({ templateId, envs, timeout })   image ≈ templateId
//   resume  → provider.sandbox.getById(sandboxId)
//   delete → provider.sandbox.destroy(sandboxId); missing sandboxes are already deleted.
//   exec    → sandbox.runCommand(cmd, { cwd, env, timeout, onStdout, onStderr })
//
// Workarounds for two missing ComputeSDK capabilities:
//   stdin → write a temporary file and redirect with cmd < file.
//   signal → Promise.race returns early with timedOut; the remote process may remain alive.
//            Subsequent stop/delete removes the entire sandbox.
// Conformance tests document actual provider differences.

import type {
  ExecArgs,
  ExecResult,
  SandboxCreateArgs,
  SandboxProvider,
  SandboxSession,
  SandboxSessionState,
} from "@nimplex/core";
import { SANDBOX_SESSION_STATE_VERSION, shellQuote } from "@nimplex/core";

/** Depend on the public structural interface rather than internal ComputeSDK type paths. */
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
  /** nimplex provider ID, matching contracts SANDBOX_PROVIDERS. */
  backendId: string;
  /** Lazy construction avoids failing worker startup when keys are absent. */
  backend: () => ComputeSdkBackend;
  /** Missing credential/configuration reason; null means available. */
  unavailableReason: () => string | null;
  defaultTemplate?: string;
  /** Maximum sandbox lifetime in milliseconds; terminal runs are also deleted by the worker. */
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
      // Clean up if setup fails after creation to avoid leaking a paid sandbox.
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
    if (!sandbox)
      throw new Error(`${this.backendId} sandbox ${sandboxIdOf(state)} no longer exists`);
    return new ComputeSdkSandboxSession(state, sandbox);
  }

  /** Idempotent deletion: missing state is already removed; reapers/reclaims may repeat it. */
  async delete(state: SandboxSessionState): Promise<void> {
    await this.backend()
      .sandbox.destroy(sandboxIdOf(state))
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        if (!/not found|404|does not exist|no longer exists/i.test(message)) throw err;
      });
  }
}

function sandboxIdOf(state: SandboxSessionState): string {
  const id = (state.providerState as ComputeSdkProviderState).sandboxId;
  if (typeof id !== "string") throw new Error("computesdk sandbox state is missing sandboxId");
  return id;
}
