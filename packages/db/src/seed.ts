import { ensureDefaultOrg } from "./bootstrap.ts";
import { createDb } from "./client.ts";

const { db, client } = createDb();
const org = await ensureDefaultOrg(db);
console.log(`default org: ${org.id}`);
await client.end();
