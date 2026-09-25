// Remote E2B sandbox provider. Workers call its API without a Docker daemon,
// allowing deployment on ordinary PaaS hosts (architecture §9).
//
// Port to E2B SDK mapping:
//   create  → Sandbox.create(template, { envs, timeoutMs })   image ≈ template
//   resume → Sandbox.connect(sandboxId); serialized IDs work across workers.
//   delete → Sandbox.kill(sandboxId); no connect needed, missing IDs return false.
//   exec    → sandbox.commands.run(cmd, { cwd, envs, timeoutMs, onStdout, onStderr, signal })
//
// E2B has an independent timeoutMs lifetime and automatically destroys expired sandboxes.
// NIMPLEX_E2B_LIFETIME_MS sets that bound; the default below is one hour.
// The current Pi loop calls models from the worker, so native sandboxes need no model gateway.

import type {
  ExecArgs,
  ExecResult,
  SandboxCreateArgs,
  SandboxProvider,
  SandboxSession,
  SandboxSessionState,
} from "@nimplex/core";
import { SANDBOX_SESSION_STATE_VERSION, SandboxMissingError, shellQuote } from "@nimplex/core";
import { CommandExitError, NotFoundError, Sandbox, TimeoutError } from "e2b";

export const E2B_BACKEND_ID = "e2b";

// E2B Hobby limits lifetime to one hour; larger values return HTTP 400.
// Pro supports up to 24 hours; override NIMPLEX_E2B_LIFETIME_MS as appropriate.
// Read env lazily: this module is imported before the worker loads .env, so a module-level read
// would see nothing.
function defaultLifetimeMs(): number {
  const raw = process.env.NIMPLEX_E2B_LIFETIME_MS;
  if (raw === undefined || raw === "") return 60 * 60 * 1000;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0)
    throw new Error("NIMPLEX_E2B_LIFETIME_MS must be a positive number of milliseconds.");
  return value;
}

interface E2bProviderState extends Record<string, unknown> {
  sandboxId: string;
  template: string | null;
  /** Allocated size, for usage estimates; absent when E2B did not report it. */
  cpuCount?: number;
  memoryMB?: number;
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
      // E2B defaults to 60 seconds; the port uses zero for an unlimited omitted timeout.
      timeoutMs: args.timeoutMs ?? 0,
      onStdout: args.onStdout,
      onStderr: args.onStderr,
      signal: args.signal,
    };
    try {
      if (args.stdin !== undefined) {
        // Stdin requires a live handle: start with stdin open, send, close, then wait.
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
      // Normalize E2B nonzero-exit exceptions into the port exitCode result.
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

  get maxRunMs(): number | undefined {
    // An invalid setting is reported by unavailableReason(); estimates then stay uncapped.
    try {
      return defaultLifetimeMs();
    } catch {
      return undefined;
    }
  }

  unavailableReason(): string | null {
    if (!apiKey()) return "缺 E2B_API_KEY（e2b.dev 取得後設進環境變數）";
    try {
      defaultLifetimeMs();
    } catch (error) {
      return (error as Error).message;
    }
    return null;
  }

  async create(args: SandboxCreateArgs): Promise<SandboxSession> {
    const workdir = args.workdir ?? "/workspace";
    // E2B images and the port snapshot option map to templates in this adapter.
    const template = args.image ?? args.snapshot ?? process.env.NIMPLEX_E2B_TEMPLATE ?? null;
    const environment = args.environment ?? {};
    const opts = {
      apiKey: apiKey(),
      timeoutMs: defaultLifetimeMs(),
      envs: environment,
      metadata: { nimplex_label: args.label.slice(0, 64) },
    };
    // CPU/memory are defined by the E2B template rather than per-create port options.
    const sandbox = template ? await Sandbox.create(template, opts) : await Sandbox.create(opts);
    // Clean up any setup failure after creation so no paid sandbox loses its owner.
    // The size only informs cost estimates: it is looked up during setup and never waited
    // for beyond it, so a slow info endpoint cannot delay the first tool.
    let size: { cpuCount?: number; memoryMB?: number } = {};
    const info = sandbox
      .getInfo({ requestTimeoutMs: 3000 })
      .then((details) => {
        size = { cpuCount: details.cpuCount, memoryMB: details.memoryMB };
      })
      .catch(() => {});
    try {
      // Create /workspace as root, then chown it to the default non-root user.
      const q = shellQuote(workdir);
      await sandbox.commands.run(`mkdir -p ${q} && chown -R user:user ${q}`, {
        user: "root",
        timeoutMs: 30_000,
      });
    } catch (err) {
      await sandbox.kill().catch(() => {});
      throw err;
    }
    await Promise.race([info, new Promise((done) => setTimeout(done, 250))]);

    return new E2bSandboxSession(
      {
        version: SANDBOX_SESSION_STATE_VERSION,
        backendId: this.backendId,
        providerState: {
          sandboxId: sandbox.sandboxId,
          template,
          ...size,
        } satisfies E2bProviderState,
        workdir,
        environment,
      },
      sandbox,
    );
  }

  async resume(state: SandboxSessionState): Promise<SandboxSession> {
    try {
      // Without timeoutMs, connect shortens the lifetime to the SDK's five-minute default.
      const sandbox = await Sandbox.connect(sandboxIdOf(state), {
        apiKey: apiKey(),
        timeoutMs: defaultLifetimeMs(),
      });
      return new E2bSandboxSession(state, sandbox);
    } catch (error) {
      if (error instanceof NotFoundError)
        throw new SandboxMissingError("E2B sandbox no longer exists");
      throw error;
    }
  }

  async pause(state: SandboxSessionState): Promise<void> {
    await Sandbox.pause(sandboxIdOf(state), { apiKey: apiKey() });
  }

  /** Static idempotent kill without connect; missing IDs return false, suitable for reaping. */
  async delete(state: SandboxSessionState): Promise<void> {
    await Sandbox.kill(sandboxIdOf(state), { apiKey: apiKey() });
  }
}

function sandboxIdOf(state: SandboxSessionState): string {
  const id = (state.providerState as E2bProviderState).sandboxId;
  if (typeof id !== "string") throw new Error("e2b sandbox state 缺少 sandboxId");
  return id;
}
