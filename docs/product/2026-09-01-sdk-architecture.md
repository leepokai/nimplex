# nimplex TS SDK 架構定案（2026-09-01）

> 承接 `2026-08-27-mvp-definition.md`（gateway 計量支點、M0–M6）、
> `2026-08-18-protocol-strategy.md`（箱內 ACP、箱外自有 API）。
> 本文回答：**TS SDK 長什麼樣、怎麼分層、瀏覽器線怎麼做**——依據 2026-09-01 的多家一手調研截長補短。

> **⚠️ 2026-09-01 定位修訂（本文已按此改寫）**：end_user 不再是產品差異化——per-end-user 的帳務、上限、token 由客戶在自己那端處理。nimplex 唯一要做好的事是 **OpenRouter for cloud agents**：一把 key、一個統一 API 面（統一 run 資源 + 統一事件格式 + 統一的錶），跑任何 harness × 任何 sandbox × 自己的 model key。影響：`end_user` 從必填一級公民降為可選歸因標籤 `external_user_id`；per-end-user rolling cap／credential scope／end-user token 移出 MVP；瀏覽器線降級為可選的 **run-scoped** viewer token。`2026-08-21-enduser-sdk-direction.md` 的 end-user 主軸由此廢止，其安全鐵則（org key 永不進瀏覽器）與 SDK 分層結論仍沿用。

---

## 0. 調研方法與來源（全部一手）

| 對象 | 來源 | 狀態 |
|---|---|---|
| `ai@7.0.85` `Agent` 介面 + approval 型別 | 本地 `node_modules` 直讀 d.ts | ✅ |
| Vercel `@ai-sdk/harness` 全家族（`HarnessAgent`） | unpkg d.ts（1906 行完整拉回）+ ai-sdk.dev | ✅ |
| Claude Agent SDK（`@anthropic-ai/claude-agent-sdk`） | code.claude.com 官方文件 | ✅ |
| Claude Managed Agents（`client.beta.sessions.*`） | platform.claude.com 官方文件 | ✅ |
| Omnara `frontend/packages/{sdk,react}` | 本地 clone 源碼直讀 | ✅ |
| 瀏覽器 token 模式：Liveblocks / GetStream / Ably / AI SDK `ChatTransport` | unpkg d.ts + dist 原始碼 + 官方文件 | ✅ |
| Runloop（Stainless SDK、三維憑證） | 沿用 `2026-08-26-runloop-computesdk-omnara.md` | ✅ |
| OpenAI Codex SDK / Devin API / Cursor Background Agents | 調查中 | ⏳ 待回填 §8.1 |
| LangGraph Platform（interrupt/double-texting）/ Cloudflare Agents SDK | 調查中 | ⏳ 待回填 §8.2 |
| Cloudflare Computer / Think / AI Gateway spend limits 機制 | 調查中 | ⏳ 待回填 §8.3 |

---

## 1. 各家給的關鍵教訓（截長）

### 1.1 Anthropic：primitive 要穩、糖衣可拋

- **Agent SDK 撤回過一次 v2 session API**（`createSession()`/`session.send()` 物件包裝，0.3.142 整包移除，回歸唯一 primitive `query()` + async generator）。教訓：**底層 primitive 與上層語法糖分兩層設計；糖衣可以換，底層不輕易動。**
- `canUseTool` 可回傳 `null` = 「我會透過自己的通道、帶同一個 `requestId` 把決定送回來」——**out-of-band 審批是官方正式路徑**，正是 nimplex approval 走客戶 web 前端的形狀。
- resume / fork 二分：`resume` 續同一段歷史；`+forkSession` 拿新 ID、原歷史不動。
- **估算與強制是兩個數字**：Agent SDK 的 `total_cost_usd` 官方自標「不可拿來收費」（client 端估算）；Managed Agents 能強制的 `list_cost` 是 server 算的。→ nimplex 的 `spent_usd` 由 gateway 記帳（server 側），天生正確，守住。
- **Managed Agents 的 budget 誠實學**：強制點在兩次 model request 之間，越線那個 request 跑完，**官方明文接受 overshoot**（cap 50 分停 53 分是預期行為）。撞頂不是死、是 `idle(budget_reached)`，只收「收尾類」事件，加預算可續跑。
- 終止原因一律**封閉列舉**（`budget_reached`/`max_turns`/`end_turn`…），不用自由文字。
- 事件命名 `{domain}.{action}`：`user.message` / `agent.tool_use` / `session.status_idle`。

