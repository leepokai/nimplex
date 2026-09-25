import { createHash } from "node:crypto";
import { workspaceMetadata } from "@nimplex/contracts";
import {
  checkWorkspaceLimits,
  type ExecResult,
  type ExecutorEvent,
  type ExecutorRunContext,
  isSandboxSessionState,
  SandboxMissingError,
  type SandboxProvider,
  type SandboxSession,
  type SandboxSessionState,
  shellQuote,
} from "@nimplex/core";
import { z } from "zod";
import type { SandboxTransition } from "./sandbox-usage.ts";

// The supervisor survives the worker connection. Its journal lets another worker collect a
// finished command without executing it twice. All journals and outputs are untrusted data.
const supervisor = `
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const [inputPath, job] = process.argv.slice(1);
try { fs.mkdirSync(job); } catch (error) { if (error.code === 'EEXIST') process.exit(0); throw error; }
const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
const root = '/workspace';
const maxBytes = 32 * 1024 * 1024;
const maxOutput = 1024 * 1024;
function publish(value) { fs.writeFileSync(job + '/result.tmp', JSON.stringify(value)); fs.renameSync(job + '/result.tmp', job + '/result.json'); }
function snapshot() {
  const files = {}, metadata = {}; let bytes = 0, count = 0;
  function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      if (name === 'node_modules') continue;
      const p = path.join(dir, name), st = fs.lstatSync(p);
      if (st.isSymbolicLink()) {
        if (++count > 2000) throw new Error('workspace_too_large');
        const target = fs.readlinkSync(p), resolved = path.resolve(path.dirname(p), target);
        if (resolved !== root && !resolved.startsWith(root + '/')) throw new Error('symlink escapes workspace: ' + p);
        metadata[p] = {kind: 'symlink', target, mode: st.mode & 4095};
        continue;
      }
      if (st.isDirectory()) { if (++count > 2000) throw new Error('workspace_too_large'); metadata[p] = {kind: 'directory', mode: st.mode & 4095}; walk(p); }
      else if (st.isFile()) {
        metadata[p] = {kind: 'file', mode: st.mode & 4095};
        bytes += st.size; count++;
        if (bytes > maxBytes || count > 2000) throw new Error('workspace_too_large');
        files[p] = fs.readFileSync(p).toString('base64');
      } else throw new Error('unsupported workspace entry: ' + p);
    }
  }
  walk(root);
  if (bytes + Buffer.byteLength(JSON.stringify(metadata)) > maxBytes) throw new Error('workspace_too_large');
  return {files, metadata};
}
try {
  fs.writeFileSync(job + '/pid', String(process.pid));
  fs.mkdirSync(root, {recursive: true});
  for (const name of fs.readdirSync(root)) if (name !== 'node_modules') fs.rmSync(path.join(root, name), {recursive: true, force: true});
  for (const [p, content] of Object.entries(input.files)) {
    if (!p.startsWith(root + '/') || path.normalize(p) !== p) throw new Error('invalid workspace path');
    fs.mkdirSync(path.dirname(p), {recursive: true}); fs.writeFileSync(p, Buffer.from(content, 'base64'));
  }
  for (const [p, entry] of Object.entries(input.metadata)) {
    if (!p.startsWith(root + '/') || path.normalize(p) !== p) throw new Error('invalid workspace metadata path');
    if (entry.kind === 'directory') fs.mkdirSync(p, {recursive: true});
    if (entry.kind === 'symlink') {
      const resolved = path.resolve(path.dirname(p), entry.target);
      if (resolved !== root && !resolved.startsWith(root + '/')) throw new Error('symlink escapes workspace');
      fs.mkdirSync(path.dirname(p), {recursive: true}); fs.symlinkSync(entry.target, p);
    } else fs.chmodSync(p, entry.mode);
  }
  const started = Date.now(); let stdout = '', stderr = '', timedOut = false;
  const child = spawn('/bin/bash', ['-c', input.command], {cwd: root, detached: true,
    env: {PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8'}});
  const collect = (old, chunk) => (old + chunk.toString()).slice(0, maxOutput);
  child.stdout.on('data', (chunk) => { stdout = collect(stdout, chunk); });
  child.stderr.on('data', (chunk) => { stderr = collect(stderr, chunk); });
  const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, input.timeoutMs);
  child.on('error', (error) => { clearTimeout(timer); publish({error: String(error)}); });
  child.on('close', (code) => {
    clearTimeout(timer);
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    try { publish({result: {exitCode: code, stdout, stderr, timedOut, wallTimeSeconds: (Date.now()-started)/1000}, ...snapshot()}); }
    catch (error) { publish({error: String(error)}); }
  });
} catch (error) { publish({error: String(error)}); }
`;

