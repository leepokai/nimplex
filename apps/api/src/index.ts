import { serve } from "@hono/node-server";
import { createDb, ensureDefaultOrg } from "@loopbox/db";
import { createApp } from "./app.ts";

const { db } = createDb();
const org = await ensureDefaultOrg(db);
const app = createApp(db, org.id);

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port });
console.log(`loopbox api listening on :${port} (org ${org.id})`);
