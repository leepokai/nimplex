/**
 * e2e smoke test: Better Auth sign-up -> auto org -> API key -> SDK run -> budget kill -> tenant isolation.
 *
 *   pnpm --filter @nimplex/example-quickstart exec tsx src/e2e.ts
 *
 * Needs api (:8787) and worker running. No sandbox provider and no real LLM key needed: the fake upstream
 * scripts 4 bash tool calls then stops, so every run is 5 model calls at 1000 in / 500 out tokens
 * = $0.007 each at the claude-sonnet-5 rate ($0.035 per run).
 */
import assert from "node:assert/strict";
import { Nimplex, NimplexError } from "@nimplex/sdk";
import { startFakeAnthropic } from "@nimplex/testkit";
import { API, ok, sessionFetch, signUp } from "./lib.ts";

// Budget assertions always use a deterministic fake upstream, even when real keys are set.
const fake = await startFakeAnthropic(8790, { toolCalls: 4 });
if (fake) ok(`fake Anthropic upstream ${fake.url} (no-key mode)`);

// 1. no identity -> 401
{
  const res = await fetch(`${API}/v1/runs`);
  assert.equal(res.status, 401);
  ok("/v1/* without identity is 401");
}

// 2. sign up -> one org
const alice = await signUp("alice");
const aliceOrgs = (await (await sessionFetch(alice.cookie, "/v1/orgs")).json()) as {
  orgs: { id: string; name: string }[];
};
assert.equal(aliceOrgs.orgs.length, 1, "sign-up should create exactly one org");
ok(`sign-up created org "${aliceOrgs.orgs[0]?.name}"`);

// 3. mint an org API key (plaintext appears once)
const keyRes = await sessionFetch(alice.cookie, "/v1/api-keys", {
  method: "POST",
  body: JSON.stringify({ name: "e2e" }),
});
assert.equal(keyRes.status, 201);
const created = (await keyRes.json()) as { id: string; key: string; last4: string };
assert.ok(created.key.startsWith("nmx_live_"));
ok(`API key nmx_live_****${created.last4}`);

// 4. SDK with the Bearer key
const nimplex = new Nimplex({ baseUrl: API, apiKey: created.key });

await nimplex.providerKeys.put({
  provider: "anthropic",
  api_key: "sk-ant-fake-e2e",
  scope: "org",
  base_url: fake.url,
});
ok("BYOK key stored (AES-256-GCM)");

// Slice 1 never opens a box (tools run in-process); the list is only checked for shape here.
const providers = await nimplex.sandbox.listProviders();
assert.ok(providers.length > 0, "sandbox provider list must not be empty");
ok(`sandbox providers ${providers.map((p) => `${p.id}${p.available ? "" : "(x)"}`).join(" / ")}`);

const agentWith = (instructions: string, budgetUsd: number) =>
  nimplex.agent({
    model: { provider: "anthropic", id: "claude-sonnet-5" },
    sandbox: { provider: "local" },
    instructions,
    budgetUsd,
  });

// 5. the Pi loop completes: 5 model calls, 4 bash tool calls in the just-bash VFS ($0.035 < $1 cap)
{
  const result = await agentWith("e2e smoke", 1).generate({ prompt: "hello" });
  assert.equal(result.run.status, "completed", `run ${result.run.id}: ${result.run.error}`);
  const calls = result.events.filter((e) => e.type === "model.call").length;
  const toolResults = result.events.filter((e) => e.type === "tool.result").length;
  assert.equal(calls, 5, `expected 5 model calls, got ${calls}`);
  assert.equal(toolResults, 4, `expected 4 tool results, got ${toolResults}`);
  assert.ok(
    Math.abs(result.spentUsd - 0.035) < 1e-9,
    `spent should be 0.035, got ${result.spentUsd}`,
  );
  ok(
    `run completed: ${calls} model calls, ${toolResults} tool results, spent $${result.spentUsd} (cap $1)`,
  );
}

// 6. The USD cap rejects the next unaffordable call before dispatch.
{
  const result = await agentWith("e2e budget kill", 0.02).generate({ prompt: "burn" });
  assert.equal(result.run.status, "killed");
  assert.equal(result.run.error, "budget_exceeded");
  assert.ok(result.run.spent_usd <= 0.02, "spend must never exceed the cap");
  ok(`mid-run kill: killed(budget_exceeded) at $${result.run.spent_usd}`);
}

// 7. missing budget is rejected by the contract
{
  const res = await fetch(`${API}/v1/runs`, {
    method: "POST",
    headers: { authorization: `Bearer ${created.key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: { provider: "anthropic", id: "claude-sonnet-5" },
      sandbox: { provider: "local" },
      instructions: "no budget",
    }),
  });
  assert.equal(res.status, 400, "a run without budget_usd must be rejected");
  ok("budget_usd is mandatory");
}

// 8. tenant isolation
{
  const bob = await signUp("bob");
  const bobKeyRes = await sessionFetch(bob.cookie, "/v1/api-keys", {
    method: "POST",
    body: JSON.stringify({ name: "bob" }),
  });
  const bobKey = ((await bobKeyRes.json()) as { key: string }).key;
  const bobClient = new Nimplex({ baseUrl: API, apiKey: bobKey });

  assert.equal((await bobClient.runs.list()).length, 0, "bob must not see alice's runs");
  const aliceRun = (await nimplex.runs.list())[0];
  assert.ok(aliceRun);
  await assert.rejects(
    () => bobClient.runs.get(aliceRun.id),
    (err: unknown) => err instanceof NimplexError && err.status === 404,
    "cross-tenant run read must be 404",
  );
  ok("tenant isolation: cross-org run is 404");
}

// 9. revoke key -> 401
{
  const revokeRes = await sessionFetch(alice.cookie, `/v1/api-keys/${created.id}`, {
    method: "DELETE",
  });
  assert.equal(revokeRes.status, 204);
  await assert.rejects(
    () => nimplex.runs.list(),
    (err: unknown) => err instanceof NimplexError && err.status === 401,
    "revoked key must be 401",
  );
  ok("revoked key: next request is 401");
}

await fake?.close();
console.log("\ne2e passed");
