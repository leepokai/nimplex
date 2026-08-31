import {
  createRunRequest,
  type MeteringMode,
  type ModelProvider,
  putProviderKeyRequest,
} from "@nimplex/contracts";
import { BUILTIN_LOOP_COMMAND, isTerminal, listPricedModels } from "@nimplex/core";
import {
  appendRunEvents,
  auditEvents,
  type Db,
  endUsers,
  events,
  generateRunToken,
  hashToken,
  killRun,
  last4,
  providerKeys,
  type RunRow,
  runs,
  seal,
  workItems,
} from "@nimplex/db";
import { createGateway, findProviderKeyRow, listProviderKeys } from "@nimplex/gateway";
import { getSandboxProvider, hasSandboxProvider, listSandboxProviders } from "@nimplex/sandbox";
import { and, asc, desc, eq, gt } from "drizzle-orm";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
  BUILTIN_SLUGS,
  deleteOrgHarness,
  listHarnesses,
  parseManifest,
  resolveHarness,
  toHarnessResponse,
  upsertOrgHarness,
} from "./harnesses.ts";

// TODO(auth)：MVP 尚未有 API key／org 驗證，只供本機開發。
export function createApp(db: Db, orgId: string) {
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true }));

  // 沙箱裡的 harness 打回來的那條線。掛在公開 API 面上，不是 /internal。
  app.route("/gw", createGateway(db));

  // ---- 插槽 2：harness 註冊表 ----

  app.get("/v1/harnesses", async (c) => {
    const rows = await listHarnesses(db, orgId);
    return c.json({ harnesses: rows.map(toHarnessResponse) });
  });

  app.get("/v1/harnesses/:slug", async (c) => {
    const found = await resolveHarness(db, orgId, c.req.param("slug"));
    if (!found) return c.json({ error: "not_found" }, 404);
    return c.json(toHarnessResponse(found));
  });

  /** 上傳自己的 harness。同名會覆寫內建版本（只在這個 org 生效）。 */
  app.put("/v1/harnesses/:slug", async (c) => {
    const slug = c.req.param("slug");
    const parsed = parseManifest(slug, await c.req.json().catch(() => null));
    if (!parsed.ok) return c.json(parsed.problem, 400);
    const saved = await upsertOrgHarness(db, orgId, parsed.manifest);
    await db.insert(auditEvents).values({
      orgId,
      actor: "api",
      action: "harness.upserted",
      meta: { slug, overrides_builtin: BUILTIN_SLUGS.has(slug) },
    });
    return c.json(toHarnessResponse(saved), 200);
  });

  app.delete("/v1/harnesses/:slug", async (c) => {
    const removed = await deleteOrgHarness(db, orgId, c.req.param("slug"));
    if (!removed) return c.json({ error: "not_found" }, 404);
    return c.body(null, 204);
  });

  // ---- 插槽 3：sandbox provider ----

  app.get("/v1/sandbox-providers", async (c) => {
    const providers = await Promise.all(
      listSandboxProviders().map(async (provider) => ({
        id: provider.backendId,
        available: (await provider.unavailableReason()) === null,
        unavailable_reason: (await provider.unavailableReason()) ?? null,
      })),
    );
    return c.json({ providers });
  });

  // ---- 插槽 1：BYOK ----

  app.get("/v1/provider-keys", async (c) => {
    const rows = await listProviderKeys(db, orgId);
    return c.json({
      provider_keys: rows
        .filter((row) => !row.endUserId)
        .map((row) => ({
          id: row.id,
          provider: row.provider,
          scope: "org",
          last4: row.last4,
          base_url: row.baseUrl,
          created_at: row.createdAt.toISOString(),
        })),
    });
  });

  /** 明文只在這個請求裡出現，落地即 AES-256-GCM 加密，之後只讀得到 last4。 */
  app.put("/v1/provider-keys", async (c) => {
    const parsed = putProviderKeyRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "invalid_request", issues: parsed.error.issues }, 400);
    }
    const body = parsed.data;
    const sealed = seal(body.api_key);
    const values = {
      orgId,
      endUserId: null,
      provider: body.provider,
      ...sealed,
      last4: last4(body.api_key),
      baseUrl: body.base_url ?? null,
    };

    const existing = await findProviderKeyRow(db, orgId, body.provider, null);
    const [row] = existing
      ? await db
          .update(providerKeys)
          .set(values)
          .where(eq(providerKeys.id, existing.id))
          .returning()
      : await db.insert(providerKeys).values(values).returning();
    if (!row) throw new Error("provider key upsert failed");

    await db.insert(auditEvents).values({
      orgId,
      actor: "api",
      action: "provider_key.upserted",
      meta: { provider: body.provider, scope: "org", last4: row.last4 },
    });

    return c.json({
      id: row.id,
      provider: row.provider,
      scope: "org",
      last4: row.last4,
      base_url: row.baseUrl,
      created_at: row.createdAt.toISOString(),
    });
  });

  app.delete("/v1/provider-keys/:id", async (c) => {
    const deleted = await db
      .delete(providerKeys)
      .where(and(eq(providerKeys.orgId, orgId), eq(providerKeys.id, c.req.param("id"))))
      .returning({ id: providerKeys.id });
    if (deleted.length === 0) return c.json({ error: "not_found" }, 404);
    return c.body(null, 204);
  });

  /** 價格表：計量與跑前試算共用同一份資料。 */
  app.get("/v1/models", (c) =>
    c.json({
      models: listPricedModels().map(({ provider, model, rate }) => ({
        provider,
        model,
        input_per_mtok: rate.inputPerMtok,
        output_per_mtok: rate.outputPerMtok,
      })),
    }),
  );

  // ---- runs ----

  app.post("/v1/runs", async (c) => {
    const parsed = createRunRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "invalid_request", issues: parsed.error.issues }, 400);
    }
    const body = parsed.data;

    const harness = await resolveHarness(db, orgId, body.harness);
    if (!harness) {
      return c.json(
        { error: "unknown_harness", detail: `harness "${body.harness}" 不在註冊表裡` },
        400,
      );
    }
    const usesSandbox = harness.manifest.command !== BUILTIN_LOOP_COMMAND;

    // harness manifest 決定講哪一種協定、用哪一把 key；model 必須是同一家。
    if (usesSandbox && body.model.provider !== harness.manifest.provider) {
      return c.json(
        {
          error: "provider_mismatch",
          detail: `harness "${harness.slug}" 講的是 ${harness.manifest.provider}，但 model.provider 是 ${body.model.provider}。要換供應商請上傳一份改了 env 映射的 harness。`,
        },
        400,
      );
    }

    if (usesSandbox) {
      if (!hasSandboxProvider(body.sandbox.provider)) {
        return c.json(
          {
            error: "unknown_sandbox_provider",
            detail: `sandbox provider "${body.sandbox.provider}" 尚未註冊`,
          },
          400,
        );
      }
      const reason = await getSandboxProvider(body.sandbox.provider).unavailableReason();
      if (reason) {
        return c.json({ error: "sandbox_provider_unavailable", detail: reason }, 400);
      }
    }

    // BYOK 缺席要在建立時就擋掉，不要跑到一半才在閘道爆
    if (usesSandbox) {
      const key = await findProviderKeyRow(db, orgId, harness.manifest.provider, null);
      if (!key) {
        return c.json(
          {
            error: "missing_provider_key",
            detail: `尚未提供 ${harness.manifest.provider} 的 BYOK 憑證（PUT /v1/provider-keys）`,
          },
          400,
        );
      }
    }

    // external_user_id 只是歸因標籤；沒給就掛在 org 的 default 桶
    const externalUserId = body.external_user_id ?? "default";
    const endUser = await getOrCreateEndUser(db, orgId, externalUserId);
    const runToken = generateRunToken();

    try {
      const run = await db.transaction(async (tx) => {
        const [created] = await tx
          .insert(runs)
          .values({
            orgId,
            endUserId: endUser.id,
            harness: harness.slug,
            modelProvider: body.model.provider,
            model: body.model.id,
            sandbox: body.sandbox,
            metering: body.metering,
            config: {
              instructions: body.instructions,
              input: body.input ?? null,
              credentials: body.credentials,
              metadata: body.metadata ?? null,
            },
            budgetUsd: body.budget_usd ?? null,
            maxDurationSeconds: body.max_duration_seconds ?? null,
            runTokenHash: hashToken(runToken),
            clientNonce: body.client_nonce,
            eventSeq: 1,
          })
          .returning();
        if (!created) throw new Error("insert run failed");
        await tx.insert(events).values({
          runId: created.id,
          seq: 0,
          type: "run.created",
          payload: {
            external_user_id: externalUserId,
            harness: harness.slug,
            model: body.model,
            sandbox: body.sandbox,
            metering: body.metering,
            budget_usd: body.budget_usd ?? null,
          },
        });
        await tx.insert(workItems).values({
          runId: created.id,
          kind: usesSandbox ? "harness" : "model",
          payload: usesSandbox ? {} : { step: 1 },
        });
        await tx.insert(auditEvents).values({
          orgId,
          endUserId: endUser.id,
          runId: created.id,
          actor: "api",
          action: "run.created",
          meta: {
            harness: harness.slug,
            sandbox_provider: body.sandbox.provider,
            model: body.model,
            budget_usd: body.budget_usd ?? null,
          },
        });
        return created;
      });
      return c.json({ ...toRunResponse(run, externalUserId), run_token: runToken }, 201);
    } catch (err) {
      if (isUniqueViolation(err)) return c.json({ error: "duplicate_client_nonce" }, 409);
      throw err;
    }
  });

  app.get("/v1/runs", async (c) => {
    const limitRaw = Number(c.req.query("limit") ?? 50);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, Math.trunc(limitRaw)), 200) : 50;
    const endUserExt = c.req.query("external_user_id");
    const rows = await db
      .select({ run: runs, endUserExternalId: endUsers.externalId })
      .from(runs)
      .innerJoin(endUsers, eq(runs.endUserId, endUsers.id))
      .where(
        endUserExt
          ? and(eq(runs.orgId, orgId), eq(endUsers.externalId, endUserExt))
          : eq(runs.orgId, orgId),
      )
      .orderBy(desc(runs.createdAt))
      .limit(limit);
    return c.json({ runs: rows.map((r) => toRunResponse(r.run, r.endUserExternalId)) });
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

  /** 立刻軟殺；沙箱由 worker 看到狀態改變後硬殺（destroy）。 */
  app.post("/v1/runs/:id/kill", async (c) => {
    const found = await findRunWithEndUser(db, c.req.param("id"));
    if (!found) return c.json({ error: "not_found" }, 404);
    const reason = c.req.query("reason") ?? "manual_kill";
    await killRun(db, found.run, reason, "api");
    const after = await findRunWithEndUser(db, found.run.id);
    return c.json(toRunResponse(after?.run ?? found.run, found.endUserExternalId));
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
    external_user_id: endUserExternalId,
    harness: run.harness,
    model: { provider: run.modelProvider as ModelProvider, id: run.model },
    sandbox: run.sandbox,
    sandbox_ref: run.sandboxRef,
    metering: run.metering as MeteringMode,
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
