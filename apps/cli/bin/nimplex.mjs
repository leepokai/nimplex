#!/usr/bin/env node
import { register } from "tsx/esm/api";

// Register the process loader so Pi's lazy provider imports can resolve Node built-ins.
register();
const { main } = await import("../src/index.ts");
await main();
