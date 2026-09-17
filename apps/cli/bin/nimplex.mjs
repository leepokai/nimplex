#!/usr/bin/env node
import { tsImport } from "tsx/esm/api";

const { main } = await tsImport("../src/index.ts", import.meta.url);
await main();
