import { createHash, randomUUID } from "node:crypto";
import type { ModelAttempt, WorkspaceMetadata } from "@nimplex/contracts";
import {
  checkWorkspaceLimits,
  type ExecutorEvent,
  type ExecutorRunContext,
  roundUsd,
} from "@nimplex/core";
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
 * accounting and workspace implementation.
 */
export function startModelIn(
  store: RuntimeStore,
  id: string,
  extra: Record<string, unknown> = {},
): ModelAttempt {
  activeTurn(store, id);
  const attempt: ModelAttempt = { call_id: randomUUID() };
  store.append(id, [{ type: "model.started", payload: { ...attempt, ...extra } }]);
  return attempt;
}

export function commitModelIn(
  store: RuntimeStore,
  id: string,
  attempt: ModelAttempt,
  events: ExecutorEvent[],
  cost: number,
  uncertain: boolean,
) {
  if (!Number.isFinite(cost) || cost < 0) throw new Error("Invalid model cost.");
  const history = store.events(id);
  const match = history.find(
    (e) =>
      (e.type === "model.started" || e.type === "model.reserved") &&
      (e.payload as ModelAttempt).call_id === attempt.call_id,
  );
  if (!match) throw new Error("Unknown model attempt.");
  if (
    history.some(
      (e) =>
        e.type === "spend.updated" &&
        (e.payload as { call_id: string }).call_id === attempt.call_id,
    )
  )
    return;
  const issued = match.payload as ModelAttempt;
  const turn = store.turn(id);
  const r = turn.result;
  const rounded = Math.ceil(cost * 1e6 - 1e-8) / 1e6;
  r.spent_usd = roundUsd(r.spent_usd + rounded);
  store.append(id, [
    ...events,
    {
      type: "spend.updated",
      payload: {
        call_id: issued.call_id,
        spent_usd: r.spent_usd,
        uncertain,
      },
    },
  ]);
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
    startModel: async () => commit(() => startModelIn(store, id)),
    commitModel: async (attempt, events, cost, uncertain) =>
      commit(() => commitModelIn(store, id, attempt, events, cost, uncertain)),
    startTool: async (toolId, name) =>
      commit(() => {
        activeTurn(store, id);
        store.append(id, [{ type: "tool.started", payload: { id: toolId, name } }]);
      }),
    commitTool: async (events, files, metadata) =>
      commit(() => commitToolIn(store, id, events, files, metadata)),
  };
}
