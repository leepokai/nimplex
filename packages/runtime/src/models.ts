import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { lookupRate } from "@nimplex/core";

export const CODEX_PROVIDER = "openai-codex";
export const DEFAULT_CODEX_MODEL = "openai-codex/gpt-5.6-sol";
export const CODEX_BASE_URL = "https://chatgpt.com/backend-api";

export function codexModels() {
  return getBuiltinModels(CODEX_PROVIDER).filter((m) => m.api === "openai-codex-responses");
}

/** Namespaced model selection keeps subscription routing explicit and durable. */
export function resolveLocalModel(selection: string) {
  if (selection.startsWith(`${CODEX_PROVIDER}/`)) {
    const id = selection.slice(CODEX_PROVIDER.length + 1);
    if (!codexModels().some((m) => m.id === id))
      throw new Error(`Unsupported Codex subscription model: ${id}. Choose a model from /model.`);
    return { provider: CODEX_PROVIDER, id, billing: "subscription" } as const;
  }
  if (!lookupRate("anthropic", selection)) throw new Error(`Unpriced model: ${selection}`);
  return { provider: "anthropic", id: selection, billing: "api" } as const;
}
