import { z } from "zod";

// ---- run 狀態 ----
export const RUN_STATUSES = [
  "queued",
  "running",
  "awaiting_input",
  "completed",
  "failed",
  "killed",
  "canceled",
] as const;
export const runStatus = z.enum(RUN_STATUSES);
export type RunStatus = z.infer<typeof runStatus>;

// ---- 插槽 1：LLM provider（BYOK）----
// 使用者自己提供 token；nimplex 只當閘道，key 永不進沙箱。
export const MODEL_PROVIDERS = ["anthropic", "openai", "openrouter"] as const;
export const modelProvider = z.enum(MODEL_PROVIDERS);
export type ModelProvider = z.infer<typeof modelProvider>;

// ---- organizations ----
export const createOrgRequest = z.object({ name: z.string().min(1).max(120) });
export type CreateOrgRequest = z.infer<typeof createOrgRequest>;

export const orgResponse = z.object({
  id: z.string(),
  name: z.string(),
  created_at: z.string(),
});
export type OrgResponse = z.infer<typeof orgResponse>;

export const orgListResponse = z.object({ orgs: z.array(orgResponse) });
export type OrgListResponse = z.infer<typeof orgListResponse>;

// ---- org API keys（程式化身分）----
// 明文只在建立回應出現一次；之後只讀得到 last4。撤銷＝標記不刪列。
export const createApiKeyRequest = z.object({ name: z.string().min(1).max(120) });
export type CreateApiKeyRequest = z.infer<typeof createApiKeyRequest>;

export const apiKeyResponse = z.object({
  id: z.string(),
  name: z.string(),
  last4: z.string(),
  created_at: z.string(),
  last_used_at: z.string().nullable(),
  revoked_at: z.string().nullable(),
});
export type ApiKeyResponse = z.infer<typeof apiKeyResponse>;

export const createApiKeyResponse = apiKeyResponse.extend({
  /** 只在這裡出現一次的明文 key（nmx_live_…），存好再關掉 */
  key: z.string(),
});
export type CreateApiKeyResponse = z.infer<typeof createApiKeyResponse>;

// ---- org members（登入 console 的「人」；你產品的終端使用者不在這層）----
export const ORG_ROLES = ["owner", "admin", "member"] as const;
export const orgRole = z.enum(ORG_ROLES);
export type OrgRole = z.infer<typeof orgRole>;

export const addMemberRequest = z.object({
  email: z.string().email(),
  role: orgRole.default("member"),
});
export type AddMemberRequest = z.infer<typeof addMemberRequest>;

export const updateMemberRequest = z.object({ role: orgRole });
export type UpdateMemberRequest = z.infer<typeof updateMemberRequest>;

export const memberResponse = z.object({
  id: z.string(),
  email: z.string(),
  role: orgRole,
  created_at: z.string(),
});
export type MemberResponse = z.infer<typeof memberResponse>;

/** 2026-09-01 起 BYOK 只有 org 一層；per-user 的帳務切分由呼叫端在自己那端處理。 */
export const CREDENTIAL_SCOPES = ["org"] as const;
export const credentialScope = z.enum(CREDENTIAL_SCOPES);
export type CredentialScope = z.infer<typeof credentialScope>;

export const modelSpec = z.object({
  provider: modelProvider,
  /** provider 端的 model id，如 "claude-sonnet-4-5"、"gpt-5"、"anthropic/claude-sonnet-4.5" */
  id: z.string().min(1),
});
export type ModelSpec = z.infer<typeof modelSpec>;

// ---- sandbox provider ----
export const SANDBOX_PROVIDERS = ["local", "docker", "e2b", "vercel", "daytona"] as const;
export const sandboxProvider = z.enum(SANDBOX_PROVIDERS);
export type SandboxProviderId = z.infer<typeof sandboxProvider>;

export const sandboxSpec = z.object({
  provider: sandboxProvider.default("local"),
  /** Provider image / template override (docker image, e2b template, ...) */
  image: z.string().optional(),
  cpu: z.number().positive().max(16).optional(),
  memory_mb: z.number().int().positive().max(65_536).optional(),
  snapshot: z.string().optional(),
});
export type SandboxSpec = z.infer<typeof sandboxSpec>;

