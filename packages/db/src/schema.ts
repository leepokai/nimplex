import type { ModelProvider, SandboxSpec, WorkspaceMetadata } from "@nimplex/contracts";
import type { SandboxSessionState } from "@nimplex/core";
import { sql } from "drizzle-orm";
import {
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const id = () => uuid("id").primaryKey().default(sql`gen_random_uuid()`);
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const usd = (name: string) => numeric(name, { precision: 12, scale: 6, mode: "number" });
// drizzle 0.45 has no bytea column; postgres.js returns Buffer for bytea.
const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType: () => "bytea",
  toDriver: (value) => Buffer.from(value),
  fromDriver: (value) => new Uint8Array(value),
});

export const orgs = pgTable("orgs", {
  id: id(),
  name: text("name").notNull(),
  createdAt: createdAt(),
});

// Console 登入者。與 end_users 無任何繼承關係——這是刻意的（spec Q4）。
export const orgMembers = pgTable(
  "org_members",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role", { enum: ["owner", "admin", "member"] })
      .notNull()
      .default("member"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("org_members_org_email").on(t.orgId, t.email)],
);

// 2026-09-01 起降級為歸因標籤桶：external_user_id 只進帳目與稽核，
// 誰是客戶的使用者由客戶自理。「人」的身分層只有 org_members。
export const endUsers = pgTable(
  "end_users",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    /** 客戶系統裡的 user id */
    externalId: text("external_id").notNull(),
    displayName: text("display_name"),
    metadata: jsonb("metadata"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("end_users_org_external").on(t.orgId, t.externalId)],
);

// 程式化身分：org API key（SDK / CI / 客戶後端用）。
// 明文只在建立當下回傳一次，落地只有 sha256——DB 外洩不足以冒用任何 key（不變式 I3 同款）。
// 未來的花費控制掛點是 per-key limit（OpenRouter 模式），欄位先不建、掛點留在這張表。
export const apiKeys = pgTable(
  "api_keys",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    keyHash: text("key_hash").notNull(),
    last4: text("last4").notNull(),
    createdAt: createdAt(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    /** 撤銷＝標記不刪列：稽核要能回答「這把 key 曾經存在過」 */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("api_keys_hash").on(t.keyHash), index("api_keys_org").on(t.orgId)],
);

// 插槽 1：BYOK 保險庫。明文永不落地，只存 AES-256-GCM 密文。
// 解析優先序 end_user > org —— 同一個 org 底下每個終端使用者可以燒自己的帳。
export const providerKeys = pgTable(
  "provider_keys",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    /** null ＝ org 層預設 */
    endUserId: uuid("end_user_id").references(() => endUsers.id, { onDelete: "cascade" }),
    provider: text("provider").$type<ModelProvider>().notNull(),
    ciphertext: text("ciphertext").notNull(),
    iv: text("iv").notNull(),
    tag: text("tag").notNull(),
    last4: text("last4").notNull(),
    /** 覆寫上游 base URL（自架 proxy、Azure 等） */
    baseUrl: text("base_url"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("provider_keys_org_provider")
      .on(t.orgId, t.provider)
      .where(sql`${t.endUserId} is null`),
    uniqueIndex("provider_keys_end_user_provider")
      .on(t.orgId, t.endUserId, t.provider)
      .where(sql`${t.endUserId} is not null`),
  ],
);

