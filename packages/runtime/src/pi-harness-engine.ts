// Production adapter for Pi's public AgentHarness. Pi owns the model/tool loop and
// the session tree; the host owns the transaction that commits every Pi write together
// with its own events, accounting and workspace revision. The engine is storage
// agnostic: the local runtime supplies a SQLite host through the HarnessTurnHost port.
// Opt in per session; the default executor is unchanged.
import {
  AgentHarness,
  type AgentHarnessTool,
  type AgentLane,
  type AgentTool,
  DEFAULT_COMPACTION_SETTINGS,
  getOrThrow,
  HarnessFault,
  type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/pi-agent-core/harness/context";
import {
  type CommitResult,
  type InboxItem,
  type LaneState,
  type OperationState,
  operationMeta,
  operationState,
  type PendingEntry,
  type Storage,
  StorageBackedSession,
  type UsageRow,
  type Write,
} from "@earendil-works/pi-agent-core/harness/session";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import type { ModelAttempt, WorkspaceMetadata } from "@nimplex/contracts";
import { type ExecutorEvent, type ExecutorRunContext, WORKSPACE_MAX_BYTES } from "@nimplex/core";
import { Bash } from "just-bash";
import { buildPiModel, CODEX_BASE_URL } from "./models.ts";
import { archiveTool, systemPrompt, vfsTools, WORKSPACE } from "./pi-executor.ts";
import {
  activatePiExtensions,
  type LoadedPiExtensions,
  type PiExtensionActivation,
} from "./pi-extensions/bridge.ts";
import { durableModels } from "./pi-harness-models.ts";
import { piSummaryModels } from "./pi-summary-models.ts";
import { PI_LANE } from "./store.ts";
import { restoreWorkspace, snapshotWorkspace } from "./workspace.ts";

export { PI_LANE, PI_TENANT } from "./store.ts";

/** In-flight controls the host exposes while a harness turn owns its lane. */
export interface HarnessTurnControls {
  /** Durably queue steering or follow-up input; Pi delivers it at its next boundary. */
  queue(kind: "steer" | "followUp", text: string): Promise<{ entryId: string }>;
  /** Durably remove queued input that Pi has not consumed yet. */
  cancel(entryId: string): Promise<{ kind: "cancelled" | "already_consumed" | "not_found" }>;
}

/** The unit of work the engine drives: one Pi run operation on one Pi session lane. */
export interface HarnessTurn {
  /** Pi operation id; the host's turn or run id. */
  id: string;
  /** Pi session id: the local session whose turns share one tree. */
  sessionId: string;
  prompt: string;
  instructions: string;
  executionMode: "build" | "read_only";
  contextMode: "continue" | "reset" | "compact";
  thinkingLevel: ThinkingLevel;
  model: { provider: string; id: string };
  billing: "api" | "subscription";
}

/** One nimplex record derived from a Pi commit; applied inside the same transaction. */
export type HarnessCommitStep =
  | { kind: "events"; events: ExecutorEvent[] }
  | {
      kind: "settlement";
      attempt: ModelAttempt;
      events: ExecutorEvent[];
      costUsd: number;
      uncertain: boolean;
    }
  | {
      kind: "tool";
      events: ExecutorEvent[];
      files: Record<string, Uint8Array>;
      metadata: WorkspaceMetadata;
    };

/**
 * What a host supplies for one turn. `commit` must apply Pi's writes and the derived
 * steps atomically, in order, and must check execution ownership inside that
 * transaction. `startModel` commits before dispatch in its own transaction.
 */
export interface HarnessTurnHost {
  turn: HarnessTurn;
  /** Pi Storage for reads; the engine never calls its `commit`. */
  storage: Storage;
  commit(writes: Write[], steps: HarnessCommitStep[]): Promise<CommitResult>;
  /** Commit dispatch intent under execution ownership before contacting the provider. */
  startModel(extra: Record<string, unknown>): Promise<ModelAttempt>;
  readEvents(): Promise<ExecutorEvent[]>;
  workspace(): Promise<{ files: Record<string, Uint8Array>; metadata: WorkspaceMetadata }>;
  credential: ExecutorRunContext["credential"];
  nativeBash: ExecutorRunContext["nativeBash"];
  /** Host abort: cancellation, duration cap, shutdown or ownership loss. */
  signal: AbortSignal;
  /**
   * Whether an abort should detach from the operation and leave it resumable instead of
   * cancelling it durably. Defaults to shutdown (`runtime_interrupted`) only.
   */
  detachOnAbort?(reason: unknown): boolean;
  notify?(): void;
  /** Receives the lane's controls once the turn owns it; unavailable after the turn settles. */
  onControls?(controls: HarnessTurnControls): void;
  /** Loaded Pi extensions to bridge into this turn; absent means none run. */
  extensions?: LoadedPiExtensions;
  /** Test seam: awaited after each committed transaction, before execution continues. */
  afterCommit?(events: ExecutorEvent[]): Promise<void> | void;
}

export type HarnessTurnOutcome = { status: "completed" } | { status: "failed"; error: string };

interface EngineState {
  /** False while a predecessor operation is reconciled; its writes are not this turn's. */
  project: boolean;
  /** Pi operation ids this turn owns: its run plus any context operation it started. */
  owned: Set<string>;
  /** Pi usage id of the request whose intent was committed last. */
  pendingUsageId?: string;
  /** Committed attempts keyed by Pi usage id, restored from current or legacy intent events. */
  attempts: Map<string, ModelAttempt>;
  /** Committed assistant messages by entry id; needed to name tool intents. */
  assistants: Map<string, AssistantMessage>;
  /** Complete summary responses keyed by attempt, awaiting Pi's usage settlement. */
  structural: Map<string, AssistantMessage>;
  /** Last committed lane inbox, to describe queued and consumed input as events. */
  inbox: InboxItem[];
  /** Tool call ids whose intent is already recorded; Pi rewrites op.state on cancel. */
  started: Set<string>;
  denied?: unknown;
}

/** Context operations run under deterministic ids so recovery can tell them from other turns. */
export const contextOperationId = (turnId: string, kind: "reset" | "compact") =>
  `${turnId}:${kind}`;

/** Dispatch intent events carry the Pi usage id so a restart can settle them. */
export const PI_USAGE_ID = "pi_usage_id";

function restoreStartedTools(events: ExecutorEvent[]) {
  return new Set(
    events
      .filter((event) => event.type === "tool.started")
      .map((event) => (event.payload as { id: string }).id),
  );
}

function restoreAttempts(events: ExecutorEvent[]) {
  const attempts = new Map<string, ModelAttempt>();
  const settled = new Set<string>();
  for (const event of events)
    if (event.type === "spend.updated") settled.add((event.payload as { call_id: string }).call_id);
  for (const event of events) {
    if (event.type !== "model.started" && event.type !== "model.reserved") continue;
    const payload = event.payload as ModelAttempt & { [PI_USAGE_ID]?: string };
    const usageId = payload[PI_USAGE_ID];
    if (usageId && !settled.has(payload.call_id)) {
      const { [PI_USAGE_ID]: _usage, ...rest } = payload;
      attempts.set(usageId, {
        call_id: rest.call_id,
      });
    }
  }
  return attempts;
}

function settlement(
  message: AssistantMessage,
  attempt: ModelAttempt,
  turn: HarnessTurn,
  step: "assistant" | "summary",
): Extract<HarnessCommitStep, { kind: "settlement" }> {
  const uncertain = message.stopReason === "error" || message.stopReason === "aborted";
  const subscription = turn.billing === "subscription";
  const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  const cost = subscription
    ? { costUsd: 0, estimated: false }
    : { costUsd: message.usage.cost.total, estimated: true };
  const events: ExecutorEvent[] = [
    {
      type: uncertain ? "model.unknown" : "model.call",
      payload: {
        call_id: attempt.call_id,
        model: message.model,
        stop_reason: message.stopReason,
        usage: {
          input_tokens: message.usage.input,
          output_tokens: message.usage.output,
          cache_read_tokens: message.usage.cacheRead,
          cache_write_tokens: message.usage.cacheWrite,
        },
        cost_usd: cost.costUsd,
        billing_mode: subscription ? "subscription" : "api",
        estimated: cost.estimated,
        uncertain,
        step,
        message: subscription
          ? { ...message, usage: { ...message.usage, cost: zeroCost } }
          : message,
      },
    },
  ];
  // Summary text is context maintenance, not assistant output for the transcript.
  for (const block of uncertain || step === "summary" ? [] : message.content) {
    if (block.type === "text" && block.text)
      events.push({ type: "message.delta", payload: { text: block.text } });
    if (block.type === "toolCall")
      events.push({
        type: "tool.call",
        payload: { id: block.id, name: block.name, input: block.arguments },
      });
  }
  return { kind: "settlement", attempt, events, costUsd: cost.costUsd, uncertain };
}

/**
 * Derive the nimplex records implied by one Pi commit: attempt settlements, tool
 * results with their workspace revision, tool intents, inbox changes and compaction.
 * Pure apart from the engine's in-memory bookkeeping; the host applies the steps.
 */
function planCommit(
  writes: Write[],
  snapshot: Awaited<ReturnType<typeof snapshotWorkspace>> | undefined,
  state: EngineState,
  turn: HarnessTurn,
): HarnessCommitStep[] {
  const steps: HarnessCommitStep[] = [];
  const assistantMessages = new Map<string, AssistantMessage>();
  for (const write of writes)
    if (
      write.kind === "entry" &&
      write.entry.type === "message" &&
      write.entry.message.role === "assistant"
    )
      assistantMessages.set(write.entry.id, write.entry.message);
  const settleUsage = (row: Omit<UsageRow, "seq">) => {
    const attempt = state.attempts.get(row.id);
    // Assistant usage names its entry; summary usage carries no entry and Pi keeps no
    // response, so the facade's captured response is the settlement record.
    const structural = row.entryId === undefined;
    const message = structural
      ? attempt && state.structural.get(attempt.call_id)
      : assistantMessages.get(row.entryId as string);
    if (!attempt) {
      // A request denied or failed before dispatch settles zero usage without an attempt.
      const failed = message?.stopReason === "error" || message?.stopReason === "aborted";
      if (row.usage.totalTokens === 0 && (structural || failed)) return;
      throw new Error("Pi usage has no matching nimplex attempt");
    }
    if (!message) throw new Error("Pi usage settled without its response");
    state.attempts.delete(row.id);
    if (structural) state.structural.delete(attempt.call_id);
    else state.assistants.set(row.entryId as string, message);
    steps.push(settlement(message, attempt, turn, structural ? "summary" : "assistant"));
  };
  for (const write of writes) {
    if (write.kind === "usage") settleUsage(write.row);
    if (write.kind === "entry" && write.entry.type === "compaction")
      steps.push({
        kind: "events",
        events: [
          {
            type: "context.compacted",
            payload: {
              entry_id: write.entry.id,
              tokens_before: write.entry.tokensBefore,
              summary_chars: write.entry.summary.length,
            },
          },
        ],
      });
    if (write.kind !== "value" || write.op !== "set") continue;
    if (write.namespace === "pi.lane.state" && write.key === PI_LANE) {
      const next = (write.value as LaneState).inbox;
      const before = new Set(state.inbox.map((item) => item.entryId));
      const after = new Set(next.map((item) => item.entryId));
      const delivered = new Set(writes.flatMap((w) => (w.kind === "entry" ? [w.entry.id] : [])));
      const changes: ExecutorEvent[] = [
        ...next
          .filter((item) => !before.has(item.entryId) && item.kind !== "write")
          .map((item) => ({
            type: "input.queued",
            payload: { entry_id: item.entryId, kind: item.kind },
          })),
        ...state.inbox
          .filter((item) => !after.has(item.entryId) && item.kind !== "write")
          .map((item) => ({
            type: "input.consumed",
            payload: {
              entry_id: item.entryId,
              kind: item.kind,
              delivered: delivered.has(item.entryId),
            },
          })),
      ];
      if (changes.length) steps.push({ kind: "events", events: changes });
      state.inbox = next;
    }
    if (write.namespace === "pi.op.state" && state.owned.has(write.key)) {
      const next = write.value as OperationState;
      if (next.at === "assistant.effect_pending") state.pendingUsageId = next.usageId;
      if (next.at === "summary.effect_pending" && next.request)
        state.pendingUsageId = next.request.usageId;
      if (next.at === "tools") {
        const assistant = state.assistants.get(next.batch.assistantEntryId);
        if (!assistant) throw new Error("Tool batch refers to an unknown assistant response");
        for (const call of next.batch.calls) {
          if (call.status !== "effect_pending") continue;
          const block = assistant.content[call.sourceIndex];
          if (block?.type !== "toolCall") throw new Error("Tool intent has no tool call block");
          if (state.started.has(block.id)) continue;
          state.started.add(block.id);
          steps.push({
            kind: "events",
            events: [{ type: "tool.started", payload: { id: block.id, name: block.name } }],
          });
        }
      }
    }
    if (write.namespace === "pi.pending.entry") {
      const pending = write.value as PendingEntry;
      if (pending.type !== "message" || pending.payload.role !== "toolResult") continue;
      if (!snapshot) throw new Error("Tool outcome committed without a workspace snapshot");
      const message = pending.payload as ToolResultMessage;
      steps.push({
        kind: "tool",
        events: [
          {
            type: "tool.result",
            payload: {
              id: message.toolCallId,
              name: message.toolName,
              is_error: message.isError,
              content: message.content,
            },
          },
        ],
        files: snapshot.files,
        metadata: snapshot.metadata,
      });
    }
  }
  return steps;
}

/**
 * Storage decorator: reads go to the host's Pi Storage; every commit is planned and
 * handed to the host, which applies Pi's writes and the derived records in one
 * transaction with its ownership check.
 */
function durableTurnStorage(host: HarnessTurnHost, state: EngineState, bash: Bash): Storage {
  let queue: Promise<unknown> = Promise.resolve();
  return new Proxy(host.storage, {
    get(target, property) {
      // The outer turn owns storage lifetime so a faulted Pi harness can be
      // reopened once for cancellation reconciliation without closing the host.
      if (property === "close")
        return async () => {
          await queue;
        };
      if (property === "commit")
        return (writes: Write[], _context: Context) => {
          const frozen = structuredClone(writes);
          const result = queue.then(async () => {
            const toolOutcome = frozen.some(
              (write) =>
                write.kind === "value" &&
                write.op === "set" &&
                write.namespace === "pi.pending.entry" &&
                (write.value as PendingEntry).type === "message" &&
                (write.value as { payload: { role: string } }).payload.role === "toolResult",
            );
            // Tools run sequentially, so the VFS is quiescent once its outcome is published.
            const snapshot = toolOutcome ? await snapshotWorkspace(bash) : undefined;
            // Pi seals the lane after any rejected commit. A cancellation retry
            // reloads from durable records; retain shared maps here so concurrent
            // dispatch and steering cannot overwrite each other's bookkeeping.
            const steps = state.project ? planCommit(frozen, snapshot, state, host.turn) : [];
            const receipt = await host.commit(frozen, steps);
            host.notify?.();
            await host.afterCommit?.(steps.flatMap((step) => step.events));
            return receipt;
          });
          queue = result.then(
            () => {},
            () => {},
          );
          return result;
        };
      const member = Reflect.get(target, property, target);
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
}

function harnessTools(tools: AgentTool[]): AgentHarnessTool<undefined>[] {
  return tools.map((tool) => ({
    ...tool,
    // Private-workspace tools re-execute against the last committed revision; native bash
    // reattaches to its supervisor journal by tool call id instead of running twice.
    replay: "safe" as const,
    async execute(toolCallId, params, onUpdate, _toolContext, _invocation, context) {
      context.abortSignal?.throwIfAborted();
      return tool.execute(toolCallId, params, context.abortSignal, (partial) => onUpdate(partial));
    },
  }));
}

/** Settle an attempt whose Pi request can never produce a usage row as an unknown outcome. */
async function settleOrphanedStructural(
  host: HarnessTurnHost,
  state: EngineState,
  operation: OperationState | undefined,
) {
  if (operation?.at !== "summary.effect_pending" || !operation.request) return;
  const usageId = operation.request.usageId;
  const attempt = state.attempts.get(usageId);
  if (!attempt) return;
  const identity = operation.summaryContext.configuration.model;
  const message: AssistantMessage = {
    role: "assistant",
    content: [],
    api: "unknown",
    provider: identity.provider,
    model: identity.modelId,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: "Summary request was interrupted and its external outcome is unknown",
    timestamp: Date.now(),
  };
  await host.commit([], [settlement(message, attempt, host.turn, "summary")]);
  state.attempts.delete(usageId);
}

/** Run or resume one turn on the Pi harness. Returns Pi's terminal outcome; aborts propagate. */
export async function runHarnessTurn(host: HarnessTurnHost): Promise<HarnessTurnOutcome> {
  try {
    return await driveHarnessTurn(host, true);
  } finally {
    await host.storage.close(BACKGROUND_CONTEXT);
  }
}

async function driveHarnessTurn(
  host: HarnessTurnHost,
  reconcileAfterFault: boolean,
): Promise<HarnessTurnOutcome> {
  const { turn, signal } = host;
  const id = turn.id;
  const context = BACKGROUND_CONTEXT;
  const subscription = turn.model.provider === "openai-codex" && turn.billing === "subscription";
  if (subscription) {
    if (
      host.credential.billingMode !== "subscription" ||
      (host.credential.baseUrl !== null && host.credential.baseUrl !== CODEX_BASE_URL)
    )
      throw new Error("Codex requires subscription credentials bound to the ChatGPT endpoint.");
  }
  const [workspace, history] = await Promise.all([host.workspace(), host.readEvents()]);
  const bash = new Bash({
    cwd: WORKSPACE,
    files: workspace.files,
    executionLimits: { maxFileSystemBytes: WORKSPACE_MAX_BYTES, maxOutputSize: 1024 * 1024 },
  });
  await restoreWorkspace(bash, workspace.files, workspace.metadata);
  const state: EngineState = {
    project: true,
    owned: new Set([id, contextOperationId(id, "reset"), contextOperationId(id, "compact")]),
    attempts: restoreAttempts(history),
    assistants: new Map(),
    structural: new Map(),
    inbox: [],
    started: restoreStartedTools(history),
  };
  const storage = durableTurnStorage(host, state, bash);
  const session = new StorageBackedSession(
    { id: turn.sessionId, createdAt: 0, storageVersion: 1 },
    storage,
  );
  const model = buildPiModel(turn.model.provider, turn.model.id, host.credential.baseUrl);
  const models = piSummaryModels(
    durableModels({
      model,
      credential: host.credential,
      startModel: async () => {
        const usageId = state.pendingUsageId;
        if (!usageId) throw new Error("Model dispatch without a committed Pi request intent");
        const attempt = await host.startModel({ [PI_USAGE_ID]: usageId });
        state.denied = undefined;
        host.notify?.();
        state.attempts.set(usageId, attempt);
        return attempt;
      },
      onDenied: (error) => {
        state.denied ??= error;
      },
      onStructural: (attempt, message) => {
        state.structural.set(attempt.call_id, message);
      },
    }),
  );
  let tools = vfsTools(bash, async (toolCallId, command, toolSignal, timeoutMs) => {
    if (!host.nativeBash) throw new Error("native sandbox is unavailable");
    const before = await snapshotWorkspace(bash);
    const remote = await host.nativeBash(
      toolCallId,
      command,
      before.files,
      before.metadata,
      toolSignal,
      timeoutMs,
    );
    await restoreWorkspace(bash, remote.files, remote.metadata);
    return remote.result;
  });
  if (turn.executionMode === "read_only") tools = tools.filter((tool) => tool.name === "read");
  const readEvents = () => host.readEvents();
  tools.push(archiveTool("read_output", readEvents), archiveTool("read_log", readEvents));
  const prompt =
    systemPrompt(turn.instructions) +
    (turn.executionMode === "read_only"
      ? `\nRead-only workspace paths: ${JSON.stringify(Object.keys(workspace.files))}. Only read and archive tools are available.`
      : "") +
    (history.some((e) => e.type === "environment.reset")
      ? "\nThe native environment was recreated from the durable workspace. Installed dependencies and background processes may be gone."
      : "");
  let current = id;
  // Extension tools and hooks join the harness; extension-sent messages use the lane inbox.
  let lane!: AgentLane;
  const extensions: PiExtensionActivation | undefined = host.extensions?.result.extensions.length
    ? await activatePiExtensions({
        loaded: host.extensions,
        sessionId: turn.sessionId,
        prompt: turn.prompt,
        systemPrompt: prompt,
        model,
        thinkingLevel: turn.thinkingLevel,
        baseTools: tools.map((tool) => tool.name),
        signal,
        queue: async (kind, text) =>
          getOrThrow(
            await (kind === "steer"
              ? lane.steer(text, undefined, context)
              : lane.followUp(text, undefined, context)),
          ),
        abort: () => void lane.requestAbort(current, context).catch(() => {}),
      })
    : undefined;
  const created = await AgentHarness.create<undefined>(
    {
      session,
      models,
      model,
      thinkingLevel: turn.thinkingLevel,
      toolExecution: "sequential",
      toolContext: undefined,
      systemPrompt: prompt,
      compaction: DEFAULT_COMPACTION_SETTINGS,
      // Each attempt is a new identified attempt; an interrupted request is retried once.
      retry: { enabled: true, maxRetries: 1, baseDelayMs: 1_000 },
      streamOptions: { maxRetries: 0, timeoutMs: 120_000, cacheRetention: "none" },
      tools: [...harnessTools(tools), ...(extensions?.tools ?? [])],
    },
    context,
  );
  const { harness } = created;
  const detach = (reason: unknown) =>
    host.detachOnAbort
      ? host.detachOnAbort(reason)
      : reason instanceof Error && reason.message === "runtime_interrupted";
  const onAbort = () => {
    // Detaching keeps the operation resumable; every other abort is a durable cancellation.
    if (detach(signal.reason)) void harness.close(context).catch(() => {});
    else void lane.requestAbort(current, context).catch(() => {});
  };
  const drive = async (operationId: string) => {
    current = operationId;
    const driven = getOrThrow(
      await lane.drive({ operationId, waitForRetry: true, pollDeferred: true }, context),
    );
    if (driven.kind !== "settled")
      throw new Error(
        `Pi operation ${operationId} is waiting (${driven.reason}); unsupported by this engine`,
      );
    return driven.outcome;
  };
  try {
    lane = await harness.lane(PI_LANE, context);
    await extensions?.attach(harness);
    const watched = await lane.watch(context);
    state.inbox = watched.snapshot.queues.map((item) => ({
      entryId: item.entryId,
      kind: item.kind,
    }));
    watched.unsubscribe();
    const open = created.open.find((operation) => operation.lane === PI_LANE);
    if (open && !state.owned.has(open.operationId)) {
      // Another turn's operation may only be reconciled here when it cannot dispatch
      // new work: a durable cancellation or a plain tree navigation.
      const [stored, meta] = await Promise.all([
        host.storage.getValue(operationState(open.operationId), context),
        host.storage.getValue(operationMeta(open.operationId), context),
      ]);
      const reconcilable =
        stored?.value.control.status === "cancel_requested" ||
        (meta?.value.intent.kind === "navigation" && !meta.value.intent.summarize);
      if (!reconcilable)
        throw new Error(
          `Session has an unfinished Pi operation ${open.operationId}; resume that turn first.`,
        );
      state.project = false;
      try {
        getOrThrow(await lane.resume(context));
      } finally {
        state.project = true;
      }
    }
    if (open && state.owned.has(open.operationId)) {
      const stored = await host.storage.getValue(operationState(open.operationId), context);
      if (stored?.value.at === "tools") {
        const entries = await host.storage.getEntries(
          [stored.value.batch.assistantEntryId],
          context,
        );
        const entry = entries.get(stored.value.batch.assistantEntryId);
        if (entry?.type === "message" && entry.message.role === "assistant")
          state.assistants.set(entry.id, entry.message);
      }
      if (signal.aborted && !detach(signal.reason))
        getOrThrow(await lane.requestAbort(open.operationId, context));
      // Pi never settles usage for an interrupted summary request; record the unknown outcome.
      await settleOrphanedStructural(host, state, stored?.value);
      host.notify?.();
      if (signal.aborted && !detach(signal.reason)) await drive(open.operationId);
    }
    signal.throwIfAborted();
    signal.addEventListener("abort", onAbort, { once: true });
    host.onControls?.({
      queue: async (kind, text) => {
        signal.throwIfAborted();
        const queued = getOrThrow(
          await (kind === "steer"
            ? lane.steer(text, undefined, context)
            : lane.followUp(text, undefined, context)),
        );
        return { entryId: queued.entryId };
      },
      cancel: async (entryId) => {
        signal.throwIfAborted();
        return getOrThrow(await lane.cancelQueued(entryId, context));
      },
    });
    const settled = (operationId: string) => lane.getResult(operationId, context);
    if (!(await settled(id)) && open?.operationId !== id) {
      // Lane configuration outlives operations. Align it with this turn's selection so a
      // continued session neither inherits an earlier thinking level nor dispatches the
      // model an earlier turn chose (the durable facade only serves this turn's model).
      // `getModel` resolves through the durable facade, which only knows this turn's
      // model: undefined means the lane still points at an earlier turn's selection.
      if (!(await lane.getModel(context)))
        await lane.setModel({ provider: model.provider, modelId: model.id }, context);
      if ((await lane.getThinkingLevel(context)) !== turn.thinkingLevel)
        await lane.setThinkingLevel(turn.thinkingLevel, context);
      // Active tools persist in the lane as well. A read-only turn after a build turn must
      // not ask for tools this process did not register (Pi fails the generation), and a
      // build turn after a read-only turn must get its write tools back.
      const activeTools = [...tools, ...(extensions?.tools ?? [])].map((tool) => tool.name);
      const currentTools = await lane.getActiveTools(context);
      if (
        currentTools.length !== activeTools.length ||
        activeTools.some((name) => !currentTools.includes(name))
      )
        await lane.setActiveTools(activeTools, context);
      // Context operations run before the prompt is accepted and only once per turn.
      if (turn.contextMode === "reset") {
        const operationId = contextOperationId(id, "reset");
        if (!(await settled(operationId))) {
          if (open?.operationId !== operationId) {
            const accepted = await lane.accept(
              { kind: "navigation", operationId, targetId: null },
              context,
            );
            // Already at the root: nothing to reset.
            if (!accepted.ok && accepted.error._tag !== "InvalidNavigation") throw accepted.error;
            if (accepted.ok) await drive(operationId);
          } else await drive(operationId);
        }
      }
      if (turn.contextMode === "compact") {
        const operationId = contextOperationId(id, "compact");
        if (!(await settled(operationId))) {
          if (open?.operationId !== operationId) {
            // An explicit compaction summarizes everything before the latest turn boundary.
            await harness.setCompactionSettings(
              { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 0 },
              context,
            );
            const accepted = await lane.accept({ kind: "compaction", operationId }, context);
            await harness.setCompactionSettings(DEFAULT_COMPACTION_SETTINGS, context);
            if (!accepted.ok && accepted.error._tag !== "NothingToCompact") throw accepted.error;
            if (accepted.ok) {
              const outcome = await drive(operationId);
              if (outcome.status !== "completed" && outcome.status !== "declined")
                throw new Error(
                  state.denied
                    ? String(state.denied)
                    : `Context compaction ${outcome.status}: ${outcome.error?.message ?? ""}`,
                );
            }
          } else await drive(operationId);
        }
      }
      signal.throwIfAborted();
      getOrThrow(
        await lane.accept({ kind: "prompt", operationId: id, prompt: turn.prompt }, context),
      );
    }
    const outcome = await drive(id);
    if (outcome.status !== "completed") signal.throwIfAborted();
    if (state.denied) throw state.denied;
    if (extensions?.errors.length)
      throw new Error(`Pi extension errors: ${extensions.errors.join("; ")}`);
    if (outcome.status === "completed") return { status: "completed" };
    // A durable cancellation reconciled after restart is still a cancellation.
    if (outcome.status === "aborted") throw new Error("canceled");
    return {
      status: "failed",
      error: outcome.error?.message ?? outcome.error?.code ?? outcome.status,
    };
  } catch (error) {
    if (
      reconcileAfterFault &&
      error instanceof HarnessFault &&
      signal.aborted &&
      !detach(signal.reason)
    ) {
      // A terminal host can reject a racing forward commit before its heartbeat
      // fires. Pi faults its lane on storage rejection, so reopen committed state
      // once to reconcile cancellation under the same ownership fence. The aborted
      // signal prevents accepting a prompt or dispatching new work on this pass.
      await harness.close(context).catch(() => {});
      return await driveHarnessTurn(host, false);
    }
    if (state.denied && !signal.aborted) throw state.denied;
    // A storage or invariant fault reports its root cause; Pi wraps it for its own callers.
    throw error instanceof HarnessFault && error.cause instanceof Error ? error.cause : error;
  } finally {
    signal.removeEventListener("abort", onAbort);
    await extensions?.close().catch(() => {});
    await harness.close(context).catch(() => {});
  }
}
