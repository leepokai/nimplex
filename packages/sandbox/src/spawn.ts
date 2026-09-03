// 所有 provider 共用的 process 執行原語：串流、逾時、stdin、abort。

import { spawn } from "node:child_process";
import type { ExecResult } from "@nimplex/core";

export interface SpawnOptions {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs?: number;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  signal?: AbortSignal;
}

export function spawnCollect(
  command: string,
  args: string[],
  options: SpawnOptions = {},
): Promise<ExecResult> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, options.timeoutMs)
      : null;

    const onAbort = () => {
      timedOut = true;
      child.kill("SIGKILL");
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      options.onStdout?.(chunk);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      options.onStderr?.(chunk);
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        exitCode: code,
        stdout,
        stderr,
        wallTimeSeconds: (Date.now() - startedAt) / 1000,
        timedOut,
      });
    });

    // If the child exits before consuming stdin (e.g. the executable is missing and sh exits 127),
    // the write raises EPIPE as an 'error' event on child.stdin itself, not on the child, so the
    // handler above never sees it and an unhandled error would crash the whole worker. The outcome
    // is already reflected in the exit code / stderr, so swallowing it here is correct.
    child.stdin.on("error", () => {});
    if (options.stdin !== undefined) child.stdin.write(options.stdin);
    child.stdin.end();
  });
}

/** 只想知道成功與否的小工具（探測 docker 有沒有開之類）。 */
export async function probe(command: string, args: string[]): Promise<boolean> {
  try {
    const result = await spawnCollect(command, args, { timeoutMs: 5000 });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}