// Bound remote input before it enters the worker. The command can alter its own journal,
// including replacing it with a huge file or a FIFO; never trust the supervisor's limits alone.
const readJournal = `
const fs = require('node:fs');
let fd;
try { fd = fs.openSync(process.argv[1], fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
catch (error) { if (error.code === 'ENOENT') process.exit(3); throw error; }
const stat = fs.fstatSync(fd);
if (!stat.isFile() || stat.size > 64 * 1024 * 1024) { console.error('invalid or oversized sandbox journal'); process.exit(4); }
const bytes = Buffer.alloc(stat.size);
let offset = 0;
while (offset < bytes.length) { const n = fs.readSync(fd, bytes, offset, bytes.length - offset, offset); if (!n) break; offset += n; }
fs.closeSync(fd);
process.stdout.write(bytes.subarray(0, offset));
`;

const journalResult = z.object({
  result: z.object({
    exitCode: z.number().int().nullable(),
    stdout: z.string().max(1024 * 1024),
    stderr: z.string().max(1024 * 1024),
    timedOut: z.boolean(),
    wallTimeSeconds: z.number().nonnegative(),
  }),
  files: z.record(z.string(), z.string()),
  metadata: workspaceMetadata,
});

export interface NativeHost {
  id: string;
  sandbox: { provider: string; image?: string; cpu?: number; memory_mb?: number };
  sandboxState: unknown;
  provider: SandboxProvider;
  assertActive(): Promise<void>;
  /** Records a newly created sandbox; `startedAt` is when creation began. */
  recordState(state: SandboxSessionState, reset: boolean, startedAt: Date): Promise<void>;
  /**
   * Usage metering follows provider transitions and must be recorded even when the turn
   * is no longer active: a sandbox that paused stops costing whether or not the turn
   * survives. Never gate it on assertActive(). `at` is when the provider call began, so
   * resume latency is metered like creation.
   */
  sandboxTransition(transition: SandboxTransition, at?: Date): Promise<void>;
  /**
   * Meters a created sandbox that the turn could not record because it ended meanwhile.
   * `stopped` is false when stopping it failed, so it may still be running.
   */
  sandboxDiscarded(state: SandboxSessionState, startedAt: Date, stopped: boolean): Promise<void>;
  readEvents(): Promise<ExecutorEvent[]>;
  appendEvents(events: ExecutorEvent[]): Promise<void>;
  generation(): Promise<number>;
  shouldDestroyOnAbort(): Promise<boolean>;
}

