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

// ---- 插槽 2：harness ----
// harness 是「資料」不是 enum：內建的與使用者上傳的走同一份 manifest，
// 所以「用網路上的 harness」跟「上傳自己的 harness」在系統裡是同一件事。
export const HARNESS_SOURCE_KINDS = ["npm", "git", "image", "inline"] as const;

export const harnessSource = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("npm"),
    package: z.string().min(1),
    version: z.string().default("latest"),
  }),
  z.object({ kind: z.literal("git"), repo: z.string().url(), ref: z.string().default("HEAD") }),
  z.object({ kind: z.literal("image"), image: z.string().min(1) }),
  /** inline：沒有外部來源，install 步驟自己寫完（給完全自訂的 harness 用） */
  z.object({ kind: z.literal("inline") }),
]);
export type HarnessSource = z.infer<typeof harnessSource>;

/** harness 讀哪一種輸出格式；MVP 只解析 stdout 的兩種。 */
export const HARNESS_OUTPUTS = ["text", "stream-json"] as const;
export const harnessOutput = z.enum(HARNESS_OUTPUTS);
export type HarnessOutput = z.infer<typeof harnessOutput>;

/**
 * 上傳自己的 harness ＝ POST 這份 manifest。
 *
 * 模板變數（`install` / `command` / `env` 都會展開）：
 *   {{gateway.anthropic}} {{gateway.openai}} {{gateway.openrouter}}  ← nimplex 閘道 base URL
 *   {{run.token}}   ← 只在這個 run 有效的短期票（不是使用者的真 key）
 *   {{run.id}} {{model}} {{prompt}} {{workdir}}
 */
export const harnessManifest = z.object({
  slug: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "slug 只能用小寫英數與連字號"),
  name: z.string().min(1).max(128),
  version: z.string().min(1).max(64).default("0.0.0"),
  description: z.string().max(512).optional(),
  source: harnessSource,
  /** 在沙箱裡依序執行的安裝指令 */
  install: z.array(z.string().min(1)).max(20).default([]),
  /** 啟動指令；沒有 {{prompt}} 的話 prompt 會從 stdin 餵進去 */
  command: z.string().min(1),
  /** 注入沙箱的環境變數。base URL 指向 nimplex 閘道，key 是短期票。 */
  env: z.record(z.string(), z.string()).default({}),
  /** 這個 harness 打哪一家的 API —— 決定閘道用哪個協定與哪把 BYOK key */
  provider: modelProvider,
  output: harnessOutput.default("text"),
  workdir: z.string().default("/workspace"),
  /** 沙箱裡的硬性上限，避免壞掉的 harness 永遠不結束 */
  timeout_seconds: z.number().int().positive().max(86_400).default(1800),
});
export type HarnessManifest = z.infer<typeof harnessManifest>;

export const harnessResponse = harnessManifest.extend({
  id: z.string(),
  builtin: z.boolean(),
  created_at: z.string(),
});
export type HarnessResponse = z.infer<typeof harnessResponse>;

// ---- 插槽 3：sandbox provider ----
export const SANDBOX_PROVIDERS = ["local", "docker", "e2b", "vercel", "daytona"] as const;
export const sandboxProvider = z.enum(SANDBOX_PROVIDERS);
export type SandboxProviderId = z.infer<typeof sandboxProvider>;

export const sandboxSpec = z.object({
  provider: sandboxProvider.default("local"),
  /** 覆寫 harness manifest 的 image（docker / e2b template 等） */
  image: z.string().optional(),
  cpu: z.number().positive().max(16).optional(),
  memory_mb: z.number().int().positive().max(65_536).optional(),
  snapshot: z.string().optional(),
});
export type SandboxSpec = z.infer<typeof sandboxSpec>;

// ---- 計量模式 ----
// exact：model 流量走閘道，美元硬上限是真的。
// none：走訂閱席次等不經過我們的路徑 —— 只能給時間/次數上限，不准設 budget_usd。
export const METERING_MODES = ["exact", "none"] as const;
export const meteringMode = z.enum(METERING_MODES);
export type MeteringMode = z.infer<typeof meteringMode>;

// ---- 建立 run ----
// external_user_id 是可選的歸因標籤：只進帳目與稽核，方便呼叫端自己 rollup。
// 誰是你的使用者、每個使用者能花多少——由呼叫端在自己那端管。
export const createRunRequest = z
  .object({
    external_user_id: z.string().min(1).optional(),
    /** harness slug，對應註冊表裡的 manifest（內建或自己上傳的） */
    harness: z.string().min(1).default("builtin"),
    model: modelSpec,
    sandbox: sandboxSpec.default({ provider: "local" }),
    instructions: z.string().min(1),
    input: z.string().optional(),
    metering: meteringMode.default("exact"),
    /** metering=exact 時必填；metering=none 時禁止 */
    budget_usd: z.number().positive().optional(),
    /** metering=none 的替代上限 */
    max_duration_seconds: z.number().int().positive().max(86_400).optional(),
    /** 憑證只接受 broker 引用（如 "nango:conn_abc"），永不接受明文 */
    credentials: z.array(z.string()).default([]),
    client_nonce: z.string().min(1).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((v) => (v.metering === "exact" ? v.budget_usd !== undefined : true), {
    message: "metering=exact 必須設 budget_usd",
    path: ["budget_usd"],
  })
  .refine((v) => (v.metering === "none" ? v.budget_usd === undefined : true), {
    message: "metering=none 無法保證美元上限，請改用 max_duration_seconds",
    path: ["budget_usd"],
  });
export type CreateRunRequest = z.infer<typeof createRunRequest>;

export const runResponse = z.object({
  id: z.string(),
  status: runStatus,
  external_user_id: z.string().nullable(),
  harness: z.string(),
  model: modelSpec,
  sandbox: sandboxSpec,
  sandbox_ref: z.string().nullable(),
  metering: meteringMode,
  budget_usd: z.number().nullable(),
  spent_usd: z.number(),
  error: z.string().nullable(),
  created_at: z.string(),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
});
export type RunResponse = z.infer<typeof runResponse>;

export const createRunResponse = runResponse.extend({
  /** 只在建立時回傳一次：沙箱裡的 harness 用這張短期票打閘道 */
  run_token: z.string().nullable(),
});
export type CreateRunResponse = z.infer<typeof createRunResponse>;

export const runListResponse = z.object({ runs: z.array(runResponse) });
export type RunListResponse = z.infer<typeof runListResponse>;

export const runEvent = z.object({
  seq: z.number().int().nonnegative(),
  type: z.string(),
  payload: z.unknown().optional(),
  created_at: z.string(),
});
export type RunEvent = z.infer<typeof runEvent>;

// ---- BYOK 憑證 ----
export const putProviderKeyRequest = z.object({
  provider: modelProvider,
  /** 明文只在這一個請求裡出現，落地即加密，之後只能拿到 last4 */
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
