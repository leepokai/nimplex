# nimplex

開源、可自架的 coding agent 雲端 runtime。主張一句話：**run 不會因為 worker 或箱子死掉而死、錢有美元硬上限、隨時殺得掉。**

> **2026-09-06 重新聚焦**：harness 改為自己寫、跑在 worker 程序裡（loop-outside），工具面以
> just-bash 虛擬環境為第一層、真箱子（docker / E2B …）為第二層；append-only 的 run events 是
> runtime 的唯一真相（log is the runtime，見 Apache Maka 的同名文章）。
> 舊的「任意 CLI harness 進箱子」、Claude Managed Agents、閘道代理、console、tool registry
> 已全部移除，要翻舊帳看 commit `0f32657`。

## 現在 repo 裡有什麼

| 目錄 | 內容 |
| --- | --- |
| `apps/api` | `/v1` 控制面：Better Auth 登入、org API key、BYOK provider key、runs、可續傳 SSE 事件流（Hono，:8787） |
| `apps/worker` | lease + fence 工作佇列（含 heartbeat）、美元硬上限、kill、孤兒沙箱回收。`pi-executor.ts`：Pi 當 loop kernel，一個 work item ＝ 一個 turn，工具打在 just-bash VFS（Tier 1），檔案寫回 `workspace_files`（Tier 0） |
| `apps/site` | 行銷首頁（nimplex.dev，Vercel） |
| `packages/contracts` | zod schemas：run / event / key / org / sandbox spec（唯一真理來源） |
| `packages/core` | 零 IO 純函式：budget、pricing、狀態機、SandboxProvider port |
| `packages/db` | Drizzle schema + migrations、BYOK 加密、append-only events |
| `packages/sandbox` | SandboxProvider 實作：docker、e2b、computesdk（daytona / vercel）、local（dev） |
| `packages/sdk` | `@nimplex/sdk`：Nimplex client + CloudAgent（對齊 ai@7 `Agent`）+ SSE transport |
| `packages/testkit` | 假 Anthropic 上游（e2e 不用真 key）+ sandbox conformance kit |
| `examples/quickstart` | `src/harness-e2e.ts` 完整隔離驗收；`src/index.ts` 最小示範；`src/e2e.ts` 冒煙測試；`src/demo-kill.ts` kill -9 worker 續跑 demo |

## 跑起來

```bash
pnpm install
docker compose up -d        # Postgres on :5433
pnpm db:migrate
NIMPLEX_DEV_EMAIL_AUTH=1 pnpm --filter @nimplex/api start &
pnpm --filter @nimplex/worker start &
pnpm --filter @nimplex/example-quickstart exec tsx src/e2e.ts   # 註冊 → 發 key → Pi loop 跑完 → 預算殺 → 租戶隔離（固定假上游）
```

沒有 console：先 `POST /api/auth/sign-up/email`（需 `NIMPLEX_DEV_EMAIL_AUTH=1`）拿 session，
再 `POST /v1/api-keys` 發一把 `nmx_live_…`；之後 `/v1/*` 全用 Bearer key。

```bash
export NIMPLEX_API_KEY=nmx_live_...

# 放進自己的 LLM token（明文只在這一次請求裡出現，落地即加密）
curl -X PUT localhost:8787/v1/provider-keys \
  -H "authorization: Bearer $NIMPLEX_API_KEY" -H 'content-type: application/json' \
  -d '{"provider":"anthropic","api_key":"sk-ant-...","scope":"org"}'

# 跑一次，上限 $0.50
curl -X POST localhost:8787/v1/runs \
  -H "authorization: Bearer $NIMPLEX_API_KEY" -H 'content-type: application/json' -d '{
  "model":{"provider":"anthropic","id":"claude-sonnet-5"},
  "sandbox":{"provider":"docker"},
  "instructions":"在 /workspace 建一個 hello.txt",
  "budget_usd":0.5
}'

curl -N -H "authorization: Bearer $NIMPLEX_API_KEY" localhost:8787/v1/runs/<run_id>/events
```

## Demo：kill -9 worker，run 照跑完、錢停在上限

