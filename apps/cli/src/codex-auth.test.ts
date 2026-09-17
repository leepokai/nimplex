import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { codexAccounts, codexCredentialPath, readCodexCredential } from "./codex-auth.ts";

const directories: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
const token = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64url")}.signature`;
function fixture(expires = Date.now() + 3_600_000) {
  const root = mkdtempSync(join(tmpdir(), "nimplex-codex-auth-"));
  directories.push(root);
  vi.stubEnv("XDG_CONFIG_HOME", root);
  const path = codexCredentialPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      "openai-codex": { type: "oauth", access: token, refresh: "original-refresh", expires },
    }),
    { mode: 0o600 },
  );
  return path;
}

it("resolves nimplex's subscription login without using API keys or exposing credentials in status", async () => {
  fixture();
  vi.stubEnv("OPENAI_API_KEY", "must-not-use-api-key");
  vi.stubEnv("ANTHROPIC_BASE_URL", "https://must-not-receive-token.invalid");
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  expect(await readCodexCredential()).toEqual({
    apiKey: token,
    baseUrl: "https://chatgpt.com/backend-api",
    billingMode: "subscription",
  });
  const accounts = await codexAccounts();
  expect(JSON.stringify(await accounts.checkAuth("openai-codex"))).not.toContain(token);
  await accounts.logout("openai-codex");
  await expect(readCodexCredential()).rejects.toThrow("nimplex login codex");
  expect(fetch).not.toHaveBeenCalled();
});

it("serializes token refresh across independent runtimes and persists the rotated credential", async () => {
  const path = fixture(0);
  const fetch = vi.fn(async (url: string, options: RequestInit) => {
    expect(String(url)).toBe("https://auth.openai.com/oauth/token");
    expect(String(options.body)).toContain("original-refresh");
    await new Promise((resolve) => setTimeout(resolve, 20));
    return Response.json({
      access_token: token,
      refresh_token: "rotated-refresh",
      expires_in: 3600,
    });
  });
  vi.stubGlobal("fetch", fetch);
  const [a, b] = await Promise.all([readCodexCredential(), readCodexCredential()]);
  expect(a.apiKey).toBe(token);
  expect(b.apiKey).toBe(token);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(JSON.parse(readFileSync(path, "utf8"))["openai-codex"].refresh).toBe("rotated-refresh");
  expect(statSync(path).mode & 0o777).toBe(0o600);
});

it("preserves credentials after refresh failure and returns a sanitized re-login message", async () => {
  const path = fixture(0);
  const before = readFileSync(path, "utf8");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("secret-provider-diagnostic", { status: 401 })),
  );
  await expect(readCodexCredential()).rejects.toThrow(
    /^Codex subscription authentication is unavailable/,
  );
  expect(readFileSync(path, "utf8")).toBe(before);
});
