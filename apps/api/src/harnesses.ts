import { type HarnessManifest, harnessManifest } from "@nimplex/contracts";
import { BUILTIN_HARNESSES, collectUnknownVariables } from "@nimplex/core";
import { type Db, harnesses, type ResolvedHarness } from "@nimplex/db";
import { and, eq } from "drizzle-orm";

export { listHarnesses, resolveHarness } from "@nimplex/db";

export interface HarnessValidationError {
  error: string;
  detail: unknown;
}

/** 上傳自己的 harness：驗 manifest 形狀，再驗它引用的模板變數存不存在。 */
export function parseManifest(
  slug: string,
  body: unknown,
): { ok: true; manifest: HarnessManifest } | { ok: false; problem: HarnessValidationError } {
  const withSlug = typeof body === "object" && body !== null ? { slug, ...(body as object) } : body;
  const parsed = harnessManifest.safeParse(withSlug);
  if (!parsed.success) {
    return { ok: false, problem: { error: "invalid_manifest", detail: parsed.error.issues } };
  }
  if (parsed.data.slug !== slug) {
    return {
      ok: false,
      problem: { error: "slug_mismatch", detail: { url: slug, body: parsed.data.slug } },
    };
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
