import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  type CancelQueuedInputResponse,
  type ModelProvider,
  type QueueInputRequest,
  type QueueInputResponse,
  queueInputRequest,
  type RunEvent,
  type RunFileEntry,
  type SandboxUsageRecord,
  type SandboxUsageSummary,
  type SessionSnapshot,
  type StartTurnRequest,
  type StartTurnResponse,
  startTurnRequest,
} from "@nimplex/contracts";
import {
  type ExecutorEvent,
  type ExecutorRunContext,
  isTerminal,
  type RunExecutor,
} from "@nimplex/core";
import { getSandboxProvider, listSandboxProviders } from "@nimplex/sandbox";
import { createCheckpoints } from "./checkpoints.ts";
import { piModels, resolveLocalModel } from "./models.ts";
import { createNativeBash } from "./native-bash.ts";
import { piExecutor } from "./pi-executor.ts";
import {
  describePiExtensions,
  type LoadedPiExtensions,
  loadPiExtensions,
  type PiExtensionSummary,
} from "./pi-extensions/bridge.ts";
import { type HarnessTurnControls, runHarnessTurn } from "./pi-harness-engine.ts";
import { localHarnessHost } from "./pi-harness-local-host.ts";
import {
  inheritSandboxUsage,
  recordDiscardedSandbox,
  recordSandboxTransition,
  sandboxUsageSummary,
  settleSandboxUsage,
  startSandboxUsage,
} from "./sandbox-usage.ts";
import { publicEvents, Sessions } from "./sessions.ts";
import { RuntimeStore, type SessionEngine, type StoredSession, type StoredTurn } from "./store.ts";

export interface RuntimeOptions {
  directory: string;
  credential: (
    provider: ModelProvider,
    signal?: AbortSignal,
  ) => ExecutorRunContext["credential"] | Promise<ExecutorRunContext["credential"]>;
  /** Engine for sessions created by this runtime; existing sessions keep their own. */
  engine?: SessionEngine;
  /** Replaces the legacy `pi-executor` loop; injectable only at composition time, for deterministic tests. */
  executor?: RunExecutor;
  /** Test seam: awaited after each harness-engine commit before execution continues. */
  afterCommit?: (turnId: string, events: ExecutorEvent[]) => Promise<void> | void;
  /**
   * Pi extensions for harness sessions. User extensions under `<agentDir>/extensions`
   * always load; `<cwd>/.pi/extensions` executes only when `projectTrusted(cwd)` says so.
   * Absent means no extension code runs.
   */
  extensions?: { agentDir: string; projectTrusted: (cwd: string) => boolean };
}

