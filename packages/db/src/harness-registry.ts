import type { HarnessManifest } from "@nimplex/contracts";
import { and, eq, isNull, or } from "drizzle-orm";
import type { Db } from "./client.ts";
import { harnesses } from "./schema.ts";

export interface ResolvedHarness {
  id: string;
  slug: string;
  builtin: boolean;
  manifest: HarnessManifest;
  createdAt: Date;
}

/**
 * 解析順序：org 自己上傳的 > 內建。
 * 「用網路上的 harness」跟「上傳自己的」在這裡是同一條路徑，
 * 客戶用同一個 slug 覆寫內建版本是合法且刻意支援的行為。
 */
export async function resolveHarness(
  db: Db,
  orgId: string,
  slug: string,
): Promise<ResolvedHarness | null> {
  const rows = await db
    .select()
    .from(harnesses)
    .where(and(eq(harnesses.slug, slug), or(eq(harnesses.orgId, orgId), isNull(harnesses.orgId))));
  const own = rows.find((r) => r.orgId === orgId);
  const builtin = rows.find((r) => r.orgId === null);
  const chosen = own ?? builtin;
  if (!chosen) return null;
  return toResolved(chosen);
}

export async function listHarnesses(db: Db, orgId: string): Promise<ResolvedHarness[]> {
  const rows = await db
    .select()
    .from(harnesses)
    .where(or(eq(harnesses.orgId, orgId), isNull(harnesses.orgId)));
  const bySlug = new Map<string, ResolvedHarness>();
  for (const row of rows) {
    const entry = toResolved(row);
    const existing = bySlug.get(row.slug);
    // org 自己的版本蓋掉同名內建版本
    if (!existing || (existing.builtin && !entry.builtin)) bySlug.set(row.slug, entry);
  }
  return [...bySlug.values()].sort((a, b) => a.slug.localeCompare(b.slug));
}

function toResolved(row: typeof harnesses.$inferSelect): ResolvedHarness {
  return {
    id: row.id,
    slug: row.slug,
    builtin: row.orgId === null,
    manifest: row.manifest,
    createdAt: row.createdAt,
  };
}
