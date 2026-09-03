import type {
  McpServerRequest,
  McpServerResponse,
  SkillManifest,
  SkillResponse,
} from "@nimplex/contracts";
import { type Db, mcpServers, skills } from "@nimplex/db";
import { and, asc, eq } from "drizzle-orm";

/**
 * 工具 registry：agent 用的 skills 與 MCP servers。
 * 兩者都是 org 層資料、以 (org_id, slug) 唯一；PUT 冪等覆寫。
 */

export interface RegistryProblem {
  error: string;
  detail: unknown;
}

interface SlugParser<T> {
  safeParse(
    input: unknown,
  ): { success: true; data: T } | { success: false; error: { issues: unknown } };
}

/** URL 的 slug 是權威：body 沒帶就補上，帶了就必須一致。 */
export function parseWithSlug<T extends { slug: string }>(
  schema: SlugParser<T>,
  slug: string,
  body: unknown,
): { ok: true; data: T } | { ok: false; problem: RegistryProblem } {
  const withSlug = typeof body === "object" && body !== null ? { slug, ...(body as object) } : body;
  const parsed = schema.safeParse(withSlug);
  if (!parsed.success) {
    return { ok: false, problem: { error: "invalid_request", detail: parsed.error.issues } };
  }
  if (parsed.data.slug !== slug) {
    return {
      ok: false,
      problem: { error: "slug_mismatch", detail: { url: slug, body: parsed.data.slug } },
    };
  }
  return { ok: true, data: parsed.data };
}

// ---- skills ----

type SkillRow = typeof skills.$inferSelect;

export function listSkills(db: Db, orgId: string): Promise<SkillRow[]> {
  return db.select().from(skills).where(eq(skills.orgId, orgId)).orderBy(asc(skills.slug));
}

export function findSkill(db: Db, orgId: string, slug: string): Promise<SkillRow | undefined> {
  return db.query.skills.findFirst({ where: and(eq(skills.orgId, orgId), eq(skills.slug, slug)) });
}

export async function upsertSkill(
  db: Db,
  orgId: string,
  manifest: SkillManifest,
): Promise<SkillRow> {
  const fields = {
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    enabled: manifest.enabled,
    files: manifest.files,
  };
  const [row] = await db
    .insert(skills)
    .values({ orgId, slug: manifest.slug, ...fields })
    .onConflictDoUpdate({
      target: [skills.orgId, skills.slug],
      set: { ...fields, updatedAt: new Date() },
    })
    .returning();
  if (!row) throw new Error("skill upsert failed");
  return row;
}

export async function deleteSkill(db: Db, orgId: string, slug: string): Promise<boolean> {
  const deleted = await db
    .delete(skills)
    .where(and(eq(skills.orgId, orgId), eq(skills.slug, slug)))
    .returning({ id: skills.id });
  return deleted.length > 0;
}

export function toSkillResponse(row: SkillRow): SkillResponse {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    version: row.version,
    description: row.description,
    enabled: row.enabled,
    files: row.files,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

// ---- MCP servers ----

type McpServerRow = typeof mcpServers.$inferSelect;

export function listMcpServers(db: Db, orgId: string): Promise<McpServerRow[]> {
  return db
    .select()
    .from(mcpServers)
    .where(eq(mcpServers.orgId, orgId))
    .orderBy(asc(mcpServers.slug));
}

export function findMcpServer(
  db: Db,
  orgId: string,
  slug: string,
): Promise<McpServerRow | undefined> {
  return db.query.mcpServers.findFirst({
    where: and(eq(mcpServers.orgId, orgId), eq(mcpServers.slug, slug)),
  });
}

export async function upsertMcpServer(
  db: Db,
  orgId: string,
  request: McpServerRequest,
): Promise<McpServerRow> {
  const fields = {
    url: request.url,
    auth: request.auth,
    credentialRef: request.credential_ref ?? null,
    enabled: request.enabled,
  };
  const [row] = await db
    .insert(mcpServers)
    .values({ orgId, slug: request.slug, ...fields })
    .onConflictDoUpdate({
      target: [mcpServers.orgId, mcpServers.slug],
      set: { ...fields, updatedAt: new Date() },
    })
    .returning();
  if (!row) throw new Error("mcp server upsert failed");
  return row;
}

export async function deleteMcpServer(db: Db, orgId: string, slug: string): Promise<boolean> {
  const deleted = await db
    .delete(mcpServers)
    .where(and(eq(mcpServers.orgId, orgId), eq(mcpServers.slug, slug)))
    .returning({ id: mcpServers.id });
  return deleted.length > 0;
}

export function toMcpServerResponse(row: McpServerRow): McpServerResponse {
  return {
    id: row.id,
    slug: row.slug,
    url: row.url,
    auth: row.auth,
    credential_ref: row.credentialRef,
    enabled: row.enabled,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}
