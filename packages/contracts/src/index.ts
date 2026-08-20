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

// ---- 建立 run ----
// end_user 是第一級物件：每個 run 必須代表某一個終端使用者執行。
// credentials 只接受 broker 引用（如 "nango:conn_abc"），永不接受明文。
export const createRunRequest = z.object({
  end_user: z.string().min(1),
  harness: z.enum(["builtin"]).default("builtin"),
  model: z.string().min(1),
  instructions: z.string().min(1),
  input: z.string().optional(),
  budget_usd: z.number().positive(),
  credentials: z.array(z.string()).default([]),
  client_nonce: z.string().min(1).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type CreateRunRequest = z.infer<typeof createRunRequest>;

export const runResponse = z.object({
  id: z.string(),
  status: runStatus,
  end_user: z.string(),
  harness: z.string(),
  budget_usd: z.number(),
  spent_usd: z.number(),
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
