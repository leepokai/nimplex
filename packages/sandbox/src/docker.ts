// Docker provider: one container per run, destroyed with docker rm -f.
//
// Follows OpenAI agents-core DockerSandboxSession/UnixLocalSandboxSession layering:
// execute the same filesystem commands in a different environment.

import { randomUUID } from "node:crypto";
import type {
  ExecArgs,
  ExecResult,
  SandboxCreateArgs,
  SandboxProvider,
  SandboxSession,
  SandboxSessionState,
} from "@nimplex/core";
import { SANDBOX_SESSION_STATE_VERSION, SandboxMissingError, shellQuote } from "@nimplex/core";
import { probe, spawnCollect } from "./spawn.ts";

export const DOCKER_BACKEND_ID = "docker";

/**
 * Most harnesses are npm CLIs, so default to an image that ships node.
 * Read env lazily: this module is imported before the worker loads .env, so a module-level read
 * would see nothing.
 */
export function defaultDockerImage(): string {
  return process.env.NIMPLEX_DOCKER_IMAGE ?? "node:22-bookworm-slim";
}

interface DockerProviderState extends Record<string, unknown> {
  containerId: string;
  image: string;
}

export class DockerSandboxSession implements SandboxSession {
  constructor(readonly state: SandboxSessionState) {}

  private get containerId(): string {
    const id = (this.state.providerState as DockerProviderState).containerId;
    if (typeof id !== "string") throw new Error("docker sandbox state is missing containerId");
    return id;
  }

  private dockerArgs(args: Pick<ExecArgs, "workdir" | "env">): string[] {
    const out = ["exec", "-i", "-w", args.workdir ?? this.state.workdir];
    for (const [key, value] of Object.entries({ ...this.state.environment, ...args.env })) {
      out.push("-e", `${key}=${value}`);
    }
    out.push(this.containerId);
    return out;
  }

  async exec(args: ExecArgs): Promise<ExecResult> {
    return spawnCollect("docker", [...this.dockerArgs(args), "/bin/sh", "-lc", args.cmd], {
      stdin: args.stdin,
      timeoutMs: args.timeoutMs,
      onStdout: args.onStdout,
      onStderr: args.onStderr,
      signal: args.signal,
    });
  }

  async writeFile(path: string, contents: string): Promise<void> {
    const quoted = shellQuote(path);
    const result = await this.exec({
      cmd: `mkdir -p "$(dirname ${quoted})" && cat > ${quoted}`,
      stdin: contents,
    });
    if (result.exitCode !== 0) {
      throw new Error(`Writing ${path} failed: ${result.stderr.trim()}`);
    }
  }

  async readFile(path: string): Promise<string> {
    const result = await this.exec({ cmd: `cat ${shellQuote(path)}` });
    if (result.exitCode !== 0) throw new Error(`Reading ${path} failed: ${result.stderr.trim()}`);
    return result.stdout;
  }

  async stop(): Promise<void> {
    await spawnCollect("docker", ["rm", "-f", this.containerId], { timeoutMs: 30_000 });
  }
}

export class DockerSandboxProvider implements SandboxProvider {
  readonly backendId = DOCKER_BACKEND_ID;

  async unavailableReason(): Promise<string | null> {
    return (await probe("docker", ["info"]))
      ? null
      : "docker daemon is not responding (docker info failed)";
  }

  async create(args: SandboxCreateArgs): Promise<SandboxSession> {
    const workdir = args.workdir ?? "/workspace";
    const image = args.image ?? defaultDockerImage();
    const environment = args.environment ?? {};
    const name = `nimplex-${slug(args.label)}-${randomUUID().slice(0, 8)}`;

    const runArgs = [
      "run",
      "-d",
      "--name",
      name,
      "-w",
      workdir,
      // Make host.docker.internal available to containers on Linux too.
      "--add-host=host.docker.internal:host-gateway",
    ];
    if (args.cpu) runArgs.push("--cpus", String(args.cpu));
    if (args.memoryMb) runArgs.push("--memory", `${args.memoryMb}m`);
    for (const [key, value] of Object.entries(environment)) runArgs.push("-e", `${key}=${value}`);
    runArgs.push(image, "sleep", "infinity");

    const created = await spawnCollect("docker", runArgs, { timeoutMs: 180_000 });
    if (created.exitCode !== 0) {
      throw new Error(`docker run failed: ${created.stderr.trim() || created.stdout.trim()}`);
    }
    const containerId = created.stdout.trim();

    return new DockerSandboxSession({
      version: SANDBOX_SESSION_STATE_VERSION,
      backendId: this.backendId,
      providerState: { containerId, image } satisfies DockerProviderState,
      workdir,
      environment,
    });
  }

  async resume(state: SandboxSessionState): Promise<SandboxSession> {
    const containerId = String(state.providerState.containerId);
    const result = await spawnCollect(
      "docker",
      ["inspect", "--format", "{{.State.Running}}", containerId],
      { timeoutMs: 10000 },
    );
    if (result.exitCode !== 0) {
      if (/No such (object|container)/i.test(result.stderr))
        throw new SandboxMissingError("Docker sandbox no longer exists");
      throw new Error(`docker inspect failed: ${result.stderr}`);
    }
    if (result.stdout.trim() !== "true")
      throw new SandboxMissingError("Docker sandbox is no longer running");
    return new DockerSandboxSession(state);
  }

  async delete(state: SandboxSessionState): Promise<void> {
    await new DockerSandboxSession(state).stop();
  }
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 24) || "run"
  );
}
