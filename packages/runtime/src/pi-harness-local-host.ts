// Local SQLite host for the Pi harness engine: one RuntimeStore transaction commits
// Pi's writes and the derived nimplex records; the turn must still be running at both
// ends of that transaction.
import type { ExecutorEvent, ExecutorRunContext } from "@nimplex/core";
import { activeTurn, commitModelIn, commitToolIn, startModelIn } from "./checkpoints.ts";
import type { LoadedPiExtensions } from "./pi-extensions/bridge.ts";
import type { HarnessTurnControls, HarnessTurnHost } from "./pi-harness-engine.ts";
import { SqlitePiStorage } from "./pi-storage/sqlite.ts";
import { PI_TENANT, type RuntimeStore, type StoredTurn } from "./store.ts";

export interface LocalHarnessHostOptions {
  store: RuntimeStore;
  turn: StoredTurn;
  credential: ExecutorRunContext["credential"];
  nativeBash: ExecutorRunContext["nativeBash"];
  signal: AbortSignal;
  notify(): void;
  onControls?(controls: HarnessTurnControls): void;
  afterCommit?(events: ExecutorEvent[]): Promise<void> | void;
  extensions?: LoadedPiExtensions;
}

export function localHarnessHost(options: LocalHarnessHostOptions): HarnessTurnHost {
  const { store, turn } = options;
  const id = turn.result.id;
  const storage = new SqlitePiStorage(
    store.db,
    { tenantId: PI_TENANT, sessionId: turn.sessionId },
    () => activeTurn(store, id),
    { transaction: (operation) => store.transaction(operation) },
  );
  return {
    turn: {
      id,
      sessionId: turn.sessionId,
      prompt: turn.config.input,
      instructions: turn.config.instructions,
      executionMode: turn.config.execution_mode,
      contextMode: turn.request.contextMode,
      thinkingLevel: turn.request.thinking ?? "off",
      model: turn.result.model,
      billing: turn.result.billing_mode ?? "api",
    },
    storage,
    async commit(writes, steps) {
      return store.transaction(() => {
        activeTurn(store, id);
        const receipt = storage.commitSync(writes);
        for (const step of steps) {
          if (step.kind === "events") store.append(id, step.events);
          else if (step.kind === "settlement")
            commitModelIn(store, id, step.attempt, step.events, step.costUsd, step.uncertain);
          else commitToolIn(store, id, step.events, step.files, step.metadata);
        }
        activeTurn(store, id);
        return receipt;
      });
    },
    async startModel(extra) {
      return store.transaction(() => startModelIn(store, id, extra));
    },
    async readEvents() {
      return store.events(id);
    },
    async workspace() {
      return store.workspace(id);
    },
    credential: options.credential,
    extensions: options.extensions,
    nativeBash: options.nativeBash,
    signal: options.signal,
    notify: options.notify,
    onControls: options.onControls,
    afterCommit: options.afterCommit,
  };
}
