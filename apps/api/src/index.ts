import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createDb } from "@nimplex/db";
import { createApp } from "./app.ts";
import { createAuth } from "./auth.ts";

// 根目錄 .env（OAuth 憑證、secret 等）；已存在的環境變數優先，不覆蓋。
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
for (const candidate of [resolve(process.cwd(), ".env"), resolve(repoRoot, ".env")]) {
  if (existsSync(candidate)) {
    process.loadEnvFile(candidate);
    break;
  }
}

const { db } = createDb();
const auth = createAuth(db);
const app = createApp(db, auth);

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port });
console.log(`nimplex api listening on :${port}`);
