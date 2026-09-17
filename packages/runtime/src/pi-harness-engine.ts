// Production adapter for Pi's public AgentHarness. Pi owns the model/tool loop and
// the session tree; nimplex owns the SQLite transaction that commits every Pi write
// together with its own events, accounting and workspace revision. Opt in per
// session; the default executor remains unchanged.
import {
  AgentHarness,
  type AgentHarnessTool,
  type AgentTool,
  DEFAULT_COMPACTION_SETTINGS,
  getOrThrow,
  HarnessFault,
} from "@earendil-works/pi-agent-core";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/pi-agent-core/harness/context";
import {
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
import type { Api, AssistantMessage, Model, ToolResultMessage } from "@earendil-works/pi-ai";
import type { ModelReservation } from "@nimplex/contracts";
import {
  computeCost,
  type ExecutorEvent,
  type ExecutorRunContext,
  WORKSPACE_MAX_BYTES,
} from "@nimplex/core";
import { Bash } from "just-bash";
import { activeTurn, commitModelIn, commitToolIn, reserveModelIn } from "./checkpoints.ts";
import { CODEX_BASE_URL } from "./models.ts";
import {
  archiveTool,
  buildCodexModel,
  buildModel,
  DEFAULT_ANTHROPIC_URL,
  systemPrompt,
  vfsTools,
  WORKSPACE,
} from "./pi-executor.ts";
import { budgetedModels } from "./pi-harness-models.ts";
import { SqlitePiStorage } from "./pi-storage/sqlite.ts";
import { piSummaryModels } from "./pi-summary-models.ts";
import { PI_LANE, PI_TENANT, type RuntimeStore, type StoredTurn } from "./store.ts";
import { restoreWorkspace, snapshotWorkspace } from "./workspace.ts";

export { PI_LANE, PI_TENANT } from "./store.ts";

/** Reservations never plan above this output cap; the model limit must match it (see below). */
const OUTPUT_LIMIT = 4096;

/** In-flight controls the runtime exposes while a harness turn owns its lane. */
export interface HarnessTurnControls {
  /** Durably queue steering or follow-up input; Pi delivers it at its next boundary. */
  queue(kind: "steer" | "followUp", text: string): Promise<{ entryId: string }>;
  /** Durably remove queued input that Pi has not consumed yet. */
  cancel(entryId: string): Promise<{ kind: "cancelled" | "already_consumed" | "not_found" }>;
}

export interface HarnessTurnHost {
  store: RuntimeStore;
  turn: StoredTurn;
  credential: ExecutorRunContext["credential"];
  nativeBash: ExecutorRunContext["nativeBash"];
  /** Runtime abort: cancellation, duration cap or runtime shutdown. */
  signal: AbortSignal;
  notify(): void;
  /** Receives the lane's controls once the turn owns it; unavailable after the turn settles. */
  onControls?(controls: HarnessTurnControls): void;
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
  /** Committed reservations keyed by Pi usage id, restored from `model.reserved` events. */
  reservations: Map<string, ModelReservation>;
  /** Committed assistant messages by entry id; needed to name tool intents. */
  assistants: Map<string, AssistantMessage>;
  /** Complete summary responses keyed by reservation, awaiting Pi's usage settlement. */
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

const PI_USAGE_ID = "pi_usage_id";

function restoreStartedTools(store: RuntimeStore, id: string) {
  return new Set(
    store
      .events(id)
      .filter((event) => event.type === "tool.started")
      .map((event) => (event.payload as { id: string }).id),
  );
}

function restoreReservations(store: RuntimeStore, id: string) {
  const reservations = new Map<string, ModelReservation>();
  const settled = new Set<string>();
  const events = store.events(id);
  for (const event of events)
    if (event.type === "spend.updated") settled.add((event.payload as { call_id: string }).call_id);
  for (const event of events) {
    if (event.type !== "model.reserved") continue;
    const payload = event.payload as ModelReservation & { [PI_USAGE_ID]?: string };
    const usageId = payload[PI_USAGE_ID];
    if (usageId && !settled.has(payload.call_id)) {
      const { [PI_USAGE_ID]: _usage, ...reservation } = payload;
      reservations.set(usageId, reservation);
    }
  }
  return reservations;
}

function assistantEvents(
  message: AssistantMessage,
  reservation: ModelReservation,
  turn: StoredTurn,
  step: "assistant" | "summary",
) {
  const uncertain = message.stopReason === "error" || message.stopReason === "aborted";
  const subscription = turn.result.billing_mode === "subscription";
  const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  const cost = subscription
    ? { costUsd: 0, estimated: false }
    : computeCost(turn.result.model.provider, turn.result.model.id, {
        inputTokens: message.usage.input,
        outputTokens: message.usage.output,
        cacheWriteTokens: message.usage.cacheWrite,
        cacheReadTokens: message.usage.cacheRead,
      });
  const events: ExecutorEvent[] = [
    {
      type: uncertain ? "model.unknown" : "model.call",
      payload: {
        call_id: reservation.call_id,
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
  return { events, cost: cost.costUsd, uncertain };
}

/**
 * Storage decorator: one SQLite transaction commits Pi's writes and the nimplex
 * projection they imply (reservation settlement, tool results with the workspace
 * revision, tool intents). Ownership is checked inside the transaction.
 */
function durableTurnStorage(
  inner: SqlitePiStorage,
  host: HarnessTurnHost,
  state: EngineState,
  bash: Bash,
): Storage {
  const { store, turn } = host;
  const id = turn.result.id;
  let queue: Promise<unknown> = Promise.resolve();

  const project = (
    writes: Write[],
    snapshot: Awaited<ReturnType<typeof snapshotWorkspace>> | undefined,
    projected: ExecutorEvent[],
  ) => {
    const record = (events: ExecutorEvent[]) => {
      projected.push(...events);
      return events;
    };
    const assistantMessages = new Map<string, AssistantMessage>();
    for (const write of writes)
      if (
        write.kind === "entry" &&
        write.entry.type === "message" &&
        write.entry.message.role === "assistant"
      )
        assistantMessages.set(write.entry.id, write.entry.message);
    for (const write of writes) {
      if (write.kind === "usage") settleUsage(write.row, assistantMessages);
      if (write.kind === "entry" && write.entry.type === "compaction")
        store.append(
          id,
          record([
            {
              type: "context.compacted",
              payload: {
                entry_id: write.entry.id,
                tokens_before: write.entry.tokensBefore,
                summary_chars: write.entry.summary.length,
              },
            },
          ]),
        );
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
        if (changes.length) store.append(id, record(changes));
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
            store.append(
              id,
              record([{ type: "tool.started", payload: { id: block.id, name: block.name } }]),
            );
          }
        }
      }
      if (write.namespace === "pi.pending.entry") {
        const pending = write.value as PendingEntry;
        if (pending.type !== "message" || pending.payload.role !== "toolResult") continue;
        if (!snapshot) throw new Error("Tool outcome committed without a workspace snapshot");
        const message = pending.payload as ToolResultMessage;
        commitToolIn(
          store,
          id,
          record([
            {
              type: "tool.result",
              payload: {
                id: message.toolCallId,
                name: message.toolName,
                is_error: message.isError,
                content: message.content,
              },
            },
          ]),
          snapshot.files,
          snapshot.metadata,
        );
      }
    }
    function settleUsage(row: Omit<UsageRow, "seq">, messages: Map<string, AssistantMessage>) {
      const reservation = state.reservations.get(row.id);
      // Assistant usage names its entry; summary usage carries no entry and Pi keeps no
      // response, so the facade's captured response is the settlement record.
      const structural = row.entryId === undefined;
      const message = structural
        ? reservation && state.structural.get(reservation.call_id)
        : messages.get(row.entryId as string);
      if (!reservation) {
        // A request denied or failed before dispatch settles zero usage without a reservation.
        const failed = message?.stopReason === "error" || message?.stopReason === "aborted";
        if (row.usage.totalTokens === 0 && (structural || failed)) return;
        throw new Error("Pi usage has no matching nimplex reservation");
      }
      if (!message) throw new Error("Pi usage settled without its response");
      state.reservations.delete(row.id);
      if (structural) state.structural.delete(reservation.call_id);
      else state.assistants.set(row.entryId as string, message);
      const { events, cost, uncertain } = assistantEvents(
        message,
        reservation,
        turn,
        structural ? "summary" : "assistant",
      );
      commitModelIn(store, id, reservation, record(events), cost, uncertain);
    }
  };

  return new Proxy(inner as Storage, {
    get(target, property) {
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
            const projected: ExecutorEvent[] = [];
            const receipt = store.transaction(() => {
              activeTurn(store, id);
              const receipt = inner.commitSync(frozen);
              if (state.project) project(frozen, snapshot, projected);
              activeTurn(store, id);
              return receipt;
            });
            host.notify();
            await host.afterCommit?.(projected);
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

/** Settle a reservation whose Pi request can never produce a usage row as an unknown outcome. */
function settleOrphanedStructural(
  store: RuntimeStore,
  turn: StoredTurn,
  state: EngineState,
  operation: OperationState | undefined,
) {
  if (operation?.at !== "summary.effect_pending" || !operation.request) return;
  const usageId = operation.request.usageId;
  const reservation = state.reservations.get(usageId);
  if (!reservation) return;
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
  const { events, cost, uncertain } = assistantEvents(message, reservation, turn, "summary");
  store.transaction(() =>
    commitModelIn(store, turn.result.id, reservation, events, cost, uncertain),
  );
  state.reservations.delete(usageId);
}

/** Run or resume one turn on the Pi harness. Returns Pi's terminal outcome; aborts propagate. */
export async function runHarnessTurn(host: HarnessTurnHost): Promise<HarnessTurnOutcome> {
  const { store, turn, signal } = host;
  const id = turn.result.id;
  const context = BACKGROUND_CONTEXT;
  const subscription =
    turn.result.model.provider === "openai-codex" && turn.result.billing_mode === "subscription";
  if (subscription) {
    if (
      host.credential.billingMode !== "subscription" ||
      (host.credential.baseUrl !== null && host.credential.baseUrl !== CODEX_BASE_URL)
    )
      throw new Error("Codex requires subscription credentials bound to the ChatGPT endpoint.");
  } else if (turn.result.model.provider !== "anthropic")
    throw new Error("Unsupported Pi model provider.");
  const workspace = store.workspace(id);
  const bash = new Bash({
    cwd: WORKSPACE,
    files: workspace.files,
    executionLimits: { maxFileSystemBytes: WORKSPACE_MAX_BYTES, maxOutputSize: 1024 * 1024 },
  });
  await restoreWorkspace(bash, workspace.files, workspace.metadata);
  const state: EngineState = {
    project: true,
    owned: new Set([id, contextOperationId(id, "reset"), contextOperationId(id, "compact")]),
    reservations: restoreReservations(store, id),
    assistants: new Map(),
    structural: new Map(),
    inbox: [],
    started: restoreStartedTools(store, id),
  };
  const inner = new SqlitePiStorage(
    store.db,
    { tenantId: PI_TENANT, sessionId: turn.sessionId },
    () => activeTurn(store, id),
    { transaction: (operation) => store.transaction(operation) },
  );
  const storage = durableTurnStorage(inner, host, state, bash);
  const session = new StorageBackedSession(
    { id: turn.sessionId, createdAt: 0, storageVersion: 1 },
    storage,
  );
  const known: Model<Api> = subscription
    ? buildCodexModel(turn.result.model.id)
    : buildModel(turn.result.model.id, host.credential.baseUrl ?? DEFAULT_ANTHROPIC_URL);
  // Pi treats a length stop below the model limit as recoverable overflow. Align the
  // limit with the reservation cap so budget-capped output is an ordinary length stop.
  const model: Model<Api> = subscription
    ? known
    : { ...known, maxTokens: Math.min(known.maxTokens, OUTPUT_LIMIT) };
  const models = piSummaryModels(
    budgetedModels({
      model,
      apiKey: host.credential.apiKey,
      billing: subscription ? "subscription" : "api",
      reserve: (inputTokenBound) => {
        const usageId = state.pendingUsageId;
        if (!usageId) throw new Error("Model dispatch without a committed Pi request intent");
        const reservation = store.transaction(() =>
          reserveModelIn(store, id, inputTokenBound, { [PI_USAGE_ID]: usageId }),
        );
        host.notify();
        state.reservations.set(usageId, reservation);
        return reservation;
      },
      onDenied: (error) => {
        state.denied ??= error;
      },
      onStructural: (reservation, message) => {
        state.structural.set(reservation.call_id, message);
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
  if (turn.config.execution_mode === "read_only")
    tools = tools.filter((tool) => tool.name === "read");
  const readEvents = async () => store.events(id);
  tools.push(archiveTool("read_output", readEvents), archiveTool("read_log", readEvents));
  const created = await AgentHarness.create<undefined>(
    {
      session,
      models,
      model,
      thinkingLevel: "off",
      toolExecution: "sequential",
      toolContext: undefined,
      systemPrompt:
        systemPrompt(turn.config.instructions) +
        (turn.config.execution_mode === "read_only"
          ? `\nRead-only workspace paths: ${JSON.stringify(Object.keys(workspace.files))}. Only read and archive tools are available.`
          : "") +
        (store.events(id).some((e) => e.type === "environment.reset")
          ? "\nThe native environment was recreated from the durable workspace. Installed dependencies and background processes may be gone."
          : ""),
      compaction: DEFAULT_COMPACTION_SETTINGS,
      // Each attempt is a new identified reservation; an interrupted request is retried once.
      retry: { enabled: true, maxRetries: 1, baseDelayMs: 1_000 },
      streamOptions: { maxRetries: 0, timeoutMs: 120_000, cacheRetention: "none" },
      tools: harnessTools(tools),
    },
    context,
  );
  const { harness } = created;
  let current = id;
  const onAbort = () => {
    const reason = signal.reason instanceof Error ? signal.reason.message : String(signal.reason);
    // Shutdown keeps the operation resumable; every other abort is a durable cancellation.
    if (reason === "runtime_interrupted") void harness.close(context).catch(() => {});
    else void lane.requestAbort(current, context).catch(() => {});
  };
  let lane: Awaited<ReturnType<typeof harness.lane>>;
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
        inner.getValue(operationState(open.operationId), context),
        inner.getValue(operationMeta(open.operationId), context),
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
      const stored = await inner.getValue(operationState(open.operationId), context);
      if (stored?.value.at === "tools") {
        const entries = await inner.getEntries([stored.value.batch.assistantEntryId], context);
        const entry = entries.get(stored.value.batch.assistantEntryId);
        if (entry?.type === "message" && entry.message.role === "assistant")
          state.assistants.set(entry.id, entry.message);
      }
      // Pi never settles usage for an interrupted summary request; record the unknown outcome.
      settleOrphanedStructural(store, turn, state, stored?.value);
      host.notify();
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
      // Context operations run before the prompt is accepted and only once per turn.
      if (turn.request.contextMode === "reset") {
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
      if (turn.request.contextMode === "compact") {
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
                    ? "budget_exceeded"
                    : `Context compaction ${outcome.status}: ${outcome.error?.message ?? ""}`,
                );
            }
          } else await drive(operationId);
        }
      }
      signal.throwIfAborted();
      getOrThrow(
        await lane.accept({ kind: "prompt", operationId: id, prompt: turn.config.input }, context),
      );
    }
    const outcome = await drive(id);
    if (outcome.status !== "completed") signal.throwIfAborted();
    if (state.denied) throw new Error("budget_exceeded");
    if (outcome.status === "completed") return { status: "completed" };
    // A durable cancellation reconciled after restart is still a cancellation.
    if (outcome.status === "aborted") throw new Error("canceled");
    return {
      status: "failed",
      error: outcome.error?.message ?? outcome.error?.code ?? outcome.status,
    };
  } catch (error) {
    if (state.denied && !signal.aborted) throw new Error("budget_exceeded");
    // A storage or invariant fault reports its root cause; Pi wraps it for its own callers.
    throw error instanceof HarnessFault && error.cause instanceof Error ? error.cause : error;
  } finally {
    signal.removeEventListener("abort", onAbort);
    await harness.close(context).catch(() => {});
  }
}
