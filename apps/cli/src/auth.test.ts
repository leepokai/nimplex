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
