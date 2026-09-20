import type { ModelProvider, SandboxSpec, WorkspaceMetadata } from "@nimplex/contracts";
import type { SandboxSessionState } from "@nimplex/core";
import { sql } from "drizzle-orm";
import {
  bigint,
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

// Human organization members are independent of end-user attribution records.
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

// Since 2026-09-01, external_user_id is an accounting/audit attribution label.
// Customers manage their own users; org_members is the human identity layer.
export const endUsers = pgTable(
  "end_users",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    /** User identifier in the customer system. */
    externalId: text("external_id").notNull(),
    displayName: text("display_name"),
    metadata: jsonb("metadata"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("end_users_org_external").on(t.orgId, t.externalId)],
);

// Organization API keys for SDKs, CI, and customer backends.
// Return plaintext once and store SHA-256 only; a DB leak alone cannot impersonate keys.
// Future per-key spending limits belong here; no speculative fields yet.
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
    /** Retain revoked rows to preserve evidence that a key existed. */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("api_keys_hash").on(t.keyHash), index("api_keys_org").on(t.orgId)],
);

// BYOK vault stores AES-256-GCM ciphertext, never plaintext.
// Legacy end-user scope remains in storage; the public BYOK API is organization-scoped.
export const providerKeys = pgTable(
  "provider_keys",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    /** Null denotes the organization default. */
    endUserId: uuid("end_user_id").references(() => endUsers.id, { onDelete: "cascade" }),
    provider: text("provider").$type<ModelProvider>().notNull(),
    ciphertext: text("ciphertext").notNull(),
    iv: text("iv").notNull(),
    tag: text("tag").notNull(),
    last4: text("last4").notNull(),
    /** Override upstream base URL for compatible providers or self-hosted proxies. */
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
    /** Required: every run belongs to an organization. */
    endUserId: uuid("end_user_id")
      .notNull()
      .references(() => endUsers.id),
    status: text("status", {
      enum: ["queued", "running", "awaiting_input", "completed", "failed", "killed", "canceled"],
    })
      .notNull()
      .default("queued"),
    /** Selected model provider and model ID. */
    modelProvider: text("model_provider").$type<ModelProvider>().notNull().default("anthropic"),
    model: text("model").notNull(),
    /** Selected sandbox provider. */
    sandbox: jsonb("sandbox").$type<SandboxSpec>().notNull(),
    /** Human-readable provider sandbox ID. */
    sandboxRef: text("sandbox_ref"),
    /**
     * Serializable sandbox session state, following OpenAI agents-core.
     * A replacement worker can reconnect and destroy the same environment.
     */
    sandboxState: jsonb("sandbox_state").$type<SandboxSessionState>(),
    /** { instructions, input, credentials } */
    config: jsonb("config").notNull(),
    spentUsd: usd("spent_usd").notNull().default(sql`0`),
    maxDurationSeconds: integer("max_duration_seconds"),
    /** Atomic event sequence counter used by appendRunEvents. */
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

// Append-only events resume by (run_id, seq), with Last-Event-ID equal to seq.
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

// Work queue: each loop step is claimable work, following Omnara.
// Leases and fencing reject late writes from workers that recover after takeover.
export const workItems = pgTable(
  "work_items",
  {
    id: id(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    /** `harness` leases one whole Pi harness operation; `model`/`tool` schedule per turn. */
    kind: text("kind", { enum: ["model", "tool", "harness"] }).notNull(),
    payload: jsonb("payload"),
    status: text("status", { enum: ["pending", "leased", "done", "failed"] })
      .notNull()
      .default("pending"),
    fence: integer("fence").notNull().default(0),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    /** Earliest claim time; a scheduled run waits here in `pending` until then. */
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    index("work_items_claim").on(t.status, t.leaseExpiresAt),
    index("work_items_available").on(t.status, t.availableAt),
  ],
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
    status: text("status", { enum: ["started", "settled", "unknown"] }).notNull(),
    costUsd: usd("cost_usd"),
    createdAt: createdAt(),
  },
  (t) => [index("model_calls_run").on(t.orgId, t.runId)],
);

// USD usage records retain attribution for customer accounting and exports.
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
    /** Organization/time index for accounting rollups independent of end-user labels. */
    index("usage_org_time").on(t.orgId, t.createdAt),
  ],
);

// Append-only audit records connect credentials, spending, and actions.
export const auditEvents = pgTable(
  "audit_events",
  {
    id: id(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    /** Organization-level actions have no end-user attribution. */
    endUserId: uuid("end_user_id").references(() => endUsers.id),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    meta: jsonb("meta"),
    createdAt: createdAt(),
  },
  (t) => [index("audit_org_time").on(t.orgId, t.createdAt)],
);

// Pi AgentHarness storage, organization-scoped. Rows mirror the local SQLite adapter:
// JSON payloads stay as text so digests and journal replay are byte-stable, and the
// immutable commit journal can rebuild every projection table.
const piScope = {
  orgId: uuid("org_id")
    .notNull()
    .references(() => orgs.id, { onDelete: "cascade" }),
  sessionId: text("session_id").notNull(),
};
export const piSessions = pgTable(
  "pi_sessions",
  {
    ...piScope,
    format: text("format").notNull(),
    nextSeq: integer("next_seq").notNull(),
    stats: text("stats").notNull(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.sessionId] })],
);
export const piEntries = pgTable(
  "pi_entries",
  {
    ...piScope,
    id: text("id").notNull(),
    parentId: text("parent_id"),
    seq: integer("seq").notNull(),
    timestamp: bigint("timestamp", { mode: "number" }).notNull(),
    type: text("type").notNull(),
    customType: text("custom_type"),
    data: text("data").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.sessionId, t.id] }),
    uniqueIndex("pi_entries_seq").on(t.orgId, t.sessionId, t.seq),
    index("pi_entries_type").on(t.orgId, t.sessionId, t.type, t.seq),
  ],
);
export const piCommits = pgTable(
  "pi_commits",
  {
    ...piScope,
    commitId: uuid("commit_id").notNull(),
    firstSeq: integer("first_seq").notNull(),
    lastSeq: integer("last_seq").notNull(),
    digest: text("digest").notNull(),
    data: text("data").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.sessionId, t.commitId] }),
    uniqueIndex("pi_commits_first_seq").on(t.orgId, t.sessionId, t.firstSeq),
  ],
);
export const piUsage = pgTable(
  "pi_usage",
  {
    ...piScope,
    id: text("id").notNull(),
    seq: integer("seq").notNull(),
    data: text("data").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.sessionId, t.id] }),
    uniqueIndex("pi_usage_seq").on(t.orgId, t.sessionId, t.seq),
  ],
);
export const piValues = pgTable(
  "pi_values",
  {
    ...piScope,
    namespace: text("namespace").notNull(),
    key: text("key").notNull(),
    seq: integer("seq").notNull(),
    data: text("data").notNull(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.sessionId, t.namespace, t.key] })],
);
export const piLists = pgTable(
  "pi_lists",
  {
    ...piScope,
    namespace: text("namespace").notNull(),
    key: text("key").notNull(),
    seq: integer("seq").notNull(),
    data: text("data").notNull(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.sessionId, t.namespace, t.key, t.seq] })],
);
