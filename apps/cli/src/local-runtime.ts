import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { NimplexRuntime } from "@nimplex/runtime";
import { readCredential } from "./auth.ts";

export function stateDirectory(cwd = process.cwd()) {
  return (
    process.env.NIMPLEX_STATE_DIR ??
    join(
      process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
      "nimplex",
      createHash("sha256").update(realpathSync(cwd)).digest("hex").slice(0, 24),
    )
  );
}
/** Opt-in experimental engine for new sessions; existing sessions keep their recorded engine. */
export function engineFromEnvironment(value = process.env.NIMPLEX_ENGINE) {
  if (value === undefined || value === "" || value === "pi-executor") return "pi-executor" as const;
  if (value === "pi-harness") return value;
  throw new Error("NIMPLEX_ENGINE must be pi-executor or pi-harness.");
}
export function openRuntime(directory = stateDirectory()) {
  return new NimplexRuntime({
    directory,
    engine: engineFromEnvironment(),
    credential: async (provider, signal) => {
      if (provider === "openai-codex") {
        const { readCodexCredential } = await import("./codex-auth.ts");
        return readCodexCredential(signal);
      }
      if (provider !== "anthropic") throw new Error("Unsupported local model provider.");
      return readCredential();
    },
  });
}
