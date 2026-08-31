// 價格表：計量與試算共用同一份資料。
//
// 這是**資料**不是邏輯——之後改成資料庫裡可版本化的表，介面不動。
// 找不到的 model 一律走 FALLBACK_RATE（刻意訂得貴），並標記 estimated：
// 寧可提早殺掉，也不要因為不認得的 model 而讓美元上限變成假的。

import type { ModelProvider } from "@nimplex/contracts";

export interface TokenRate {
  /** 每 1M input token 的美元價 */
  inputPerMtok: number;
  /** 每 1M output token 的美元價 */
  outputPerMtok: number;
  /** 快取寫入倍率（相對 input） */
  cacheWriteMultiplier?: number;
  /** 快取讀取倍率（相對 input） */
  cacheReadMultiplier?: number;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
}

export interface CostBreakdown {
  costUsd: number;
  /** true = 用 fallback 價估的，不是表上的真價 */
  estimated: boolean;
  rate: TokenRate;
}

const ANTHROPIC_DEFAULTS = { cacheWriteMultiplier: 1.25, cacheReadMultiplier: 0.1 } as const;

/** 2026-08-31 的第一方定價。改價時連同日期一起更新。 */
const ANTHROPIC_RATES: Record<string, TokenRate> = {
  "claude-fable-5": { inputPerMtok: 10, outputPerMtok: 50, ...ANTHROPIC_DEFAULTS },
  "claude-mythos-5": { inputPerMtok: 10, outputPerMtok: 50, ...ANTHROPIC_DEFAULTS },
  "claude-opus-5": { inputPerMtok: 5, outputPerMtok: 25, ...ANTHROPIC_DEFAULTS },
  "claude-opus-4-8": { inputPerMtok: 5, outputPerMtok: 25, ...ANTHROPIC_DEFAULTS },
  "claude-opus-4-7": { inputPerMtok: 5, outputPerMtok: 25, ...ANTHROPIC_DEFAULTS },
  "claude-opus-4-6": { inputPerMtok: 5, outputPerMtok: 25, ...ANTHROPIC_DEFAULTS },
  "claude-sonnet-5": { inputPerMtok: 2, outputPerMtok: 10, ...ANTHROPIC_DEFAULTS },
  "claude-sonnet-4-6": { inputPerMtok: 3, outputPerMtok: 15, ...ANTHROPIC_DEFAULTS },
  "claude-haiku-4-5": { inputPerMtok: 1, outputPerMtok: 5, ...ANTHROPIC_DEFAULTS },
};

const OPENAI_RATES: Record<string, TokenRate> = {
  "gpt-5": { inputPerMtok: 1.25, outputPerMtok: 10, cacheReadMultiplier: 0.1 },
  "gpt-5-mini": { inputPerMtok: 0.25, outputPerMtok: 2, cacheReadMultiplier: 0.1 },
  "gpt-5-nano": { inputPerMtok: 0.05, outputPerMtok: 0.4, cacheReadMultiplier: 0.1 },
};

const PRICES: Record<ModelProvider, Record<string, TokenRate>> = {
  anthropic: ANTHROPIC_RATES,
  openai: OPENAI_RATES,
  // OpenRouter 會在回應裡直接給實際成本，價格表只是它回不出來時的保險。
  openrouter: {},
};

/** 不認得的 model 用這個價估：貴到讓上限依然有意義。 */
export const FALLBACK_RATE: TokenRate = { inputPerMtok: 15, outputPerMtok: 75 };

export function lookupRate(provider: ModelProvider, model: string): TokenRate | null {
  const table = PRICES[provider];
  const exact = table[model];
  if (exact) return exact;
  // provider 前綴（OpenRouter 慣例 "anthropic/claude-sonnet-4.5"）與日期後綴都試著剝掉
  const bare = model.includes("/") ? (model.split("/").at(-1) ?? model) : model;
  const normalized = bare.replace(/\./g, "-").replace(/-\d{8}$/, "");
  for (const candidates of Object.values(PRICES)) {
    const hit = candidates[normalized];
    if (hit) return hit;
  }
  return null;
}

export function computeCost(
  provider: ModelProvider,
  model: string,
  usage: TokenUsage,
): CostBreakdown {
  const found = lookupRate(provider, model);
  const rate = found ?? FALLBACK_RATE;
  const perMtok = (tokens: number, price: number) => (tokens / 1_000_000) * price;
  const costUsd = roundUsdPrecise(
    perMtok(usage.inputTokens, rate.inputPerMtok) +
      perMtok(usage.outputTokens, rate.outputPerMtok) +
      perMtok(usage.cacheWriteTokens ?? 0, rate.inputPerMtok * (rate.cacheWriteMultiplier ?? 1)) +
      perMtok(usage.cacheReadTokens ?? 0, rate.inputPerMtok * (rate.cacheReadMultiplier ?? 1)),
  );
  return { costUsd, estimated: found === null, rate };
}

export function listPricedModels(): { provider: ModelProvider; model: string; rate: TokenRate }[] {
  const out: { provider: ModelProvider; model: string; rate: TokenRate }[] = [];
  for (const [provider, table] of Object.entries(PRICES) as [
    ModelProvider,
    typeof PRICES.anthropic,
  ][]) {
    for (const [model, rate] of Object.entries(table)) out.push({ provider, model, rate });
  }
  return out;
}

function roundUsdPrecise(value: number): number {
  return Math.round(value * 1e9) / 1e9;
}