// ---- create run ----
// external_user_id is an optional attribution label: it only lands in usage/audit rows so the
// caller can roll up spend on their side. Who the end user is stays the caller's business.
export const createRunRequest = z.object({
  external_user_id: z.string().min(1).optional(),
  model: modelSpec,
  sandbox: sandboxSpec.default({ provider: "local" }),
  instructions: z.string().min(1),
  input: z.string().optional(),
  /** Hard USD cap: the run is killed the moment spend reaches it. */
  budget_usd: z.number().positive(),
  /** Optional wall-clock cap on top of the USD cap. */
  max_duration_seconds: z.number().int().positive().max(86_400).optional(),
  client_nonce: z.string().min(1).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type CreateRunRequest = z.infer<typeof createRunRequest>;

export const runResponse = z.object({
  id: z.string(),
  status: runStatus,
  external_user_id: z.string().nullable(),
  model: modelSpec,
  sandbox: sandboxSpec,
  sandbox_ref: z.string().nullable(),
  budget_usd: z.number().nullable(),
  spent_usd: z.number(),
  reserved_usd: z.number().optional(),
  workspace_revision: z.number().int().nonnegative().optional(),
  sandbox_generation: z.number().int().nonnegative().optional(),
  error: z.string().nullable(),
  created_at: z.string(),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
});
export type RunResponse = z.infer<typeof runResponse>;

export const runListResponse = z.object({ runs: z.array(runResponse) });
export type RunListResponse = z.infer<typeof runListResponse>;

export const runEvent = z.object({
  seq: z.number().int().nonnegative(),
  type: z.string(),
  payload: z.unknown().optional(),
  created_at: z.string(),
});
export type RunEvent = z.infer<typeof runEvent>;

// Durable execution identifiers survive worker leases and process restarts.
export const modelReservation = z.object({
  call_id: z.string().uuid(),
  input_token_bound: z.number().int().positive(),
  max_output_tokens: z.number().int().positive(),
  reserved_usd: z.number().nonnegative(),
});
export type ModelReservation = z.infer<typeof modelReservation>;

export const durableToolCall = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
});
export type DurableToolCall = z.infer<typeof durableToolCall>;

export const contextCheckpoint = z.object({
  version: z.literal(1),
  high_water: z.number().int().nonnegative(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  strategy: z.literal("extractive"),
  messages: z.array(z.record(z.string(), z.unknown())),
});
export type ContextCheckpoint = z.infer<typeof contextCheckpoint>;

// ---- run workspace files (Tier 0) ----
// The durable file tree of a run. Readable at any time, including after the run ended.
export const workspaceEntryMetadata = z.object({
  kind: z.enum(["file", "directory", "symlink"]),
  mode: z.number().int().min(0).max(4095),
  target: z.string().optional(),
});
export const workspaceMetadata = z.record(z.string(), workspaceEntryMetadata);
export type WorkspaceMetadata = z.infer<typeof workspaceMetadata>;

export const runFileEntry = z.object({
  /** Absolute path inside the workspace, e.g. /workspace/src/index.ts */
  path: z.string(),
  bytes: z.number().int().nonnegative(),
  updated_at: z.string(),
  kind: z.enum(["file", "directory", "symlink"]).optional(),
  mode: z.number().int().optional(),
  target: z.string().optional(),
});
export type RunFileEntry = z.infer<typeof runFileEntry>;

export const runFileListResponse = z.object({ files: z.array(runFileEntry) });
export type RunFileListResponse = z.infer<typeof runFileListResponse>;

// ---- BYOK provider keys ----
export const putProviderKeyRequest = z.object({
  provider: modelProvider,
  /** Plaintext appears only in this request; it is encrypted at rest and only last4 is readable after. */
  api_key: z.string().min(8),
  scope: credentialScope.default("org"),
  base_url: z.string().url().optional(),
});
export type PutProviderKeyRequest = z.infer<typeof putProviderKeyRequest>;

export const providerKeyResponse = z.object({
  id: z.string(),
  provider: modelProvider,
  scope: credentialScope,
  last4: z.string(),
  base_url: z.string().nullable(),
  created_at: z.string(),
});
export type ProviderKeyResponse = z.infer<typeof providerKeyResponse>;
