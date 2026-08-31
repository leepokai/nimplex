/**
 * 三個插槽走一遍：任意 harness（含自己上傳的）× 自帶 LLM token × 自選 sandbox。
 *
 *   pnpm --filter @nimplex/example-quickstart start
 */

import { defineHarness, Nimplex } from "@nimplex/sdk";

const nimplex = new Nimplex({ baseUrl: process.env.NIMPLEX_BASE_URL });

// ── 插槽 3：先看有哪些 sandbox provider 可用 ────────────────────────────────
const providers = await nimplex.sandbox.listProviders();
console.log("sandbox providers:");
for (const p of providers) {
  console.log(`  ${p.id.padEnd(8)} ${p.available ? "可用" : `不可用（${p.unavailable_reason}）`}`);
}
const sandboxProvider = providers.find((p) => p.available)?.id ?? "docker";

// ── 插槽 1：自己的 LLM token。明文只在這一次請求裡出現 ──────────────────────
await nimplex.providerKeys.put({
  provider: "anthropic",
  api_key: process.env.ANTHROPIC_API_KEY ?? "sk-ant-example-0000",
  scope: "org",
  // 自架 proxy / 相容端點可以覆寫；不填就打官方
  base_url: process.env.ANTHROPIC_BASE_URL,
});
console.log(
  "provider keys:",
  (await nimplex.providerKeys.list()).map((k) => `${k.provider}(${k.scope}) ••••${k.last4}`),
);

// ── 插槽 2a：用網路上現成的 harness ─────────────────────────────────────────
console.log(
  "harnesses:",
  (await nimplex.harness.list()).map((h) => `${h.slug}${h.builtin ? "" : "*"}`).join(" "),
);

// ── 插槽 2b：上傳自己的 harness ─────────────────────────────────────────────
// manifest 就是全部的介面：裝什麼、跑什麼、注入哪些 env。
// {{gateway.anthropic}} 會被換成 nimplex 閘道，{{run.token}} 是只在這個 run 有效的短期票，
// 所以你的真 key 永遠不會進到箱子裡。
await nimplex.harness.upload(
  defineHarness({
    slug: "hello-harness",
    name: "Hello harness",
    version: "1.0.0",
    source: { kind: "inline" },
    install: [],
    command: "echo harness 收到：{{prompt}} && echo 閘道在 $ANTHROPIC_BASE_URL",
    env: {
      ANTHROPIC_BASE_URL: "{{gateway.anthropic}}",
      ANTHROPIC_API_KEY: "{{run.token}}",
    },
    provider: "anthropic",
    output: "text",
    workdir: "/workspace",
    timeout_seconds: 120,
  }),
);

// ── 跑一次：介面形狀對齊 Vercel AI SDK 的 Agent（generate / stream）───────────
const agent = nimplex.agent({
  id: "quickstart",
  harness: "hello-harness",
  model: { provider: "anthropic", id: "claude-sonnet-5" },
  sandbox: { provider: sandboxProvider as "docker" },
  instructions: "示範一次完整的 run",
  budgetUsd: 0.05, // 美元硬上限：跑到一半也砍得掉
});

// externalUserId 是可選的歸因標籤（方便你自己 rollup 帳目），不給也能跑
const run = await agent.stream({ prompt: "你好" });
console.log(`run ${run.runId} 建立，狀態 ${run.run.status}`);
for await (const event of run.events) {
  console.log(`  [${event.seq}] ${event.type}`, JSON.stringify(event.payload)?.slice(0, 120) ?? "");
}
const final = await run.wait();
console.log(`結束：${final.status}，花了 $${final.spent_usd}（上限 $${final.budget_usd}）`);
