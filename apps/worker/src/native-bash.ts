import { type ExecutorRunContext, isTerminal } from "@nimplex/core";
import { appendRunEvents, type Db, listRunEvents, type RunRow, runs } from "@nimplex/db";
import { createNativeBash as createRunner } from "@nimplex/runtime/native-bash";
import { getSandboxProvider } from "@nimplex/sandbox";
import { and, eq } from "drizzle-orm";
import { type Lease, lockOwnedRun } from "./checkpoints.ts";

/** Cloud ownership is enforced here; native execution has no database dependency. */
export function createNativeBash(
  db: Db,
  lease: Lease,
  run: RunRow,
): NonNullable<ExecutorRunContext["nativeBash"]> {
  return createRunner({
    ...run,
    provider: getSandboxProvider(run.sandbox.provider),
    assertActive: async () => {
      await db.transaction(async (tx) => {
        const current = await lockOwnedRun(tx, lease, run);
        if (current.status !== "running") throw new Error(`run is ${current.status}`);
      });
    },
    recordState: async (state, reset) => {
      await db.transaction(async (tx) => {
        const current = await lockOwnedRun(tx, lease, run);
        if (!["running", "queued"].includes(current.status))
          throw new Error(`run is ${current.status}`);
        const generation = current.sandboxGeneration + 1;
        await tx
          .update(runs)
          .set({
            sandboxState: state,
            sandboxRef: String(
              state.providerState.sandboxId ?? state.providerState.containerId ?? "",
            ),
            sandboxGeneration: generation,
          })
          .where(and(eq(runs.id, run.id), eq(runs.orgId, run.orgId)));
        await appendRunEvents(tx, run, [
          { type: "sandbox.created", payload: { provider: run.sandbox.provider, generation } },
          ...(reset
            ? [
                {
                  type: "environment.reset",
                  payload: {
                    generation,
                    reason: "sandbox_unavailable",
                    workspace_revision: current.workspaceRevision,
                  },
                },
              ]
            : []),
        ]);
      });
    },
    readEvents: () => listRunEvents(db, run.id, run.orgId),
    appendEvents: async (events) => {
      await db.transaction(async (tx) => {
        const current = await lockOwnedRun(tx, lease, run);
        if (isTerminal(current.status)) throw new Error(`run is ${current.status}`);
        await appendRunEvents(tx, run, events);
      });
    },
    generation: async () =>
      db.transaction(async (tx) => (await lockOwnedRun(tx, lease, run)).sandboxGeneration),
    shouldDestroyOnAbort: async () => {
      const current = await db.query.runs.findFirst({
        where: and(eq(runs.id, run.id), eq(runs.orgId, run.orgId)),
      });
      return !!current && isTerminal(current.status);
    },
  });
}
