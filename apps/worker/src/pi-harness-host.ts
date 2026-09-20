// PostgreSQL host for the Pi harness engine. Every commit runs inside one fenced
// transaction: the lease and run are locked first, Pi's session writes land in the
// organization-scoped pi_* tables, then the derived events, accounting and workspace
// revision follow. A worker that lost its lease cannot commit anything.
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core/harness/context";
import { type OperationState, operationState } from "@earendil-works/pi-agent-core/harness/session";
import { type ExecutorEvent, type ExecutorRunContext, isTerminal } from "@nimplex/core";
import {
  appendRunEvents,
  type Db,
  type DbExecutor,
  type DbHandle,
  listRunEvents,
  loadWorkspace,
  type RunRow,
  type WorkspaceFiles,
} from "@nimplex/db";
import type { HarnessTurnHost } from "@nimplex/runtime/pi-harness-engine";
import { sql } from "drizzle-orm";
import {
  alive,
  commitModelIn,
  commitToolIn,
  type Lease,
  LostLeaseError,
  lockOwnedRun,
  startModelIn,
} from "./checkpoints.ts";
import { type PiSqlExecutor, PostgresPiStorage } from "./pi-storage.ts";

/** Run a `$n`-parameterized statement through a drizzle executor. */
export function drizzleExecutor(tx: DbExecutor): PiSqlExecutor {
  return async (query, params) => {
    const pieces = query.split(/\$(\d+)/);
    // Bind each value as one parameter: drizzle expands bare arrays into SQL tuples.
    const parts = pieces.map((piece, index) =>
      index % 2 === 0 ? sql.raw(piece) : sql.param(params[Number(piece) - 1]),
    );
    const rows = await tx.execute(sql.join(parts, sql.raw("")));
    return Array.from(rows as Iterable<Record<string, unknown>>);
  };
}

export interface PostgresHarnessHostOptions {
  db: Db;
  client: DbHandle["client"];
  lease: Lease;
  run: RunRow;
  credential: ExecutorRunContext["credential"];
  nativeBash: ExecutorRunContext["nativeBash"];
  signal: AbortSignal;
  onTerminal(): void;
}

interface HarnessRunConfig {
  instructions: string;
  input: string | null;
  execution_mode?: "build" | "read_only";
  context_mode?: "continue" | "reset" | "compact";
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  /** Pi session shared by a run lineage; defaults to the root run's id. */
  session?: string;
}

export async function postgresHarnessHost(
  options: PostgresHarnessHostOptions,
): Promise<HarnessTurnHost> {
  const { db, client, lease, run } = options;
  const config = run.config as HarnessRunConfig;
  const sessionId = config.session ?? run.id;
  const fenced = <T>(operation: (tx: DbExecutor, current: RunRow) => Promise<T>) =>
    db.transaction(async (tx) => operation(tx, await lockOwnedRun(tx, lease, run)));
  const storage = await PostgresPiStorage.open(
    client,
    { tenantId: run.orgId, sessionId },
    { transaction: (operation) => fenced((tx) => operation(drizzleExecutor(tx))) },
  );
  let files: WorkspaceFiles | undefined;
  return {
    turn: {
      id: run.id,
      sessionId,
      prompt: config.input ?? config.instructions,
      instructions: config.instructions,
      executionMode: config.execution_mode ?? "build",
      contextMode: config.context_mode ?? "continue",
      thinkingLevel: config.thinking ?? "off",
      model: { provider: run.modelProvider, id: run.model },
      billing: "api",
    },
    storage,
    commit: (writes, steps) =>
      fenced(async (tx, current) => {
        const terminal = isTerminal(current.status);
        if (terminal) {
          options.onTerminal();
          const ids = [run.id, `${run.id}:reset`, `${run.id}:compact`];
          // A terminal run can only reconcile an already-owned cancellation. New
          // model/tool dispatch and successful workspace mutations remain forbidden.
          const requested = writes.some(
            (write) =>
              write.kind === "value" &&
              write.op === "set" &&
              write.namespace === operationState(run.id).namespace &&
              ids.includes(write.key) &&
              (write.value as OperationState).control.status === "cancel_requested",
          );
          const stored = requested
            ? []
            : await Promise.all(
                ids.map((id) => storage.getValue(operationState(id), BACKGROUND_CONTEXT)),
              );
          if (
            !requested &&
            !stored.some((state) => state?.value.control.status === "cancel_requested")
          )
            alive(current);
          if (
            steps.some((step) =>
              step.events.some(
                (event) =>
                  event.type === "tool.started" ||
                  (event.type === "tool.result" &&
                    !(event.payload as { is_error?: boolean }).is_error),
              ),
            )
          )
            alive(current);
        }
        const receipt = await storage.commitIn(drizzleExecutor(tx), writes);
        for (const step of steps) {
          if (step.kind === "events") await appendRunEvents(tx, current, step.events);
          else if (step.kind === "settlement")
            await commitModelIn(
              tx,
              current,
              step.attempt,
              step.events,
              step.costUsd,
              step.uncertain,
            );
          else {
            if (terminal) {
              // Cancellation may produce synthetic tool errors; retain them without
              // persisting the interrupted tool's partially modified workspace.
              await appendRunEvents(tx, current, step.events);
              continue;
            }
            const before = files ?? (await loadWorkspace(db, run.id, run.orgId));
            await commitToolIn(tx, current, step.events, before, step.files, step.metadata);
            files = step.files;
          }
        }
        return receipt;
      }),
    startModel: (extra) => fenced((tx, current) => startModelIn(tx, current, lease, extra)),
    readEvents: () => listRunEvents(db, run.id, run.orgId, true) as Promise<ExecutorEvent[]>,
    async workspace() {
      files = await loadWorkspace(db, run.id, run.orgId);
      const [current] = await db.execute<{ workspace_metadata: RunRow["workspaceMetadata"] }>(
        sql`select workspace_metadata from runs where id = ${run.id} and org_id = ${run.orgId}`,
      );
      return { files, metadata: current?.workspace_metadata ?? run.workspaceMetadata };
    },
    credential: options.credential,
    nativeBash: options.nativeBash,
    signal: options.signal,
    // Ownership loss leaves the operation resumable for the successor; kills cancel durably.
    detachOnAbort: (reason) => reason instanceof LostLeaseError,
  };
}
