// Providers share one contract suite; unavailable infrastructure skips its provider group.
process.env.NIMPLEX_ALLOW_LOCAL_SANDBOX = "1";

import { daytona } from "@computesdk/daytona";
import { vercel } from "@computesdk/vercel";
import { describeSandboxConformance } from "@nimplex/testkit";
import { ComputeSdkSandboxProvider } from "./computesdk.ts";
import { DockerSandboxProvider } from "./docker.ts";
import { E2bSandboxProvider } from "./e2b.ts";
import { LocalSandboxProvider } from "./local.ts";

// Local /workspace maps file operations and cwd into a temporary directory, but does not
// rewrite absolute paths inside shell scripts. Declare this development-only limitation.
describeSandboxConformance("local", () => new LocalSandboxProvider(), {
  timeoutMs: 30_000,
  absolutePaths: false,
});
describeSandboxConformance("docker", () => new DockerSandboxProvider(), { timeoutMs: 180_000 });
// E2B skips without a key; configured runs create real paid cloud sandboxes.
describeSandboxConformance("e2b", () => new E2bSandboxProvider(), { timeoutMs: 180_000 });

// ComputeSDK providers also skip without credentials and otherwise run the same contracts.
describeSandboxConformance(
  "daytona (via ComputeSDK)",
  () =>
    new ComputeSdkSandboxProvider({
      backendId: "daytona",
      unavailableReason: () => (process.env.DAYTONA_API_KEY ? null : "缺 DAYTONA_API_KEY"),
      backend: () => daytona({ apiKey: process.env.DAYTONA_API_KEY }),
    }),
  { timeoutMs: 180_000 },
);
describeSandboxConformance(
  "vercel (via ComputeSDK)",
  () =>
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
  { timeoutMs: 180_000 },
);
