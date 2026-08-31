import { Nimplex } from "@nimplex/sdk";

/**
 * Console 用的是**跟客戶完全同一個 SDK**，打同一組公開 endpoint。
 * 沒有 /internal —— 只要 console 做得到，SDK 與 agent 就做得到。
 * vite dev server 把 /v1 代理到 :8787。
 */
export const nimplex = new Nimplex({ baseUrl: globalThis.location?.origin });

export const queryKeys = {
  harnesses: ["harnesses"] as const,
  providerKeys: ["provider-keys"] as const,
  sandboxProviders: ["sandbox-providers"] as const,
};
