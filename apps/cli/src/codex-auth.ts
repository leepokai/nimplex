import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { CODEX_BASE_URL, CODEX_PROVIDER } from "@nimplex/runtime/models";

export const codexCredentialPath = () =>
  join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "nimplex", "codex-auth.json");

/** Pi serializes OAuth refreshes under its cross-process credential-store lock. */
export function codexAccounts(path = codexCredentialPath()) {
  return ModelRuntime.create({
    authPath: path,
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
}

export async function readCodexCredential(signal?: AbortSignal) {
  try {
    const resolved = await (await codexAccounts()).getAuth(CODEX_PROVIDER, { signal });
    if (!resolved?.auth.apiKey) throw new Error("Missing credential");
    return {
      apiKey: resolved.auth.apiKey,
      baseUrl: CODEX_BASE_URL,
      billingMode: "subscription" as const,
    };
  } catch {
    signal?.throwIfAborted();
    throw new Error(
      "Codex subscription authentication is unavailable. Run nimplex login codex to sign in again.",
    );
  }
}

export async function logoutCodex() {
  await (await codexAccounts()).logout(CODEX_PROVIDER);
  console.log("Nimplex Codex login removed. Other applications' logins are unchanged.");
}

export async function loginPiProvider(provider = CODEX_PROVIDER) {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error(`Run nimplex login ${provider} in an interactive terminal.`);
  const abort = new AbortController();
  let hidden = false;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (!hidden) process.stdout.write(chunk);
      callback();
    },
  });
  const input = createInterface({ input: process.stdin, output, terminal: true });
  const cancel = () => abort.abort(new Error("Login canceled."));
  input.on("SIGINT", cancel);
  input.on("close", cancel);
  const interaction: AuthInteraction = {
    signal: abort.signal,
    prompt: async (prompt) => {
      const signal = prompt.signal ? AbortSignal.any([abort.signal, prompt.signal]) : abort.signal;
      signal.throwIfAborted();
      if (prompt.type === "select") {
        console.log(prompt.message);
        prompt.options.forEach((option, i) => {
          console.log(`${i + 1}. ${option.label}`);
        });
        const choice = (await input.question("Choice [1]: ", { signal })).trim() || "1";
        const selected =
          prompt.options[Number(choice) - 1] ?? prompt.options.find((o) => o.id === choice);
        if (!selected) throw new Error("Invalid login method.");
        return selected.id;
      }
      hidden = prompt.type === "secret" || prompt.type === "manual_code";
      process.stdout.write(`${prompt.message}${hidden ? " (hidden)" : ""}: `);
      try {
        return await input.question("", { signal });
      } finally {
        hidden = false;
        process.stdout.write("\n");
      }
    },
    notify: (event) => {
      if (event.type === "auth_url") {
        console.log(`Open this URL to sign in:\n${event.url}`);
        if (event.instructions) console.log(event.instructions);
        const command =
          process.platform === "darwin"
            ? "open"
            : process.platform === "linux"
              ? "xdg-open"
              : undefined;
        if (command) execFile(command, [event.url], () => {});
      } else if (event.type === "device_code") {
        console.log(`Open ${event.verificationUri}\nDevice code: ${event.userCode}`);
      } else console.log(event.message);
    },
  };
  try {
    const accounts = await piAccounts(provider);
    const selected = accounts.getProvider(provider);
    if (!selected) throw new Error(`Unknown Pi provider: ${provider}`);
    const method = selected.auth.oauth?.login ? "oauth" : "api_key";
    await accounts.login(provider, method, interaction);
    console.log(`Pi provider login saved: ${provider}. Select a model with /model.`);
  } catch {
    throw new Error(
      abort.signal.aborted
        ? "Login canceled."
        : `Login did not complete. Retry nimplex login ${provider}.`,
    );
  } finally {
    hidden = false;
    input.close();
    process.stdin.pause();
  }
}

/** Credentials stay in nimplex's private store; Pi owns provider-specific resolution and refresh. */
export function piAccounts(provider: string) {
  return codexAccounts(
    provider === CODEX_PROVIDER
      ? codexCredentialPath()
      : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "nimplex", "pi-auth.json"),
  );
}
export async function readPiCredential(provider: string, signal?: AbortSignal) {
  const accounts = await piAccounts(provider);
  const resolved = await accounts.getAuth(provider, { signal });
  if (!resolved)
    throw new Error(
      `Missing ${provider} credential. Run nimplex login ${provider} or configure Pi's provider environment variables.`,
    );
  const auth = await accounts.checkAuth(provider, { signal });
  const subscription =
    auth?.type === "oauth" && accounts.getProvider(provider)?.auth.oauth?.isSubscription === true;
  return {
    apiKey: resolved.auth.apiKey,
    headers: resolved.auth.headers,
    env: resolved.env,
    baseUrl: resolved.auth.baseUrl ?? null,
    ...(subscription ? { billingMode: "subscription" as const } : {}),
  };
}
export async function logoutPiProvider(provider: string) {
  await (await piAccounts(provider)).logout(provider);
  console.log(`Saved ${provider} login removed. Environment credentials remain available.`);
}
export const loginCodex = () => loginPiProvider(CODEX_PROVIDER);
