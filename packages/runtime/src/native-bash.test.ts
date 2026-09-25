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
      const sandboxTransition = vi.fn();
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
        sandboxTransition,
        sandboxDiscarded: async () => {},
        generation: async () => 1,
        shouldDestroyOnAbort: async () => false,
      });
      await expect(
        run("dispatched", "node external-action.js", {}, {}, new AbortController().signal, 1000),
      ).rejects.toThrow("outcome is unknown");
      expect(exec).not.toHaveBeenCalled();
      expect(recordState).toHaveBeenCalledTimes(1);
      // A sandbox that vanished stops its usage meter before a replacement starts one.
      expect(sandboxTransition.mock.calls).toEqual(previous ? [["missing"]] : []);
    },
  );
  it("stops the usage meter when the sandbox vanishes in the middle of a command", async () => {
    const commands: string[] = [];
    const session: SandboxSession = {
      state,
      exec: async ({ cmd }) => {
        commands.push(cmd);
        if (cmd.includes("result.json")) throw new Error("connection reset");
        return { exitCode: 0, stdout: "", stderr: "", wallTimeSeconds: 0, timedOut: false };
      },
      writeFile: async () => {},
      readFile: async () => "",
      stop: async () => {},
    };
    let resumes = 0;
    const provider: SandboxProvider = {
      backendId: "e2b",
      unavailableReason: () => null,
      create: async () => session,
      resume: async () => {
        if (resumes++ === 0) return session;
        throw new SandboxMissingError("expired");
      },
      pause: async () => {},
      delete: async () => {},
    };
    const sandboxTransition = vi.fn();
    const run = createNativeBash({
      id: "turn",
      sandbox: { provider: "e2b" },
      sandboxState: state,
      provider,
      assertActive: async () => {},
      recordState: vi.fn(),
      readEvents: async () => [],
      appendEvents: async () => {},
      sandboxTransition,
      sandboxDiscarded: async () => {},
      generation: async () => 1,
      shouldDestroyOnAbort: async () => false,
    });
    await expect(
      run("cmd", "node build.js", {}, {}, new AbortController().signal, 1000),
    ).rejects.toThrow("expired");
    expect(sandboxTransition.mock.calls.map(([transition]) => transition)).toEqual([
      "running",
      "missing",
    ]);
    // The resume was timed from before the provider call.
    expect(sandboxTransition.mock.calls[0]?.[1]).toBeInstanceOf(Date);
  });
  it("pauses the sandbox when the command fails so it stops billing", async () => {
    const session: SandboxSession = {
      state,
      exec: async ({ cmd }) => ({
        exitCode: 0,
        stdout: cmd.includes("result.json") ? JSON.stringify({ error: "supervisor crashed" }) : "",
        stderr: "",
        wallTimeSeconds: 0,
        timedOut: false,
      }),
      writeFile: async () => {},
      readFile: async () => "",
      stop: async () => {},
    };
    const pause = vi.fn(async () => {});
    const sandboxTransition = vi.fn();
    const run = createNativeBash({
      id: "turn",
      sandbox: { provider: "e2b" },
      sandboxState: state,
      provider: {
        backendId: "e2b",
        unavailableReason: () => null,
        create: async () => session,
        resume: async () => session,
        pause,
        delete: async () => {},
      },
      assertActive: async () => {},
      recordState: vi.fn(),
      readEvents: async () => [],
      appendEvents: async () => {},
      sandboxTransition,
      sandboxDiscarded: async () => {},
      generation: async () => 1,
      shouldDestroyOnAbort: async () => false,
    });
    await expect(
      run("cmd", "node x.js", {}, {}, new AbortController().signal, 1000),
    ).rejects.toThrow("supervisor crashed");
    expect(pause).toHaveBeenCalledTimes(1);
    expect(sandboxTransition.mock.calls.map(([transition]) => transition)).toEqual([
      "running",
      "paused",
    ]);
  });
  it("pauses a replacement sandbox when the lost command cannot be repeated", async () => {
    const replacement: SandboxSession = {
      state,
      exec: vi.fn(),
      writeFile: async () => {},
      readFile: async () => "",
      stop: async () => {},
    };
    const pause = vi.fn(async () => {});
    const sandboxTransition = vi.fn();
    const run = createNativeBash({
      id: "turn",
      sandbox: { provider: "e2b" },
      sandboxState: state,
      provider: {
        backendId: "e2b",
        unavailableReason: () => null,
        create: async () => replacement,
        resume: async () => {
          throw new SandboxMissingError("gone");
        },
        pause,
        delete: async () => {},
      },
      assertActive: async () => {},
      recordState: vi.fn(),
      readEvents: async () => [{ type: "tier.escalated", payload: { tool_call_id: "lost" } }],
      appendEvents: async () => {},
      sandboxTransition,
      sandboxDiscarded: async () => {},
      generation: async () => 1,
      shouldDestroyOnAbort: async () => false,
    });
    await expect(
      run("lost", "node x.js", {}, {}, new AbortController().signal, 1000),
    ).rejects.toThrow("environment.reset");
    expect(replacement.exec).not.toHaveBeenCalled();
    expect(pause).toHaveBeenCalledTimes(1);
    expect(sandboxTransition.mock.calls.map(([transition]) => transition)).toEqual([
      "missing",
      "paused",
    ]);
  });
});