### 1.2 Vercel `@ai-sdk/harness`：session 切分與能力宣告

- `HarnessAgent` 實作 `ai` 的 `Agent` 介面（`version:'agent-v1'`/`generate`/`stream`）——**nimplex `CloudAgent` 對齊同一介面，方向已驗證**。
- **Agent 無狀態，session 物件才是狀態載體**：`agent.createSession({ resumeFrom | continueFrom })` 回傳 handle，`generate/stream` 必須帶 session。
- 三段式生命週期：`detach()`（runtime 換手、sandbox 熱著）/ `stop()`（存 resume state、關 sandbox 省錢）/ `destroy()`（直接丟棄）。`suspendTurn()` 是 turn 進行中的切片原語，並誠實標注 lossless（bridge 型 adapter）vs lossy（host-resident 型）。
- Approval 用 **AI SDK v7 標準 stream part**（`tool-approval-request`，決議 `submitToolApproval({ approvalId, approved, reason })`），不自創協議。
- `onBootstrap` + `bootstrapHash`：sandbox template 建置與 session 執行分兩段、hash 決定 snapshot 重建——對「自上傳 harness」的冷啟動快取直接適用。
- **能力不支援是一級公民**：`HarnessV1CallWarning('unsupported-setting'|'unsupported-tool')` + `HarnessCapabilityUnsupportedError`。→ nimplex「任意 harness × 任意 sandbox」的組合爆炸需要同款顯式宣告；`metering: "exact"|"none"` 其實就是第一個實例。
- ACP 在 Vercel 是 `@ai-sdk/harness-acp` 一個 **adapter**，不是對外介面——與我們 08-18「消費 ACP、不生產 ACP」定案一致。
- 刻意不抄：Workflow SDK 的 `"use workflow"` 編譯魔法（只抄「continuation state 是可序列化 JSON」）；多 sandbox provider 的重型網路抽象（v1 用不到）；整包仍 experimental，當參考實作不當標準。

### 1.3 Omnara 源碼：auth 策略與包裝結構

- **`AuthStrategy` 注入**：`bearerToken(string | () => Promise<string>)`（getter 天然支援換發）、瀏覽器 `cookieCsrf()`。
- **OpenAPI 產碼 + 手寫薄包裝**共存（`generated/{sdk,types,zod}.gen.ts` + `createOmnaraClient`/`openAgentEventStream`）——證明 08-27「OpenAPI 單一事實來源」的落地形狀。
- 反面教材：react 包混雜 org 管理面 hooks、**無 end_user 隔離，不能交到客戶產品前端**——nimplex 的 browser/react 層要刻意只暴露「單一 end user 視角」。

### 1.4 瀏覽器 token 模式（Liveblocks / GetStream / Ably）

- **合約學 Liveblocks 再補強**：client 收 `authEndpoint`（URL 或 callback），回應用 `{ token, expiresAt }`——比 Liveblocks 只回 `{ token }` 好：client 永遠不解 token 內部，未來換 token 形式不破壞相容。
- **Refresh 學 Liveblocks 的懶惰快取 + 主動預換**：`expiresAt - 30s` 背景換發。不學 GetStream（等 401 才救，SSE 斷一拍）、不學 Ably（server 推 AUTH frame，要多養一條控制通道）。
- **Scoping 採自包含簽章 token**：claims `{ endUserId, runId?, scopes, exp }`，nimplex 平台簽發（客戶後端拿 org key 換發）。gateway/SSE 每次重連本地驗簽即可。08-21 傾向 opaque 的撤銷需求以**短 TTL（15 分鐘）**滿足；因為合約已把 token 當不透明字串，之後要改 opaque + introspection 不動任何客戶端程式碼。
- **Resume 用原生 SSE `Last-Event-ID`**：AI SDK 的 `resume:true` 不是 SSE 續傳，是 transport 層自刻的「重新 GET 拿新 stream」（需配 Redis-backed `resumable-stream`）。我們事件流本來就有 seq，走 web 標準即可，更輕。

---

## 2. 架構定案

### 2.1 分層（Anthropic 教訓的落地）

