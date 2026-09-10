import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db, DbExecutor } from "./client.ts";
import { runs, workspaceFiles } from "./schema.ts";

/** Tier 0 file tree: absolute path -> bytes. */
export type WorkspaceFiles = Record<string, Uint8Array>;

export interface WorkspaceChange {
  path: string;
  action: "write" | "delete";
  bytes: number;
}

export async function loadWorkspace(db: Db, runId: string, orgId: string): Promise<WorkspaceFiles> {
  const rows = await db
    .select({ path: workspaceFiles.path, content: workspaceFiles.content })
    .from(workspaceFiles)
    .innerJoin(runs, and(eq(runs.id, workspaceFiles.runId), eq(runs.orgId, orgId)))
    .where(eq(workspaceFiles.runId, runId));
  return Object.fromEntries(rows.map((r) => [r.path, r.content]));
}

/** Write-through diff: upsert changed files, delete removed ones. Returns what changed. */
export async function saveWorkspace(
  executor: DbExecutor,
  runId: string,
  before: WorkspaceFiles,
  after: WorkspaceFiles,
  orgId: string,
): Promise<WorkspaceChange[]> {
  const [owner] = await executor
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.id, runId), eq(runs.orgId, orgId)));
  if (!owner) throw new Error("workspace not found");
  const changes: WorkspaceChange[] = [];
  const upserts: (typeof workspaceFiles.$inferInsert)[] = [];
  for (const [path, content] of Object.entries(after)) {
    const prev = before[path];
    if (prev && Buffer.compare(prev, content) === 0) continue;
    upserts.push({ runId, path, content, updatedAt: new Date() });
    changes.push({ path, action: "write", bytes: content.byteLength });
  }
  const removed = Object.keys(before).filter((path) => !(path in after));
  for (const path of removed) changes.push({ path, action: "delete", bytes: 0 });

  if (upserts.length > 0) {
    await executor
      .insert(workspaceFiles)
      .values(upserts)
      .onConflictDoUpdate({
        target: [workspaceFiles.runId, workspaceFiles.path],
        set: { content: sql`excluded.content`, updatedAt: sql`excluded.updated_at` },
      });
  }
  if (removed.length > 0) {
    await executor
      .delete(workspaceFiles)
      .where(and(eq(workspaceFiles.runId, runId), inArray(workspaceFiles.path, removed)));
  }
  return changes;
}
