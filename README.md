# nimplex

**OpenRouter for cloud agents.** 一把 key，在任何 sandbox 上跑任何 harness、燒你自己的 LLM 額度，
而且每一個終端使用者都有一個跑到一半也砍得掉的美元硬上限。

## 三個插槽

換掉任何一格，其他格都不用改。

| 插槽 | 你可以選 | 換掉它要改什麼 |
| --- | --- | --- |
| **harness** | 內建的 `claude-code` / `codex` / `opencode` / `claude-managed-agent`（Anthropic 託管），或**上傳你自己的** | `PUT /v1/harnesses/:slug` 一份 manifest |
| **LLM provider** | anthropic / openai / openrouter，**你自己的 token** | `PUT /v1/provider-keys` |
| **sandbox** | `docker`、`e2b`（直接接）、`daytona` / `vercel`（透過 ComputeSDK adapter）、`local`（dev） | 直接接：實作 `SandboxProvider`；長尾：`new ComputeSdkSandboxProvider({ backendId, backend: () => modal({…}) })` 三行；兩條路都要過 `@nimplex/testkit` 的 conformance kit |

harness 是**資料不是程式碼**：內建的與你上傳的走同一份 manifest、同一條解析路徑。
同名 slug 會覆寫內建版本（只在你的 org 生效）——上游 CLI 改了旗標，你自己改 manifest 就好，不用等我們發版。

## 為什麼錶跟 harness 無關

支點是 **`ANTHROPIC_BASE_URL` 注入**：沙箱裡的 harness 拿到的是 nimplex 簽發的短期票，
你的真 key 只存在閘道那一側（AES-256-GCM 加密落地），**永遠不進箱子**。

```
        ┌────────── nimplex control plane ──────────┐
        │  runs · budgets · events · audit          │
        └────┬──────────────────────┬───────────────┘
             │ 開/砍                 │ 每次 call 記帳 + 放行/拒絕
             ▼                      ▼
     ┌───────────────┐      ┌──────────────────┐
     │  Sandbox Port │      │  nimplex Gateway │──► Anthropic / OpenAI /
     │ docker·local  │      │  (BYOK vault)    │    OpenRouter（你自己的 key）
     └───────┬───────┘      └────────▲─────────┘
             │ 箱子裡跑              │ base URL 注入
             ▼                      │
     ┌───────────────────────────────┴──┐
     │  Harness（內建 or 你上傳的）        │ ← 箱內只有 nimplex 短期票
     └──────────────────────────────────┘
```

因此 kill 有兩層：**軟殺**（閘道拒發下一個 call）+ **硬殺**（銷毀整個沙箱）。

## Quickstart

```bash
pnpm install
docker compose up -d        # Postgres on :5433
pnpm db:migrate && pnpm db:seed
pnpm --filter @nimplex/api start &
pnpm --filter @nimplex/worker start &
pnpm --filter @nimplex/console dev &   # console on :5173
```

**先拿一把 org API key**：開 <http://localhost:5173> 用 GitHub 或 Google 登入
（Better Auth；OAuth 憑證填在根目錄 `.env`，步驟見 `.env.example`；首次登入即自動擁有一個
organization）→「API keys」頁建立一把 `nmx_live_…`。開發期沒有 OAuth 憑證時，
可先設 `NIMPLEX_DEV_EMAIL_AUTH=1` 走 email 註冊（e2e 冒煙腳本也走這條）。
`/v1/*` 全部要帶身分——console 用 session cookie，程式用 Bearer key，兩者打的是同一組 endpoint。

```bash
export NIMPLEX_API_KEY=nmx_live_...

# 插槽 1：放進你自己的 LLM token（明文只在這一次請求裡出現，落地即加密）
curl -X PUT localhost:8787/v1/provider-keys \
  -H "authorization: Bearer $NIMPLEX_API_KEY" -H 'content-type: application/json' \
  -d '{"provider":"anthropic","api_key":"sk-ant-...","scope":"org"}'

# 插槽 3：看有哪些 sandbox provider 可用
curl -s -H "authorization: Bearer $NIMPLEX_API_KEY" localhost:8787/v1/sandbox-providers

# 插槽 2：用網路上現成的 harness 跑一次，上限 $0.50
curl -X POST localhost:8787/v1/runs \
  -H "authorization: Bearer $NIMPLEX_API_KEY" -H 'content-type: application/json' -d '{
  "harness":"claude-code",
  "model":{"provider":"anthropic","id":"claude-sonnet-5"},
  "sandbox":{"provider":"docker"},
  "instructions":"在 /workspace 建一個 hello.txt",
  "budget_usd":0.5
}'

curl -N -H "authorization: Bearer $NIMPLEX_API_KEY" localhost:8787/v1/runs/<run_id>/events
```

