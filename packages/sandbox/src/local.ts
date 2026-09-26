// Local provider executes commands in a temporary directory on the host.
//
// Development only, disabled by default. Arbitrary shell runs without isolation,
// so enable it explicitly with NIMPLEX_ALLOW_LOCAL_SANDBOX=1.
//
// Declared absolutePaths:false: /workspace is a virtual mapping for file operations
// and exec cwd, not a real host directory. Absolute paths embedded in shell scripts
// therefore behave differently from isolated Docker or cloud sandboxes.

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
    if (typeof root !== "string") throw new Error("local sandbox state is missing workspaceRoot");
    return root;
  }

  /** Map /workspace paths into the temporary host directory without escaping it. */
  protected hostPath(path: string): string {
    const relative = isAbsolute(path)
      ? path.startsWith(this.state.workdir)
        ? path.slice(this.state.workdir.length).replace(/^\/+/, "")
        : path.replace(/^\/+/, "")
      : path;
    const full = resolve(this.workspaceRoot, relative);
    if (full !== this.workspaceRoot && !full.startsWith(`${this.workspaceRoot}/`)) {
      throw new Error(`Path escapes the workspace: ${path}`);
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
    return "local sandbox has no isolation and is off by default; set NIMPLEX_ALLOW_LOCAL_SANDBOX=1 for development";
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
