import type { Api, Model } from "@earendil-works/pi-ai";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";

export const CODEX_PROVIDER = "openai-codex";
export const DEFAULT_CODEX_MODEL = "openai-codex/gpt-5.6-sol";
export const CODEX_BASE_URL = "https://chatgpt.com/backend-api";

/** The installed Pi catalog is the source of truth; prices never authorize dispatch. */
export function piModels(): Model<Api>[] {
  return getBuiltinProviders().flatMap((provider) => getBuiltinModels(provider));
}
export function codexModels() {
  return getBuiltinModels(CODEX_PROVIDER).filter((m) => m.api === "openai-codex-responses");
}
export function resolveLocalModel(selection: string) {
  const slash = selection.indexOf("/");
  const provider = slash < 0 ? "anthropic" : selection.slice(0, slash);
  const id = slash < 0 ? selection : selection.slice(slash + 1);
  if (!piModels().some((model) => model.provider === provider && model.id === id))
    throw new Error(`Unsupported Pi model: ${selection}. Choose a model from /model.`);
  return {
    provider,
    id,
    billing: provider === CODEX_PROVIDER ? ("subscription" as const) : ("api" as const),
  };
}

export function buildPiModel(provider: string, id: string, baseUrl: string | null): Model<Api> {
  const known = piModels().find((model) => model.provider === provider && model.id === id);
  if (!known) throw new Error(`Unsupported Pi model: ${provider}/${id}`);
  return baseUrl ? { ...known, baseUrl } : known;
}
