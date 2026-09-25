import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
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
/** Engine for new sessions; `pi-executor` is a legacy opt-out. Existing sessions keep their recorded engine. */
export function engineFromEnvironment(value = process.env.NIMPLEX_ENGINE) {
  if (value === undefined || value === "" || value === "pi-harness") return "pi-harness" as const;
  if (value === "pi-executor") return value;
  throw new Error("NIMPLEX_ENGINE must be pi-executor or pi-harness.");
}
/** Pi's agent directory: user extensions load from here and project trust is recorded here. */
export function piAgentDirectory() {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}
export function openRuntime(directory = stateDirectory()) {
  const agentDir = piAgentDirectory();
  return new NimplexRuntime({
    directory,
    engine: engineFromEnvironment(),
    extensions: {
      agentDir,
      // Shared with Pi: a project trusted in Pi is trusted here, and /trust records here.
      projectTrusted: (cwd) => new ProjectTrustStore(agentDir).get(cwd) === true,
    },
    credential: async (provider, signal) => {
      if (provider === "openai") return readCredential("openai");
      if (provider === "openai-codex") {
        const { readCodexCredential } = await import("./codex-auth.ts");
        return readCodexCredential(signal);
      }
      if (provider === "anthropic") return readCredential();
      const { readPiCredential } = await import("./codex-auth.ts");
      return readPiCredential(provider, signal);
    },
  });
}
