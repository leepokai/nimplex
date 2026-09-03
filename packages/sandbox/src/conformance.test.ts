// 兩個內建 provider 都要過同一把尺；沒 docker daemon 時 docker 那組自動 skip。
process.env.NIMPLEX_ALLOW_LOCAL_SANDBOX = "1";

import { daytona } from "@computesdk/daytona";
import { vercel } from "@computesdk/vercel";
import { describeSandboxConformance } from "@nimplex/testkit";
import { ComputeSdkSandboxProvider } from "./computesdk.ts";
import { DockerSandboxProvider } from "./docker.ts";
import { E2bSandboxProvider } from "./e2b.ts";
import { LocalSandboxProvider } from "./local.ts";

// local 的 /workspace 是虛擬映射：writeFile/readFile/workdir 會轉成暫存目錄，但 shell 裡的絕對路徑不會——
// 這是它只能 dev 用的原因之一，明示宣告而不是假裝過關。
describeSandboxConformance("local", () => new LocalSandboxProvider(), {
  timeoutMs: 30_000,
  absolutePaths: false,
});
describeSandboxConformance("docker", () => new DockerSandboxProvider(), { timeoutMs: 180_000 });
// 沒有 E2B_API_KEY 時整組 skip；有 key 會真的開雲端沙箱（少量費用）
describeSandboxConformance("e2b", () => new E2bSandboxProvider(), { timeoutMs: 180_000 });

// ComputeSDK 走的長尾：沒 key 一樣 skip；有 key 就知道它們跟 docker 差幾條
describeSandboxConformance(
  "daytona (via ComputeSDK)",
  () =>
    new ComputeSdkSandboxProvider({
      backendId: "daytona",
      unavailableReason: () => (process.env.DAYTONA_API_KEY ? null : "缺 DAYTONA_API_KEY"),
      backend: () => daytona({ apiKey: process.env.DAYTONA_API_KEY }),
    }),
  { timeoutMs: 180_000 },
);
describeSandboxConformance(
  "vercel (via ComputeSDK)",
  () =>
    new ComputeSdkSandboxProvider({
      backendId: "vercel",
      unavailableReason: () =>
        process.env.VERCEL_TOKEN && process.env.VERCEL_TEAM_ID && process.env.VERCEL_PROJECT_ID
          ? null
          : "缺 VERCEL_TOKEN / VERCEL_TEAM_ID / VERCEL_PROJECT_ID",
      backend: () =>
        vercel({
          token: process.env.VERCEL_TOKEN,
          teamId: process.env.VERCEL_TEAM_ID,
          projectId: process.env.VERCEL_PROJECT_ID,
        }),
    }),
  { timeoutMs: 180_000 },
);
