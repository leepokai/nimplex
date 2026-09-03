# Console IA 定義（2026-09-01）

> 承接 `2026-09-01-sdk-architecture.md` 的定位修訂（OpenRouter for cloud agents）。
> 本文定義 console 的每一個 tab 是什麼、真假狀態、以及背後缺哪個 API。
> 鐵則不變（08-27 §5）：console 只打公開 API、每個改狀態的操作旁邊都有「複製這次呼叫」。

## Tab 總表

| 分組 | Tab | 狀態 | 資料來源 | 缺的後端 |
|---|---|---|---|---|
| 執行 | **Runs** | ✅ 真 | `runs.list/kill/cancel/events`（SSE 即時）；2026-09-03 起沒 run 時是空狀態，不再塞示意 run | — |
| 執行 | **Usage** | ✅ 真（2026-09-03） | `usage.summary()` → `GET /v1/usage`（day / harness / external_user_id / model 分桶） | — |
| 執行 | **跑前試算** | 🟢 半真 | `models.list()` 真價格 + 手抄機時常數 | price registry 進 DB、版本化 |
| 三插槽 | Harness | ✅ 真 | 既有；2026-09-03 起上傳表單開放完整 manifest（env / output / workdir / timeout），可編輯、可覆寫內建 | — |
| 三插槽 | LLM provider | ✅ 真 | 既有（org-scope only） | — |
| 三插槽 | Sandbox | ✅ 真 | 既有 | — |
| 工具 | **Skills** | ✅ 真（registry） | `skills.list/get/upload/delete` → `/v1/skills` | 建 run 帶 `skills: [slug]` 的沙箱注入路徑 |
| 工具 | **MCP servers** | ✅ 真（registry） | `mcpServers.list/get/put/delete` → `/v1/mcp-servers` | 建 run 帶 `mcp_servers: [slug]` 的注入路徑；broker 憑證解析 |
| 組織 | **API keys** | ✅ 真 | `apiKeys.list/create/revoke` | — |
| 組織 | **Members** | ✅ 真 | `members.list/add/setRole/remove` | 邀請流（目前直接加 email） |
| topbar | **Org switcher** | ✅ 真 | `orgs.list/create` + `x-nimplex-org` header | auth 上線後 org 改由 key/session 決定 |

## 各 tab 功能定義

### Runs（observability 核心）
run 列表（狀態、harness、model×sandbox、spent/budget、時間），active run 2 秒輪詢、
終態 15 秒。點開看即時事件流（SSE + Last-Event-ID 續傳，SDK 同一條路），
`external_user_id` 標籤與 metering 模式顯示在 detail。兩個動詞分開：
**Cancel**（優雅收尾）／**Kill**（銷毀沙箱）——對映 API 的兩個 primitive。

### Usage
花費 rollup：今日／本月卡 + 按 harness、按 `external_user_id` 標籤分組。
資料層已就緒（`usage_events` 每筆掛 run/provider/標籤），缺 rollup endpoint。
定位語：「錶與 harness 無關」在這頁被看見。

### 跑前試算（OpenRouter 的比價體驗）
輸入預估 token 量與時長 → 全部 model × sandbox 組合的成本由低到高排。
model 單價與計量共用同一份價格表（`GET /v1/models`）；機時目前是近似常數，
待 price registry 版本化。**預設視圖 token 為主、機時為輔**（08-27 §4.4 的鐵律）。

### Skills（agent 用的）
skill = 一個資料夾 + `SKILL.md`。上傳進 org registry，建 run 帶 `skills: ["slug"]`，
supervisor 在沙箱裡放進該 harness 的 skills 目錄——跨 harness 同一份 skill 沿用。
與「使用者拿來管 nimplex 的 skill」（AgentConnect 安裝卡）刻意分開，不混頁。

### MCP servers（agent 用的）
agent 在沙箱內連得到的 MCP endpoint 白名單（未來 egress allowlist 的一部分）。
這是「原生工具橋接」入口：客戶把自己產品的 MCP server 掛進來，agent 能操作宿主產品。
auth 只收 broker 引用，明文不落地不進箱。建 run 帶 `mcp_servers: ["slug"]`。
頁尾另放「用你的 AI 工具管 nimplex」卡（`@nimplex/mcp`）——兩個 MCP 語意在同頁分區、不混淆。

### API keys
org 程式化身分：建立時明文只顯示一次、hash 落地、列表只有 last4、可撤銷。
**per-key limit 是未來的花費控制掛點**（OpenRouter 模式：要 per-user 管控就發 per-user 的 key）。

### Members
console 登入者（owner／admin／member）。權責：owner 管帳與成員、admin 管三插槽與 key、
member 唯讀＋開 run。「人」只有這層——終端使用者由客戶自理。

### Org switcher（topbar）
`GET/POST /v1/orgs` + `x-nimplex-org` header（middleware 驗證存在）。選擇存
localStorage、切換整頁重載；存的 org 失效時自動退回 default 自救。
auth 上線後 header 讓位給 key/session 的 org 綁定。

## 從示意轉真的順序

1. ✅ `api_keys` + Bearer middleware（2026-09-01）
2. ✅ `GET /v1/usage` rollup（2026-09-03；`usage_records` 分桶加總，tz 由呼叫端帶）
3. ✅ `/v1/skills`、`/v1/mcp-servers` registry（2026-09-03；表 + CRUD，PUT 冪等）
4. ✅ Members（2026-09-01，Better Auth 接線）

console 已無示意資料。剩下的是 registry 的「用」而不是「管」：
`createRunRequest` 收 `skills` / `mcp_servers`，worker 開箱時把 skill 檔放進 harness 的 skills 目錄、
把 MCP endpoint 寫進 harness 的設定（每家 harness 格式不同，先做 claude-code）。