```
┌─ 糖衣層（可演進）──────────────────────────────────────────┐
│  CloudAgent（generate/stream，對齊 ai 'agent-v1'）          │
│  @nimplex/ai-sdk：NimplexChatTransport → useChat            │
│  （未來）@nimplex/react：useRun / useApprovals              │
├─ primitive 層（穩定、不輕易動）────────────────────────────┤
│  Transport（HTTP + SSE/Last-Event-ID）                      │
│  resources：runs / harness / providerKeys / sandbox /       │
│             models / endUsers                               │
│  事件 union（contracts 定義，見 §2.3）                       │
├─ 契約層 ───────────────────────────────────────────────────┤
│  @nimplex/contracts（zod → 未來 OpenAPI 單一事實來源）       │
└────────────────────────────────────────────────────────────┘
```

**規則**：糖衣層只能用 primitive 層公開的東西組合而成（不走後門）；破壞性演進只允許發生在糖衣層。Console 與 SDK 同 API 面（08-27 規則 1）不變。

### 2.2 套件切法

| 套件 / entry | 跑在哪 | 憑證 | 內容 |
|---|---|---|---|
| `@nimplex/sdk`（`.`） | 客戶後端 | org API key | 現有 `Nimplex` client + `CloudAgent`；（可選配件）`runs.issueViewerToken()` |
| `@nimplex/sdk/browser`（可選配件） | 客戶前端 | run-scoped viewer token | `NimplexBrowser`：**型別上不存在 `apiKey` 欄位**，只收 `authEndpoint` |
| `@nimplex/ai-sdk`（後續） | 客戶前端 | 同上 | `ChatTransport` 適配器，翻譯事件 union → `UIMessageChunk` |
| `@nimplex/react`（後續） | 客戶前端 | 同上 | 只暴露單一 run 視角 hooks（不混管理面——Omnara 反例的修正） |
| `@nimplex/contracts` | 共用 | — | schema、事件 union、scope 列舉 |

單一 `@nimplex/sdk` 套件雙 entry（subpath export），比拆兩包少一次版本同步負擔；`ai-sdk`/`react` 適配層獨立成包（各自的 peer deps 不污染核心）。

### 2.3 事件 union：契約的一級公民

現況問題：`runEvent.payload` 鬆散，SDK `extractText()` 在對三種形狀 duck-typing。定案：

- **discriminated union + `{domain}.{action}` 命名**（學 Managed Agents）：
  `run.status`（含 `stop_reason` 封閉列舉）、`message.delta`、`tool.call`、`tool.result`、
  `tool.approval_requested`、`tool.approval_resolved`、`spend.updated`、
  `file.changed`、`log.stdout`、`harness.raw`（逃生口，原始 payload 保留）。
- **approval 事件欄位對齊 ai@7**：`{ approvalId, toolCall, reason }` / 決議 `{ approvalId, approved, reason? }`——同一形狀同時容納 ACP `session/request_permission` 的翻譯與 `useChat` 的渲染。
- **翻譯發生在箱內 supervisor、只做一次**：ACP `session/update` → union；Claude Code stream-json → union；純 stdout → `log.stdout`。SDK 與前端永遠只看 nimplex 型別。（協議策略不變：消費 ACP，不生產 ACP；`harnessManifest.output` 未來加 `"acp"` 一值即為掛點。）
- `spend.updated` 事件讓瀏覽器即時顯示燒錢率，不用輪詢 run 物件。
- **SSE 連線的第一個事件固定是 `run.snapshot`**（狀態、`spent_usd`、pending approval 的全量快照），之後才是增量——重整頁面/斷線重連不必重放歷史事件也拿得到現況（學 Cloudflare Agents 的 state-sync + LangGraph 的一級 interrupt 欄位）。
- **`pending_approval` 持久化在 run 物件上**：`GET /v1/runs/:id` 直接看得到「正在等誰按什麼」，不依賴事件流收全。
- Resume 語意 exclusive（`Last-Event-ID` 之後的事件，不含該筆），型別與文件同時寫死；只做這一套 reconnect，不做第二條協定。

### 2.4 Run 生命週期與預算語意

