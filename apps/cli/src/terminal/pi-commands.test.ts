import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { Controller } from "./controller.ts";
import { piCommands } from "./pi-commands.ts";

afterEach(() => vi.unstubAllEnvs());

it("/trust records the project decision in Pi's trust store and reloads extensions", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "nimplex-pi-agent-"));
  const cwd = mkdtempSync(join(tmpdir(), "nimplex-trust-project-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  const notices: string[] = [];
  const controller = {
    session: { cwd, engine: "pi-harness" },
    client: {
      reloadExtensions: vi.fn(),
      extensions: async () => ({
        projectTrusted: true,
        extensions: [{ path: "guard.ts", tools: ["shout"], events: ["tool_call"] }],
        errors: [],
      }),
    },
    view: {
      notice: (_title: string, body: string) => {
        notices.push(body);
      },
      choose: async () => "yes",
    },
  } as unknown as Controller;
  const trust = piCommands.find((command) => command.name === "trust");
  const extensions = piCommands.find((command) => command.name === "extensions");
  if (!trust || !extensions) throw new Error("Missing commands");
  await trust.action(controller, "");
  const stored = JSON.parse(readFileSync(join(agentDir, "trust.json"), "utf8"));
  expect(JSON.stringify(stored)).toContain(cwd);
  expect(controller.client.reloadExtensions).toHaveBeenCalledTimes(1);
  await expect(trust.action(controller, "maybe")).rejects.toThrow("Choose yes or no");
  await trust.action(controller, "no");
  expect(readFileSync(join(agentDir, "trust.json"), "utf8")).toContain("false");
  await extensions.action(controller, "");
  expect(notices.at(-1)).toContain("guard.ts");
  expect(notices.at(-1)).toContain("shout");
  rmSync(agentDir, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});
