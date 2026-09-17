import { fork } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it.each(["session", "agent"])(
  "SIGKILL at the %s observer exposes whether effects preceded the pending response commit",
  async (boundary) => {
    const child = fork(
      fileURLToPath(new URL("./testing/pi-composition-child.ts", import.meta.url)),
      [boundary],
      {
        execArgv: ["--import", "tsx"],
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
    let directory: string | undefined;
    let stderr = "";
    child.stderr?.on("data", (data) => {
      stderr += String(data);
    });
    const exited = once(child, "exit");
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Child did not reach boundary: ${stderr}`)),
          10_000,
        );
        child.once("exit", () => {
          clearTimeout(timer);
          reject(new Error(`Child exited before boundary: ${stderr}`));
        });
        child.on("message", (message: { stage: string; directory?: string }) => {
          if (message.stage === "ready") directory = message.directory;
          if (message.stage === (boundary === "agent" ? "commit-pending" : "effect-completed")) {
            clearTimeout(timer);
            resolve();
          }
        });
      });
      child.kill("SIGKILL");
      const [code, signal] = await exited;
      expect(code).toBeNull();
      expect(signal).toBe("SIGKILL");
      if (!directory) throw new Error("Missing child fixture directory");
      expect(existsSync(join(directory, "committed-response.json"))).toBe(false);
      if (boundary === "session") {
        expect(readFileSync(join(directory, "probe.txt"), "utf8")).toBe("committed?");
      } else {
        expect(existsSync(join(directory, "probe.txt"))).toBe(false);
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
      if (directory) rmSync(directory, { recursive: true, force: true });
    }
  },
  15_000,
);
