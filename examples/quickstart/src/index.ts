/**
 * Minimal walkthrough: BYOK key -> pick a sandbox provider -> run with a USD hard cap.
 *
 *   NIMPLEX_API_KEY=nmx_live_... pnpm --filter @nimplex/example-quickstart start
 *
 * Mint the key via the API (see examples/quickstart/src/e2e.ts for the sign-up flow).
 */

import { Nimplex } from "@nimplex/sdk";

if (!process.env.NIMPLEX_API_KEY) {
  console.error("NIMPLEX_API_KEY missing: create an org API key first (POST /v1/api-keys).");
  process.exit(1);
}
const nimplex = new Nimplex({ baseUrl: process.env.NIMPLEX_BASE_URL });

const providers = await nimplex.sandbox.listProviders();
console.log("sandbox providers:");
for (const p of providers) {
  console.log(
    `  ${p.id.padEnd(8)} ${p.available ? "available" : `unavailable (${p.unavailable_reason})`}`,
  );
}
const sandboxProvider = providers.find((p) => p.available)?.id ?? "docker";

// Your own LLM token: plaintext travels in this one request only.
await nimplex.providerKeys.put({
  provider: "anthropic",
  api_key: process.env.ANTHROPIC_API_KEY ?? "sk-ant-example-0000",
  scope: "org",
  base_url: process.env.ANTHROPIC_BASE_URL,
});
console.log(
  "provider keys:",
  (await nimplex.providerKeys.list()).map((k) => `${k.provider}(${k.scope}) ****${k.last4}`),
);

// Interface shape follows the Vercel AI SDK Agent (generate / stream).
const agent = nimplex.agent({
  id: "quickstart",
  model: { provider: "anthropic", id: "claude-sonnet-5" },
  sandbox: { provider: sandboxProvider as "docker" },
  instructions: "demo run",
  budgetUsd: 0.05, // USD hard cap: killable mid-run
});

const run = await agent.stream({ prompt: "hello" });
console.log(`run ${run.runId} created, status ${run.run.status}`);
for await (const event of run.events) {
  console.log(`  [${event.seq}] ${event.type}`, JSON.stringify(event.payload)?.slice(0, 120) ?? "");
}
const final = await run.wait();
console.log(`done: ${final.status}, spent $${final.spent_usd} (cap $${final.budget_usd})`);
