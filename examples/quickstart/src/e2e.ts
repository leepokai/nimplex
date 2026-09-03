/**
 * e2e 冒煙測試：Better Auth 註冊 → 自動建 org → 發 API key → SDK 三插槽全流程。
 *
 *   pnpm --filter @nimplex/example-quickstart exec tsx src/e2e.ts
 *
 * 需要 api（:8787）與 worker 都在跑。內建 loop 不需要真的 LLM key。
 */
import assert from "node:assert/strict";
import { defineHarness, Nimplex, NimplexError } from "@nimplex/sdk";
import { startFakeAnthropic } from "@nimplex/testkit";

const API = process.env.NIMPLEX_BASE_URL ?? "http://localhost:8787";
const ok = (label: string) => console.log(`  ✓ ${label}`);

// 沒有真 Anthropic key → 起假上游。閘道、預算、docker 沙箱、Managed Agents executor 全走真實程式碼，
// 只有最外面那一跳（api.anthropic.com）是假的；BYOK 的 base_url 指過去即可，閘道零改動。
const REAL_KEY = process.env.ANTHROPIC_API_KEY;
const fake = REAL_KEY ? null : await startFakeAnthropic(8790);
if (fake) ok(`假 Anthropic 上游 ${fake.url}（無 key 模式）`);

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
  api_key: REAL_KEY ?? "sk-ant-fake-e2e",
  scope: "org",
  base_url: fake ? fake.url : process.env.ANTHROPIC_BASE_URL,
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

// 前兩個 run 的花費累計起來，等一下要在 usage rollup 一分不差地對回來
let spentSoFar = 0;

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
  spentSoFar += result.spentUsd;
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
  spentSoFar += result.run.spent_usd;
  ok(`mid-run kill：killed(budget_exceeded)，花到 $${result.run.spent_usd} 就停`);
}

// ── 6a. 帳務 rollup：前面兩個 run 的每一分錢都在 GET /v1/usage 對得回來 ──────
{
  const byHarness = await nimplex.usage.summary({ groupBy: "harness" });
  const builtin = byHarness.buckets.find((b) => b.key === "builtin");
  assert.ok(builtin, "rollup 應有 builtin 桶");
  assert.equal(builtin.runs, 2, "builtin 桶應有 2 個 run");
  assert.ok(
    Math.abs(byHarness.total_usd - spentSoFar) < 1e-6,
    `rollup 總額 ${byHarness.total_usd} 應等於兩個 run 的花費 ${spentSoFar}`,
  );
  assert.ok(Math.abs(builtin.usd - spentSoFar) < 1e-6, "builtin 桶應等於總額");

  const byUser = await nimplex.usage.summary({ groupBy: "external_user_id" });
  assert.equal(byUser.buckets.length, 1);
  assert.equal(byUser.buckets[0]?.key, "default", "沒帶 external_user_id 應進 default 桶");

  const byDay = await nimplex.usage.summary({ groupBy: "day", tz: "Asia/Taipei" });
  const daySum = byDay.buckets.reduce((n, b) => n + b.usd, 0);
  assert.ok(Math.abs(daySum - spentSoFar) < 1e-6, "day 桶加總應等於總額");
  assert.ok(
    byDay.buckets.every((b) => /^\d{4}-\d{2}-\d{2}$/.test(b.key)),
    `day 桶的 key 應是 YYYY-MM-DD，實際 ${byDay.buckets.map((b) => b.key).join(",")}`,
  );

  const empty = await nimplex.usage.summary({
    from: "2000-01-01T00:00:00Z",
    to: "2000-01-02T00:00:00Z",
  });
  assert.equal(empty.total_usd, 0);
  assert.equal(empty.buckets.length, 0);

  await assert.rejects(
    () => nimplex.usage.summary({ tz: "Mars/Olympus" }),
    (err: unknown) => err instanceof NimplexError && err.status === 400,
    "不認得的時區應 400",
  );
  ok(
    `usage rollup：builtin 2 runs $${byHarness.total_usd}，harness / external_user_id / day 三種分桶都對得回逐筆記帳`,
  );
}