SDK 版本見 `examples/quickstart`（讀 `NIMPLEX_API_KEY`）：

```bash
pnpm --filter @nimplex/example-quickstart start        # 三插槽走一遍
pnpm --filter @nimplex/example-quickstart exec tsx src/e2e.ts   # e2e 冒煙：不需要任何 LLM key（自帶假上游），驗閘道計量、預算殺、Managed Agents、租戶隔離
```

## 上傳自己的 harness

manifest 就是全部的介面。模板變數會在開箱時展開：

| 變數 | 展開成 |
| --- | --- |
| `{{gateway.anthropic}}` `{{gateway.openai}}` `{{gateway.openrouter}}` | nimplex 閘道 base URL |
| `{{run.token}}` | 只在這個 run 有效的短期票（**不是**你的真 key） |
| `{{model}}` `{{prompt}}` `{{run.id}}` `{{workdir}}` | 這次 run 的參數 |

```jsonc
{
  "name": "My harness",
  "source": { "kind": "npm", "package": "my-agent-cli" },
  "install": ["npm install -g my-agent-cli@latest"],
  // 代入 command 的值一律會被 shell 單引號包起來——manifest 自己不要再補引號
  "command": "my-agent run {{prompt}} --model {{model}}",
  "env": {
    "ANTHROPIC_BASE_URL": "{{gateway.anthropic}}",
    "ANTHROPIC_API_KEY": "{{run.token}}"
  },
  "provider": "anthropic",
  "output": "text"
}
```

## SDK

介面形狀對齊 **Vercel AI SDK v7 的 `Agent`**（`version` / `id` / `generate` / `stream`）——
極小的介面加一個現成實作。差別在跑的地方：AI SDK 在你的程序裡跑 tool loop，
nimplex 在雲端沙箱裡跑一整個 harness，所以多了 `budgetUsd`（美元硬上限，跑到一半也砍得掉）。

```ts
const nimplex = new Nimplex();
const agent = nimplex.agent({
  harness: "claude-code",
  model: { provider: "anthropic", id: "claude-sonnet-5" },
  sandbox: { provider: "docker" },
  instructions: "修好 CI",
  budgetUsd: 0.5,
});

const run = await agent.stream({ prompt: "測試一直紅" });
for await (const event of run.events) console.log(event.type, event.payload);
console.log(await run.wait());
```

## metered vs unmetered

| 模式 | 條件 | 你拿得到 |
| --- | --- | --- |
| `exact`（預設） | model 流量走閘道（BYOK API key） | 美元硬上限、即時花費、mid-run kill、精確帳 |
| `provider_reported` | 上游自己跑 loop 並回報花費（`claude-managed-agent`） | 上限由上游強制（Anthropic session budget）、花費是**公開價**非合約價、mid-run kill |
| `none` | 綁訂閱席次，流量不經過我們 | 只有 `max_duration_seconds` + 硬殺沙箱；**美元不可保證** |

`metering: "none"` 的 run **不准**設 `budget_usd`——含糊帶過就是計量出錯的來源。
上游沒回報 usage 時會寫一筆 `metering.gap` 事件，而不是靜靜當成 $0。

## Layout

```
apps/api            Hono — 控制面 + /gw 閘道（Console 與 SDK 走同一組公開 endpoint）
apps/worker         work-queue executor — 開箱、跑 harness、串事件、硬殺、回收孤兒沙箱
apps/console        三個插槽的接線台（harness 註冊表 / BYOK / sandbox provider），吃 @nimplex/sdk
apps/site           waitlist 首頁（GSAP + ScrollTrigger）；表單走 Tally，見 apps/site/.env.example
packages/contracts  zod schemas：harness manifest、sandbox spec、run 契約
packages/core       狀態機 · budget · 價格表 · harness 模板 · SandboxProvider port
packages/gateway    BYOK 保險庫 + 計量 + 預留/結算 + 軟殺
packages/sandbox    sandbox provider 註冊表（docker / local）
packages/sdk        @nimplex/sdk — Agent 介面（generate / stream）+ 控制面客戶端
packages/db         Drizzle + Postgres — runs 第一級物件、美元計量、append-only 稽核
examples/quickstart 三個插槽走一遍
```

## 設計來源

- **harness / Agent 介面** ← Vercel AI SDK v7 `Agent`（`ai@7`）：介面自帶 `version` 才改得動又不破相容。
- **sandbox port** ← OpenAI Agents SDK `SandboxClient` / `SandboxSession`（`@openai/agents-core`）：
  session state 可序列化、可跨程序 `resume`。nimplex 的 worker 無狀態、隨時可死，
  所以「誰砍得掉這個箱子」不能靠記憶體裡的 handle——寫進 `runs.sandbox_state`，
  任何一個 worker 讀到都能接回去銷毀。
