# Console IA 定義（2026-09-01）

> 承接 `2026-09-01-sdk-architecture.md` 的定位修訂（OpenRouter for cloud agents）。
> 本文定義 console 的每一個 tab 是什麼、真假狀態、以及背後缺哪個 API。
> 鐵則不變（08-27 §5）：console 只打公開 API、每個改狀態的操作旁邊都有「複製這次呼叫」。

## Tab 總表

| 分組 | Tab | 狀態 | 資料來源 | 缺的後端 |
|---|---|---|---|---|
| 執行 | **Runs** | ✅ 真 | `runs.list/kill/cancel/events`（SSE 即時） | — |
| 執行 | **Usage** | 🟡 示意 | mock rollup | `GET /v1/usage?group_by=…`（`usage_events` 資料已在記） |
| 執行 | **跑前試算** | 🟢 半真 | `models.list()` 真價格 + 手抄機時常數 | price registry 進 DB、版本化 |
| 三插槽 | Harness | ✅ 真 | 既有 | — |
| 三插槽 | LLM provider | ✅ 真 | 既有（org-scope only） | — |
| 三插槽 | Sandbox | ✅ 真 | 既有 | — |
| 工具 | **Skills** | 🟡 示意 | 本地 state | `/v1/skills` registry |
| 工具 | **MCP servers** | 🟡 示意 | 本地 state | `/v1/mcp-servers` |
| 組織 | **API keys** | 🟡 示意 | 本地 state | `api_keys` 表 + Bearer middleware（SDK 架構 §3-5） |
| 組織 | **Members** | 🟡 示意 | 本地 state | Better Auth 接線 + 邀請流 |
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

1. `api_keys` + Bearer middleware（組織組轉真的地基，SDK 架構 §3-5 已排）
2. `GET /v1/usage` rollup（資料已在，工程量最小）
3. `/v1/skills`、`/v1/mcp-servers` registry（表 + CRUD，形狀照本頁定義）
4. Members = Better Auth 接線時一起轉真
