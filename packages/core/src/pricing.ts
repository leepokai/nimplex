// Shared price data for accounting and estimates.
//
// Prices are data; a future versioned DB table can preserve this interface.
// Estimates for unknown models use an intentionally expensive FALLBACK_RATE.
// Accounting estimates do not control model dispatch.

import type { ModelProvider } from "@nimplex/contracts";

export interface TokenRate {
  /** USD per million input tokens. */
  inputPerMtok: number;
  /** USD per million output tokens. */
  outputPerMtok: number;
  /** Cache-write multiplier relative to input price. */
  cacheWriteMultiplier?: number;
  /** Cache-read multiplier relative to input price. */
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
  /** True when using a fallback estimate rather than a listed rate. */
  estimated: boolean;
  rate: TokenRate;
}

const ANTHROPIC_DEFAULTS = { cacheWriteMultiplier: 1.25, cacheReadMultiplier: 0.1 } as const;

/** First-party prices recorded on 2026-08-31; update this date with price changes. */
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

/** OpenAI API prices recorded on 2026-09-18 from Pi's model catalog; cached input bills at 10%. */
const OPENAI_RATES: Record<string, TokenRate> = {
  "gpt-5": { inputPerMtok: 1.25, outputPerMtok: 10, cacheReadMultiplier: 0.1 },
  "gpt-5-mini": { inputPerMtok: 0.25, outputPerMtok: 2, cacheReadMultiplier: 0.1 },
  "gpt-5-nano": { inputPerMtok: 0.05, outputPerMtok: 0.4, cacheReadMultiplier: 0.1 },
  "gpt-5.4": { inputPerMtok: 2.5, outputPerMtok: 15, cacheReadMultiplier: 0.1 },
  "gpt-5.4-mini": { inputPerMtok: 0.75, outputPerMtok: 4.5, cacheReadMultiplier: 0.1 },
  "gpt-5.4-nano": { inputPerMtok: 0.2, outputPerMtok: 1.25, cacheReadMultiplier: 0.1 },
  "gpt-5.5": { inputPerMtok: 5, outputPerMtok: 30, cacheReadMultiplier: 0.1 },
  "gpt-5.6-luna": { inputPerMtok: 0.2, outputPerMtok: 1.2, cacheReadMultiplier: 0.1 },
  "gpt-5.6-sol": { inputPerMtok: 4, outputPerMtok: 20, cacheReadMultiplier: 0.1 },
  "gpt-5.6-terra": { inputPerMtok: 2, outputPerMtok: 12, cacheReadMultiplier: 0.1 },
  "gpt-6-astra": { inputPerMtok: 10, outputPerMtok: 50, cacheReadMultiplier: 0.1 },
};

const PRICES: Record<ModelProvider, Record<string, TokenRate>> = {
  anthropic: ANTHROPIC_RATES,
  openai: OPENAI_RATES,
  // OpenRouter reports actual cost; listed rates are a fallback when unavailable.
  openrouter: {},
  "openai-codex": {},
};

/** Conservative estimate for unrecognized models; not a paid-dispatch authorization. */
export const FALLBACK_RATE: TokenRate = { inputPerMtok: 15, outputPerMtok: 75 };

export function lookupRate(provider: ModelProvider, model: string): TokenRate | null {
  const table = PRICES[provider];
  const exact = table?.[model];
  if (exact) return exact;
  // Normalize provider prefixes (OpenRouter) and dated model suffixes.
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
    Record<string, TokenRate>,
  ][]) {
    for (const [model, rate] of Object.entries(table)) out.push({ provider, model, rate });
  }
  return out;
}

/** Estimated sandbox compute price while a sandbox is running (not paused or deleted). */
export interface SandboxRate {
  usdPerSecond: number;
  /** What the rate assumes, shown with every estimate. */
  basis: string;
}

// E2B bills per second while a sandbox runs, by allocated vCPU and RAM; paused and killed
// sandboxes are not billed (docs.e2b.dev/faq/calculate-sandbox-price, read 2026-09-25).
// The default sandbox is 2 vCPU / 512 MiB. The provider bills from its own records, so
// every sandbox cost here is an estimate.
const E2B_VCPU_SECOND = 0.000014;
const E2B_GIB_SECOND = 0.0000045;
const E2B_DEFAULT_SIZE = { cpuCount: 2, memoryMB: 512 };

export interface SandboxSize {
  cpuCount?: number;
  memoryMB?: number;
  /** A custom template whose size was not reported cannot be priced. */
  customTemplate?: boolean;
}

/** The running rate for a provider's sandbox, or null when its size or rate is unknown. */
export function lookupSandboxRate(provider: string, size: SandboxSize = {}): SandboxRate | null {
  if (provider === "docker") return { usdPerSecond: 0, basis: "local Docker" };
  if (provider !== "e2b") return null;
  const reported = size.cpuCount !== undefined && size.memoryMB !== undefined;
  if (!reported && size.customTemplate) return null;
  const { cpuCount, memoryMB } = reported
    ? { cpuCount: size.cpuCount ?? 0, memoryMB: size.memoryMB ?? 0 }
    : E2B_DEFAULT_SIZE;
  return {
    usdPerSecond: cpuCount * E2B_VCPU_SECOND + (memoryMB / 1024) * E2B_GIB_SECOND,
    basis: `E2B list price for ${cpuCount} vCPU / ${memoryMB} MiB${reported ? "" : " (default size)"}`,
  };
}

/** Round to the nano-dollar: small sandbox and cache amounts vanish at the micro unit. */
export function roundUsdPrecise(value: number): number {
  return Math.round(value * 1e9) / 1e9;
}

/** Round accumulated accounting amounts to the database USD micro-unit. */
export function roundUsd(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