- 動詞維持兩個 primitive：`cancel`（軟、優雅收尾）/ `kill`（硬、含 sandbox destroy）——對映 Managed Agents 的 `user.interrupt` vs `archive/delete`、HarnessAgent 的 `stop()` vs `destroy()`。
- **終態帶 `stop_reason` 封閉列舉**：`completed | budget_exceeded | max_duration | user_killed | user_canceled | error`。
- **overshoot 明文化**（學 Managed Agents 的誠實）：gateway 軟殺的保證是「**最多超出一個 in-flight model call**」；reserve 機制（呼叫前預扣估計值）把這個 bound 再壓小。文件與 SDK JSDoc 都要寫。
- v1 撞頂即 `killed(budget_exceeded)`（MVP 驗收 demo 不變）；**roadmap 留 `paused(budget_exceeded)` + 加預算續跑**（Managed Agents 已證明這是更好的產品語意），狀態機轉移表預留該邊。
- **approval 決議與輸入是兩個動詞**：`resolveApproval({ approvalId, approved, reason? })` 與 `sendInput()` 各自獨立 endpoint（學 LangGraph `Command({resume})` vs `input` 的切分）——涉及預算扣款時，把「回答中斷」誤當「新一輪輸入」處理是危險的。
- 多輪對話（session 物件、resume/fork）**這一輪不做**，但 `CloudAgent` 保持無狀態、run 建立參數自帶冪等 `client_nonce`，未來加 `agent.createSession()` 不需破壞現有 API。
- 開放項（後續定）：**double-texting 政策**——同一 run 未完成時再送輸入，採 LangGraph 式的 per-create-run 參數（`reject|interrupt|enqueue`；`rollback` 牽涉已燒預算退不退，v1 不做）。

### 2.5 Run-scoped viewer token 與瀏覽器線（可選配件，非 MVP 主軸）

> 09-01 修訂：token 綁 **run**，不綁 end user。用途：客戶想把「run 進度、燒錢率、approval 按鈕」直接嵌進自己前端時用；不想用的客戶完全可以在自己後端代理一切。誰是他們的 user、每個 user 累積花多少——客戶自己管。

**簽發（Server SDK）**：

```ts
const { token, expiresAt } = await nimplex.runs.issueViewerToken("run_...", {
  ttlSeconds: 900,                     // 上限由平台 clamp
  scopes: ["run:read", "run:input", "run:approve"],
});
```

- API：`POST /v1/runs/:id/viewer-tokens`（僅 org key 可打）。
- Token：nimplex 平台簽章的自包含 token，claims `{ runId, scopes, exp }`；對客戶端是不透明字串。
- Auth middleware 認兩種身分：org key（全功能）與 viewer token（只能讀/寫該 run，其餘 403）。**org key 永不進瀏覽器——瀏覽器 client 型別上就沒有 apiKey 欄位。**（08-21 安全鐵則沿用。）

**瀏覽器 client**：

```ts
import { NimplexBrowser } from "@nimplex/sdk/browser";

const client = new NimplexBrowser({
  // URL（POST，回 { token, expiresAt }）或 callback；expiresAt-30s 主動背景換發
  authEndpoint: "/api/nimplex-token",
});

const run = client.run(runId);
for await (const ev of run.events({ after: lastSeq })) {   // 原生 SSE + Last-Event-ID
  switch (ev.type) {
    case "message.delta": ...
    case "spend.updated": ...
    case "tool.approval_requested":
      await run.resolveApproval({ approvalId: ev.approvalId, approved: true });
  }
}
await run.sendInput("繼續");
```

### 2.6 能力宣告（組合爆炸的解法）

學 `HarnessV1CallWarning`：run 建立回應與事件流帶 `warnings: { kind: "unsupported-setting" | "unsupported-tool", detail }[]`；不可行的組合（如 unmetered + `budget_usd`）在 contracts 層直接拒絕。`metering: "exact"|"none"` 併入同一套能力宣告敘事。

### 2.7 身分模型（09-01 修訂後的「人」與「鑰匙」）

```
organization
 ├── org_members   登入 console 的人（owner/admin/member；Better Auth）——「人」只有這一層
 ├── api_keys      程式化身分：org key（名稱、last4、撤銷；未來 per-key 限額 = OpenRouter 的 key limits 模式）
 └── runs          工作單位；external_user_id 只是 run 上的歸因標籤，不是身分
```

- **org member ≠ 你產品的使用者**：member 是客戶團隊的人；他們的終端使用者 nimplex 不認識（客戶自理）。schema 已刻意讓 `org_members` 與 `end_users` 無任何繼承關係，這個決策在新定位下反而更對。
- 現況：`orgs` / `org_members` 表已建；**`api_keys` 表與 Bearer 驗證 middleware 未建**——API 目前是 bootstrap 單一 org 無驗證，SDK 的 `Transport` 已會送 `Authorization: Bearer` 但 server 沒驗。
- 未來的花費控制掛點是 **per-key limit**（OpenRouter 模式：一個 key 一個限額，客戶要 per-user 就發 per-user 的 key）——這比 per-end-user 物件更貼新定位，且不用 nimplex 認識任何「使用者」概念。