/** Session execution authority. Product surfaces issue commands and observe committed events. */
export class NimplexRuntime {
  private readonly store: RuntimeStore;
  private readonly active = new Map<
    string,
    { id: string; abort: AbortController; done: Promise<void>; controls?: HarnessTurnControls }
  >();
  private readonly listeners = new Set<() => void>();
  private readonly loadedExtensions = new Map<string, Promise<LoadedPiExtensions>>();
  private closing = false;
  private closePromise?: Promise<void>;
  constructor(private readonly options: RuntimeOptions) {
    // An injected executor replaces only the legacy loop; with the harness default it
    // would be silently bypassed by real provider calls.
    if (options.executor && options.engine !== "pi-executor")
      throw new Error('An injected executor requires engine: "pi-executor".');
    this.store = new RuntimeStore(options.directory);
    this.sessions = new Sessions(this.store);
    // Recovery never silently spends money. The user explicitly resumes interrupted turns.
    this.store.transaction(() => {
      for (const turn of this.store.turns()) {
        if (isTerminal(turn.result.status)) continue;
        turn.result.status = "failed";
        turn.result.error = "runtime_interrupted";
        turn.result.completed_at = new Date().toISOString();
        this.store.saveTurn(turn);
        this.store.append(turn.result.id, [
          { type: "run.interrupted", payload: { reason: "runtime_interrupted", resumable: true } },
        ]);
      }
      // No runtime watched a sandbox that was left running while it was down.
      for (const session of this.store.sessionsWithOpenSandboxInterval())
        inheritSandboxUsage(this.store, session);
    });
  }
  private assertOpen() {
    if (this.closing) throw new Error("Runtime is closing.");
  }
  private notify = () => {
    for (const listener of this.listeners) listener();
  };
  private readonly sessions: Sessions;
  createSession(cwd: string, title?: string): SessionSnapshot {
    this.assertOpen();
    return this.sessions.createSession(cwd, title, this.options.engine ?? "pi-harness");
  }
  /** Settled estimated sandbox cost and any running interval; a single-record read. */
  sandboxUsage(sessionId: string): SandboxUsageSummary | undefined {
    return sandboxUsageSummary(this.store.session(sessionId));
  }
  /** The session's settled sandbox intervals, oldest first. */
  sandboxUsageRecords(sessionId: string): SandboxUsageRecord[] {
    return this.store.sandboxUsage(sessionId);
  }
  getSession(id: string): SessionSnapshot {
    return this.sessions.getSession(id);
  }
  listSessions(): SessionSnapshot[] {
    return this.sessions.listSessions();
  }
  renameSession(id: string, title: string) {
    this.assertOpen();
    this.sessions.renameSession(id, title);
  }
  forkSession(id: string, turnId?: string): SessionSnapshot {
    this.assertOpen();
    return this.sessions.forkSession(id, turnId);
  }
  async startTurn(sessionId: string, input: StartTurnRequest): Promise<StartTurnResponse> {
    this.assertOpen();
    const request = startTurnRequest.parse(input);
    if (request.requestId) {
      const accepted = this.store.acceptedInput(sessionId, request.requestId);
      if (accepted) {
        if (JSON.stringify(accepted.request) !== JSON.stringify(request))
          throw new Error("Request ID was already accepted with different content.");
        // A retry observes acceptance; it never resumes or dispatches the turn again.
        return { runId: accepted.turnId, requestId: accepted.requestId };
      }
    }
    if (this.active.has(sessionId)) throw new Error("This session already has an active turn.");
    resolveLocalModel(request.model);
    request.requestId ??= randomUUID();
    const turn = this.sessions.seedTurn(sessionId, request);
    this.launch(turn);
    return { runId: turn.result.id, requestId: request.requestId };
  }
  /** Queue durable in-flight input for the session's active harness turn. */
  async queueInput(sessionId: string, input: QueueInputRequest): Promise<QueueInputResponse> {
    this.assertOpen();
    const request = queueInputRequest.parse(input);
    const task = this.active.get(sessionId);
    if (!task) throw new Error("This session has no active turn to steer.");
    if (!task.controls)
      throw new Error("In-flight input requires a Pi harness session with a running turn.");
    return task.controls.queue(request.kind, request.text);
  }
  /** Cancel queued input that the active harness turn has not consumed yet. */
  async cancelQueuedInput(sessionId: string, entryId: string): Promise<CancelQueuedInputResponse> {
    this.assertOpen();
    const task = this.active.get(sessionId);
    if (!task?.controls)
      throw new Error("In-flight input requires a Pi harness session with a running turn.");
    return task.controls.cancel(entryId);
  }
  async resumeTurn(sessionId: string): Promise<{ runId: string }> {
    this.assertOpen();
    if (this.active.has(sessionId)) throw new Error("This session already has an active turn.");
    const id = this.store.session(sessionId).turnIds.at(-1);
    if (!id) throw new Error("No interrupted turn to resume.");
    const turn = this.store.turn(id);
    if (turn.sessionId !== sessionId || turn.result.error !== "runtime_interrupted")
      throw new Error("Only an interrupted turn owned by this session can be resumed.");
    this.store.transaction(() => {
      turn.result.status = "running";
      turn.result.error = null;
      turn.result.completed_at = null;
      this.store.saveTurn(turn);
      this.store.append(id, [{ type: "run.resumed", payload: { session_id: sessionId } }]);
    });
    this.launch(turn);
    return { runId: id };
  }
  private launch(turn: StoredTurn) {
    const abort = new AbortController();
    // Register ownership before execution starts, including synchronous/reentrant callers.
    const done = Promise.resolve()
      .then(() => this.execute(turn, abort))
      .finally(() => {
        this.active.delete(turn.sessionId);
        this.notify();
      });
    this.active.set(turn.sessionId, { id: turn.result.id, abort, done });
    this.notify();
  }
  private async execute(turn: StoredTurn, abort: AbortController) {
    const id = turn.result.id;
    const timer = setTimeout(
      () => abort.abort(new Error("duration_exceeded")),
      turn.request.timeout * 1000,
    );
    const session = this.store.session(turn.sessionId);
    const persistence = createCheckpoints(this.store, id, this.notify);
    const assertActive = async () => {
      abort.signal.throwIfAborted();
      if (this.store.turn(id).result.status !== "running")
        throw new Error("Turn is no longer running.");
    };
    const sandboxProvider = getSandboxProvider(turn.request.sandbox);
    const nativeBash = createNativeBash({
      id,
      sandbox: turn.result.sandbox,
      sandboxState: session.sandboxState,
      provider: sandboxProvider,
      assertActive,
      readEvents: async () => this.store.events(id),
      generation: async () => this.store.session(turn.sessionId).sandboxGeneration,
      appendEvents: async (events) => {
        await assertActive();
        this.store.transaction(() => this.store.append(id, events));
        this.notify();
      },
      sandboxDiscarded: async (state, startedAt, stopped) => {
        this.store.transaction(() =>
          recordDiscardedSandbox(this.store, turn.sessionId, {
            provider: turn.request.sandbox,
            state,
            startedAt,
            stopped,
            turnId: id,
            maxRunMs: sandboxProvider.maxRunMs,
          }),
        );
        this.notify();
      },
      sandboxTransition: async (transition, at) => {
        this.store.transaction(() =>
          recordSandboxTransition(this.store, turn.sessionId, transition, {
            turnId: id,
            at,
            maxRunMs: sandboxProvider.maxRunMs,
          }),
        );
        this.notify();
      },
      recordState: async (state, reset, startedAt) => {
        await assertActive();
        this.store.transaction(() => {
          const current = this.store.session(turn.sessionId);
          current.sandboxState = state;
          current.sandboxProvider = turn.request.sandbox;
          current.sandboxGeneration++;
          this.store.saveSession(current);
          startSandboxUsage(this.store, turn.sessionId, startedAt, sandboxProvider.maxRunMs);
          const live = this.store.turn(id);
          live.result.sandbox_generation = current.sandboxGeneration;
          live.result.sandbox_ref = String(
            state.providerState.sandboxId ?? state.providerState.containerId ?? "",
          );
          this.store.saveTurn(live);
          this.store.append(id, [
            {
              type: "sandbox.created",
              payload: { provider: turn.request.sandbox, generation: current.sandboxGeneration },
            },
            ...(reset || current.sandboxGeneration > 1
              ? [{ type: "environment.reset", payload: { generation: current.sandboxGeneration } }]
              : []),
          ]);
        });
        this.notify();
      },
      // Preserve the journal until the runtime settles the turn and explicitly cleans up.
      shouldDestroyOnAbort: async () => false,
    });
    try {
      if (session.engine === "pi-harness") {
        await assertActive();
        const credential = await this.options.credential(turn.result.model.provider, abort.signal);
        if (
          credential.billingMode === "subscription" &&
          turn.result.billing_mode !== "subscription"
        ) {
          this.store.transaction(() => {
            const current = this.store.turn(id);
            if (current.result.status !== "running")
              throw new Error(`turn is ${current.result.status}`);
            current.result.billing_mode = "subscription";
            this.store.saveTurn(current);
          });
          turn.result.billing_mode = "subscription";
        }
        const extensions = await this.extensionsFor(session.cwd);
        await assertActive();
        const outcome = await runHarnessTurn(
          localHarnessHost({
            store: this.store,
            turn,
            credential,
            extensions,
            nativeBash,
            signal: abort.signal,
            notify: this.notify,
            onControls: (controls) => {
              const task = this.active.get(turn.sessionId);
              if (task?.id === id) task.controls = controls;
            },
            afterCommit: this.options.afterCommit
              ? (events) => this.options.afterCommit?.(id, events)
              : undefined,
          }),
        );
        // A cancel or timer landing after Pi settled the turn must not reclassify it.
        if (outcome.status !== "completed") abort.signal.throwIfAborted();
        this.finish(id, outcome.status, outcome.status === "completed" ? null : outcome.error);
      } else {
        for (;;) {
          await assertActive();
          const credential = await this.options.credential(
            turn.result.model.provider,
            abort.signal,
          );
          await assertActive();
          const workspace = this.store.workspace(id);
          const result = await (this.options.executor ?? piExecutor)(
            {
              id,
              modelProvider: turn.result.model.provider,
              model: turn.result.model.id,
              config: turn.config,
              events: this.store.events(id),
              files: workspace.files,
              workspaceMetadata: workspace.metadata,
              credential,
              persistence,
              nativeBash,
            },
            abort.signal,
          );
          if (result.stopReason !== "stop") abort.signal.throwIfAborted();
          if (result.stopReason === "toolUse" || result.stopReason === "length") continue;
          this.finish(
            id,
            result.stopReason === "stop" ? "completed" : "failed",
            result.errorMessage ?? (result.stopReason === "stop" ? null : result.stopReason),
          );
          break;
        }
      }
    } catch (error) {
      const reason = abort.signal.aborted
        ? String(abort.signal.reason?.message ?? "canceled")
        : error instanceof Error
          ? error.message
          : String(error);
      this.finish(
        id,
        reason === "canceled" ? "canceled" : reason === "duration_exceeded" ? "killed" : "failed",
        reason,
      );
      if (abort.signal.aborted && reason !== "runtime_interrupted")
        await this.cleanupSandbox(turn.sessionId);
    } finally {
      clearTimeout(timer);
      this.notify();
    }
  }
  private finish(
    id: string,
    status: "completed" | "failed" | "killed" | "canceled",
    error: string | null,
  ) {
    this.store.transaction(() => {
      const turn = this.store.turn(id);
      if (isTerminal(turn.result.status)) return;
      turn.result.status = status;
      turn.result.error = error;
      turn.result.completed_at = new Date().toISOString();
      this.store.saveTurn(turn);
      this.store.append(id, [{ type: `run.${status}`, payload: { reason: error } }]);
    });
    this.notify();
  }
  private async cleanupSandbox(sessionId: string) {
    const session = this.store.session(sessionId);
    if (!session.sandboxState || !session.sandboxProvider) return;
    try {
      await getSandboxProvider(session.sandboxProvider).delete(session.sandboxState);
      this.store.transaction(() => {
        settleSandboxUsage(this.store, sessionId, "deleted");
        const s = this.store.session(sessionId);
        delete s.sandboxState;
        this.store.saveSession(s);
      });
    } catch (error) {
      // Keep the handle durable so the next owner can retry cleanup.
      console.error(`Sandbox cleanup failed for session ${sessionId}:`, error);
    }
  }
  async stopTurn(id: string) {
    const task = [...this.active.values()].find((task) => task.id === id);
    if (task) {
      task.abort.abort(new Error("canceled"));
      await task.done;
    }
    return this.store.turn(id).result;
  }
  getTurn(id: string) {
    return this.store.turn(id).result;
  }
  listTurns(limit = 20) {
    return this.store
      .turns()
      .sort((a, b) => b.result.created_at.localeCompare(a.result.created_at))
      .slice(0, limit)
      .map((t) => t.result);
  }
  async *events(
    id: string,
    options: { after?: number; signal?: AbortSignal } = {},
  ): AsyncGenerator<RunEvent> {
    let after = options.after ?? -1;
    let wake: (() => void) | undefined;
    const notify = () => wake?.();
    this.listeners.add(notify);
    options.signal?.addEventListener("abort", notify);
    try {
      for (;;) {
        if (options.signal?.aborted) return;
        const waiting = new Promise<void>((resolve) => {
          wake = resolve;
        });
        for (const event of publicEvents(this.store, id, after)) {
          after = event.seq;
          yield event;
        }
        const active = [...this.active.values()].some((task) => task.id === id);
        if (!active && isTerminal(this.getTurn(id).status)) return;
        if (this.closing || options.signal?.aborted) return;
        await waiting;
      }
    } finally {
      this.listeners.delete(notify);
      options.signal?.removeEventListener("abort", notify);
    }
  }
  files(id: string): RunFileEntry[] {
    const { files, metadata } = this.store.workspace(id);
    return [...new Set([...Object.keys(files), ...Object.keys(metadata)])].sort().map((path) => ({
      path,
      bytes: files[path]?.byteLength ?? 0,
      updated_at: this.getTurn(id).completed_at ?? this.getTurn(id).created_at,
      ...metadata[path],
    }));
  }
  readFile(id: string, path: string): Uint8Array {
    const bytes = this.store.workspace(id).files[path];
    if (!bytes) throw new Error(`File not found: ${path}`);
    return bytes;
  }
  /** Loaded Pi extensions for a project directory; a load error fails the turn that needs them. */
  private extensionsFor(cwd: string): Promise<LoadedPiExtensions | undefined> {
    const sources = this.options.extensions;
    if (!sources) return Promise.resolve(undefined);
    const projectTrusted = sources.projectTrusted(cwd);
    const key = `${projectTrusted ? "trusted" : "untrusted"}:${cwd}`;
    let loading = this.loadedExtensions.get(key);
    if (!loading) {
      loading = loadPiExtensions({
        cwd,
        agentDir: sources.agentDir,
        projectTrusted,
        authPath: join(this.options.directory, "pi-extension-auth.json"),
      }).then((loaded) => {
        if (loaded.result.errors.length)
          throw new Error(
            `Pi extensions failed to load: ${loaded.result.errors
              .map((error) => `${error.path}: ${error.error}`)
              .join("; ")}`,
          );
        return loaded;
      });
      this.loadedExtensions.set(key, loading);
      loading.catch(() => this.loadedExtensions.delete(key));
    }
    return loading;
  }
  /** Describe the extensions a harness turn in `cwd` would run, including load errors. */
  async extensions(cwd: string): Promise<PiExtensionSummary | undefined> {
    const sources = this.options.extensions;
    if (!sources) return undefined;
    try {
      const loaded = await this.extensionsFor(cwd);
      return loaded ? describePiExtensions(loaded) : undefined;
    } catch (error) {
      return {
        projectTrusted: sources.projectTrusted(cwd),
        extensions: [],
        errors: [{ path: cwd, error: error instanceof Error ? error.message : String(error) }],
      };
    }
  }
  /** Drop loaded extension modules so the next harness turn reloads them from disk. */
  reloadExtensions() {
    this.loadedExtensions.clear();
  }
  models() {
    return piModels().map((model) => ({
      provider: model.provider,
      model: model.provider === "anthropic" ? model.id : `${model.provider}/${model.id}`,
      input_per_mtok: model.provider === "openai-codex" ? null : model.cost.input,
      output_per_mtok: model.provider === "openai-codex" ? null : model.cost.output,
      billing_mode:
        model.provider === "openai-codex" ? ("subscription" as const) : ("api" as const),
    }));
  }

