import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ExecArgs,
  type RunExecutor,
  SandboxMissingError,
  type SandboxProvider,
  type SandboxSession,
  type SandboxSessionState,
} from "@nimplex/core";

export interface FakeSandboxOptions {
  /** Directory holding every sandbox's files, so another process can resume them. */
  root: string;
  backendId: "docker" | "e2b";
  /** true pauses, "fail" rejects pause(), false leaves the provider without pause(). */
  pause: boolean | "fail";
  /** How long a launched command takes before its journal appears. */
  commandMs?: number;
  template?: string;
  /** Called inside pause() before it resolves, to simulate races with the turn. */
  onPause?: () => void | Promise<void>;
  onLaunch?: () => void;
  maxRunMs?: number;
  /** How long create() takes, to race cancellation against sandbox creation. */
  createMs?: number;
}

/**
 * A disk-backed sandbox that speaks the native supervisor protocol without executing
 * anything: a launch publishes a journal that echoes the submitted workspace once
 * `commandMs` has elapsed, and journal reads return it.
 */
export function fakeSandboxProvider(options: FakeSandboxOptions) {
  const counters = { create: 0, resume: 0, pause: 0, delete: 0 };
  const key = (path: string) => createHash("sha256").update(path).digest("hex");
  const boxDir = (state: SandboxSessionState) =>
    join(options.root, String(state.providerState.sandboxId));
  const session = (state: SandboxSessionState): SandboxSession => ({
    state,
    async exec({ cmd }: ExecArgs) {
      await new Promise((done) => setTimeout(done, 20));
      if (!existsSync(boxDir(state))) throw new SandboxMissingError("gone");
      const ok = (stdout = "") => ({
        exitCode: 0,
        stdout,
        stderr: "",
        wallTimeSeconds: 0,
        timedOut: false,
      });
      if (cmd.startsWith("mkdir -p")) return ok();
      const launch = /'([^']+\.input\.json)' '([^']+)'/.exec(cmd);
      if (cmd.startsWith("nohup node -e") && launch?.[1] && launch[2]) {
        const journal = join(boxDir(state), key(`${launch[2]}/result.json`));
        // The supervisor's once-only marker: a repeated launch never republishes.
        if (!existsSync(journal)) {
          const input = JSON.parse(readFileSync(join(boxDir(state), key(launch[1])), "utf8"));
          writeFileSync(
            journal,
            JSON.stringify({
              readyAt: Date.now() + (options.commandMs ?? 0),
              payload: {
                result: {
                  exitCode: 0,
                  stdout: "ran",
                  stderr: "",
                  timedOut: false,
                  wallTimeSeconds: 0,
                },
                files: input.files,
                metadata: input.metadata,
              },
            }),
          );
        }
        options.onLaunch?.();
        return ok();
      }
      const read = /'([^']+\/result\.json)'/.exec(cmd);
      if (read?.[1]) {
        const path = join(boxDir(state), key(read[1]));
        if (!existsSync(path)) return { ...ok(), exitCode: 3 };
        const journal = JSON.parse(readFileSync(path, "utf8"));
        return Date.now() < journal.readyAt
          ? { ...ok(), exitCode: 3 }
          : ok(JSON.stringify(journal.payload));
      }
      throw new Error(`unexpected command: ${cmd.slice(0, 40)}`);
    },
    async writeFile(path: string, contents: string) {
      writeFileSync(join(boxDir(state), key(path)), contents);
    },
    async readFile() {
      return "";
    },
    async stop() {
      rmSync(boxDir(state), { recursive: true, force: true });
    },
  });
  const provider: SandboxProvider = {
    backendId: options.backendId,
    ...(options.maxRunMs === undefined ? {} : { maxRunMs: options.maxRunMs }),
    unavailableReason: () => null,
    async create() {
      counters.create++;
      if (options.createMs) await new Promise((done) => setTimeout(done, options.createMs));
      const state: SandboxSessionState = {
        version: 1,
        backendId: options.backendId,
        providerState: {
          sandboxId: randomUUID(),
          ...(options.template ? { template: options.template } : {}),
        },
        workdir: "/workspace",
        environment: {},
      };
      mkdirSync(boxDir(state), { recursive: true });
      return session(state);
    },
    async resume(state) {
      counters.resume++;
      if (!existsSync(boxDir(state))) throw new SandboxMissingError("gone");
      return session(state);
    },
    ...(options.pause
      ? {
          async pause() {
            counters.pause++;
            await options.onPause?.();
            if (options.pause === "fail") throw new Error("pause request failed");
          },
        }
      : {}),
    async delete(state) {
      counters.delete++;
      rmSync(boxDir(state), { recursive: true, force: true });
    },
  };
  /** Simulates the provider losing every sandbox, e.g. an expired lifetime. */
  const loseAll = () => rmSync(options.root, { recursive: true, force: true });
  return { provider, counters, loseAll };
}

/** A legacy-engine executor that runs `count` native commands, committing each like a bash tool. */
export function nativeExecutor(count: number): RunExecutor {
  return async (run, signal) => {
    if (!run.nativeBash) throw new Error("Native runner missing");
    let files = run.files;
    let metadata = run.workspaceMetadata;
    for (let index = 0; index < count; index++) {
      const id = `${run.id}-${index}`;
      const native = await run.nativeBash(id, "node -v", files, metadata, signal, 10_000);
      await run.persistence.commitTool(
        [{ type: "tool.result", payload: { id, name: "bash", content: [], is_error: false } }],
        native.files,
        native.metadata,
      );
      files = native.files;
      metadata = native.metadata;
    }
    return { files, costUsd: 0, events: [], stopReason: "stop" };
  };
}
