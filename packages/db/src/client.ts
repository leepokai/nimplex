import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as authSchema from "./auth-schema.ts";
import * as appSchema from "./schema.ts";

const schema = { ...appSchema, ...authSchema };

export const DEFAULT_DATABASE_URL = "postgres://nimplex:nimplex@localhost:5433/nimplex";

export function createDb(url = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL) {
  const client = postgres(url);
  const db = drizzle(client, { schema });
  return { db, client };
}

export type DbHandle = ReturnType<typeof createDb>;
export type Db = DbHandle["db"];
/** Transaction callback executor: the subset of Db available within a transaction. */
export type DbExecutor = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
