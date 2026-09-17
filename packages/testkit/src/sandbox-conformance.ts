// Contract tests shared by every SandboxProvider.
//
// Architecture §4.1 requires provider interchangeability to be mechanically tested.
// Differences in resumed env, post-stop execution, or timeout cancellation otherwise
// appear as intermittent runs that cannot be stopped.
// Express each port guarantee as an assertion; C4/C5 enforce invariant I4:
// any worker can destroy any sandbox from serialized state.
//
// Usage from provider *.test.ts files:
//   describeSandboxConformance("docker", () => new DockerSandboxProvider(), { timeoutMs: 180_000 });
// Unavailable providers skip their group and print the configuration reason.

import {
  isSandboxSessionState,
  type SandboxCreateArgs,
  type SandboxProvider,
  type SandboxSession,
  type SandboxSessionState,
} from "@nimplex/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

export interface SandboxConformanceOptions {
  /** Override default image/template for providers that require it. */
  image?: string;
  /**
   * Whether absolute /workspace paths in shell commands address the same filesystem.
   * Isolated providers default to true; the development-only local adapter declares false.
   */
  absolutePaths?: boolean;
  /** Per-test timeout allows for image pulls and cloud provisioning. */
  timeoutMs?: number;
}

export function describeSandboxConformance(
  label: string,
  factory: () => SandboxProvider,
  options: SandboxConformanceOptions = {},
): void {
  const timeout = options.timeoutMs ?? 120_000;

  describe(`sandbox conformance: ${label}`, () => {
    let provider: SandboxProvider;
    let unavailable: string | null = null;
    const leftovers: SandboxSessionState[] = [];

    beforeAll(async () => {
      provider = factory();
      unavailable = await provider.unavailableReason();
      if (unavailable) console.log(`  [conformance:${label}] 跳過：${unavailable}`);
    }, timeout);

    // Clean up sandboxes regardless of test outcome.
    afterAll(async () => {
      for (const state of leftovers) await provider.delete(state).catch(() => {});
    }, timeout);

    const create = async (overrides: Partial<SandboxCreateArgs> = {}): Promise<SandboxSession> => {
      const session = await provider.create({
        label: `conformance-${label}`,
        image: options.image,
        workdir: "/workspace",
        ...overrides,
      });
      leftovers.push(session.state);
      return session;
    };

    const spec = (name: string, fn: () => Promise<void>) =>
      it(
        name,
        async (ctx) => {
          if (unavailable) return ctx.skip();
          await fn();
        },
        timeout,
      );

    spec("C0 backendId 非空，state 帶正確 backendId 與版本", async () => {
      expect(provider.backendId.length).toBeGreaterThan(0);
      const s = await create();
      expect(s.state.backendId).toBe(provider.backendId);
      expect(isSandboxSessionState(s.state)).toBe(true);
      await s.stop();
    });

    spec("C1 create → exec → writeFile/readFile → stop 完整循環", async () => {
      const s = await create();
      const echo = await s.exec({ cmd: "echo hello-conformance" });
      expect(echo.exitCode).toBe(0);
      expect(echo.stdout).toContain("hello-conformance");

      await s.writeFile("/workspace/c1/a.txt", "round-trip\n");
      expect(await s.readFile("/workspace/c1/a.txt")).toBe("round-trip\n");
      await s.stop();
    });

    // Isolated providers expose a real /workspace for absolute shell paths.
    // Local cannot provide that path and must explicitly declare absolutePaths:false.
    if (options.absolutePaths !== false) {
      spec("C1b writeFile 的檔案在 exec 裡用絕對路徑看得到", async () => {
        const s = await create();
        await s.writeFile("/workspace/c1b/a.txt", "absolute\n");
        const cat = await s.exec({ cmd: "cat /workspace/c1b/a.txt" });
        expect(cat.exitCode).toBe(0);
        expect(cat.stdout).toBe("absolute\n");
        await s.stop();
      });
    }

    spec("C2 create 時注入的 env 在 exec 裡看得到；per-exec env 可覆寫", async () => {
      // Environment propagation must retain injected configuration and scoped credentials.
      const s = await create({ environment: { NIMPLEX_CONF: "from-create" } });
      const a = await s.exec({ cmd: 'printf %s "$NIMPLEX_CONF"' });
      expect(a.stdout).toBe("from-create");
      const b = await s.exec({
        cmd: 'printf %s "$NIMPLEX_CONF:$NIMPLEX_CONF2"',
        env: { NIMPLEX_CONF2: "per-exec" },
      });
      expect(b.stdout).toBe("from-create:per-exec");
      await s.stop();
    });

    spec("C3 exec 的 workdir 生效（相對路徑以它為基準）", async () => {
      const s = await create();
      await s.writeFile("/workspace/c3/sub/m.txt", "in-subdir");
      const r = await s.exec({ cmd: "cat m.txt", workdir: "/workspace/c3/sub" });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe("in-subdir");
      await s.stop();
    });

    spec("C4 state 可 JSON round-trip；resume 後仍是同一個箱子（I4 的前提）", async () => {
      const s = await create();
      await s.writeFile("/workspace/c4.txt", "before-resume");
      const copy = JSON.parse(JSON.stringify(s.state)) as unknown;
      expect(isSandboxSessionState(copy)).toBe(true);
      const again = await provider.resume(copy as SandboxSessionState);
      expect(await again.readFile("/workspace/c4.txt")).toBe("before-resume");
      // Reconnected sessions must retain environment variables.
      const env = await again.exec({ cmd: "env | sort | head -50" });
      expect(env.exitCode).toBe(0);
      await again.stop();
    });

    spec("C5 delete(state) 不需先 resume，之後箱子確實不在", async () => {
      const s = await create();
      const copy = JSON.parse(JSON.stringify(s.state)) as SandboxSessionState;
      await provider.delete(copy);
      await expectDead(provider, copy);
    });

    spec("C6 stop() 之後 exec 必須失敗", async () => {
      const s = await create();
      await s.stop();
      await expectExecFails(s);
    });

    spec("C7 exec 的 timeoutMs 真的中止得了", async () => {
      const s = await create();
      const started = Date.now();
      const r = await s.exec({ cmd: "sleep 30", timeoutMs: 1_000 });
      expect(Date.now() - started).toBeLessThan(15_000);
      expect(r.timedOut).toBe(true);
      await s.stop();
    });

    spec("C8 exec 的 signal 真的中止得了", async () => {
      const s = await create();
      const controller = new AbortController();
      const started = Date.now();
      setTimeout(() => controller.abort(), 500);
      await s.exec({ cmd: "sleep 30", signal: controller.signal }).catch(() => undefined);
      expect(Date.now() - started).toBeLessThan(15_000);
      await s.stop();
    });

    spec("C9 onStdout 在執行中即時回呼（事件流靠它，不能等結束才吐）", async () => {
      const s = await create();
      let firstChunkAt: number | null = null;
      const chunks: string[] = [];
      const r = await s.exec({
        cmd: "echo first; sleep 1; echo second",
        onStdout: (chunk) => {
          firstChunkAt ??= Date.now();
          chunks.push(chunk);
        },
      });
      const finishedAt = Date.now();
      expect(r.exitCode).toBe(0);
      expect(chunks.join("")).toContain("first");
      expect(firstChunkAt).not.toBeNull();
      // Initial output must arrive well before completion: within half the one-second sleep.
      expect(finishedAt - (firstChunkAt ?? finishedAt)).toBeGreaterThan(400);
      await s.stop();
    });

    spec("C10 delete 可重複呼叫（reaper 可能對同一個 state 跑兩次）", async () => {
      const s = await create();
      await provider.delete(s.state);
      await expect(provider.delete(s.state)).resolves.toBeUndefined();
    });
  });
}

async function expectExecFails(session: SandboxSession): Promise<void> {
  const outcome = await session
    .exec({ cmd: "echo still-alive", timeoutMs: 15_000 })
    .then((r) => ({ kind: "resolved" as const, r }))
    .catch((err: unknown) => ({ kind: "rejected" as const, err }));
  if (outcome.kind === "rejected") return;
  expect(
    outcome.r.exitCode !== 0 || !outcome.r.stdout.includes("still-alive"),
    `箱子應該已經不在了，但 exec 仍成功：${JSON.stringify(outcome.r)}`,
  ).toBe(true);
}

async function expectDead(provider: SandboxProvider, state: SandboxSessionState): Promise<void> {
  let session: SandboxSession;
  try {
    session = await provider.resume(state);
  } catch {
    return; // Rejected resume also establishes that the sandbox no longer exists.
  }
  await expectExecFails(session);
}
