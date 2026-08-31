/**
 * 沙箱裡的 harness 要打回閘道，用的 URL 不見得跟外面看到的一樣
 * （docker 容器裡的 localhost 不是主機的 localhost）。
 * api 與 worker 都要算這組 URL，所以放在 core。
 */

import type { ModelProvider } from "@nimplex/contracts";

export function publicUrl(): string {
  return process.env.NIMPLEX_PUBLIC_URL ?? "http://localhost:8787";
}

export function gatewayBaseUrl(sandboxProvider: string): string {
  const base = publicUrl();
  if (sandboxProvider === "local") return process.env.NIMPLEX_GATEWAY_URL_LOCAL ?? base;
  if (sandboxProvider === "docker") {
    return (
      process.env.NIMPLEX_GATEWAY_URL_DOCKER ??
      base.replace("localhost", "host.docker.internal").replace("127.0.0.1", "host.docker.internal")
    );
  }
  return base;
}

/**
 * 各協定的閘道進入點。路徑尾巴刻意配合各家 CLI 的慣例：
 *   ANTHROPIC_BASE_URL 後面會接 /v1/messages
 *   OPENAI_BASE_URL 本身就含 /v1
 */
export function gatewayUrls(sandboxProvider: string): Record<ModelProvider, string> {
  const base = gatewayBaseUrl(sandboxProvider);
  return {
    anthropic: `${base}/gw/anthropic`,
    openai: `${base}/gw/openai/v1`,
    openrouter: `${base}/gw/openrouter/api/v1`,
  };
}
