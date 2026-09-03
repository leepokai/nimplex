/**
 * One concrete combination end to end: claude-code harness × E2B sandbox × Anthropic's own API (BYOK) × Haiku 4.5.
 *
 *   NIMPLEX_API_KEY=nmx_live_... ANTHROPIC_API_KEY=sk-ant-... \
 *     pnpm --filter @nimplex/example-quickstart exec tsx src/claude-code-e2b.ts
 *
 * Without a real ANTHROPIC_API_KEY, point ANTHROPIC_BASE_URL at the testkit fake upstream
 * (pnpm --filter @nimplex/testkit start) and the exact same path runs with a fake key:
 * E2B sandbox -> gateway -> upstream.
 *
 * Prerequisite: the worker's NIMPLEX_PUBLIC_URL must be reachable from E2B's cloud. For local dev,
 * run `ngrok http 8787`, then restart the worker with the https://xxx.ngrok-free.dev URL as
 * NIMPLEX_PUBLIC_URL.
 */

import { Nimplex } from "@nimplex/sdk";

const nimplexKey = process.env.NIMPLEX_API_KEY;
if (!nimplexKey) {
  console.error("缺 NIMPLEX_API_KEY：在 console（http://localhost:5173）的 API keys 頁發一把。");
  process.exit(1);
}
const anthropicKey =
  process.env.ANTHROPIC_API_KEY ?? (process.env.ANTHROPIC_BASE_URL ? "sk-ant-fake" : undefined);
if (!anthropicKey) {
  console.error("缺 ANTHROPIC_API_KEY（或設 ANTHROPIC_BASE_URL 指到假上游）。");
  process.exit(1);
}

const MODEL = process.env.NIMPLEX_MODEL ?? "claude-haiku-4-5-20251001";
const BUDGET_USD = Number(process.env.BUDGET_USD ?? 0.5);
const PROMPT =
  process.env.PROMPT ??
  "在目前目錄建一個 hello.txt，內容寫一句話介紹你自己。建好後用 cat 把它印出來，然後結束。";

const nimplex = new Nimplex({ baseUrl: process.env.NIMPLEX_BASE_URL });

// ── Slot 3: E2B must be available ────────────────────────────────────────
const providers = await nimplex.sandbox.listProviders();
const e2b = providers.find((p) => p.id === "e2b");
if (!e2b?.available) {
  console.error(`E2B 不可用：${e2b?.unavailable_reason ?? "provider 未列出"}`);
  process.exit(1);
}

// ── Slot 1: BYOK. The real key appears only in this one request; afterwards only the gateway can unseal it ──
await nimplex.providerKeys.put({
  provider: "anthropic",
  api_key: anthropicKey,
  scope: "org",
  base_url: process.env.ANTHROPIC_BASE_URL,
});
console.log(
  `BYOK：anthropic ••••${anthropicKey.slice(-4)}${process.env.ANTHROPIC_BASE_URL ? `（上游 ${process.env.ANTHROPIC_BASE_URL}）` : "（官方端點）"}`,
);

// ── Slot 2: the built-in claude-code harness ─────────────────────────────
const agent = nimplex.agent({
  id: "claude-code-e2b",
  harness: "claude-code",
  model: { provider: "anthropic", id: MODEL },
  sandbox: { provider: "e2b" },
  instructions: "你在一個 E2B 雲端沙箱裡，工作目錄是 /workspace。",
  budgetUsd: BUDGET_USD,
});

const startedAt = Date.now();
const stamp = () => `${((Date.now() - startedAt) / 1000).toFixed(1).padStart(6)}s`;

const run = await agent.stream({ prompt: PROMPT });
console.log(
  `run ${run.runId}  harness=claude-code  sandbox=e2b  model=${MODEL}  上限 $${BUDGET_USD}`,
);

type Block = { type: string; text?: string; name?: string };
for await (const ev of run.events) {
  const p = (ev.payload ?? {}) as Record<string, unknown>;
  if (ev.type === "harness.event") {
    // claude-code --output-format stream-json: one {type: system | assistant | user | result} per line
    const kind = p.type as string | undefined;
    if (kind === "system") {
      // Many system subtypes exist (init / status / hook ...); only init carries model and cwd
      if (p.subtype === "init") {
        console.log(`${stamp()}  claude-code 啟動  model=${p.model}  cwd=${p.cwd}`);
      }
    } else if (kind === "assistant") {
      const msg = p.message as { content?: Block[] } | undefined;
      const text = (msg?.content ?? [])
        .map((b) =>
          b.type === "text" ? b.text : b.type === "tool_use" ? `[tool ${b.name}]` : `[${b.type}]`,
        )
        .join(" ");
      console.log(`${stamp()}  assistant  ${text.slice(0, 220)}`);
    } else if (kind === "result") {
      console.log(
        `${stamp()}  result  ${String(p.result ?? "").slice(0, 300)}  （claude-code 自報 $${p.total_cost_usd}）`,
      );
    } else if (kind) {
      console.log(`${stamp()}  ${kind}`);
    }
  } else if (ev.type === "harness.stderr") {
    console.log(`${stamp()}  stderr  ${String(p.text ?? "").slice(0, 220)}`);
  } else if (ev.type === "harness.stdout") {
    console.log(`${stamp()}  stdout  ${String(p.text ?? "").slice(0, 220)}`);
  } else {
    console.log(`${stamp()}  ${ev.type}  ${JSON.stringify(p).slice(0, 140)}`);
  }
}

const final = await run.wait();
console.log(
  `\n結束：${final.status}${final.error ? `（${final.error}）` : ""}，閘道記帳 $${final.spent_usd}（上限 $${final.budget_usd}），共 ${((Date.now() - startedAt) / 1000).toFixed(0)} 秒`,
);
process.exit(final.status === "completed" ? 0 : 1);
