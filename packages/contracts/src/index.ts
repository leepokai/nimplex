import { z } from "zod";

export * from "./engine.ts";
export * from "./pi-storage.ts";
export * from "./runtime.ts";

// Run states.
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

// Model provider selection.
/** Provider identifiers are supplied by Pi; each deployment validates its supported set. */
export const modelProvider = z.string().min(1);
export type ModelProvider = z.infer<typeof modelProvider>;

export const modelSpec = z.object({
  provider: modelProvider,
  /** Provider model ID, e.g. claude-sonnet-4-5, gpt-5, or anthropic/claude-sonnet-4.5. */
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
});
export type SandboxSpec = z.infer<typeof sandboxSpec>;

export const runResponse = z.object({
  id: z.string(),
  status: runStatus,
  external_user_id: z.string().nullable(),
  model: modelSpec,
  sandbox: sandboxSpec,
  sandbox_ref: z.string().nullable(),
  spent_usd: z.number(),
  /** Subscription usage has no per-request API charge; quota is provider-managed. */
  billing_mode: z.enum(["api", "subscription"]).optional(),
  workspace_revision: z.number().int().nonnegative().optional(),
  sandbox_generation: z.number().int().nonnegative().optional(),
  error: z.string().nullable(),
  created_at: z.string(),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
});
export type RunResponse = z.infer<typeof runResponse>;

export const runEvent = z.object({
  seq: z.number().int().nonnegative(),
  type: z.string(),
  payload: z.unknown().optional(),
  created_at: z.string(),
});
export type RunEvent = z.infer<typeof runEvent>;

// Durable execution identifiers survive process restarts.
export const modelAttempt = z.object({
  call_id: z.string().uuid(),
});
export type ModelAttempt = z.infer<typeof modelAttempt>;

export const contextCheckpoint = z.object({
  version: z.literal(1),
  high_water: z.number().int().nonnegative(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  strategy: z.literal("extractive"),
  messages: z.array(z.record(z.string(), z.unknown())),
});
export type ContextCheckpoint = z.infer<typeof contextCheckpoint>;

// ---- workspace files (Tier 0) ----
// The durable file tree of a session. Readable at any time, including after a turn ended.
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