### 2.8 刻意不做

- ACP-over-HTTP 對外（RFD 未定案；信任模型相反）。
- transport 層自刻 resume 協定（原生 SSE 夠用）。
- 多 sandbox provider 的網路策略抽象（v1 executor 骨幹已定 api+worker）。
- 手寫多語言 SDK（Python 等 → OpenAPI 產生，M5/M6）。

---

## 3. 實作順序（09-01 修訂：先做好「OpenRouter 本體」，瀏覽器線降為配件）

1. **contracts 收斂**：`end_user` 必填 → 可選 `external_user_id` 歸因標籤；事件 union；`stop_reason` 封閉列舉。
2. **統一性驗收（OpenRouter 的核心承諾）**：同一個 create run call，只改 `harness` slug（builtin ↔ claude-code ↔ 自上傳）與 `sandbox` provider，照跑、事件格式一致、錶照轉——這就是「一個 API 面」的 demo。
3. **gateway 計量 + per-run cap + 兩段殺**（M1 不變，仍是產品存在理由）。
4. **價格表 / 跑前試算 / 跨 provider 比價**（OpenRouter 的殺手級素材）。
5. **org api_keys + Bearer 驗證 middleware**（hash 落地、last4 顯示、可撤銷；per-key limit 留作演進）——上線前必要，viewer token 也依賴它。
6. （可選配件）run viewer token + `@nimplex/sdk/browser` + `examples/web-chat`。
7. （後續）`@nimplex/ai-sdk` 的 `NimplexChatTransport`。

---

## 8. 待回填（調查進行中）

### 8.1 OpenAI Codex SDK / Devin API / Cursor Cloud Agents / OpenHands（✅ 2026-09-01 回填）

一手來源：Codex 讀 GitHub raw source；Devin 讀 docs.devin.ai v3；Cursor 讀 cursor.com/docs cloud-agent API；OpenHands 讀 docs.openhands.dev。

| | 生命週期 | 串流 | 成本控制 | 中途砍 |
|---|---|---|---|---|
| **Codex SDK** | `startThread`/`resumeThread` → `run`/`runStreamed`（本地 spawn CLI，**無 hosted session**） | 本地 AsyncGenerator，`item.started/updated/completed` + 型別化 item（`command_execution`/`file_change`/`mcp_tool_call`…）——四家最細 | ❌ 無 | 只有 client `AbortSignal` |
| **Devin v3** | `POST /sessions` → 輪詢 → `POST .../messages` → `DELETE` | **無串流，只能輪詢** | ✅ `max_acu_limit` server 強制（`status_detail: usage_limit_exceeded`）——但單位是 ACU 非 USD、綁單一 session 非 end-user | ✅ DELETE（不可 resume） |
| **Cursor v1** | `POST /v1/agents` → runs → `cancel`/`archive`；`agentId` 冪等鍵 | webhook（文件自相矛盾，過渡期） | ❌ run 層全無；美元限額只在團隊 Admin API | ✅ `runs/{id}/cancel` |
| **OpenHands V1** | 兩段式（start-task 輪詢→conversation） | Socket.IO（最重） | ❌ UI 有預算、**API schema 沒有**（`accumulated_cost` 唯讀） | 公開文件查無 stop |

**對定案的影響／驗證**：

