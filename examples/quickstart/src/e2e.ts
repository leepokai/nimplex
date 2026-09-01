/**
 * e2e 冒煙測試：Better Auth 註冊 → 自動建 org → 發 API key → SDK 三插槽全流程。
 *
 *   pnpm --filter @nimplex/example-quickstart exec tsx src/e2e.ts
 *
 * 需要 api（:8787）與 worker 都在跑。內建 loop 不需要真的 LLM key。
 */
import assert from "node:assert/strict";
import { defineHarness, Nimplex, NimplexError } from "@nimplex/sdk";

const API = process.env.NIMPLEX_BASE_URL ?? "http://localhost:8787";
const ok = (label: string) => console.log(`  ✓ ${label}`);

async function signUp(label: string) {
  const email = `e2e-${label}-${Date.now()}@example.com`;
  const res = await fetch(`${API}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: API },
    body: JSON.stringify({ name: `E2E ${label}`, email, password: "password1234" }),
  });
  assert.equal(res.ok, true, `sign-up 失敗：${res.status} ${await res.clone().text()}`);
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  assert.ok(cookie.length > 0, "sign-up 沒回 session cookie");
  return { email, cookie };
}

async function sessionFetch(cookie: string, path: string, init: RequestInit = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { cookie, "content-type": "application/json", ...init.headers },
  });
  return res;
}

// ── 1. 沒帶身分 → 401 ────────────────────────────────────────────────────────
{
  const res = await fetch(`${API}/v1/runs`);
  assert.equal(res.status, 401);
  ok("/v1/* 無身分一律 401");
}

// ── 2. 註冊（Better Auth）→ 自動擁有一個 org ────────────────────────────────
const alice = await signUp("alice");
const aliceOrgs = (await (await sessionFetch(alice.cookie, "/v1/orgs")).json()) as {
  orgs: { id: string; name: string }[];
};
assert.equal(aliceOrgs.orgs.length, 1, "註冊後應該剛好有一個 org");
ok(`註冊即建 org：「${aliceOrgs.orgs[0]?.name}」`);

// ── 3. 用 session 發一把 org API key（明文只出現這一次）─────────────────────
const keyRes = await sessionFetch(alice.cookie, "/v1/api-keys", {
  method: "POST",
  body: JSON.stringify({ name: "e2e" }),
});
assert.equal(keyRes.status, 201);
const created = (await keyRes.json()) as { id: string; key: string; last4: string };
assert.ok(created.key.startsWith("nmx_live_"));
ok(`發 API key：nmx_live_••••${created.last4}`);

// ── 4. SDK 帶 Bearer key 走三插槽 ───────────────────────────────────────────
const nimplex = new Nimplex({ baseUrl: API, apiKey: created.key });

await nimplex.providerKeys.put({
  provider: "anthropic",
  api_key: process.env.ANTHROPIC_API_KEY ?? "sk-ant-e2e-dummy-0000",
  scope: "org",
});
ok("插槽 1：BYOK key 落地（AES-256-GCM）");

const harnesses = await nimplex.harness.list();
assert.ok(
  harnesses.some((h) => h.slug === "builtin"),
  "內建 harness 應該在註冊表裡",
);
ok(`插槽 2：harness 註冊表 ${harnesses.map((h) => h.slug).join(" / ")}`);

const providers = await nimplex.sandbox.listProviders();
ok(
  `插槽 3：sandbox providers ${providers.map((p) => `${p.id}${p.available ? "" : "(x)"}`).join(" / ")}`,
);

// ── 5. 內建 loop 跑完（5 步 × $0.12 = $0.60 < $1 上限）──────────────────────
{
  const agent = nimplex.agent({
    harness: "builtin",
    model: { provider: "anthropic", id: "claude-sonnet-5" },
    instructions: "e2e 冒煙",
    budgetUsd: 1,
  });
  const result = await agent.generate({ prompt: "hello" });
  assert.equal(result.run.status, "completed");
  assert.ok(Math.abs(result.spentUsd - 0.6) < 1e-9, `spent 應為 0.60，實際 ${result.spentUsd}`);
  ok(`run 跑完：completed，花 $${result.spentUsd}（上限 $1）`);
}

// ── 6. 頭條承諾：美元上限中途砍（$0.30 上限，第 3 步就會超）────────────────
{
  const agent = nimplex.agent({
    harness: "builtin",
    model: { provider: "anthropic", id: "claude-sonnet-5" },
    instructions: "e2e 預算殺",
    budgetUsd: 0.3,
  });
  const result = await agent.generate({ prompt: "burn" });
  assert.equal(result.run.status, "killed");
  assert.equal(result.run.error, "budget_exceeded");
  assert.ok(result.run.spent_usd < 0.6, "應該在跑完之前就被砍");
  ok(`mid-run kill：killed(budget_exceeded)，花到 $${result.run.spent_usd} 就停`);
}

// ── 7. docker sandbox × 自上傳 harness（echo，不需要真 LLM）────────────────
const docker = providers.find((p) => p.id === "docker");
if (docker?.available) {
  await nimplex.harness.upload(
    defineHarness({
      slug: "e2e-hello",
      name: "E2E hello harness",
      version: "1.0.0",
      source: { kind: "inline" },
      install: [],
      command: "echo e2e-harness-got:{{prompt}} && echo gateway=$ANTHROPIC_BASE_URL",
      env: {
        ANTHROPIC_BASE_URL: "{{gateway.anthropic}}",
        ANTHROPIC_API_KEY: "{{run.token}}",
      },
      provider: "anthropic",
      output: "text",
      workdir: "/workspace",
      timeout_seconds: 300,
    }),
  );
  const agent = nimplex.agent({
    harness: "e2e-hello",
    model: { provider: "anthropic", id: "claude-sonnet-5" },
    sandbox: { provider: "docker" },
    instructions: "e2e docker",
    budgetUsd: 0.5,
  });
  const result = await agent.generate({ prompt: "ping" });
  assert.equal(result.run.status, "completed", `docker run 應完成，錯誤：${result.run.error}`);
  // {{prompt}} = instructions + input 合併，中間帶換行
  assert.ok(result.text.includes("e2e-harness-got:"), `stdout 應含哨兵，實際：${result.text}`);
  assert.ok(result.text.includes("ping"), `stdout 應含 prompt 內容，實際：${result.text}`);
  assert.ok(result.text.includes("gateway="), "stdout 應含注入的 gateway base URL");
  ok("docker sandbox：自上傳 harness 跑完，閘道 URL 與 run token 注入成功");
} else {
  console.log("  - docker 不可用，跳過 sandbox 實跑");
}

// ── 8. 租戶隔離：另一個帳號看不到 alice 的東西 ─────────────────────────────
{
  const bob = await signUp("bob");
  const bobKeyRes = await sessionFetch(bob.cookie, "/v1/api-keys", {
    method: "POST",
    body: JSON.stringify({ name: "bob" }),
  });
  const bobKey = ((await bobKeyRes.json()) as { key: string }).key;
  const bobClient = new Nimplex({ baseUrl: API, apiKey: bobKey });

  const bobRuns = await bobClient.runs.list();
  assert.equal(bobRuns.length, 0, "bob 不該看到 alice 的 run");

  const aliceRun = (await nimplex.runs.list())[0];
  assert.ok(aliceRun);
  await assert.rejects(
    () => bobClient.runs.get(aliceRun.id),
    (err: unknown) => err instanceof NimplexError && err.status === 404,
    "跨租戶讀 run 應該 404",
  );
  ok("租戶隔離：跨 org 的 run 一律 404");
}

// ── 9. 撤銷 key → 立即 401 ─────────────────────────────────────────────────
{
  const revokeRes = await sessionFetch(alice.cookie, `/v1/api-keys/${created.id}`, {
    method: "DELETE",
  });
  assert.equal(revokeRes.status, 204);
  await assert.rejects(
    () => nimplex.runs.list(),
    (err: unknown) => err instanceof NimplexError && err.status === 401,
    "撤銷後的 key 應該 401",
  );
  ok("撤銷 key：下一個請求立刻 401");
}

console.log("\ne2e 全數通過 ✅");