// ── 6b. 工具 registry：skills / MCP servers 上傳、覆寫、列表、刪除；明文憑證擋在門外 ──
{
  const skill = await nimplex.skills.upload({
    slug: "e2e-skill",
    name: "E2E skill",
    files: { "SKILL.md": "# e2e\n" },
  });
  assert.equal(skill.enabled, true);
  assert.equal(skill.version, "0.1.0");
  const again = await nimplex.skills.upload({
    slug: "e2e-skill",
    name: "E2E skill",
    version: "0.2.0",
    enabled: false,
    files: { "SKILL.md": "# e2e v2\n", "ref/notes.md": "x" },
  });
  assert.equal(again.id, skill.id, "同 slug 再上傳應是覆寫不是新建");
  assert.equal(again.version, "0.2.0");
  assert.equal(again.enabled, false);
  assert.ok((await nimplex.skills.list()).some((s) => s.slug === "e2e-skill"));
  await assert.rejects(
    () => nimplex.skills.upload({ slug: "no-entry", name: "x", files: { "README.md": "" } }),
    "沒有 SKILL.md 應在本地就被擋",
  );
  await assert.rejects(
    () =>
      nimplex.skills.upload({
        slug: "escape",
        name: "x",
        files: { "SKILL.md": "", "../etc/passwd": "" },
      }),
    "路徑穿越應被擋",
  );

  const mcp = await nimplex.mcpServers.put({
    slug: "e2e-mcp",
    url: "https://mcp.example.com/mcp",
    auth: "bearer_ref",
    credential_ref: "nango:conn_e2e",
  });
  assert.equal(mcp.credential_ref, "nango:conn_e2e");
  await assert.rejects(
    () =>
      nimplex.mcpServers.put({
        slug: "leak",
        url: "https://x.example/mcp",
        auth: "bearer_ref",
        credential_ref: "sk-ant-api03-plaintext",
      }),
    "明文 token 應在本地就被擋",
  );
  await assert.rejects(
    () => nimplex.mcpServers.put({ slug: "ftp", url: "ftp://x.example/mcp" }),
    "非 http(s) 應被擋",
  );
  // 繞過 SDK 直接打 API 也一樣擋
  const raw = await fetch(`${API}/v1/mcp-servers/leak`, {
    method: "PUT",
    headers: { authorization: `Bearer ${created.key}`, "content-type": "application/json" },
    body: JSON.stringify({
      url: "https://x.example/mcp",
      auth: "bearer_ref",
      credential_ref: "sk-ant-api03-plaintext",
    }),
  });
  assert.equal(raw.status, 400, "API 層也要擋明文憑證");

  await nimplex.mcpServers.delete("e2e-mcp");
  await assert.rejects(
    () => nimplex.mcpServers.delete("e2e-mcp"),
    (err: unknown) => err instanceof NimplexError && err.status === 404,
    "重複刪除應 404",
  );
  ok(
    "工具 registry：skills / MCP servers 上傳、覆寫、列表、刪除；缺 SKILL.md、路徑穿越、明文憑證都擋在門外",
  );
}