1. **生命週期骨架四家一致**（create → 不透明 ID → poll/stream → 對同 ID 追加訊息 → terminate）——nimplex run 資源照這個骨架走，§2.4 不變。
2. **Devin 的 `status` + `status_detail` 兩層設計**印證 §2.4 的 `status` + `stop_reason` 拆法；reason 要同時出現在 SSE 終止事件與 polling 回應。
3. **SSE + Last-Event-ID resume 是市場空白**：四家沒有一家給 hosted session 乾淨的可續傳事件流（Devin 純輪詢、Cursor 只有完成型 webhook、OpenHands 用 Socket.IO）。§2.5 的選擇從「合理」升級為「差異化」。
4. **差異化語言要更精準**（09-01 修訂後）：mid-run kill 五五開（Devin/Cursor 都有）；Devin 甚至有 server 強制的 session 硬上限。修訂後的差異化敘事＝「**一個統一 API 面跑所有 cloud agent + 原生 USD 的 per-run 硬上限 + 可續傳事件流**」；per-end-user 累加額度不再是我們的訴求（客戶自理）。OpenHands「UI 有預算、API 沒有」仍是『預算沒人做成 API 一等公民』的證據。
5. **Cursor 的 `/v1/sub-tokens`**（service account 換發 1 小時 per-user worker token）＝我們 §2.5 end-user token 交換的同構驗證。
6. **可以考慮補進 contracts 的**：建立時帶 `output_schema`（JSON Schema structured output，Devin/Codex 都有，已是基本盤）；事件顆粒度參考 Codex 的型別化 item（我們的 union 已含 `tool.call`/`file.changed`，夠對齊）。
7. **反面教訓**：四家全在新舊版本過渡期且文件互相矛盾——第一版就把核心資源形狀定死，version 就標 deprecated；**發布真 OpenAPI spec 並由它產 SDK**（研究過程本身就是「查不到精確欄位形狀的 API 難被信任」的活證據），呼應 08-27 規則 2。

### 8.2 LangGraph Platform / Cloudflare Agents SDK（✅ 2026-09-01 回填）

一手來源：unpkg `@langchain/langgraph-sdk@1.10.0` 與 `agents@0.22.0` 的 d.ts、docs.langchain.com、developers.cloudflare.com。

**LangGraph 給的（HITL 與併發策略）**：

1. **中斷是持久化的一級欄位**：`Thread.interrupts` 直接掛在 thread 物件上，一次 `GET` 就知道「現在卡在哪等 approve」，不用重放事件流。→ 已採納進 §2.3/§2.4：run 物件持久化 `pending_approval`。
2. **Resume 是型別化動詞**：`Command({ resume })` 與 `input` 徹底分開——「回答中斷」不是「開新一輪」。→ 已採納：`resolveApproval` 與 `sendInput` 分開的 endpoint，approval 絕不走輸入路徑（涉及扣款時混淆很危險）。
3. **`multitaskStrategy`（double-texting）**：`reject | interrupt | rollback | enqueue`，且是**每次 create run 可指定的參數**、不是固定政策。這正是「同一個 end user 在 run 沒跑完時又發訊息」的產品問題。→ 列入 §2.4 開放項；注意 `rollback` 在 nimplex 多一個維度：被回滾的 run 已燒掉的錢算不算，要明文定義。
4. **反面教訓**：legacy（`Last-Event-ID` header）與 protocol v2（body 帶 `since` seq）兩套 reconnect 並存、語意不同（v0.6.0 還改過 exclusive/inclusive）。→ nimplex 只做一套（`Last-Event-ID`，exclusive 語意在型別與文件同時講明），不給自己開第二條路。

**Cloudflare Agents 給的（瀏覽器線）**：

1. **兩條資料面分開**：state sync（連上先拿全量快照、之後全量覆蓋、不做 diff）vs 事件流（append-only）。→ 已採納：SSE 連線第一個事件是 `run.snapshot`（狀態＋spent＋pending approval 全量），之後才是增量——前端不必自己從事件流重建現況。state 小就全量，不搞 JSON patch。
2. **瀏覽器長連線 auth 與我們同構**：WS 不能帶 header，官方模式就是「短效簽章 token 放 query + server 連線時驗證」，且 `useAgent` 的 `query` 支援 **async function、每次重連重新呼叫**——與 §2.5 的 `authEndpoint` callback 設計互相印證。
3. **終止要有語意化代碼**：auth 失敗、budget 用罄、token 撤銷各給不同 close code/事件，讓 SDK 分得出「正常結束」與「錢燒完被砍」。→ 與 §2.4 `stop_reason` 一致，SSE 終止事件也要帶。
4. **反面教訓**：`unstable_callable` 轉正改名、`AgentNamespace` 棄用、`AIChatAgent` 整個搬出去成 `@cloudflare/ai-chat`——命名前綴當版本策略會逼客戶改碼。→ nimplex 用 `/v1` 路徑版本化 + `@experimental` 標記；transport 核心與 chat 形狀的糖衣**從第一天就分包**（§2.2 的 `@nimplex/ai-sdk` 獨立成包再獲一票）。

### 8.3 Cloudflare Computer / Sandbox / Think / AI Gateway（✅ 2026-09-01 回填）

