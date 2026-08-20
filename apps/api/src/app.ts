import { createRunRequest } from "@loopbox/contracts";
import { isTerminal } from "@loopbox/core";
import {
  appendRunEvents,
  auditEvents,
  type Db,
  endUsers,
  events,
  runs,
  workItems,
} from "@loopbox/db";
import { and, asc, eq, gt } from "drizzle-orm";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

type RunRow = typeof runs.$inferSelect;

// TODO(auth)：MVP 尚未有 API key／org 驗證，只供本機開發。
export function createApp(db: Db, orgId: string) {
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true }));

  app.post("/v1/runs", async (c) => {
    const parsed = createRunRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "invalid_request", issues: parsed.error.issues }, 400);
    }
    const body = parsed.data;

    const endUser = await getOrCreateEndUser(db, orgId, body.end_user);

    try {
      const run = await db.transaction(async (tx) => {
        const [created] = await tx
          .insert(runs)
          .values({
            orgId,
            endUserId: endUser.id,
            harness: body.harness,
            config: {
              model: body.model,
              instructions: body.instructions,
              input: body.input ?? null,
              credentials: body.credentials,
            },
            budgetUsd: body.budget_usd,
            clientNonce: body.client_nonce,
            eventSeq: 1,
          })
          .returning();
        if (!created) throw new Error("insert run failed");
        await tx.insert(events).values({
          runId: created.id,
          seq: 0,
          type: "run.created",
          payload: { end_user: body.end_user, budget_usd: body.budget_usd },
        });
        await tx
          .insert(workItems)
          .values({ runId: created.id, kind: "model", payload: { step: 1 } });
        await tx.insert(auditEvents).values({
          orgId,
          endUserId: endUser.id,
          runId: created.id,
          actor: "api",
          action: "run.created",
          meta: { harness: body.harness, budget_usd: body.budget_usd },
        });
        return created;
      });
      return c.json(toRunResponse(run, body.end_user), 201);
    } catch (err) {
      if (isUniqueViolation(err)) return c.json({ error: "duplicate_client_nonce" }, 409);
      throw err;
    }
  });

  app.get("/v1/runs/:id", async (c) => {
    const found = await findRunWithEndUser(db, c.req.param("id"));
    if (!found) return c.json({ error: "not_found" }, 404);
    return c.json(toRunResponse(found.run, found.endUserExternalId));
  });

  app.post("/v1/runs/:id/cancel", async (c) => {
    const found = await findRunWithEndUser(db, c.req.param("id"));
    if (!found) return c.json({ error: "not_found" }, 404);
    const { run, endUserExternalId } = found;
    if (isTerminal(run.status)) return c.json(toRunResponse(run, endUserExternalId));

    const updated = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(runs)
        .set({ status: "canceled", completedAt: new Date() })
        .where(eq(runs.id, run.id))
        .returning();
      if (!row) throw new Error("cancel failed");
      await appendRunEvents(tx, run.id, [{ type: "run.canceled" }]);
      await tx.insert(auditEvents).values({
        orgId: run.orgId,
        endUserId: run.endUserId,
        runId: run.id,
        actor: "api",
        action: "run.canceled",
      });
      return row;
    });
    return c.json(toRunResponse(updated, endUserExternalId));
  });

  app.get("/v1/runs/:id/events", async (c) => {
    const id = c.req.param("id");
    const run = await db.query.runs.findFirst({ where: eq(runs.id, id) });
    if (!run) return c.json({ error: "not_found" }, 404);

    const raw = c.req.header("Last-Event-ID") ?? c.req.query("after");
    let after = raw === undefined ? -1 : Number(raw);
    if (Number.isNaN(after)) after = -1;

    return streamSSE(c, async (stream) => {
      for (;;) {
        const rows = await db
          .select()
          .from(events)
          .where(and(eq(events.runId, id), gt(events.seq, after)))
          .orderBy(asc(events.seq));
        for (const row of rows) {
          after = row.seq;
          await stream.writeSSE({
            id: String(row.seq),
            event: row.type,
            data: JSON.stringify({
              seq: row.seq,
              type: row.type,
              payload: row.payload,
              created_at: row.createdAt.toISOString(),
            }),
          });
        }
        const current = await db.query.runs.findFirst({
          where: eq(runs.id, id),
          columns: { status: true },
        });
        if (!current || isTerminal(current.status)) break;
        await stream.sleep(400);
      }
    });
  });

  return app;
}

async function getOrCreateEndUser(db: Db, orgId: string, externalId: string) {
  const found = await db.query.endUsers.findFirst({
    where: and(eq(endUsers.orgId, orgId), eq(endUsers.externalId, externalId)),
  });
  if (found) return found;
  const [created] = await db
    .insert(endUsers)
    .values({ orgId, externalId })
    .onConflictDoNothing()
    .returning();
  if (created) return created;
  const again = await db.query.endUsers.findFirst({
    where: and(eq(endUsers.orgId, orgId), eq(endUsers.externalId, externalId)),
  });
  if (!again) throw new Error("end user upsert failed");
  return again;
}

async function findRunWithEndUser(db: Db, id: string) {
  const run = await db.query.runs.findFirst({ where: eq(runs.id, id) });
  if (!run) return null;
  const endUser = await db.query.endUsers.findFirst({ where: eq(endUsers.id, run.endUserId) });
  return { run, endUserExternalId: endUser?.externalId ?? run.endUserId };
}

function toRunResponse(run: RunRow, endUserExternalId: string) {
  return {
    id: run.id,
    status: run.status,
    end_user: endUserExternalId,
    harness: run.harness,
    budget_usd: run.budgetUsd,
    spent_usd: run.spentUsd,
    error: run.error,
    created_at: run.createdAt.toISOString(),
    started_at: run.startedAt?.toISOString() ?? null,
    completed_at: run.completedAt?.toISOString() ?? null,
  };
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "23505";
}
