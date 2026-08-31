export type {
  CreateRunRequest,
  HarnessManifest,
  HarnessOutput,
  HarnessSource,
  MeteringMode,
  ModelProvider,
  ModelSpec,
  ProviderKeyResponse,
  PutProviderKeyRequest,
  RunEvent,
  RunResponse,
  RunStatus,
  SandboxProviderId,
  SandboxSpec,
} from "@nimplex/contracts";
export { harnessManifest } from "@nimplex/contracts";
export * from "./agent.ts";
export * from "./client.ts";
export { NimplexError, Transport, type TransportOptions } from "./http.ts";

import { type HarnessManifest, harnessManifest } from "@nimplex/contracts";

/**
 * 定義一份自己的 harness。純粹是「型別 + 立刻驗證」的糖，
 * 讓打錯的欄位在編輯器裡就紅起來，而不是上傳後才被 API 退回。
 */
export function defineHarness(manifest: HarnessManifest): HarnessManifest {
  return harnessManifest.parse(manifest);
}
