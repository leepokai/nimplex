import { z } from "zod";

/** Identity of an experimental Pi AgentHarness store; never inferred from a tool. */
export const piStorageScope = z.object({
  tenantId: z.string().min(1).max(128),
  sessionId: z.string().min(1).max(128),
});
export type PiStorageScope = z.infer<typeof piStorageScope>;

/** Separate from legacy AgentSession JSONL versions and the existing local engine. */
export const piStorageFormat = z.object({
  version: z.literal(1),
  engine: z.literal("pi-agent-harness"),
  piVersion: z.literal("0.85.1"),
});
export type PiStorageFormat = z.infer<typeof piStorageFormat>;

/** Opaque pinned-Pi writes; consumers must use the declared engine's projector. */
export const piStorageCommit = z.object({
  version: z.literal(1),
  format: piStorageFormat,
  scope: piStorageScope,
  commitId: z.uuid(),
  committedAt: z.number().int().nonnegative(),
  firstSeq: z.number().int().positive(),
  writes: z.array(z.json()).min(1),
});
export type PiStorageCommit = z.infer<typeof piStorageCommit>;

/** Pi 3.x extension-facing records, derived atomically from the pinned harness writes. */
export const piCompatibilityEntry = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("custom"),
    id: z.string().min(1),
    parentId: z.string().nullable(),
    timestamp: z.iso.datetime(),
    customType: z.string(),
    data: z.json().optional(),
  }),
  z.object({
    type: z.literal("message"),
    id: z.string().min(1),
    parentId: z.string().nullable(),
    timestamp: z.iso.datetime(),
    message: z.json(),
  }),
  z.object({
    type: z.literal("compaction"),
    id: z.string().min(1),
    parentId: z.string().nullable(),
    timestamp: z.iso.datetime(),
    summary: z.string(),
    firstKeptEntryId: z.string().min(1),
    tokensBefore: z.number().nonnegative(),
    details: z.json().optional(),
    usage: z.json().optional(),
    fromHook: z.boolean(),
  }),
  z.object({
    type: z.literal("branch_summary"),
    id: z.string().min(1),
    parentId: z.string().nullable(),
    timestamp: z.iso.datetime(),
    fromId: z.string().min(1),
    summary: z.string(),
    details: z.json().optional(),
    usage: z.json().optional(),
    fromHook: z.boolean(),
  }),
  z.object({
    type: z.literal("model_change"),
    id: z.string().min(1),
    parentId: z.string().nullable(),
    timestamp: z.iso.datetime(),
    provider: z.string().min(1),
    modelId: z.string().min(1),
  }),
  z.object({
    type: z.literal("thinking_level_change"),
    id: z.string().min(1),
    parentId: z.string().nullable(),
    timestamp: z.iso.datetime(),
    thinkingLevel: z.string(),
  }),
  z.object({
    type: z.literal("session_info"),
    id: z.string().min(1),
    parentId: z.string().nullable(),
    timestamp: z.iso.datetime(),
    name: z.string().optional(),
  }),
  z.object({
    type: z.literal("label"),
    id: z.string().min(1),
    parentId: z.string().nullable(),
    timestamp: z.iso.datetime(),
    targetId: z.string().min(1),
    label: z.string().optional(),
  }),
]);
export type PiCompatibilityEntry = z.infer<typeof piCompatibilityEntry>;

/** Derived tail nodes never masquerade as native history; the native payload stays intact. */
export const piCompatibilityCompaction = z.object({
  version: z.literal(1),
  nativeEntryId: z.string().min(1),
  firstKeptEntryId: z.string().min(1),
  derivedEntryIds: z.array(z.string().min(1)),
});
export type PiCompatibilityCompaction = z.infer<typeof piCompatibilityCompaction>;

/** Native details envelope preserving the exact legacy retention boundary and extension payload. */
export const piExtensionCompaction = z.object({
  kind: z.literal("nimplex.pi.extension.compaction"),
  version: z.literal(1),
  firstKeptEntryId: z.string().min(1),
  details: z.json().optional(),
});
export type PiExtensionCompaction = z.infer<typeof piExtensionCompaction>;

/** Native value mutations have no Pi entry ID; their projected history receives one atomically. */
export const piCompatibilityMetadata = z.object({
  version: z.literal(1),
  entryId: z.string().min(1),
  lane: z.string().min(1),
  namespace: z.enum(["pi.lane.config", "pi.session.name", "pi.entry.label"]),
  key: z.string(),
  sourceWriteIndex: z.number().int().nonnegative(),
});
export type PiCompatibilityMetadata = z.infer<typeof piCompatibilityMetadata>;

export const piCompatibilityHeader = z.object({
  version: z.literal(3),
  piVersion: z.literal("0.85.1"),
  header: z.object({
    type: z.literal("session"),
    version: z.literal(3),
    id: z.string().min(1),
    timestamp: z.iso.datetime(),
    cwd: z.string(),
  }),
});
export type PiCompatibilityHeader = z.infer<typeof piCompatibilityHeader>;

/** Recoverable compound extension action; contains no provider credentials. */
export const piExtensionModelChange = z.object({
  version: z.literal(1),
  id: z.uuid(),
  status: z.enum(["accepted", "applied"]),
  model: z.object({ provider: z.string().min(1), modelId: z.string().min(1) }),
  thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
});
export type PiExtensionModelChange = z.infer<typeof piExtensionModelChange>;

/** Original structural provider response, committed atomically with its Pi usage row. */
export const piSummaryResponse = z.object({
  version: z.literal(1),
  operationId: z.string().min(1),
  lane: z.string().min(1),
  taskId: z.string().min(1),
  kind: z.enum(["compaction", "branch_summary"]),
  attempt: z.number().int().positive(),
  requestIndex: z.number().int().nonnegative(),
  usageId: z.string().min(1),
  model: z.object({ provider: z.string().min(1), modelId: z.string().min(1) }),
  response: z.json(),
  delivered: z.object({
    stopReason: z.enum(["pending", "stop", "length", "toolUse", "error", "aborted", "deferred"]),
    errorMessage: z.string().optional(),
  }),
});
export type PiSummaryResponse = z.infer<typeof piSummaryResponse>;