/** Native dispatch is shared; the host supplies ownership and durable state boundaries. */
export function createNativeBash(host: NativeHost): NonNullable<ExecutorRunContext["nativeBash"]> {
  const run = host;
  let state = isSandboxSessionState(host.sandboxState) ? host.sandboxState : null;
  let session: SandboxSession | null = null;
  const provider = host.provider;
  async function recordState(next: SandboxSessionState, reset: boolean, startedAt: Date) {
    await host.recordState(next, reset, startedAt);
    state = next;
  }
  // An idle sandbox is paused so it stops billing, after every command that reached a
  // running sandbox, including failed ones.
  async function pauseIdle() {
    if (!provider.pause || session === null) return undefined;
    const target = session;
    // A failed response may still have paused the box. Reconnect before the next tool,
    // and keep metering it as running but uncertain until an observed transition.
    session = null;
    let paused = true;
    try {
      await provider.pause(target.state);
    } catch (error) {
      paused = false;
      console.warn(`[worker] sandbox pause failed for run ${run.id}`, error);
    }
    await host.sandboxTransition(paused ? "paused" : "unobserved");
    return paused;
  }

  return async (id, command, files, metadata, signal, timeoutMs) => {
    signal.throwIfAborted();
    if (run.sandbox.provider === "local")
      throw new Error("native commands require a configured isolated sandbox (docker or e2b)");
    const unavailable = await provider.unavailableReason();
    if (unavailable) throw new Error(unavailable);
    const hadState = state !== null;
    let active: SandboxSession | null = null;
    try {
      if (!session && state) {
        const resumedAt = new Date();
        try {
          session = await provider.resume(state);
        } catch (error) {
          if (!(error instanceof SandboxMissingError)) throw error;
          session = null;
          await host.sandboxTransition("missing");
        }
        if (session) {
          await host.sandboxTransition("running", resumedAt);
          await host.appendEvents([
            { type: "sandbox.resumed", payload: { provider: provider.backendId } },
          ]);
        }
      }
      if (!session) {
        const startedAt = new Date();
        const created = await provider.create({
          label: `nimplex-${run.id}`,
          image: run.sandbox.image,
          cpu: run.sandbox.cpu,
          memoryMb: run.sandbox.memory_mb,
          workdir: "/workspace",
          environment: {},
        });
        try {
          await recordState(created.state, hadState, startedAt);
        } catch (error) {
          const stopped = await created.stop().then(
            () => true,
            (cleanupError) => {
              console.error(
                `[worker] unrecorded sandbox cleanup failed for run ${run.id}`,
                created.state.providerState,
                cleanupError,
              );
              return false;
            },
          );
          await host.sandboxDiscarded(created.state, startedAt, stopped);
          throw error;
        }
        session = created;
        const history = await host.readEvents();
        const dispatched = history.some(
          (event) =>
            event.type === "tier.escalated" &&
            (event.payload as { tool_call_id?: string } | null)?.tool_call_id === id,
        );
        if (dispatched)
          throw new Error(
            "environment.reset: previous command outcome is unknown because its sandbox was lost; do not blindly repeat external side effects",
          );
      }
      let current: SandboxSession = session;
      active = current;
      const reconnect = async () => {
        await host.assertActive();
        signal.throwIfAborted();
        const resumedAt = new Date();
        try {
          current = await provider.resume(current.state);
        } catch (error) {
          // The sandbox vanished mid-command: stop its meter before reporting the loss.
          if (error instanceof SandboxMissingError) {
            session = null;
            await host.sandboxTransition("missing");
          }
          throw error;
        }
        session = active = current;
        await host.sandboxTransition("running", resumedAt);
      };
      const runtimeDirectory = `/tmp/nimplex-runtime-${run.id}`;
      const directory = await current.exec({
        cmd: `mkdir -p ${shellQuote(runtimeDirectory)}`,
        timeoutMs: 10000,
        signal,
      });
      if (directory.exitCode !== 0) throw new Error("cannot create sandbox runtime directory");
      const job = `${runtimeDirectory}/${createHash("sha256").update(`${run.id}:${id}`).digest("hex")}`;
      await host.appendEvents([
        {
          type: "tier.escalated",
          payload: {
            tool_call_id: id,
            provider: provider.backendId,
            generation: await host.generation(),
          },
        },
      ]);
      const inputPath = `${job}.input.json`;
      const serialized = JSON.stringify({
        command,
        timeoutMs,
        metadata,
        files: Object.fromEntries(
          Object.entries(files).map(([path, bytes]) => [
            path,
            Buffer.from(bytes).toString("base64"),
          ]),
        ),
      });
      await current.writeFile(inputPath, serialized);
      // The supervisor acquires its own once-only marker. Repeated launches exit without replay.
      const launchArgs = {
        cmd: `nohup node -e ${shellQuote(supervisor)} ${shellQuote(inputPath)} ${shellQuote(job)} > ${shellQuote(`${job}.log`)} 2>&1 < /dev/null &`,
        timeoutMs: 10000,
        signal,
      };
      let launch: ExecResult;
      try {
        launch = await current.exec(launchArgs);
      } catch (error) {
        if (!provider.pause) throw error;
        await reconnect();
        launch = await current.exec(launchArgs);
      }
      if (launch.timedOut && provider.pause) {
        await reconnect();
        launch = await current.exec(launchArgs);
      }
      if (launch.exitCode !== 0) throw new Error(`sandbox dispatch failed: ${launch.stderr}`);
      const deadline = Date.now() + timeoutMs + 15000;
      while (Date.now() < deadline) {
        signal.throwIfAborted();
        let journal: ExecResult;
        try {
          journal = await current.exec({
            cmd: `node -e ${shellQuote(readJournal)} ${shellQuote(`${job}/result.json`)}`,
            timeoutMs: 10000,
            signal,
          });
        } catch (error) {
          signal.throwIfAborted();
          if (!provider.pause) throw error;
          // A pause requested by the previous owner may finish after takeover. Reconnect to
          // resume the same journal; never turn a transient read failure into command replay.
          await reconnect();
          continue;
        }
        signal.throwIfAborted();
        if (journal.timedOut && provider.pause) {
          await reconnect();
          continue;
        }
        if (journal.exitCode !== 0 && journal.exitCode !== 3)
          throw new Error(`sandbox journal read failed: ${journal.stderr}`);
        const raw = journal.exitCode === 0 ? journal.stdout : undefined;
        if (raw) {
          const decoded: unknown = JSON.parse(raw);
          const failure = z.object({ error: z.string() }).safeParse(decoded);
          if (failure.success) throw new Error(failure.data.error.slice(0, 12000));
          const payload = journalResult.parse(decoded);
          const after = Object.fromEntries(
            Object.entries(payload.files).map(([path, content]) => {
              if (!path.startsWith("/workspace/") || path.split("/").includes(".."))
                throw new Error("invalid sandbox workspace path");
              return [path, new Uint8Array(Buffer.from(content, "base64"))];
            }),
          );
          const restoredMetadata = payload.metadata;
          const exceeded = checkWorkspaceLimits(after, restoredMetadata);
          if (exceeded) throw new Error(exceeded);
          if (provider.pause) {
            await host.assertActive();
            // Provider IO must never hold run locks: kill/cancel stay responsive during outages.
            const paused = await pauseIdle();
            await host.appendEvents([
              {
                type: paused ? "sandbox.paused" : "sandbox.pause_failed",
                payload: { provider: provider.backendId },
              },
            ]);
          }
          return { result: payload.result, files: after, metadata: restoredMetadata };
        }
        await new Promise((done) => setTimeout(done, 200));
      }
      throw new Error("sandbox command outcome unknown; journal did not complete");
    } catch (error) {
      // A failed command must not leave a pausable sandbox running and billing.
      if (!signal.aborted)
        await pauseIdle().catch((pauseError) =>
          console.error(
            `[worker] sandbox pause after failure failed for run ${run.id}`,
            pauseError,
          ),
        );
      throw error;
    } finally {
      if (signal.aborted && active) {
        try {
          // The owner decides whether cancellation authorizes environment deletion.
          if (await host.shouldDestroyOnAbort()) {
            await provider.delete(active.state);
            session = null;
            await host.sandboxTransition("deleted");
          }
        } catch (error) {
          // The terminal reaper retries cleanup without replacing the original abort reason.
          console.error(`[worker] sandbox abort cleanup failed for run ${run.id}`, error);
        }
      }
    }
  };
}
