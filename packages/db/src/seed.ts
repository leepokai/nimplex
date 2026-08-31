import { BUILTIN_HARNESSES } from "@nimplex/core";
import { ensureBuiltinHarnesses, ensureDefaultOrg } from "./bootstrap.ts";
import { createDb } from "./client.ts";

const { db, client } = createDb();
const org = await ensureDefaultOrg(db);
await ensureBuiltinHarnesses(db, BUILTIN_HARNESSES);
console.log(`default org: ${org.id}`);
console.log(`builtin harnesses: ${BUILTIN_HARNESSES.map((h) => h.slug).join(", ")}`);
await client.end();
