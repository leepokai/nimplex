import {
  addMemberRequest,
  createApiKeyRequest,
  createOrgRequest,
  createRunRequest,
  type MeteringMode,
  type ModelProvider,
  mcpServerRequest,
  putProviderKeyRequest,
  skillManifest,
  updateMemberRequest,
  usageQuery,
} from "@nimplex/contracts";
import { executionKind, isTerminal, listPricedModels } from "@nimplex/core";
import {
  apiKeys,
  appendRunEvents,
  auditEvents,
  type Db,
  endUsers,
  events,
  generateApiKey,
  generateRunToken,
  hashToken,
  killRun,
  last4,
  orgMembers,
  orgs,
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
import { type Auth, authProviderStatus } from "./auth.ts";
import {
  BUILTIN_SLUGS,
  deleteOrgHarness,
  listHarnesses,
  parseManifest,
  resolveHarness,
  toHarnessResponse,
  upsertOrgHarness,
} from "./harnesses.ts";
import { PG_UNIQUE_VIOLATION, pgErrorCode } from "./pg-errors.ts";
import {
  deleteMcpServer,
  deleteSkill,
  findMcpServer,
  findSkill,
  listMcpServers,
  listSkills,
  parseWithSlug,
  toMcpServerResponse,
  toSkillResponse,
  upsertMcpServer,
  upsertSkill,
} from "./registries.ts";
import { rollupUsage, UsageQueryError } from "./usage.ts";

/** 兩種程式化身分：org API key（SDK / CI）與 console session（Better Auth cookie）。 */
type Identity =
  | { kind: "api_key"; orgId: string; keyId: string }
  | { kind: "session"; userId: string; email: string };

export function createApp(db: Db, auth: Auth) {
  const app = new Hono<{ Variables: { orgId: string; identity: Identity } }>();

  app.get("/health", (c) => c.json({ ok: true }));

  // 沙箱裡的 harness 打回來的那條線。認的是 run token，不是 org key——掛在 /v1 認證之前。
  app.route("/gw", createGateway(db));

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

  // ---- 插槽 2：harness 註冊表 ----

  app.get("/v1/harnesses", async (c) => {
    const orgId = c.get("orgId");
    const rows = await listHarnesses(db, orgId);
    return c.json({ harnesses: rows.map(toHarnessResponse) });
  });

  app.get("/v1/harnesses/:slug", async (c) => {
    const orgId = c.get("orgId");
    const found = await resolveHarness(db, orgId, c.req.param("slug"));
    if (!found) return c.json({ error: "not_found" }, 404);
    return c.json(toHarnessResponse(found));
  });

  /** 上傳自己的 harness。同名會覆寫內建版本（只在這個 org 生效）。 */
  app.put("/v1/harnesses/:slug", async (c) => {
    const orgId = c.get("orgId");
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
    const orgId = c.get("orgId");
    const removed = await deleteOrgHarness(db, orgId, c.req.param("slug"));
    if (!removed) return c.json({ error: "not_found" }, 404);
    return c.body(null, 204);
  });

  // ---- 工具 registry：agent 用的 skills 與 MCP servers ----
  // 兩者都是 org 層資料、(org_id, slug) 唯一、PUT 冪等覆寫。

  app.get("/v1/skills", async (c) => {
    const rows = await listSkills(db, c.get("orgId"));
    return c.json({ skills: rows.map(toSkillResponse) });
  });

  app.get("/v1/skills/:slug", async (c) => {
    const found = await findSkill(db, c.get("orgId"), c.req.param("slug"));
    if (!found) return c.json({ error: "not_found" }, 404);
    return c.json(toSkillResponse(found));
  });

  app.put("/v1/skills/:slug", async (c) => {
    const orgId = c.get("orgId");
    const slug = c.req.param("slug");
    const parsed = parseWithSlug(skillManifest, slug, await c.req.json().catch(() => null));
    if (!parsed.ok) return c.json(parsed.problem, 400);
    const saved = await upsertSkill(db, orgId, parsed.data);
    await db.insert(auditEvents).values({
      orgId,
      actor: actorOf(c.get("identity")),
      action: "skill.upserted",
      meta: { slug, version: saved.version, enabled: saved.enabled },
    });
    return c.json(toSkillResponse(saved), 200);
  });

  app.delete("/v1/skills/:slug", async (c) => {
    const orgId = c.get("orgId");
    const slug = c.req.param("slug");
    const removed = await deleteSkill(db, orgId, slug);
    if (!removed) return c.json({ error: "not_found" }, 404);
    await db.insert(auditEvents).values({
      orgId,
      actor: actorOf(c.get("identity")),
      action: "skill.deleted",
      meta: { slug },
    });
    return c.body(null, 204);
  });

  app.get("/v1/mcp-servers", async (c) => {
    const rows = await listMcpServers(db, c.get("orgId"));
    return c.json({ mcp_servers: rows.map(toMcpServerResponse) });
  });

  app.get("/v1/mcp-servers/:slug", async (c) => {
    const found = await findMcpServer(db, c.get("orgId"), c.req.param("slug"));
    if (!found) return c.json({ error: "not_found" }, 404);
    return c.json(toMcpServerResponse(found));
  });

  /** auth 只收 broker 引用：contracts 層就擋掉沒有 broker 前綴的字串，明文 token 到不了這裡。 */
  app.put("/v1/mcp-servers/:slug", async (c) => {
    const orgId = c.get("orgId");
    const slug = c.req.param("slug");
    const parsed = parseWithSlug(mcpServerRequest, slug, await c.req.json().catch(() => null));
    if (!parsed.ok) return c.json(parsed.problem, 400);
    const saved = await upsertMcpServer(db, orgId, parsed.data);
    await db.insert(auditEvents).values({
      orgId,
      actor: actorOf(c.get("identity")),
      action: "mcp_server.upserted",
      meta: { slug, auth: saved.auth, enabled: saved.enabled },
    });
    return c.json(toMcpServerResponse(saved), 200);
  });

  app.delete("/v1/mcp-servers/:slug", async (c) => {
    const orgId = c.get("orgId");
    const slug = c.req.param("slug");
    const removed = await deleteMcpServer(db, orgId, slug);
    if (!removed) return c.json({ error: "not_found" }, 404);
    await db.insert(auditEvents).values({
      orgId,
      actor: actorOf(c.get("identity")),
      action: "mcp_server.deleted",
      meta: { slug },
    });
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

    const harness = await resolveHarness(db, orgId, body.harness);
    if (!harness) {
      return c.json(
        { error: "unknown_harness", detail: `harness "${body.harness}" 不在註冊表裡` },
        400,
      );
    }
    const kind = executionKind(harness.manifest);
    const usesSandbox = kind === "sandbox";
    // 內建 loop 不打任何上游；沙箱與 managed-agent 都要 BYOK key
    const needsProviderKey = kind !== "builtin-loop";

    // harness manifest 決定講哪一種協定、用哪一把 key；model 必須是同一家。
    if (needsProviderKey && body.model.provider !== harness.manifest.provider) {
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
    if (needsProviderKey) {
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

    // Managed Agents 的錶是上游回報的 list cost，不是閘道實測——誠實標記
    // provider_reported 只有 Managed Agents 走得到（上游回報花費、上游強制上限）；
    // 其他 harness 的錢都經閘道，收了這個模式等於 budget_usd 存了卻沒人強制——直接拒絕。
    if (kind !== "managed-agent" && body.metering === "provider_reported") {
      return c.json(
        {
          error: "invalid_metering",
          detail:
            "metering=provider_reported 只適用 claude-managed-agent；沙箱 harness 請用 exact 或 none",
        },
        400,
      );
    }
    const metering =
      kind === "managed-agent" && body.metering === "exact" ? "provider_reported" : body.metering;

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
            metering,
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
            metering,
            // Make any rewrite explicit (claude-managed-agent: exact -> provider_reported) so it is
            // visible in both the response and the event stream
            ...(metering !== body.metering ? { metering_adjusted_from: body.metering } : {}),
            budget_usd: body.budget_usd ?? null,
          },
        });
        await tx.insert(workItems).values({
          runId: created.id,
          kind: kind === "builtin-loop" ? "model" : "harness",
          payload: kind === "builtin-loop" ? { step: 1 } : {},
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

  app.post("/v1/runs/:id/cancel", async (c) => {
    const found = await findRunWithEndUser(db, c.get("orgId"), c.req.param("id"));
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

  // ---- 帳務 rollup ----
  // 錶與 harness 無關：每一筆花費都在 usage_records，這裡按窗口分桶加總給人看。
  app.get("/v1/usage", async (c) => {
    const parsed = usageQuery.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: "invalid_request", issues: parsed.error.issues }, 400);
    }
    try {
      return c.json(await rollupUsage(db, c.get("orgId"), parsed.data));
    } catch (err) {
      if (err instanceof UsageQueryError) {
        return c.json({ error: err.code, detail: err.message }, 400);
      }
      throw err;
    }
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toOrgResponse(row: { id: string; name: string; createdAt: Date }) {
  return { id: row.id, name: row.name, created_at: row.createdAt.toISOString() };
}

function isUniqueViolation(err: unknown): boolean {
  return pgErrorCode(err) === PG_UNIQUE_VIOLATION;
}
