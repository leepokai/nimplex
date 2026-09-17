import { posix } from "node:path";
import type { CreateRunRequest, WorkspaceMetadata } from "@nimplex/contracts";
import { checkWorkspaceLimits, continuationMessages, isTerminal } from "@nimplex/core";
import { type DbExecutor, events, runs, workspaceFiles } from "@nimplex/db";
import { and, asc, eq } from "drizzle-orm";

export class RunSeedError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

/** Read the source under its run lock so conversation and workspace share one boundary. */
export async function prepareRunSeed(tx: DbExecutor, orgId: string, body: CreateRunRequest) {
  const files: Record<string, Uint8Array> = {};
  let metadata: WorkspaceMetadata = {};
  let priorMessages: Record<string, unknown>[] = [];
  if (body.parent_run_id) {
    const [parent] = await tx
      .select()
      .from(runs)
      .where(and(eq(runs.id, body.parent_run_id), eq(runs.orgId, orgId)))
      .for("update");
    if (!parent) throw new RunSeedError(404, "parent_run_not_found");
    if (!isTerminal(parent.status)) throw new RunSeedError(409, "parent_run_still_active");
    const rows = await tx
      .select({ path: workspaceFiles.path, content: workspaceFiles.content })
      .from(workspaceFiles)
      .innerJoin(runs, and(eq(runs.id, workspaceFiles.runId), eq(runs.orgId, orgId)))
      .where(eq(workspaceFiles.runId, parent.id));
    for (const row of rows) files[row.path] = row.content;
    metadata = structuredClone(parent.workspaceMetadata);
    if (body.context_mode !== "reset") {
      const history = await tx
        .select({ type: events.type, payload: events.payload })
        .from(events)
        .innerJoin(runs, and(eq(runs.id, events.runId), eq(runs.orgId, orgId)))
        .where(eq(events.runId, parent.id))
        .orderBy(asc(events.seq));
      priorMessages = continuationMessages(parent.config, history);
    }
  }
  for (const attachment of body.attachments ?? []) {
    const path = posix.normalize(attachment.path);
    if (
      path !== attachment.path ||
      !path.startsWith("/workspace/") ||
      path.includes("\0") ||
      path.endsWith("/")
    )
      throw new RunSeedError(400, "invalid_attachment_path");
    for (const [entry, value] of Object.entries(metadata)) {
      if (
        (entry === path && value.kind !== "file") ||
        (path.startsWith(`${entry}/`) && value.kind !== "directory")
      )
        throw new RunSeedError(400, "attachment_path_conflict");
    }
    if (Object.keys(files).some((entry) => entry.startsWith(`${path}/`)))
      throw new RunSeedError(400, "attachment_path_conflict");
    files[path] = Buffer.from(attachment.content);
    metadata[path] = { kind: "file", mode: 0o644 };
  }
  const violation = checkWorkspaceLimits(files, metadata);
  if (violation) throw new RunSeedError(400, violation);
  return { files, metadata, priorMessages };
}
