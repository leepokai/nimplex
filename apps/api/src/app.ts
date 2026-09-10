import { posix } from "node:path";
import {
  addMemberRequest,
  createApiKeyRequest,
  createOrgRequest,
  createRunRequest,
  type ModelProvider,
  putProviderKeyRequest,
  updateMemberRequest,
} from "@nimplex/contracts";
import { isTerminal, listPricedModels } from "@nimplex/core";
import {
  apiKeys,
  appendRunEvents,
  auditEvents,
  type Db,
  endUsers,
  events,
  findProviderKeyRow,
  generateApiKey,
  hashToken,
  killRun,
  last4,
  listProviderKeys,
  orgMembers,
  orgs,
  providerKeys,
  type RunRow,
  runs,
  seal,
  transcriptEventPayload,
  workItems,
  workspaceFiles,
} from "@nimplex/db";
import { listSandboxProviders } from "@nimplex/sandbox";
import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { type Auth, authProviderStatus } from "./auth.ts";
import { PG_UNIQUE_VIOLATION, pgErrorCode } from "./pg-errors.ts";

/** 兩種程式化身分：org API key（SDK / CI）與 console session（Better Auth cookie）。 */
type Identity =
  | { kind: "api_key"; orgId: string; keyId: string }
  | { kind: "session"; userId: string; email: string };