一手來源：GitHub `cloudflare/computer` README + docs、developers.cloudflare.com（sandbox / ai-gateway / agents）、官方 changelog RSS（8/21–8/31 全 32 條）。

**關鍵澄清：`@cloudflare/computer` ≠ `@cloudflare/sandbox`，是兩個並行產品。**

| | `@cloudflare/computer`（8/3 發布） | `@cloudflare/sandbox`（較成熟） |
|---|---|---|
| 本質 | SQLite/DO 上的 durable filesystem（`Workspace`）+ 可插拔 exec backend，**不是「開一台機器」的 API** | Container 上的完整 sandbox API |
| 狀態 | 自標 **PREVIEW ONLY / not for production**；0.2.1（8/17）後零 release、8/21 後零 commit | 0.12.x 穩定線 + 1.0 preview（`@next`） |
| env 注入 | 只有 image 層 `COMPUTER_VAR_*` 前綴，無 per-call `env` | ✅ 三層：`setEnvVars()` / `createSession({env})` / `exec(cmd,{env})` |
| Egress | 只給 hook（`interceptOutboundHttp`），policy 自己寫 | ✅ `outbound`/`outboundByHost` handler（可熱換）、`enableInternet:false` 預設斷網、`allowedHosts` glob、**HTTPS 攔截預設開**（per-sandbox CA 自動信任） |
| destroy | ❌ Workspace 層沒有 | ✅ `destroy()`；且文件明講 exec timeout **不會**殺底層 process |
| RPC auth | 文件自承 open question（「trusts anything that can reach the port」） | Worker binding 內建；外部走 bridge Worker + bearer token |

**結論一：nimplex 的 sandbox provider 候選是 `@cloudflare/sandbox`，不是 Computer。** 三層 env 注入 + egress handler + `destroy()` 足以完整實作「注入 `ANTHROPIC_BASE_URL`、egress 鎖 gateway、保證可殺」契約；代價是它是 Workers/DO 原生——要自己養一個 bridge Worker（多一跳、多一件要顧的 infra），不像 E2B/Daytona 有原生外部 API。CF 官方文件甚至就有「Claude Code 設 `ANTHROPIC_BASE_URL` 指向 AI Gateway」的教學——**base URL 注入這條路線被 CF 自己背書了**（08-27 開放問題 #4 的側面驗證）。

**結論二：AI Gateway spend limits 與 nimplex 差異化的誠實盤點**：
- **比 8/23 認知更近的部分**：per-user 歸因（Access 的 `cf.user_id` 或自帶 metadata）+ 按 user 分桶的美元預算規則，6/5 就 GA 了——「per-end-user USD 預算」的機制面 CF 已經有。
- **仍然站得住的差異**：(1) 官方自承 **eventually consistent**（併發爆量會短暫超限）；(2) 規則管理查無 CRUD API（OpenAPI spec 裡只有已棄用的舊全域 cap）——疑似 dashboard-only，無法在 signup/session 時程式化建立；(3) **spend limit 只擋 model call，不會殺 sandbox**——容器繼續跑、繼續燒錢，除非客戶自己另外呼叫 `destroy()`；(4) 綁 Cloudflare Access/全家桶。→ nimplex 的定位語言：**「預算 + 殺 + sandbox 生命週期是同一個保證動作、provider-agnostic、SDK 一等公民」**。
- 每 gateway 上限 20 條規則——也不是「每個 end user 一條規則」能規模化的形狀。

**結論三：Think harness 與成本控制解耦**（`getModel()` 回傳什麼就計什麼，Think 自己不碰美元）——與 nimplex「錶在 gateway、harness 無關」同構，方向再獲印證。Think 的 hook 分類學（`beforeTurn`/`beforeToolCall`/…）是「自己蓋 agent」的最佳化，nimplex 是「跑任意 harness」，不需要抄到這個粒度。

**結論四：8/23 之後十天，這個家族零實質新品**（Computer 停更、Think 只有內部 plumbing、AI Gateway/OS/Sandbox 零 changelog）。

**抄進 SDK 的形狀**：三層 env 注入 API（sandbox-wide → session → per-exec，`null` 顯式 unset）；「timeout ≠ kill」要在我們自己的文件裡同樣講明白（預算軟殺不 destroy 的話 process 還活著——正是我們軟殺+硬殺兩層設計的理由，CF 文件可當佐證引用）。