  async sandboxProviders() {
    return Promise.all(
      listSandboxProviders()
        .filter((p) => ["docker", "e2b"].includes(p.backendId))
        .map((p) => this.sandboxStatus(p.backendId)),
    );
  }
  /** Probes one provider only; the Docker probe can take seconds when its daemon is down. */
  async sandboxStatus(id: string) {
    const reason = await getSandboxProvider(id).unavailableReason();
    return { id, available: !reason, reason };
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.notify();
    this.closePromise = Promise.resolve().then(async () => {
      const tasks = [...this.active.values()];
      for (const task of tasks) task.abort.abort(new Error("runtime_interrupted"));
      await Promise.all(tasks.map((task) => task.done));
      for (const session of this.store.sessions()) {
        // An untouched default session holds nothing worth listing or resuming.
        if (
          !session.turnIds.length &&
          !session.sandboxState &&
          session.title === "New conversation"
        ) {
          this.store.transaction(() => this.store.deleteSession(session.id));
          continue;
        }
        // An interrupted turn may still own a native command journal; keep its
        // environment so resume can reattach instead of reporting an unknown outcome.
        if (this.resumable(session)) continue;
        await this.cleanupSandbox(session.id);
      }
      this.store.close();
    });
    return this.closePromise;
  }
  private resumable(session: StoredSession) {
    const last = session.turnIds.at(-1);
    return last !== undefined && this.store.turn(last).result.error === "runtime_interrupted";
  }
}