```bash
# 只起 api；worker 由腳本自己起（worker A → SIGKILL → worker B）
NIMPLEX_DEV_EMAIL_AUTH=1 pnpm --filter @nimplex/api start &
pnpm --filter @nimplex/example-quickstart exec tsx src/demo-kill.ts        # 無 key：假上游，不花錢
ANTHROPIC_API_KEY=sk-ant-... pnpm --filter @nimplex/example-quickstart exec tsx src/demo-kill.ts   # 真 key（Haiku，約 $0.006）
```

```
#1  run.started   by worker-A
#2  model.call    toolUse $0.0017
#4  tool.call     bash {"command":"date"}
#7  model.call    toolUse $0.0022
>>> kill -9 worker A
#9  tool.call     write {"path":"/workspace/hello.txt", ...}
#15 run.resumed   by worker-B            ← lease 到期，另一個 worker 從 log 接手
#16 model.call    stop $0.0021
#19 run.completed spent $0.006
Tier 0 /workspace/hello.txt (28 B): Wed Sep  9 09:49:11 UTC 2026
```

怎麼做到的：Pi 在 worker 跑，模型回覆先存 log 並結算預留額度；每個工具的結果、檔案差異與 metadata 再各自原子提交。
worker 死掉後只補做尚未提交的工具，已完成的模型呼叫與工具不重做。純 shell 用 just-bash；native 指令在執行前整段路由到 Docker／E2B。
E2B command 的 supervisor 與結果 journal 留在箱子內，worker 重接可收回結果；箱子確認丟失才新建 generation，從 Tier 0 重建工作區。
E2B 閒置時 pause，下一次 native 呼叫 resume。檔案、空目錄、symlink、權限與 binary 都持久化。

## 一鍵完整驗收

```bash
pnpm e2e          # 新建獨立 local DB、API、worker；假模型，不花 LLM 費用
pnpm e2e:e2b      # 加入真 E2B：native 執行、worker crash、pause/resume、箱子丟失重建
pnpm e2e:real     # 再加真 Haiku + E2B 功能驗證（從 .env 讀 key）
```

只需 local Postgres 在 :5433；腳本自選 API port、自建並清除測試 DB，不占用現有 API／worker。
`e2e:e2b` 需要 `.env` 中的 `E2B_API_KEY`，`e2e:real` 再需要 `ANTHROPIC_API_KEY`。
雲端驗收會產生少量 sandbox／模型費用，測試結束會清理建立的箱子。

預算計的是已支援價目表的 **LLM token 成本**，不包含 sandbox、儲存與網路。
每次請求先預留保守 input 上界及受限 output tokens；關閉隱藏重試、prompt caching 與付費 server tools。
`spent_usd` 是已結算費用，`reserved_usd` 是尚未確定的費用上界；worker crash 後的未知請求不會直接釋放預留。
不認得價目的模型會在付費呼叫前拒絕。完整行為、限制及 migration 見 [runtime 文件](docs/product/2026-09-10-harness-runtime.md)。

## SDK

介面形狀對齊 **Vercel AI SDK v7 的 `Agent`**（`version` / `id` / `generate` / `stream`），
多一個 `budgetUsd`（美元硬上限，跑到一半也砍得掉）。

```ts
const nimplex = new Nimplex();
const agent = nimplex.agent({
  model: { provider: "anthropic", id: "claude-sonnet-5" },
  sandbox: { provider: "docker" },
  instructions: "修好 CI",
  budgetUsd: 0.5,
});

const run = await agent.stream({ prompt: "測試一直紅" });
for await (const event of run.events) console.log(event.type, event.payload);
console.log(await run.wait());
```

## 設計來源

- **Agent 介面** ← Vercel AI SDK v7 `Agent`：介面自帶 `version` 才改得動又不破相容。
- **sandbox port** ← OpenAI Agents SDK `SandboxClient` / `SandboxSession`：session state 可序列化、可跨程序 `resume`；
  worker 無狀態、隨時可死，「誰砍得掉這個箱子」寫在 `runs.sandbox_state`，任何 worker 讀到都能接回去銷毀。
- **log is the runtime** ← Apache Maka `docs/blogs/log-is-the-runtime.md`：狀態是 append-only 事件的投影，
  UI、下一次 model context、crash recovery 各自是同一份 log 的不同投影。
