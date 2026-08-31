// 各家 API 的 usage 長相不同，但我們只需要三個數字：input / output / 成本。
// 這一層把差異壓平，讓「錶」與 provider 無關（也就與 harness 無關）。

import type { ModelProvider } from "@nimplex/contracts";
import type { TokenUsage } from "@nimplex/core";

export interface ProviderAdapter {
  id: ModelProvider;
  defaultBaseUrl: string;
  /** 打上游時要帶的認證標頭（使用者的真 key 只在這裡出現） */
  authHeaders(apiKey: string): Record<string, string>;
  /** 轉發前改寫請求，確保上游一定回報 usage —— 沒有 usage 就沒有錶 */
  rewriteBody(body: Record<string, unknown>): Record<string, unknown>;
}

const OPENAI_LIKE_REWRITE = (body: Record<string, unknown>): Record<string, unknown> => {
  if (body.stream !== true) return body;
  const existing = (body.stream_options ?? {}) as Record<string, unknown>;
  return { ...body, stream_options: { ...existing, include_usage: true } };
};

export const PROVIDER_ADAPTERS: Record<ModelProvider, ProviderAdapter> = {
  anthropic: {
    id: "anthropic",
    defaultBaseUrl: "https://api.anthropic.com",
    authHeaders: (apiKey) => ({ "x-api-key": apiKey, "anthropic-version": "2023-06-01" }),
    rewriteBody: (body) => body,
  },
  openai: {
    id: "openai",
    defaultBaseUrl: "https://api.openai.com",
    authHeaders: (apiKey) => ({ authorization: `Bearer ${apiKey}` }),
    rewriteBody: OPENAI_LIKE_REWRITE,
  },
  openrouter: {
    id: "openrouter",
    defaultBaseUrl: "https://openrouter.ai",
    authHeaders: (apiKey) => ({ authorization: `Bearer ${apiKey}` }),
    rewriteBody: (body) => {
      const withUsage = { ...body, usage: { include: true } };
      return OPENAI_LIKE_REWRITE(withUsage);
    },
  },
};

export interface UsageExtract {
  usage: TokenUsage | null;
  model: string | null;
  /** provider 自己回報的美元成本（OpenRouter 有）。有的話優先於價格表。 */
  reportedCostUsd: number | null;
}

/**
 * 從 JSON 物件（完整回應或單一 SSE 事件）累積 usage。
 *
 * 每個欄位取 max 而不是相加：Anthropic 的 message_delta 回報的是**累計值**，
 * OpenAI 只在最後一個 chunk 回報一次。取 max 兩種都對，重複回報也不會重算。
 */
export class UsageAccumulator {
  private inputTokens = 0;
  private outputTokens = 0;
  private cacheWriteTokens = 0;
  private cacheReadTokens = 0;
  private model: string | null = null;
  private reportedCostUsd: number | null = null;
  private sawUsage = false;

  addObject(obj: unknown): void {
    if (!isRecord(obj)) return;
    this.model ??= pickModel(obj);
    for (const usage of findUsageObjects(obj)) this.absorb(usage);
  }

  /** 餵一段 SSE 原文；只認 `data:` 行。 */
  addSseChunk(text: string): void {
    for (const line of text.split("\n")) {
      const trimmed = line.trimStart();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        this.addObject(JSON.parse(payload));
      } catch {
        // 半截的 chunk：下一段補齊時會再解析到完整事件，忽略即可
      }
    }
  }

  result(): UsageExtract {
    return {
      usage: this.sawUsage
        ? {
            inputTokens: this.inputTokens,
            outputTokens: this.outputTokens,
            cacheWriteTokens: this.cacheWriteTokens,
            cacheReadTokens: this.cacheReadTokens,
          }
        : null,
      model: this.model,
      reportedCostUsd: this.reportedCostUsd,
    };
  }

  private absorb(usage: Record<string, unknown>): void {
    const input = num(usage.input_tokens) ?? num(usage.prompt_tokens);
    const output = num(usage.output_tokens) ?? num(usage.completion_tokens);
    const cacheWrite = num(usage.cache_creation_input_tokens);
    const cacheRead =
      num(usage.cache_read_input_tokens) ??
      num(nested(usage, "prompt_tokens_details", "cached_tokens")) ??
      num(nested(usage, "input_tokens_details", "cached_tokens"));
    const cost = num(usage.cost);

    if (input === undefined && output === undefined && cost === undefined) return;
    this.sawUsage = true;
    if (input !== undefined) this.inputTokens = Math.max(this.inputTokens, input);
    if (output !== undefined) this.outputTokens = Math.max(this.outputTokens, output);
    if (cacheWrite !== undefined)
      this.cacheWriteTokens = Math.max(this.cacheWriteTokens, cacheWrite);
    if (cacheRead !== undefined) this.cacheReadTokens = Math.max(this.cacheReadTokens, cacheRead);
    if (cost !== undefined) this.reportedCostUsd = Math.max(this.reportedCostUsd ?? 0, cost);
  }
}

/** usage 可能在頂層、在 message.usage（Anthropic SSE）、或在 response.usage（OpenAI responses）。 */
function findUsageObjects(obj: Record<string, unknown>): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  if (isRecord(obj.usage)) out.push(obj.usage);
  for (const key of ["message", "response"]) {
    const nestedObj = obj[key];
    if (isRecord(nestedObj) && isRecord(nestedObj.usage)) out.push(nestedObj.usage);
  }
  return out;
}

function pickModel(obj: Record<string, unknown>): string | null {
  if (typeof obj.model === "string") return obj.model;
  for (const key of ["message", "response"]) {
    const nestedObj = obj[key];
    if (isRecord(nestedObj) && typeof nestedObj.model === "string") return nestedObj.model;
  }
  return null;
}

function nested(obj: Record<string, unknown>, key: string, child: string): unknown {
  const value = obj[key];
  return isRecord(value) ? value[child] : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
