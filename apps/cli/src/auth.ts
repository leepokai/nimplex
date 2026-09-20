import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";

export const credentialPath = () =>
  join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "nimplex", "credentials.json");

/** Legacy API-key credential formats retained for existing installations. */
export type KeyProvider = "anthropic" | "openai";
const PROVIDERS: Record<
  KeyProvider,
  { label: string; defaultUrl: string; keyVar: string; urlVar: string }
> = {
  anthropic: {
    label: "Anthropic",
    defaultUrl: "https://api.anthropic.com",
    keyVar: "ANTHROPIC_API_KEY",
    urlVar: "ANTHROPIC_BASE_URL",
  },
  openai: {
    label: "OpenAI",
    defaultUrl: "https://api.openai.com/v1",
    keyVar: "OPENAI_API_KEY",
    urlVar: "OPENAI_BASE_URL",
  },
};
export function keyProvider(value: string): KeyProvider {
  if (value !== "anthropic" && value !== "openai")
    throw new Error("Choose anthropic, openai or codex.");
  return value;
}
function endpoint(value: string) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new Error("Use an HTTP(S) model endpoint without embedded credentials.");
  return url.href.replace(/\/+$/, "");
}
type Saved = { apiKey?: unknown; baseUrl?: string };
/** Anthropic keeps the original top-level shape; other providers live under their name. */
type CredentialFile = Saved & { openai?: Saved };
function readFile(): CredentialFile {
  const path = credentialPath();
  try {
    const saved = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
    if (!saved || typeof saved !== "object" || Array.isArray(saved))
      throw new Error("Invalid credential file");
    return saved;
  } catch {
    throw new Error("Cannot read local model credentials. Run nimplex login to replace them.");
  }
}
export function readCredential(provider: KeyProvider = "anthropic"): {
  apiKey: string;
  baseUrl: string | null;
} {
  const spec = PROVIDERS[provider];
  const envKey = process.env[spec.keyVar];
  const envUrl = process.env[spec.urlVar];
  if (envKey !== undefined) {
    if (!envKey.trim()) throw new Error(`${spec.keyVar} is empty.`);
    return { apiKey: envKey.trim(), baseUrl: endpoint(envUrl ?? spec.defaultUrl) };
  }
  const file = readFile();
  const saved: Saved = provider === "anthropic" ? file : (file.openai ?? {});
  const baseUrl = endpoint(envUrl ?? saved.baseUrl ?? spec.defaultUrl);
  // A saved key belongs to its endpoint; an override requires its own explicit key.
  const apiKey = baseUrl === endpoint(saved.baseUrl ?? spec.defaultUrl) ? saved.apiKey : undefined;
  if (typeof apiKey !== "string" || !apiKey.trim())
    throw new Error(
      `Missing ${spec.label} credential. Set ${spec.keyVar}, load --env-file PATH, or run nimplex login${provider === "anthropic" ? "" : ` ${provider}`}.`,
    );
  return { apiKey: apiKey.trim(), baseUrl };
}
export function saveCredential(
  value: { baseUrl: string; apiKey?: string },
  provider: KeyProvider = "anthropic",
) {
  const path = credentialPath();
  let file: CredentialFile = {};
  try {
    file = readFile();
  } catch {
    // An unreadable file is replaced; the new credential must not depend on it.
  }
  const entry = { ...value, baseUrl: endpoint(value.baseUrl) };
  const next: CredentialFile =
    provider === "anthropic"
      ? { ...(file.openai ? { openai: file.openai } : {}), ...entry }
      : { ...file, openai: entry };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(next)}\n`, { flag: "wx", mode: 0o600 });
  renameSync(temp, path);
  chmodSync(path, 0o600);
}
export async function logout(provider = "anthropic") {
  if (provider === "codex" || provider === "openai-codex") {
    const { logoutCodex } = await import("./codex-auth.ts");
    return logoutCodex();
  }
  if (provider !== "anthropic" && provider !== "openai") {
    const { logoutPiProvider } = await import("./codex-auth.ts");
    return logoutPiProvider(provider);
  }
  const selected = keyProvider(provider);
  const spec = PROVIDERS[selected];
  saveCredential({ baseUrl: spec.defaultUrl }, selected);
  console.log(`Saved local ${spec.label} credential removed.`);
  if (process.env[spec.keyVar])
    console.log(`${spec.keyVar} is still set in the environment or loaded .env file.`);
}
export async function login(provider = "anthropic") {
  if (provider === "codex" || provider === "openai-codex") {
    const { loginCodex } = await import("./codex-auth.ts");
    return loginCodex();
  }
  if (provider !== "anthropic" && provider !== "openai") {
    const { loginPiProvider } = await import("./codex-auth.ts");
    return loginPiProvider(provider);
  }
  const selected = keyProvider(provider);
  const spec = PROVIDERS[selected];
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error(`Run nimplex login in an interactive terminal, or set ${spec.keyVar}.`);
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
      (await input.question(`${spec.label} endpoint [${spec.defaultUrl}]: `)).trim() ||
        spec.defaultUrl,
    );
    process.stdout.write(`${spec.label} API key (hidden): `);
    secret = true;
    const apiKey = (await input.question("")).trim();
    secret = false;
    process.stdout.write("\n");
    if (!apiKey) throw new Error("A model API key is required.");
    saveCredential({ baseUrl, apiKey }, selected);
    console.log("Credential saved locally. No model request was made. Run nimplex to begin.");
  } finally {
    secret = false;
    input.close();
    process.stdin.pause();
  }
}
