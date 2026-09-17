import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";

export const credentialPath = () =>
  join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "nimplex", "credentials.json");
const defaultUrl = "https://api.anthropic.com";
function endpoint(value: string) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new Error("Use an HTTP(S) model endpoint without embedded credentials.");
  return url.href.replace(/\/+$/, "");
}
export function readCredential(): { apiKey: string; baseUrl: string | null } {
  if (process.env.ANTHROPIC_API_KEY !== undefined) {
    if (!process.env.ANTHROPIC_API_KEY.trim()) throw new Error("ANTHROPIC_API_KEY is empty.");
    return {
      apiKey: process.env.ANTHROPIC_API_KEY.trim(),
      baseUrl: endpoint(process.env.ANTHROPIC_BASE_URL ?? defaultUrl),
    };
  }
  const path = credentialPath();
  let saved: { apiKey?: unknown; baseUrl?: string } = {};
  try {
    saved = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
    if (!saved || typeof saved !== "object" || Array.isArray(saved))
      throw new Error("Invalid credential file");
  } catch {
    throw new Error("Cannot read local model credentials. Run nimplex login to replace them.");
  }
  const baseUrl = endpoint(process.env.ANTHROPIC_BASE_URL ?? saved.baseUrl ?? defaultUrl);
  // A saved key belongs to its endpoint; an override requires its own explicit key.
  const apiKey =
    process.env.ANTHROPIC_API_KEY ??
    (baseUrl === endpoint(saved.baseUrl ?? defaultUrl) ? saved.apiKey : undefined);
  if (typeof apiKey !== "string" || !apiKey.trim())
    throw new Error(
      "Missing Anthropic credential. Set ANTHROPIC_API_KEY, load --env-file PATH, or run nimplex login.",
    );
  return { apiKey: apiKey.trim(), baseUrl };
}
export function saveCredential(value: { baseUrl: string; apiKey?: string }) {
  const path = credentialPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ ...value, baseUrl: endpoint(value.baseUrl) })}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  renameSync(temp, path);
  chmodSync(path, 0o600);
}
export async function logout(provider = "anthropic") {
  if (provider === "codex" || provider === "openai-codex") {
    const { logoutCodex } = await import("./codex-auth.ts");
    return logoutCodex();
  }
  if (provider !== "anthropic") throw new Error("Choose anthropic or codex.");
  saveCredential({ baseUrl: defaultUrl });
  console.log("Saved local model credential removed.");
  if (process.env.ANTHROPIC_API_KEY)
    console.log("ANTHROPIC_API_KEY is still set in the environment or loaded .env file.");
}
export async function login(provider = "anthropic") {
  if (provider === "codex" || provider === "openai-codex") {
    const { loginCodex } = await import("./codex-auth.ts");
    return loginCodex();
  }
  if (provider !== "anthropic") throw new Error("Choose anthropic or codex.");
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error("Run nimplex login in an interactive terminal, or set ANTHROPIC_API_KEY.");
  let secret = false;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (!secret) process.stdout.write(chunk);
      callback();
    },
  });
  const input = createInterface({ input: process.stdin, output, terminal: true });
  try {
    const baseUrl = endpoint(
      (await input.question(`Anthropic endpoint [${defaultUrl}]: `)).trim() || defaultUrl,
    );
    process.stdout.write("Anthropic API key (hidden): ");
    secret = true;
    const apiKey = (await input.question("")).trim();
    secret = false;
    process.stdout.write("\n");
    if (!apiKey) throw new Error("A model API key is required.");
    saveCredential({ baseUrl, apiKey });
    console.log("Credential saved locally. No model request was made. Run nimplex to begin.");
  } finally {
    secret = false;
    input.close();
    process.stdin.pause();
  }
}
