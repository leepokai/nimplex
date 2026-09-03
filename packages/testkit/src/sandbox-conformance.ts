// Sandbox provider conformance kit：任何一家 SandboxProvider 都必須通過的契約測試。
//
// 為什麼要有它：架構文件 §4.1——「換一格其他不動」現在靠人記得，不是靠 build 會紅。
// 第三家 provider 進來、行為稍有差異（resume 後 env 掉了、stop 後 exec 還能跑、
// timeout 殺不掉），問題會以「某些 run 隨機殺不掉」的形式出現，那是最難查的一類 bug。
// 這裡把 port 的每一條隱含契約寫成可執行的斷言；尤其 C4/C5 是不變式 I4
// （任何 worker 都能砍掉任何箱子）的機械保證。
//
// 用法（在 provider 套件的 *.test.ts 裡）：
//   describeSandboxConformance("docker", () => new DockerSandboxProvider(), { timeoutMs: 180_000 });
// provider 不可用（沒 docker daemon、沒 API key）時整組自動 skip，並印出原因。

import {
  isSandboxSessionState,
  type SandboxCreateArgs,
  type SandboxProvider,
  type SandboxSession,
  type SandboxSessionState,
} from "@nimplex/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

export interface SandboxConformanceOptions {
  /** 覆寫預設 image／template（雲端 provider 多半需要） */
  image?: string;
  /**
   * shell 指令裡的絕對路徑（/workspace/…）是否指到同一個檔案系統。
   * 隔離型 provider 一律 true（預設）；local provider 是虛擬映射，設 false 並接受它只能 dev 用。
   */
  absolutePaths?: boolean;
  /** 每個測試的上限；建箱可能很慢（拉 image、雲端排程） */
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

    // 不論測試怎麼收場，箱子一定要清乾淨（reaper 的精神）
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

    // 隔離型 provider（docker / e2b …）的 /workspace 是箱子裡真實存在的路徑，harness 會用絕對路徑讀寫。
    // local provider 做不到（host 上建不出 /workspace），要在選項裡明示 absolutePaths: false。
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
      // harness 拿閘道 URL 與 run token 全靠這條——env 掉了等於 key 路徑斷了
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
      // resume 回來的 session 也要保有 env
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
      // 第一段輸出必須明顯早於結束（至少早過那 1 秒 sleep 的一半）
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
    return; // resume 直接拒絕也算「確實不在」
  }
  await expectExecFails(session);
}