// ── 6c. metering=provider_reported 只有 Managed Agents 走得到：沙箱 harness 帶它一律 400 ──
{
  const wrongMetering = nimplex.agent({
    harness: "builtin",
    model: { provider: "anthropic", id: "claude-sonnet-5" },
    instructions: "e2e wrong metering",
    metering: "provider_reported",
    budgetUsd: 1,
  });
  await assert.rejects(
    () => wrongMetering.generate({ prompt: "nope" }),
    (err: unknown) => err instanceof NimplexError && err.status === 400,
    "沙箱 harness 帶 provider_reported 應 400（否則 budget_usd 存了卻沒人強制）",
  );
  ok("metering 守門：provider_reported 只給 claude-managed-agent，沙箱 harness 帶它直接 400");
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

// ── 7a. 同一份 harness 換到 E2B 雲端沙箱（有 E2B_API_KEY 才跑）──
{
  const e2b = providers.find((p) => p.id === "e2b");
  if (e2b?.available && docker?.available) {
    const result = await nimplex
      .agent({
        harness: "e2e-hello",
        model: { provider: "anthropic", id: "claude-sonnet-5" },
        sandbox: { provider: "e2b" },
        instructions: "e2e e2b",
        budgetUsd: 0.5,
      })
      .generate({ prompt: "ping-from-e2b" });
    assert.equal(result.run.status, "completed", `E2B run 應完成，錯誤：${result.run.error}`);
    assert.ok(
      result.text.includes("ping-from-e2b"),
      `E2B 沙箱 stdout 應含 prompt，實際：${result.text}`,
    );
    assert.ok(
      result.events.some((e) => e.type === "sandbox.destroyed"),
      "E2B 沙箱結束後應被銷毀",
    );
    ok("E2B 雲端沙箱：同一份 harness 只換 sandbox.provider，跑完並銷毀");
  } else {
    console.log(`  - E2B：${e2b?.unavailable_reason ?? "provider 未列出"}，跳過`);
  }
}

// ── 7b. claude-managed-agent：Anthropic 託管 loop + 容器；nimplex 管預算映射、事件翻譯、殺 ──
{
  const managed = (budgetUsd: number) =>
    nimplex.agent({
      harness: "claude-managed-agent",
      model: { provider: "anthropic", id: "claude-sonnet-5" },
      instructions: "e2e managed agent",
      budgetUsd,
    });

  if (fake) {
    // 假上游一個 turn 固定 42 分：預算夠 → end_turn；不夠 → budget_reached（含一個 request 的 overshoot）
    const done = await managed(1).generate({ prompt: "ping" });
    assert.equal(done.run.metering, "provider_reported", "MA 的錶應標成 provider_reported");
    assert.equal(
      done.run.status,
      "completed",
      `MA run 應完成，實際 ${done.run.status} ${done.run.error}`,
    );
    assert.ok(
      Math.abs(done.run.spent_usd - 0.42) < 1e-9,
      `session.usage 應回填 0.42，實際 ${done.run.spent_usd}`,
    );
    assert.ok(
      done.events.some((e) => e.type === "tool.call"),
      "應翻譯出 tool.call",
    );
    assert.ok(done.text.includes("任務完成"), `應翻譯出 agent.message 文字，實際：${done.text}`);
    ok(
      `claude-managed-agent：completed，session.usage 回填 $${done.run.spent_usd}，事件已翻成 nimplex union`,
    );

    const capped = await managed(0.3).generate({ prompt: "burn" });
    assert.equal(capped.run.status, "killed", `預算不足應被殺，實際 ${capped.run.status}`);
    assert.equal(capped.run.error, "budget_exceeded");
    assert.ok(
      Math.abs(capped.run.spent_usd - 0.33) < 1e-9,
      `overshoot 後應為 0.33，實際 ${capped.run.spent_usd}`,
    );
    ok(
      `claude-managed-agent 預算：上游 budget_reached → killed(budget_exceeded)，花 $${capped.run.spent_usd}`,
    );

    // 軟殺（run 標 killed）先於硬殺（刪 session）——兩層殺是最終一致，等一下再驗
    const deadline = Date.now() + 5_000;
    let sessions = [...fake.state.sessions.values()];
    while (!sessions.every((x) => x.deleted) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
      sessions = [...fake.state.sessions.values()];
    }
    assert.ok(
      sessions.length >= 2 && sessions.every((x) => x.deleted),
      `run 結束後 session 都要刪掉（否則上游繼續計時），未刪：${sessions
        .filter((x) => !x.deleted)
        .map((x) => x.id)
        .join(",")}`,
    );
    ok("claude-managed-agent：每個 run 結束都刪了 session");

    // MA 的錢不經閘道、靠 session usage 同步——同樣要進 usage_records，rollup 才對得回來
    const maUsage = await nimplex.usage.summary({ groupBy: "harness" });
    const maBucket = maUsage.buckets.find((b) => b.key === "claude-managed-agent");
    assert.ok(maBucket, "rollup 應有 claude-managed-agent 桶");
    assert.equal(maBucket.runs, 2);
    const maExpected = done.run.spent_usd + capped.run.spent_usd;
    assert.ok(
      Math.abs(maBucket.usd - maExpected) < 1e-6,
      `MA 桶 ${maBucket.usd} 應等於兩個 run 的花費 ${maExpected}`,
    );
    ok(
      `usage rollup 含 Managed Agents：claude-managed-agent 桶 $${maBucket.usd}（session usage 的增量逐筆記帳）`,
    );
  } else {
    const result = await managed(0.5).generate({ prompt: "ping" });
    assert.equal(result.run.metering, "provider_reported");
    assert.ok(
      ["completed", "killed"].includes(result.run.status),
      `真 key 應跑完或撞預算，實際：${result.run.status} ${result.run.error}`,
    );
    ok(
      `claude-managed-agent（真 key）：${result.run.status}，上游回報花費 $${result.run.spent_usd}`,
    );
  }
}

// ── 7c. 錶的真實路徑：docker 裡的 harness 打閘道 /v1/messages → reserve/settle → 超額軟殺 ──
if (fake && docker?.available) {
  const CALLER = [
    "const base = process.env.ANTHROPIC_BASE_URL;",
    "for (const n of [1, 2]) {",
    "  const r = await fetch(base + '/v1/messages', {",
    "    method: 'POST',",
    "    headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },",
    "    body: JSON.stringify({ model: process.env.NIMPLEX_MODEL, max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }),",
    "  });",
    "  console.log('call' + n + '=' + r.status);",
    "  if (!r.ok) process.exit(0);",
    "}",
  ].join("\n");
  await nimplex.harness.upload(
    defineHarness({
      slug: "e2e-llm-caller",
      name: "E2E LLM caller",
      version: "1.0.0",
      source: { kind: "inline" },
      install: [`cat > /workspace/call.mjs <<'EOS'\n${CALLER}\nEOS`],
      command: "node /workspace/call.mjs",
      env: {
        ANTHROPIC_BASE_URL: "{{gateway.anthropic}}",
        ANTHROPIC_API_KEY: "{{run.token}}",
        NIMPLEX_MODEL: "{{model}}",
      },
      provider: "anthropic",
      output: "text",
      workdir: "/workspace",
      timeout_seconds: 300,
    }),
  );
  const caller = (budgetUsd: number) =>
    nimplex.agent({
      harness: "e2e-llm-caller",
      model: { provider: "anthropic", id: "claude-sonnet-5" },
      sandbox: { provider: "docker" },
      instructions: "e2e metered",
      budgetUsd,
    });

  const metered = await caller(1).generate({ prompt: "two calls" });
  assert.equal(
    metered.run.status,
    "completed",
    `計量 run 應完成，實際 ${metered.run.status} ${metered.run.error}`,
  );
  assert.ok(metered.run.spent_usd > 0, "閘道應記到花費");
  assert.ok(
    metered.text.includes("call1=200") && metered.text.includes("call2=200"),
    `兩次 call 都應 200，實際：${metered.text}`,
  );
  ok(
    `閘道計量：沙箱裡 2 次 model call 經閘道 reserve/settle，花 $${metered.run.spent_usd}（exact）`,
  );

  const killed = await caller(0.001).generate({ prompt: "two calls" });
  assert.equal(
    killed.run.status,
    "killed",
    `超額應被殺，實際 ${killed.run.status} ${killed.run.error}`,
  );
  assert.equal(killed.run.error, "budget_exceeded");
  assert.ok(/call2=(402|409)/.test(killed.text), `第二次 call 應被閘道拒絕，實際：${killed.text}`);
  ok(
    `閘道軟殺：第一次 call 結算後超額，第二次被拒 → killed(budget_exceeded)，花 $${killed.run.spent_usd}`,
  );
}

// ── 7d. metering=none 的唯一上限：max_duration_seconds 真的會殺（以前是空殼）──
if (docker?.available) {
  await nimplex.harness.upload(
    defineHarness({
      slug: "e2e-sleeper",
      name: "E2E sleeper",
      version: "1.0.0",
      source: { kind: "inline" },
      install: [],
      command: "echo started && sleep 120",
      env: {},
      provider: "anthropic",
      output: "text",
      workdir: "/workspace",
      timeout_seconds: 600,
    }),
  );
  const started = Date.now();
  const timed = await nimplex
    .agent({
      harness: "e2e-sleeper",
      model: { provider: "anthropic", id: "claude-sonnet-5" },
      sandbox: { provider: "docker" },
      instructions: "e2e duration cap",
      metering: "none",
      maxDurationSeconds: 3,
    })
    .generate({ prompt: "zzz" });
  const elapsed = (Date.now() - started) / 1000;
  assert.equal(
    timed.run.status,
    "killed",
    `超時應被殺，實際 ${timed.run.status} ${timed.run.error}`,
  );
  assert.equal(timed.run.error, "max_duration");
  assert.ok(elapsed < 60, `應在看門狗一兩個週期內殺掉，實際 ${elapsed.toFixed(1)}s`);
  ok(
    `max_duration_seconds：metering=none 的 run 超過 3s 上限 → killed(max_duration)，${elapsed.toFixed(1)}s 內收尾`,
  );
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
  const bobUsage = await bobClient.usage.summary();
  assert.equal(bobUsage.total_usd, 0, "bob 的帳不該有 alice 的花費");
  assert.equal(bobUsage.runs, 0);
  await assert.rejects(
    () => bobClient.skills.get("e2e-skill"),
    (err: unknown) => err instanceof NimplexError && err.status === 404,
    "跨租戶讀 skill 應該 404",
  );
  assert.equal((await bobClient.skills.list()).length, 0, "bob 不該看到 alice 的 skill");
  ok("租戶隔離：跨 org 的 run / skill 一律 404，usage 是 0");
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

await fake?.close();
console.log("\ne2e 全數通過 ✅");
