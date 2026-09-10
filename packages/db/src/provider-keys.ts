import type { ModelProvider } from "@nimplex/contracts";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "./client.ts";
import { providerKeys } from "./schema.ts";

export async function listProviderKeys(db: Db, orgId: string) {
  return db
    .select({
      id: providerKeys.id,
      provider: providerKeys.provider,
      endUserId: providerKeys.endUserId,
      last4: providerKeys.last4,
      baseUrl: providerKeys.baseUrl,
      createdAt: providerKeys.createdAt,
    })
    .from(providerKeys)
    .where(eq(providerKeys.orgId, orgId));
}

export async function findProviderKeyRow(
  db: Db,
  orgId: string,
  provider: ModelProvider,
  endUserId: string | null,
) {
  return db.query.providerKeys.findFirst({
    where: and(
      eq(providerKeys.orgId, orgId),
      eq(providerKeys.provider, provider),
      endUserId ? eq(providerKeys.endUserId, endUserId) : isNull(providerKeys.endUserId),
    ),
  });
}
