import type { HarnessManifest } from "@nimplex/contracts";
import { eq, isNull } from "drizzle-orm";
import type { Db } from "./client.ts";
import { harnesses } from "./schema.ts";

/**
 * 內建 harness 以 org_id = null 寫入，所有 org 共用。
 * 客戶用同一個 slug 上傳自己的版本時會落在自己的 org 底下並覆蓋解析結果。
 */
export async function ensureBuiltinHarnesses(db: Db, manifests: HarnessManifest[]) {
  for (const manifest of manifests) {
    const existing = await db.query.harnesses.findFirst({
      where: (h, { and }) => and(eq(h.slug, manifest.slug), isNull(h.orgId)),
    });
    if (existing) {
      await db
        .update(harnesses)
        .set({ manifest, updatedAt: new Date() })
        .where(eq(harnesses.id, existing.id));
    } else {
      await db.insert(harnesses).values({ orgId: null, slug: manifest.slug, manifest });
    }
  }
}
