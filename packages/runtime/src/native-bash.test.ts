import {
  SandboxMissingError,
  type SandboxProvider,
  type SandboxSession,
  type SandboxSessionState,
} from "@nimplex/core";
import { describe, expect, it, vi } from "vitest";
import { createNativeBash } from "./native-bash.ts";

const state: SandboxSessionState = {
  version: 1,
  backendId: "docker",
  providerState: { containerId: "test" },
  workdir: "/workspace",
  environment: {},
};
describe("native recovery boundary", () => {
  it.each([null, state])(
    "does not replay a dispatched command when its environment is gone (%j)",
    async (previous) => {
      const exec = vi.fn();
      const session: SandboxSession = {
        state,
        exec,
        writeFile: async () => {},
        readFile: async () => "",
        stop: async () => {},
      };
      const provider: SandboxProvider = {
        backendId: "docker",
        unavailableReason: () => null,
        create: async () => session,
        resume: async () => {
          throw new SandboxMissingError("gone");
        },
        delete: async () => {},
      };
      const recordState = vi.fn();
      const run = createNativeBash({
        id: "turn",
        sandbox: { provider: "docker" },
        sandboxState: previous,
        provider,
        assertActive: async () => {},
        recordState,
        readEvents: async () => [
          { type: "tier.escalated", payload: { tool_call_id: "dispatched" } },
        ],
        appendEvents: async () => {},
        generation: async () => 1,
        shouldDestroyOnAbort: async () => false,
      });
      await expect(
        run("dispatched", "node external-action.js", {}, {}, new AbortController().signal, 1000),
      ).rejects.toThrow("outcome is unknown");
      expect(exec).not.toHaveBeenCalled();
      expect(recordState).toHaveBeenCalledTimes(1);
    },
  );
});
