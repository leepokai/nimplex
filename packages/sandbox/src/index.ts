// Open sandbox-provider registry.
//
// Add a provider by implementing SandboxProvider and registering it;
// worker, API, and harness code use the same port.
// E2B/Vercel/Daytona adapters map their create/connect/kill operations
// to create/resume/delete.

import { daytona } from "@computesdk/daytona";
import { vercel } from "@computesdk/vercel";
import type { SandboxProvider } from "@nimplex/core";
import { ComputeSdkSandboxProvider } from "./computesdk.ts";
import { DockerSandboxProvider } from "./docker.ts";
import { E2bSandboxProvider } from "./e2b.ts";
import { LocalSandboxProvider } from "./local.ts";

export * from "./computesdk.ts";
export * from "./docker.ts";
export * from "./e2b.ts";
export * from "./local.ts";
export * from "./spawn.ts";

const registry = new Map<string, SandboxProvider>();

export function registerSandboxProvider(provider: SandboxProvider): void {
  registry.set(provider.backendId, provider);
}

export function getSandboxProvider(backendId: string): SandboxProvider {
  const provider = registry.get(backendId);
  if (!provider) {
    throw new Error(
      `sandbox provider "${backendId}" 尚未註冊（已註冊：${[...registry.keys()].join(", ")}）。` +
        `實作 SandboxProvider 介面後用 registerSandboxProvider() 掛上去。`,
    );
  }
  return provider;
}

export function hasSandboxProvider(backendId: string): boolean {
  return registry.has(backendId);
}

export function listSandboxProviders(): SandboxProvider[] {
  return [...registry.values()];
}

registerSandboxProvider(new LocalSandboxProvider());
registerSandboxProvider(new DockerSandboxProvider());
// Missing E2B credentials produce unavailableReason while the API still lists the provider.
registerSandboxProvider(new E2bSandboxProvider());

// Additional ComputeSDK providers remain listed but unavailable without configuration.
registerSandboxProvider(
  new ComputeSdkSandboxProvider({
    backendId: "daytona",
    unavailableReason: () => (process.env.DAYTONA_API_KEY ? null : "缺 DAYTONA_API_KEY"),
    backend: () => daytona({ apiKey: process.env.DAYTONA_API_KEY }),
  }),
);
registerSandboxProvider(
  new ComputeSdkSandboxProvider({
    backendId: "vercel",
    unavailableReason: () =>
      process.env.VERCEL_TOKEN && process.env.VERCEL_TEAM_ID && process.env.VERCEL_PROJECT_ID
        ? null
        : "缺 VERCEL_TOKEN / VERCEL_TEAM_ID / VERCEL_PROJECT_ID",
    backend: () =>
      vercel({
        token: process.env.VERCEL_TOKEN,
        teamId: process.env.VERCEL_TEAM_ID,
        projectId: process.env.VERCEL_PROJECT_ID,
      }),
  }),
);
