import { BUILTIN_HARNESSES } from "@nimplex/core";
import { ensureBuiltinHarnesses } from "./bootstrap.ts";
import { createDb } from "./client.ts";

const { db, client } = createDb();
await ensureBuiltinHarnesses(db, BUILTIN_HARNESSES);
console.log(`builtin harnesses: ${BUILTIN_HARNESSES.map((h) => h.slug).join(", ")}`);
await client.end();
