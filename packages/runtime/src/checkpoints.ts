import { createHash, randomUUID } from "node:crypto";
import type { ModelReservation, WorkspaceMetadata } from "@nimplex/contracts";
import {
  checkWorkspaceLimits,
  type ExecutorEvent,
  type ExecutorRunContext,
  isTerminal,
  lookupRate,
  planReservation,
  roundUsd,
} from "@nimplex/core";
import { codexModels } from "./models.ts";
import type { RuntimeStore } from "./store.ts";

/** The turn must still be running before any new durable step is recorded. */
export function activeTurn(store: RuntimeStore, id: string) {
  const turn = store.turn(id);
  if (turn.result.status !== "running") throw new Error(`turn is ${turn.result.status}`);
  return turn;
}

/**
 * Transaction-free commit steps. `createCheckpoints` wraps each in its own SQLite
 * transaction for the default executor; the Pi harness engine runs them inside the
 * transaction that also commits Pi's session writes, so both engines share one
 * budget and workspace implementation.
 */
export function reserveModelIn(
  store: RuntimeStore,
  id: string,
  inputTokenBound: number,
  extra: Record<string, unknown> = {},
): ModelReservation {
  const turn = activeTurn(store, id);
  const r = turn.result;
  const subscription = r.model.provider === "openai-codex" && r.billing_mode === "subscription";
  const rate = subscription ? null : lookupRate(r.model.provider, r.model.id);
  if (!subscription && !rate) throw new Error(`Unpriced model: ${turn.request.model}`);
  const codex = subscription ? codexModels().find((m) => m.id === r.model.id) : undefined;
  const planned = subscription
    ? codex && { maxOutputTokens: codex.maxTokens, reservedUsd: 0 }
    : rate &&
      planReservation(
        (r.budget_usd ?? 0) - r.spent_usd - (r.reserved_usd ?? 0),
        inputTokenBound,
        rate,
      );
  if (!planned) throw new Error("budget_exceeded");
  const reservation: ModelReservation = {
    call_id: randomUUID(),
    input_token_bound: inputTokenBound,
    max_output_tokens: planned.maxOutputTokens,
    reserved_usd: planned.reservedUsd,
  };
  r.reserved_usd = roundUsd((r.reserved_usd ?? 0) + reservation.reserved_usd);
  store.saveTurn(turn);
  store.append(id, [{ type: "model.reserved", payload: { ...reservation, ...extra } }]);
  return reservation;
}

export function commitModelIn(
  store: RuntimeStore,
  id: string,
  reservation: ModelReservation,
  events: ExecutorEvent[],
  cost: number,
  uncertain: boolean,
) {
  if (!Number.isFinite(cost) || cost < 0) throw new Error("Invalid model cost.");
  const history = store.events(id);
  const match = history.find(
    (e) =>
      e.type === "model.reserved" &&
      (e.payload as ModelReservation).call_id === reservation.call_id,
  );
  if (!match) throw new Error("Unknown model reservation.");
  if (
    history.some(
      (e) =>
        e.type === "spend.updated" &&
        (e.payload as { call_id: string }).call_id === reservation.call_id,
    )
  )
    return;
  const issued = match.payload as ModelReservation;
  const turn = store.turn(id);
  const r = turn.result;
  const rounded = Math.ceil(cost * 1e6 - 1e-8) / 1e6;
  const released = uncertain ? Math.min(rounded, issued.reserved_usd) : issued.reserved_usd;
  r.spent_usd = roundUsd(r.spent_usd + rounded);
  r.reserved_usd = Math.max(0, roundUsd((r.reserved_usd ?? 0) - released));
  store.append(id, [
    ...events,
    {
      type: "spend.updated",
      payload: {
        call_id: issued.call_id,
        spent_usd: r.spent_usd,
        reserved_usd: r.reserved_usd,
        budget_usd: r.budget_usd,
      },
    },
  ]);
  if (rounded > issued.reserved_usd && !isTerminal(r.status)) {
    r.status = "failed";
    r.error = "provider_exceeded_reservation";
    r.completed_at = new Date().toISOString();
    store.append(id, [{ type: "run.failed", payload: { error: r.error } }]);
  }
  store.saveTurn(turn);
}

export function commitToolIn(
  store: RuntimeStore,
  id: string,
  events: ExecutorEvent[],
  files: Record<string, Uint8Array>,
  metadata: WorkspaceMetadata,
) {
  const turn = activeTurn(store, id);
  const exceeded = checkWorkspaceLimits(files, metadata);
  if (exceeded) throw new Error(exceeded);
  const before = store.workspace(id).files;
  const revision = (turn.result.workspace_revision ?? 0) + 1;
  const changes = [...new Set([...Object.keys(before), ...Object.keys(files)])].flatMap((path) => {
    const prior = before[path],
      after = files[path];
    if (prior && after && Buffer.from(prior).equals(Buffer.from(after))) return [];
    return [
      {
        type: "file.changed",
        payload: {
          path,
          action: after ? "write" : "delete",
          bytes: after?.byteLength ?? 0,
          revision,
          ...(after
            ? {
                sha256: createHash("sha256").update(after).digest("hex"),
                content_base64: Buffer.from(after).toString("base64"),
              }
            : {}),
        },
      },
    ];
  });
  store.saveWorkspace(id, { files, metadata });
  turn.result.workspace_revision = revision;
  store.saveTurn(turn);
  store.append(id, [
    ...events,
    ...changes,
    { type: "workspace.committed", payload: { revision, metadata } },
  ]);
}

/** Local commits use the same executor contract as the hosted Postgres adapter. */
export function createCheckpoints(
  store: RuntimeStore,
  id: string,
  notify: () => void,
): ExecutorRunContext["persistence"] {
  const commit = <T>(operation: () => T) => {
    const value = store.transaction(operation);
    notify();
    return value;
  };
  return {
    readEvents: async () => store.events(id),
    checkpointContext: async (checkpoint) =>
      commit(() => {
        activeTurn(store, id);
        store.append(id, [{ type: "context.checkpoint", payload: checkpoint }]);
      }),
    reserveModel: async (inputTokenBound) =>
      commit(() => reserveModelIn(store, id, inputTokenBound)),
    commitModel: async (reservation, events, cost, uncertain) =>
      commit(() => commitModelIn(store, id, reservation, events, cost, uncertain)),
    startTool: async (toolId, name) =>
      commit(() => {
        activeTurn(store, id);
        store.append(id, [{ type: "tool.started", payload: { id: toolId, name } }]);
      }),
    commitTool: async (events, files, metadata) =>
      commit(() => commitToolIn(store, id, events, files, metadata)),
  };
}
