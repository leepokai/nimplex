import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { credentialPath, readCredential, saveCredential } from "./auth.ts";

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "nimplex-auth-"));
  vi.stubEnv("XDG_CONFIG_HOME", directory);
  vi.stubEnv("ANTHROPIC_API_KEY", undefined);
  vi.stubEnv("ANTHROPIC_BASE_URL", undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});
it("stores credentials privately and binds the saved key to its endpoint", () => {
  saveCredential({ baseUrl: "https://api.anthropic.com", apiKey: "saved-test-key" });
  expect(statSync(credentialPath()).mode & 0o777).toBe(0o600);
  expect(readCredential().apiKey).toBe("saved-test-key");
  vi.stubEnv("ANTHROPIC_BASE_URL", "https://unrelated.invalid");
  expect(() => readCredential()).toThrow("Missing Anthropic credential");
  expect(readFileSync(credentialPath(), "utf8")).toContain("saved-test-key");
});
it("uses an explicit environment key without reading a broken saved credential", () => {
  saveCredential({ baseUrl: "https://old.invalid", apiKey: "saved-test-key" });
  writeFileSync(credentialPath(), '{"apiKey":"private-value" broken');
  expect(() => readCredential()).toThrow("Cannot read local model credentials");
  vi.stubEnv("ANTHROPIC_API_KEY", "environment-key");
  expect(readCredential()).toEqual({
    apiKey: "environment-key",
    baseUrl: "https://api.anthropic.com",
  });
});
it("keeps OpenAI and Anthropic credentials side by side and resolves each by provider", () => {
  vi.stubEnv("OPENAI_API_KEY", undefined);
  vi.stubEnv("OPENAI_BASE_URL", undefined);
  expect(() => readCredential("openai")).toThrow("Missing OpenAI credential");
  saveCredential({ baseUrl: "https://api.anthropic.com", apiKey: "anthropic-saved" });
  saveCredential({ baseUrl: "https://api.openai.com/v1", apiKey: "openai-saved" }, "openai");
  expect(readCredential().apiKey).toBe("anthropic-saved");
  expect(readCredential("openai")).toEqual({
    apiKey: "openai-saved",
    baseUrl: "https://api.openai.com/v1",
  });
  // Replacing one provider's credential leaves the other untouched.
  saveCredential({ baseUrl: "https://api.anthropic.com" });
  expect(() => readCredential()).toThrow("Missing Anthropic credential");
  expect(readCredential("openai").apiKey).toBe("openai-saved");
  // A saved OpenAI key belongs to its endpoint; an override needs its own key.
  vi.stubEnv("OPENAI_BASE_URL", "https://proxy.invalid/v1");
  expect(() => readCredential("openai")).toThrow("Missing OpenAI credential");
  vi.stubEnv("OPENAI_API_KEY", "openai-env");
  expect(readCredential("openai")).toEqual({
    apiKey: "openai-env",
    baseUrl: "https://proxy.invalid/v1",
  });
  expect(statSync(credentialPath()).mode & 0o777).toBe(0o600);
});

it("resolves additional providers using Pi environment credentials without network access", async () => {
  const { readPiCredential } = await import("./codex-auth.ts");
  vi.stubEnv("GROQ_API_KEY", "groq-test-key");
  vi.stubEnv("GEMINI_API_KEY", "google-test-key");
  expect(await readPiCredential("groq")).toMatchObject({ apiKey: "groq-test-key" });
  expect(await readPiCredential("google")).toMatchObject({ apiKey: "google-test-key" });
  await expect(readPiCredential("not-a-provider")).rejects.toThrow(
    "Missing not-a-provider credential",
  );
  const controller = new AbortController();
  controller.abort(new Error("auth canceled"));
  await expect(readPiCredential("groq", controller.signal)).rejects.toThrow("auth canceled");
});

it("uses Pi login storage, isolates providers and removes only the requested login", async () => {
  const { piAccounts, readPiCredential, logoutPiProvider } = await import("./codex-auth.ts");
  vi.stubEnv("GROQ_API_KEY", undefined);
  vi.stubEnv("DEEPSEEK_API_KEY", undefined);
  const accounts = await piAccounts("groq");
  await accounts.login("groq", "api_key", {
    prompt: async () => "groq-saved-test",
    notify: () => {},
  });
  await accounts.login("deepseek", "api_key", {
    prompt: async () => "deepseek-saved-test",
    notify: () => {},
  });
  expect(await readPiCredential("groq")).toMatchObject({ apiKey: "groq-saved-test" });
  expect(statSync(join(directory, "nimplex", "pi-auth.json")).mode & 0o777).toBe(0o600);
  await logoutPiProvider("groq");
  await expect(readPiCredential("groq")).rejects.toThrow("Missing groq credential");
  expect(await readPiCredential("deepseek")).toMatchObject({ apiKey: "deepseek-saved-test" });
});

it("accepts Pi ambient AWS authentication without requiring or storing an API key", async () => {
  const { readPiCredential } = await import("./codex-auth.ts");
  vi.stubEnv("AWS_ACCESS_KEY_ID", "synthetic-access-id");
  vi.stubEnv("AWS_SECRET_ACCESS_KEY", "synthetic-secret");
  vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", undefined);
  vi.stubEnv("AWS_PROFILE", undefined);
  const credential = await readPiCredential("amazon-bedrock");
  expect(credential.apiKey).toBeUndefined();
  expect(credential.baseUrl).toBeNull();
  expect(JSON.stringify(credential)).not.toContain("synthetic-secret");
});
