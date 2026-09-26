#!/usr/bin/env node
import { register } from "tsx/esm/api";

// Node 22 prints an ExperimentalWarning for node:sqlite at every start. nimplex uses only
// its stable subset, so drop that one warning and keep every other one.
const emitWarning = process.emitWarning;
process.emitWarning = (warning, ...rest) => {
  const message = typeof warning === "string" ? warning : (warning?.message ?? "");
  if (message.includes("SQLite is an experimental feature")) return;
  return emitWarning.call(process, warning, ...rest);
};

// Register the process loader so Pi's lazy provider imports can resolve Node built-ins.
register();
const { main } = await import("../src/index.ts");
await main();
