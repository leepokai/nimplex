import { Nimplex } from "@nimplex/sdk";

/**
 * Console 用的是**跟客戶完全同一個 SDK**，打同一組公開 endpoint。
 * 沒有 /internal —— 只要 console 做得到，SDK 與 agent 就做得到。
 * vite dev server 把 /v1 代理到 :8787。
 */

const ORG_STORAGE_KEY = "nimplex.console.org";

function readStoredOrg(): string | null {
  try {
    return localStorage.getItem(ORG_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** 目前選中的 org（null = 跟著 API 的 default org）。 */
export const currentOrgId = readStoredOrg();

/** 切換 org：存起來後整頁重載，讓所有 query 與 client header 一致重建。 */
export function switchOrg(id: string | null) {
  try {
    if (id === null) localStorage.removeItem(ORG_STORAGE_KEY);
    else localStorage.setItem(ORG_STORAGE_KEY, id);
  } catch {
    // localStorage 不可用就退回 default org，切換等於 no-op
  }
  location.reload();
}

export const nimplex = new Nimplex({
  baseUrl: globalThis.location?.origin,
  headers: currentOrgId ? { "x-nimplex-org": currentOrgId } : undefined,
});

export const queryKeys = {
  orgs: ["orgs"] as const,
  harnesses: ["harnesses"] as const,
  providerKeys: ["provider-keys"] as const,
  sandboxProviders: ["sandbox-providers"] as const,
};