export function createApp(db: Db, auth: Auth) {
  const app = new Hono<{ Variables: { orgId: string; identity: Identity } }>();

  app.get("/health", (c) => c.json({ ok: true }));

  // Better Auth：console 登入／註冊／session 全走這裡。
  app.on(["POST", "GET"], "/api/auth/*", (c) => auth.handler(c.req.raw));

  // 公開端點：哪些登入方式已設定（AuthScreen 據此渲染按鈕，不用寫死）。
  app.get("/api/auth-providers", (c) => c.json(authProviderStatus()));

  // ---- 認證：/v1/* 一律要有身分 ----
  // Bearer nmx_live_…（org API key）或 Better Auth session cookie。
  // Console 能做的事 = SDK 能做的事（不變式 I5）——兩種身分打的是同一組 endpoint。
  app.use("/v1/*", async (c, next) => {
    const header = c.req.header("authorization");
    if (header?.startsWith("Bearer ")) {
      const token = header.slice(7).trim();
      const row = await db.query.apiKeys.findFirst({
        where: eq(apiKeys.keyHash, hashToken(token)),
      });
      if (!row || row.revokedAt) {
        return c.json({ error: "invalid_api_key", detail: "API key 不存在或已撤銷" }, 401);
      }
      c.set("identity", { kind: "api_key", orgId: row.orgId, keyId: row.id });
      // 熱路徑外的順手帳：更新失敗不影響請求
      void db
        .update(apiKeys)
        .set({ lastUsedAt: new Date() })
        .where(eq(apiKeys.id, row.id))
        .catch(() => {});
      return next();
    }
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (session) {
      c.set("identity", {
        kind: "session",
        userId: session.user.id,
        email: session.user.email,
      });
      return next();
    }
    return c.json(
      {
        error: "unauthorized",
        detail: "帶 org API key（Authorization: Bearer nmx_live_…）或先登入 console",
      },
      401,
    );
  });

  // ---- organizations ----
  // 註冊在 org 上下文 middleware 之前：就算 header 指到進不去的 org，
  // console 也還列得出清單、自救得回來。
  app.get("/v1/orgs", async (c) => {
    const identity = c.get("identity");
    if (identity.kind === "api_key") {
      const org = await db.query.orgs.findFirst({ where: eq(orgs.id, identity.orgId) });
      return c.json({ orgs: org ? [toOrgResponse(org)] : [] });
    }
    const rows = await memberOrgs(db, identity.email);
    return c.json({ orgs: rows.map(toOrgResponse) });
  });

  app.post("/v1/orgs", async (c) => {
    const identity = c.get("identity");
    if (identity.kind !== "session") {
      return c.json({ error: "session_required", detail: "建立 org 請從 console 登入後操作" }, 403);
    }
    const parsed = createOrgRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "invalid_request", issues: parsed.error.issues }, 400);
    }
    const row = await db.transaction(async (tx) => {
      const [org] = await tx.insert(orgs).values({ name: parsed.data.name }).returning();
      if (!org) throw new Error("org insert failed");
      await tx.insert(orgMembers).values({ orgId: org.id, email: identity.email, role: "owner" });
      return org;
    });
    return c.json(toOrgResponse(row), 201);
  });

  // org 上下文：API key 綁死自己的 org；session 依成員資格解析，
  // x-nimplex-org header 只在使用者是該 org 成員時生效。
  app.use("/v1/*", async (c, next) => {
    const identity = c.get("identity");
    if (identity.kind === "api_key") {
      c.set("orgId", identity.orgId);
      return next();
    }
    const memberships = await memberOrgs(db, identity.email);
    if (memberships.length === 0) {
      return c.json({ error: "no_org", detail: "這個帳號不屬於任何 organization" }, 403);
    }
    const requested = c.req.header("x-nimplex-org");
    if (requested) {
      if (!UUID_RE.test(requested)) return c.json({ error: "unknown_org" }, 404);
      const hit = memberships.find((o) => o.id === requested);
      if (!hit) return c.json({ error: "unknown_org" }, 404);
      c.set("orgId", hit.id);
    } else {
      const first = memberships[0];
      if (!first) return c.json({ error: "no_org" }, 403);
      c.set("orgId", first.id);
    }
    await next();
  });

  // ---- org API keys（程式化身分）----

  app.get("/v1/api-keys", async (c) => {
    const orgId = c.get("orgId");
    const rows = await db.query.apiKeys.findMany({
      where: eq(apiKeys.orgId, orgId),
      orderBy: asc(apiKeys.createdAt),
    });
    return c.json({ api_keys: rows.map(toApiKeyResponse) });
  });

  /** 明文 key 只在這個回應出現一次；落地只有 sha256。 */
  app.post("/v1/api-keys", async (c) => {
    const orgId = c.get("orgId");
    const parsed = createApiKeyRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "invalid_request", issues: parsed.error.issues }, 400);
    }
    const key = generateApiKey();
    const [row] = await db
      .insert(apiKeys)
      .values({ orgId, name: parsed.data.name, keyHash: hashToken(key), last4: last4(key) })
      .returning();
    if (!row) throw new Error("api key insert failed");
    await db.insert(auditEvents).values({
      orgId,
      actor: actorOf(c.get("identity")),
      action: "api_key.created",
      meta: { name: row.name, last4: row.last4 },
    });
    return c.json({ ...toApiKeyResponse(row), key }, 201);
  });

  /** 撤銷＝標記不刪列；被撤銷的 key 當下起全部 401。 */
  app.delete("/v1/api-keys/:id", async (c) => {
    const orgId = c.get("orgId");
    const [row] = await db
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiKeys.orgId, orgId), eq(apiKeys.id, c.req.param("id"))))
      .returning();
    if (!row) return c.json({ error: "not_found" }, 404);
    await db.insert(auditEvents).values({
      orgId,
      actor: actorOf(c.get("identity")),
      action: "api_key.revoked",
      meta: { name: row.name, last4: row.last4 },
    });
    return c.body(null, 204);
  });

  // ---- org members（登入 console 的「人」）----

  app.get("/v1/members", async (c) => {
    const orgId = c.get("orgId");
    const rows = await db.query.orgMembers.findMany({
      where: eq(orgMembers.orgId, orgId),
      orderBy: asc(orgMembers.createdAt),
    });
    return c.json({ members: rows.map(toMemberResponse) });
  });

  app.post("/v1/members", async (c) => {
    const orgId = c.get("orgId");
    const parsed = addMemberRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "invalid_request", issues: parsed.error.issues }, 400);
    }
    try {
      const [row] = await db
        .insert(orgMembers)
        .values({ orgId, email: parsed.data.email, role: parsed.data.role })
        .returning();
      if (!row) throw new Error("member insert failed");
      return c.json(toMemberResponse(row), 201);
    } catch (err) {
      if (isUniqueViolation(err)) return c.json({ error: "already_member" }, 409);
      throw err;
    }
  });

  app.patch("/v1/members/:id", async (c) => {
    const orgId = c.get("orgId");
    const parsed = updateMemberRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "invalid_request", issues: parsed.error.issues }, 400);
    }
    const target = await db.query.orgMembers.findFirst({
      where: and(eq(orgMembers.orgId, orgId), eq(orgMembers.id, c.req.param("id"))),
    });
    if (!target) return c.json({ error: "not_found" }, 404);
    if (target.role === "owner" && parsed.data.role !== "owner") {
      const owners = await db.query.orgMembers.findMany({
        where: and(eq(orgMembers.orgId, orgId), eq(orgMembers.role, "owner")),
      });
      if (owners.length <= 1) {
        return c.json({ error: "last_owner", detail: "org 至少要留一個 owner" }, 400);
      }
    }
    const [row] = await db
      .update(orgMembers)
      .set({ role: parsed.data.role })
      .where(eq(orgMembers.id, target.id))
      .returning();
    if (!row) throw new Error("member update failed");
    return c.json(toMemberResponse(row));
  });

  app.delete("/v1/members/:id", async (c) => {
    const orgId = c.get("orgId");
    const target = await db.query.orgMembers.findFirst({
      where: and(eq(orgMembers.orgId, orgId), eq(orgMembers.id, c.req.param("id"))),
    });
    if (!target) return c.json({ error: "not_found" }, 404);
    if (target.role === "owner") {
      const owners = await db.query.orgMembers.findMany({
        where: and(eq(orgMembers.orgId, orgId), eq(orgMembers.role, "owner")),
      });
      if (owners.length <= 1) {
        return c.json({ error: "last_owner", detail: "org 至少要留一個 owner" }, 400);
      }
    }
    await db.delete(orgMembers).where(eq(orgMembers.id, target.id));
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
    const orgId = c.get("orgId");
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
    const orgId = c.get("orgId");
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
          .where(and(eq(providerKeys.id, existing.id), eq(providerKeys.orgId, orgId)))
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
    const orgId = c.get("orgId");
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
    const orgId = c.get("orgId");
    const parsed = createRunRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "invalid_request", issues: parsed.error.issues }, 400);
    }
    const body = parsed.data;

    // Slice 1 runs every tool in-process (just-bash); no sandbox is allocated, so provider
    // availability is not checked here. Re-gate when Tier 2 escalation lands.
    if (body.model.provider !== "anthropic") {
      return c.json(
        {
          error: "unsupported_provider",
          detail: `model provider "${body.model.provider}" is not wired yet (anthropic only)`,
        },
        400,
      );
    }

    // Missing BYOK must fail at creation time, not halfway through the run.
    const key = await findProviderKeyRow(db, orgId, body.model.provider, null);
    if (!key) {
      return c.json(
        {
          error: "missing_provider_key",
          detail: `no ${body.model.provider} provider key yet (PUT /v1/provider-keys)`,
        },
        400,
      );
    }

    // external_user_id is only an attribution label; default bucket when absent.
    const externalUserId = body.external_user_id ?? "default";
    const endUser = await getOrCreateEndUser(db, orgId, externalUserId);

    try {
      const run = await db.transaction(async (tx) => {
        const [created] = await tx
          .insert(runs)
          .values({
            orgId,
            endUserId: endUser.id,
            modelProvider: body.model.provider,
            model: body.model.id,
            sandbox: body.sandbox,
            config: {
              instructions: body.instructions,
              input: body.input ?? null,
              metadata: body.metadata ?? null,
            },
            budgetUsd: body.budget_usd,
            maxDurationSeconds: body.max_duration_seconds ?? null,
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
            model: body.model,
            sandbox: body.sandbox,
            budget_usd: body.budget_usd,
          },
        });
        await tx.insert(workItems).values({
          runId: created.id,
          kind: "model",
          payload: { step: 1 },
        });
        await tx.insert(auditEvents).values({
          orgId,
          endUserId: endUser.id,
          runId: created.id,
          actor: "api",
          action: "run.created",
          meta: {
            sandbox_provider: body.sandbox.provider,
            model: body.model,
            budget_usd: body.budget_usd,
          },
        });
        return created;
      });
      return c.json(toRunResponse(run, externalUserId), 201);
    } catch (err) {
      if (isUniqueViolation(err)) return c.json({ error: "duplicate_client_nonce" }, 409);
      throw err;
    }
  });

  app.get("/v1/runs", async (c) => {
    const orgId = c.get("orgId");
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
    const found = await findRunWithEndUser(db, c.get("orgId"), c.req.param("id"));
    if (!found) return c.json({ error: "not_found" }, 404);
    return c.json(toRunResponse(found.run, found.endUserExternalId));
  });

  // Tier 0: the run's durable file tree. Readable while the run is live and after it ended.
  app.get("/v1/runs/:id/files", async (c) => {
    const found = await findRunWithEndUser(db, c.get("orgId"), c.req.param("id"));
    if (!found) return c.json({ error: "not_found" }, 404);
    const rows = await db
      .select({
        path: workspaceFiles.path,
        bytes: sql<number>`length(${workspaceFiles.content})`.mapWith(Number),
        updatedAt: workspaceFiles.updatedAt,
      })
      .from(workspaceFiles)
      .innerJoin(runs, and(eq(runs.id, workspaceFiles.runId), eq(runs.orgId, found.run.orgId)))
      .where(eq(workspaceFiles.runId, found.run.id))
      .orderBy(asc(workspaceFiles.path));
    const [checkpoint] = await db
      .select({ createdAt: events.createdAt })
      .from(events)
      .innerJoin(runs, and(eq(runs.id, events.runId), eq(runs.orgId, found.run.orgId)))
      .where(and(eq(events.runId, found.run.id), eq(events.type, "workspace.committed")))
      .orderBy(desc(events.seq))
      .limit(1);
    return c.json({
      files: [
        ...rows.map((r) => ({
          path: r.path,
          bytes: r.bytes,
          updated_at: r.updatedAt.toISOString(),
          kind: "file" as const,
          mode: found.run.workspaceMetadata[r.path]?.mode ?? 420,
        })),
        ...Object.entries(found.run.workspaceMetadata)
          .filter(([, entry]) => entry.kind !== "file")
          .map(([path, entry]) => ({
            path,
            ...entry,
            bytes: 0,
            updated_at: (checkpoint?.createdAt ?? found.run.createdAt).toISOString(),
          })),
      ].sort((a, b) => a.path.localeCompare(b.path)),
    });
  });

  /** Raw bytes of one file: GET /v1/runs/:id/file?path=/workspace/hello.txt */
  app.get("/v1/runs/:id/file", async (c) => {
    const found = await findRunWithEndUser(db, c.get("orgId"), c.req.param("id"));
    if (!found) return c.json({ error: "not_found" }, 404);
    let path = c.req.query("path");
    if (!path) return c.json({ error: "invalid_request", detail: "path query is required" }, 400);
    path = posix.normalize(path);
    for (let depth = 0; depth < 32; depth++) {
      if (!path.startsWith("/workspace/")) return c.json({ error: "not_found" }, 404);
      const parts = path.split("/");
      let followed = false;
      for (let i = 2; i < parts.length; i++) {
        const prefix = parts.slice(0, i + 1).join("/");
        const entry = found.run.workspaceMetadata[prefix];
        if (entry?.kind !== "symlink" || entry.target === undefined) continue;
        path = posix.resolve(posix.dirname(prefix), entry.target, ...parts.slice(i + 1));
        followed = true;
        break;
      }
      if (!followed) break;
      if (depth === 31) return c.json({ error: "invalid_request", detail: "symlink cycle" }, 400);
    }
    const [row] = await db
      .select({ content: workspaceFiles.content })
      .from(workspaceFiles)
      .innerJoin(runs, and(eq(runs.id, workspaceFiles.runId), eq(runs.orgId, found.run.orgId)))
      .where(and(eq(workspaceFiles.runId, found.run.id), eq(workspaceFiles.path, path)));
    if (!row) return c.json({ error: "not_found" }, 404);
    return c.body(Buffer.from(row.content), 200, { "content-type": "application/octet-stream" });
  });

  app.post("/v1/runs/:id/cancel", async (c) => {
    const found = await findRunWithEndUser(db, c.get("orgId"), c.req.param("id"));
    if (!found) return c.json({ error: "not_found" }, 404);
    const { run, endUserExternalId } = found;
    if (isTerminal(run.status)) return c.json(toRunResponse(run, endUserExternalId));

    const updated = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(runs)
        .set({ status: "canceled", completedAt: new Date() })
        .where(
          and(
            eq(runs.id, run.id),
            eq(runs.orgId, run.orgId),
            sql`${runs.status} in ('queued','running','awaiting_input')`,
          ),
        )
        .returning();
      if (!row) {
        const current = await tx.query.runs.findFirst({
          where: and(eq(runs.id, run.id), eq(runs.orgId, run.orgId)),
        });
        if (!current) throw new Error("run not found");
        return current;
      }
      await appendRunEvents(tx, run, [{ type: "run.canceled" }]);
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
    const found = await findRunWithEndUser(db, c.get("orgId"), c.req.param("id"));
    if (!found) return c.json({ error: "not_found" }, 404);
    const reason = c.req.query("reason") ?? "manual_kill";
    await killRun(db, found.run, reason, "api");
    const after = await findRunWithEndUser(db, c.get("orgId"), found.run.id);
    return c.json(toRunResponse(after?.run ?? found.run, found.endUserExternalId));
  });

  app.get("/v1/runs/:id/events", async (c) => {
    const id = c.req.param("id");
    const found = await findRunWithEndUser(db, c.get("orgId"), id);
    if (!found) return c.json({ error: "not_found" }, 404);

    const raw = c.req.header("Last-Event-ID") ?? c.req.query("after");
    let after = raw === undefined ? -1 : Number(raw);
    if (Number.isNaN(after)) after = -1;

    return streamSSE(c, async (stream) => {
      for (;;) {
        if (stream.aborted || stream.closed) break;
        // Read status first: observing terminal must be followed by draining its committed events.
        const current = await db.query.runs.findFirst({
          where: and(eq(runs.id, id), eq(runs.orgId, found.run.orgId)),
          columns: { status: true },
        });
        const rows = await db
          .select({
            seq: events.seq,
            type: events.type,
            payload: transcriptEventPayload,
            createdAt: events.createdAt,
          })
          .from(events)
          .innerJoin(runs, and(eq(runs.id, events.runId), eq(runs.orgId, found.run.orgId)))
          .where(and(eq(events.runId, id), gt(events.seq, after)))
          .orderBy(asc(events.seq));
        for (const row of rows) {
          if (stream.aborted || stream.closed) break;
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

/** 一律帶 orgId 過濾：跨租戶的 run 就當不存在（404，不是 403——不洩漏存在性）。 */
async function findRunWithEndUser(db: Db, orgId: string, id: string) {
  if (!UUID_RE.test(id)) return null;
  const run = await db.query.runs.findFirst({ where: and(eq(runs.id, id), eq(runs.orgId, orgId)) });
  if (!run) return null;
  const endUser = await db.query.endUsers.findFirst({ where: eq(endUsers.id, run.endUserId) });
  return { run, endUserExternalId: endUser?.externalId ?? run.endUserId };
}

async function memberOrgs(db: Db, email: string) {
  const rows = await db
    .select({ id: orgs.id, name: orgs.name, createdAt: orgs.createdAt })
    .from(orgMembers)
    .innerJoin(orgs, eq(orgMembers.orgId, orgs.id))
    .where(eq(orgMembers.email, email))
    .orderBy(asc(orgs.createdAt));
  return rows;
}

function actorOf(identity: Identity): string {
  return identity.kind === "api_key" ? `api_key:${identity.keyId}` : `user:${identity.email}`;
}

function toApiKeyResponse(row: {
  id: string;
  name: string;
  last4: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}) {
  return {
    id: row.id,
    name: row.name,
    last4: row.last4,
    created_at: row.createdAt.toISOString(),
    last_used_at: row.lastUsedAt?.toISOString() ?? null,
    revoked_at: row.revokedAt?.toISOString() ?? null,
  };
}

function toMemberResponse(row: { id: string; email: string; role: string; createdAt: Date }) {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    created_at: row.createdAt.toISOString(),
  };
}

function toRunResponse(run: RunRow, endUserExternalId: string) {
  return {
    id: run.id,
    status: run.status,
    external_user_id: endUserExternalId,
    model: { provider: run.modelProvider as ModelProvider, id: run.model },
    sandbox: run.sandbox,
    sandbox_ref: run.sandboxRef,
    budget_usd: run.budgetUsd,
    spent_usd: run.spentUsd,
    reserved_usd: run.reservedUsd,
    workspace_revision: run.workspaceRevision,
    sandbox_generation: run.sandboxGeneration,
    error: run.error,
    created_at: run.createdAt.toISOString(),
    started_at: run.startedAt?.toISOString() ?? null,
    completed_at: run.completedAt?.toISOString() ?? null,
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toOrgResponse(row: { id: string; name: string; createdAt: Date }) {
  return { id: row.id, name: row.name, created_at: row.createdAt.toISOString() };
}

function isUniqueViolation(err: unknown): boolean {
  return pgErrorCode(err) === PG_UNIQUE_VIOLATION;
}
