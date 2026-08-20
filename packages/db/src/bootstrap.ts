import { eq } from "drizzle-orm";
import type { Db } from "./client.ts";
import { orgs } from "./schema.ts";

// TODO(auth)：MVP 用單一 default org，之後換成 API key → org 解析。
export async function ensureDefaultOrg(db: Db) {
  const existing = await db.query.orgs.findFirst({ where: eq(orgs.name, "default") });
  if (existing) return existing;
  const [created] = await db.insert(orgs).values({ name: "default" }).returning();
  if (!created) throw new Error("failed to create default org");
  return created;
}
