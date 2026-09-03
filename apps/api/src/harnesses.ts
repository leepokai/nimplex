import { type HarnessManifest, harnessManifest } from "@nimplex/contracts";
import { BUILTIN_HARNESSES, collectUnknownVariables } from "@nimplex/core";
import { type Db, harnesses, type ResolvedHarness } from "@nimplex/db";
import { and, eq } from "drizzle-orm";
import { parseWithSlug } from "./registries.ts";

export { listHarnesses, resolveHarness } from "@nimplex/db";

export interface HarnessValidationError {
  error: string;
  detail: unknown;
}

/** 上傳自己的 harness：驗 manifest 形狀（slug 以 URL 為準），再驗它引用的模板變數存不存在。 */
export function parseManifest(
  slug: string,
  body: unknown,
): { ok: true; manifest: HarnessManifest } | { ok: false; problem: HarnessValidationError } {
  const parsed = parseWithSlug(harnessManifest, slug, body);
  if (!parsed.ok) {
    const error =
      parsed.problem.error === "invalid_request" ? "invalid_manifest" : parsed.problem.error;
    return { ok: false, problem: { error, detail: parsed.problem.detail } };
  }
  const unknown = collectUnknownVariables(parsed.data);
  if (unknown.length > 0) {
    return { ok: false, problem: { error: "unknown_template_variables", detail: unknown } };
  }
  return { ok: true, manifest: parsed.data };
}

export async function upsertOrgHarness(
  db: Db,
  orgId: string,
  manifest: HarnessManifest,
): Promise<ResolvedHarness> {
  const existing = await db.query.harnesses.findFirst({
    where: and(eq(harnesses.orgId, orgId), eq(harnesses.slug, manifest.slug)),
  });
  const [row] = existing
    ? await db
        .update(harnesses)
        .set({ manifest, updatedAt: new Date() })
        .where(eq(harnesses.id, existing.id))
        .returning()
    : await db.insert(harnesses).values({ orgId, slug: manifest.slug, manifest }).returning();
  if (!row) throw new Error("harness upsert failed");
  return {
    id: row.id,
    slug: row.slug,
    builtin: false,
    manifest: row.manifest,
    createdAt: row.createdAt,
  };
}

export async function deleteOrgHarness(db: Db, orgId: string, slug: string): Promise<boolean> {
  const deleted = await db
    .delete(harnesses)
    .where(and(eq(harnesses.orgId, orgId), eq(harnesses.slug, slug)))
    .returning({ id: harnesses.id });
  return deleted.length > 0;
}

export function toHarnessResponse(harness: ResolvedHarness) {
  return {
    ...harness.manifest,
    id: harness.id,
    builtin: harness.builtin,
    created_at: harness.createdAt.toISOString(),
  };
}

export const BUILTIN_SLUGS = new Set(BUILTIN_HARNESSES.map((h) => h.slug));
