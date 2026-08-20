import { sql } from "drizzle-orm";
import {
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

// 第一級物件：客戶的終端使用者。所有隔離、計量、稽核都掛在這。
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
    /** executor id；未來：\"sandbox:opencode\" 等 */
    harness: text("harness").notNull().default("builtin"),
    /** { model, instructions, input, credentials } */
    config: jsonb("config").notNull(),
    /** 美元硬上限：超額即殺（W2） */
    budgetUsd: usd("budget_usd").notNull(),
    spentUsd: usd("spent_usd").notNull().default(sql`0`),
    /** 事件序號計數器，appendRunEvents 用原子遞增分配 seq */
    eventSeq: integer("event_seq").notNull().default(0),
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
  (t) => [index("usage_org_end_user_time").on(t.orgId, t.endUserId, t.createdAt)],
);

// 只存 broker 引用（如 nango:conn_abc）。
// 這張表永遠不會有明文欄位——憑證由 broker 保管、防火牆層注入（分岔二）。
export const credentialRefs = pgTable(
  "credential_refs",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    endUserId: uuid("end_user_id")
      .notNull()
      .references(() => endUsers.id),
    broker: text("broker").notNull(),
    brokerRef: text("broker_ref").notNull(),
    scopes: jsonb("scopes"),
    createdAt: createdAt(),
  },
  (t) => [index("credential_refs_org_end_user").on(t.orgId, t.endUserId)],
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
