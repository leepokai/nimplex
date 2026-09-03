// sandbox provider 註冊表 —— 「自選 sandbox provider」那一格的實作點。
//
// 註冊表是開放的：接一家新的雲只要實作 SandboxProvider 再 register，
// 不用動 worker、不用動 API、不用動 harness。
// （E2B / Vercel / Daytona 的 adapter 就是照這個介面補上去，
//   它們的 SDK 都有 create / connect / kill，對得上 create / resume / delete。）

import { daytona } from "@computesdk/daytona";
import { vercel } from "@computesdk/vercel";
import type { SandboxProvider } from "@nimplex/core";
import { ComputeSdkSandboxProvider } from "./computesdk.ts";
import { DockerSandboxProvider } from "./docker.ts";
import { E2bSandboxProvider } from "./e2b.ts";
import { LocalSandboxProvider } from "./local.ts";

export * from "./computesdk.ts";
export * from "./docker.ts";
export * from "./e2b.ts";
export * from "./local.ts";
export * from "./spawn.ts";

const registry = new Map<string, SandboxProvider>();

export function registerSandboxProvider(provider: SandboxProvider): void {
  registry.set(provider.backendId, provider);
}

export function getSandboxProvider(backendId: string): SandboxProvider {
  const provider = registry.get(backendId);
  if (!provider) {
    throw new Error(
      `sandbox provider "${backendId}" 尚未註冊（已註冊：${[...registry.keys()].join(", ")}）。` +
        `實作 SandboxProvider 介面後用 registerSandboxProvider() 掛上去。`,
    );
  }
  return provider;
}

export function hasSandboxProvider(backendId: string): boolean {
  return registry.has(backendId);
}

export function listSandboxProviders(): SandboxProvider[] {
  return [...registry.values()];
}

registerSandboxProvider(new LocalSandboxProvider());
registerSandboxProvider(new DockerSandboxProvider());
// 沒 E2B_API_KEY 時 unavailableReason 會說明，API 的 /v1/sandbox-providers 照樣列出來
registerSandboxProvider(new E2bSandboxProvider());

// ---- 長尾：透過 ComputeSDK 一次接進一批。沒 key 時只是「列得出來但不可用」。----
registerSandboxProvider(
  new ComputeSdkSandboxProvider({
    backendId: "daytona",
    unavailableReason: () => (process.env.DAYTONA_API_KEY ? null : "缺 DAYTONA_API_KEY"),
    backend: () => daytona({ apiKey: process.env.DAYTONA_API_KEY }),
  }),
);
registerSandboxProvider(
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
);
