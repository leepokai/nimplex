import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { expect, it } from "vitest";
import { buildPiModel, piModels, resolveLocalModel } from "./models.ts";

it("uses every installed Pi provider and preserves provider-qualified model IDs", () => {
  const models = piModels();
  expect(new Set(models.map((model) => model.provider))).toEqual(new Set(getBuiltinProviders()));
  for (const provider of getBuiltinProviders()) {
    const catalog = getBuiltinModels(provider);
    expect(models.filter((model) => model.provider === provider)).toEqual(catalog);
    for (const model of catalog) {
      expect(resolveLocalModel(`${provider}/${model.id}`)).toMatchObject({
        provider,
        id: model.id,
      });
      expect(buildPiModel(provider, model.id, null)).toEqual(model);
    }
  }
});

it("accepts Pi models absent from the old price table and rejects invalid selections", () => {
  expect(resolveLocalModel("openai/gpt-4o-2024-05-13")).toMatchObject({ provider: "openai" });
  expect(resolveLocalModel("claude-haiku-4-5")).toMatchObject({ provider: "anthropic" });
  for (const selection of ["", "google/", "unknown/model", "openai/missing-model"]) {
    expect(() => resolveLocalModel(selection)).toThrow("Unsupported Pi model");
  }
  expect(() => buildPiModel("openai", "missing", null)).toThrow("Unsupported Pi model");
  const model = buildPiModel("anthropic", "claude-haiku-4-5", "http://localhost:9999");
  expect(model.baseUrl).toBe("http://localhost:9999");
  expect(model.maxTokens).toBe(
    getBuiltinModels("anthropic").find((m) => m.id === model.id)?.maxTokens,
  );
});