export const runs = pgTable(
  "runs",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    /** NOT NULL：沒有無主的 run */
    endUserId: uuid("end_user_id")
      .notNull()
      .references(() => endUsers.id),
    status: text("status", {
      enum: ["queued", "running", "awaiting_input", "completed", "failed", "killed", "canceled"],
    })
      .notNull()
      .default("queued"),
    /** 插槽 1：走哪一家、哪個 model */
    modelProvider: text("model_provider").$type<ModelProvider>().notNull().default("anthropic"),
    model: text("model").notNull(),
    /** 插槽 3：跑在哪個 sandbox provider */
    sandbox: jsonb("sandbox").$type<SandboxSpec>().notNull(),
    /** provider 端的箱子 id，給人看的 */
    sandboxRef: text("sandbox_ref"),
    /**
     * 可序列化的 sandbox session state（OpenAI agents-core 的作法）。
     * worker 無狀態、隨時可死——任何一個 worker 讀到這欄都能接回同一個箱子把它砍掉。
     */
    sandboxState: jsonb("sandbox_state").$type<SandboxSessionState>(),
    /** { instructions, input, credentials } */
    config: jsonb("config").notNull(),
    /** Hard USD cap: the run is killed once spend reaches it. */
    budgetUsd: usd("budget_usd"),
    spentUsd: usd("spent_usd").notNull().default(sql`0`),
    /** 已發出但還沒結算的預留額度（併發保險） */
    reservedUsd: usd("reserved_usd").notNull().default(sql`0`),
    maxDurationSeconds: integer("max_duration_seconds"),
    /** 事件序號計數器，appendRunEvents 用原子遞增分配 seq */
    eventSeq: integer("event_seq").notNull().default(0),
    workspaceRevision: integer("workspace_revision").notNull().default(0),
    workspaceMetadata: jsonb("workspace_metadata").$type<WorkspaceMetadata>().notNull().default({}),
    sandboxGeneration: integer("sandbox_generation").notNull().default(0),
    error: text("error"),
    clientNonce: text("client_nonce"),
    createdAt: createdAt(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("runs_org_nonce").on(t.orgId, t.clientNonce),
    index("runs_org_end_user").on(t.orgId, t.endUserId),
    index("runs_status").on(t.status),
  ],
);

// append-only 事件流。SSE 以 (run_id, seq) 續傳（Last-Event-ID = seq）。
export const events = pgTable(
  "events",
  {
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    type: text("type").notNull(),
    payload: jsonb("payload"),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.seq] })],
);

// Tier 0 durable workspace: the run's file tree, written through on every turn in the same
// transaction as the turn's events. A sandbox (just-bash VFS today, a real box later) is only a
// cache of this table; a worker that dies loses nothing.
// ponytail: whole files per row, no history; add a snapshot + write-event replay when repos get big.
export const workspaceFiles = pgTable(
  "workspace_files",
  {
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    /** Absolute path inside the sandbox, e.g. /workspace/src/index.ts */
    path: text("path").notNull(),
    content: bytea("content").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.path] })],
);

// 工作佇列：loop 的每一步都是一個可領取的 work item（Omnara 模式）。
// lease + fence 防止卡住又醒來的 worker 雙寫（Rakazo/Omnara 同款）。
export const workItems = pgTable(
  "work_items",
  {
    id: id(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["model", "tool"] }).notNull(),
    payload: jsonb("payload"),
    status: text("status", { enum: ["pending", "leased", "done", "failed"] })
      .notNull()
      .default("pending"),
    fence: integer("fence").notNull().default(0),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    createdAt: createdAt(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [index("work_items_claim").on(t.status, t.leaseExpiresAt)],
);

// A reservation is created before dispatch. Unknown outcomes retain their entire allowance.
export const modelCalls = pgTable(
  "model_calls",
  {
    id: uuid("id").primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    workItemId: uuid("work_item_id")
      .notNull()
      .references(() => workItems.id),
    fence: integer("fence").notNull(),
    status: text("status", { enum: ["reserved", "settled", "unknown"] }).notNull(),
    reservedUsd: usd("reserved_usd").notNull(),
    costUsd: usd("cost_usd"),
    inputTokenBound: integer("input_token_bound").notNull(),
    maxOutputTokens: integer("max_output_tokens").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("model_calls_run").on(t.orgId, t.runId)],
);

// 每一分錢都掛在 end_user 上——可轉售計量的基礎（Omnara 只記 token，這裡記美元）。
export const usageRecords = pgTable(
  "usage_records",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    endUserId: uuid("end_user_id")
      .notNull()
      .references(() => endUsers.id),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
    kind: text("kind").notNull(),
    amountUsd: usd("amount_usd").notNull(),
    meta: jsonb("meta"),
    createdAt: createdAt(),
  },
  (t) => [
    index("usage_org_end_user_time").on(t.orgId, t.endUserId, t.createdAt),
    /** 帳務 rollup（GET /v1/usage）按 org × 時間窗口掃，不經 end_user */
    index("usage_org_time").on(t.orgId, t.createdAt),
  ],
);

// append-only 稽核：憑證 × 花費 × 動作。
export const auditEvents = pgTable(
  "audit_events",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    /** nullable：org 層動作沒有 end user */
    endUserId: uuid("end_user_id").references(() => endUsers.id),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    meta: jsonb("meta"),
    createdAt: createdAt(),
  },
  (t) => [index("audit_org_time").on(t.orgId, t.createdAt)],
);
