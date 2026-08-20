import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.ts";

export const DEFAULT_DATABASE_URL = "postgres://loopbox:loopbox@localhost:5433/loopbox";

export function createDb(url = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL) {
  const client = postgres(url);
  const db = drizzle(client, { schema });
  return { db, client };
}

export type DbHandle = ReturnType<typeof createDb>;
export type Db = DbHandle["db"];
/** transaction callback 拿到的 tx，與 Db 介面相容的子集 */
export type DbExecutor = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
