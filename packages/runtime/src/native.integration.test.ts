import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTurnRequest } from "@nimplex/contracts";
import type { RunExecutor, SandboxProvider } from "@nimplex/core";
import { getSandboxProvider, registerSandboxProvider } from "@nimplex/sandbox";
import { describe, expect, it } from "vitest";
import { NimplexRuntime } from "./runtime.ts";

const backend = process.env.NIMPLEX_TEST_NATIVE;
describe.skipIf(backend !== "docker" && backend !== "e2b")("native session integration", () => {
  it("creates lazily, reuses dependencies across turns, isolates a branch and cleans up", async () => {
    if (backend !== "docker" && backend !== "e2b") throw new Error("Choose docker or e2b");
    const original = getSandboxProvider(backend);
    const counters = { create: 0, resume: 0, delete: 0 };
    const provider = new Proxy(original, {
      get(target, key) {
        const value = Reflect.get(target, key);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (key === "create" || key === "resume" || key === "delete") counters[key]++;
          return value.apply(target, args);
        };
      },
    }) as SandboxProvider;
    registerSandboxProvider(provider);
    const directory = mkdtempSync(join(tmpdir(), "nimplex-native-session-"));
    const executor: RunExecutor = async (run, signal) => {
      if (!run.nativeBash) throw new Error("Native runner missing");
      const native = await run.nativeBash(
        "increment",
        `mkdir -p node_modules; node -e 'const fs=require("fs");const p="node_modules/count";const n=fs.existsSync(p)?Number(fs.readFileSync(p))+1:1;fs.writeFileSync(p,String(n));fs.writeFileSync("count.txt",String(n));console.log(n)'`,
        run.files,
        run.workspaceMetadata,
        signal,
        10000,
      );
      if (native.result.exitCode !== 0) throw new Error(native.result.stderr);
      await run.persistence.commitTool(
        [
          {
            type: "tool.result",
            payload: {
              id: "increment",
              name: "bash",
              content: [{ type: "text", text: native.result.stdout }],
              is_error: false,
            },
          },
        ],
        native.files,
        native.metadata,
      );
      return { files: native.files, costUsd: 0, events: [], stopReason: "stop" };
    };
    const runtime = new NimplexRuntime({
      directory,
      credential: () => ({ apiKey: "unused", baseUrl: null }),
      engine: "pi-executor",
      executor,
    });
    try {
      const session = runtime.createSession(directory);
      expect(counters.create).toBe(0);
      const run = async (sessionId: string) => {
        const turn = await runtime.startTurn(
          sessionId,
          startTurnRequest.parse({ prompt: "Increment", sandbox: backend }),
        );
        for await (const _event of runtime.events(turn.runId)) {
          /* Wait for the native result. */
        }
        expect(runtime.getTurn(turn.runId).status).toBe("completed");
        return turn.runId;
      };
      const first = await run(session.id);
      expect(new TextDecoder().decode(runtime.readFile(first, "/workspace/count.txt"))).toBe("1");
      const branch = runtime.forkSession(session.id);
      const second = await run(session.id);
      expect(new TextDecoder().decode(runtime.readFile(second, "/workspace/count.txt"))).toBe("2");
      expect(counters.create).toBe(1);
      expect(counters.resume).toBeGreaterThan(0);
      const forked = await run(branch.id);
      expect(new TextDecoder().decode(runtime.readFile(forked, "/workspace/count.txt"))).toBe("1");
      expect(new TextDecoder().decode(runtime.readFile(second, "/workspace/count.txt"))).toBe("2");
      expect(counters.create).toBe(2);
      expect(runtime.files(second).some((file) => file.path.includes("node_modules"))).toBe(false);
      await runtime.close();
      expect(counters.delete).toBe(2);
    } finally {
      await runtime.close();
      registerSandboxProvider(original);
      rmSync(directory, { recursive: true, force: true });
    }
  }, 120000);
});
