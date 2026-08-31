# nimplex 架構

> 2026-09-01。承接 `2026-08-26-positioning-and-naming.md`（定位）與 `2026-08-27-mvp-definition.md`（要蓋什麼）。
> 本文定義**系統怎麼切、邊界畫在哪、哪些是不可違反的不變式**，以及現況與目標的落差。
> 基準：2026-09-01 讀過的 `apps/{api,worker}`、`packages/{contracts,core,db,gateway,sandbox,sdk}` 全部原始碼。

---

## 0. 一句話

> **控制面管「誰能做什麼」，計量面管「錢與放行」，執行面管「箱子的生死」，
> 三者之間不互相呼叫——只透過 Postgres 上的 run 狀態機協調。**

這條「不互相呼叫」是整個架構最值錢的性質，現有程式碼已經做對了（見 §3）。以下大部分的建議，都是在保護這個性質不被之後的功能破壞。

---

## 1. 四個平面

現況是三個平面**擠在兩個進程**裡。目標是把計量面切出來——這是本文最重要的一刀。

| 平面 | 職責 | 認證 | 流量特性 | 現況 | 目標 |
|---|---|---|---|---|---|
| **體驗面** | console / site / SDK / MCP / CLI | org key | 低 | `apps/{console,site}` + `packages/sdk` | 不變，加 `@nimplex/mcp` |
| **控制面** | `/v1/*`：run CRUD、註冊表、憑證、事件流 | **org key（尚未實作）** | 低 QPS、可容忍延遲 | `apps/api` | 不變 |
| **計量面** | `/gw/*`：LLM 代理、reserve/settle、軟殺 | **run token** | **每一個 token 都經過**、串流、延遲敏感 | ⚠️ 掛在 `apps/api` 進程裡（`app.route("/gw", ...)`） | ✂️ **切成 `apps/gateway` 獨立部署** |
| **執行面** | 搶工作、開箱、裝 harness、串事件、硬殺、收屍 | 無對外介面 | 長時間、常駐 | `apps/worker` | 不變 |

### 1.1 為什麼一定要把 gateway 切出去

現在 `apps/api/src/app.ts` 是這樣掛的：

```ts
app.route("/gw", createGateway(db));   // 計量面 = 控制面的一個子路由
```

兩個平面因此共用**一個進程、一次部署、一組擴縮容、一個爆炸半徑**。具體後果：

- 一次 agent 流量尖峰（10 個 run 同時串流）會拖慢 console 的 CRUD 回應
- 改一個 `/v1/harnesses` 的 CRUD 路由要重啟，**所有在跑的 run 的模型連線同時斷掉**
- 兩者的擴縮容訊號完全相反：控制面看使用者數，計量面看併發 run 數
- 兩者的認證主體完全不同：控制面認 org key（信任區 A），計量面認 run token（**來自不信任的箱子**）

**把「來自不信任沙箱的流量」與「來自客戶後端的管理流量」放在同一個進程，是這份架構目前最大的結構債。** 程式碼幾乎不用改（`createGateway(db)` 已經是獨立函式），改的是部署單位。

---

## 2. 三個信任區與憑證流

```
┌─ 信任區 A（我們的機器）──────────────────────────────┐
│  控制面 apps/api      計量面 apps/gateway   Postgres  │
│                                                       │
│  provider_keys：AES-256-GCM 密文                      │
│  明文只在兩個瞬間存在於記憶體：                        │
│    ① 使用者 PUT key 的那一次 request                  │
│    ② gateway 打上游 API 的那一次 request              │
└───────────────────────┬───────────────────────────────┘
                        │ 只往下傳一張 run token
┌─ 信任區 B（我們的機器，但不持有使用者密鑰）───────────┐
│  執行面 apps/worker：開箱、裝 harness、串事件、硬殺    │
└───────────────────────┬───────────────────────────────┘
                        │ 只注入 env：base URL + run token
┌─ 信任區 C（不信任）───────────────────────────────────┐
│  沙箱：跑使用者上傳的任意 harness                      │
│  內建 claude-code manifest 帶 --permission-mode        │
│  bypassPermissions ← 箱內等同 root，這是刻意的：        │
│  **沙箱本身才是邊界，不是箱內的權限開關**              │
└───────────────────────────────────────────────────────┘
```

### 2.1 不變式（違反即為架構破口）

| # | 不變式 | 現況 |
|---|---|---|
| **I1** | 使用者的真 provider key **永不離開信任區 A** | ✅ 已成立（`ledger.resolveProviderKey` → `adapter.authHeaders` 只在轉發那一刻解封） |
| **I2** | 進入信任區 C 的憑證，其**最大損失以該 run 的預算為上界** | ⚠️ 見 §5.2，單次巨額呼叫可穿透 |
| **I3** | 資料庫外洩**不足以**冒用任何 token | ✅ 已成立（`runs` 只存 `sha256` hash） |
| **I4** | 任何一個 worker 都能砍掉任何一個箱子 | ✅ 已成立（`runs.sandbox_state` 可序列化，`provider.delete(state)` 不需先 resume） |
| **I5** | Console 能做的事 = SDK 能做的事（**無 `/internal/*`**） | ✅ 已成立且已寫進 `sdk/client.ts` 註解 |

I2 是唯一**目前不成立**的不變式，而它正好是產品的頭條承諾。

### 2.2 兩張票的分工（已做對，值得記下來）

| 票 | 誰拿 | 何時鑄 | 用途 |
|---|---|---|---|
| `run_token` | **整合方**（客戶的後端） | 建立 run 時回傳一次 | 給自架 harness 用 |
| `sandbox_token` | **箱子** | worker 開箱時另鑄一張 | 只給箱裡的 harness 用 |

兩張分開的意義：箱子被打穿時，洩漏的票**不等於**整合方手上那張。`authorizeRun` 同時認兩者，但可以獨立作廢——這個設計要保留。

---

## 3. 協調機制：資料庫就是匯流排

三個平面**沒有任何互相呼叫**。全部透過 `runs` 這一列協調：

```
gateway 發現超額                     worker 的看門狗（每 5s）
      │                                      │
      │ killRun(): status = 'killed'         │ 讀 runs.status
      ▼                                      ▼
  ┌────────────────────────┐          isTerminal() → controller.abort()
  │ runs                   │◄─────────┐        → session.stop()（硬殺）
  │  status                │          │        → sandbox_state = null
  │  spent_usd / reserved  │          │
  │  sandbox_state  ───────┼──────────┘  任何 worker 讀到都能接手砍
  │  event_seq             │
  └────────────────────────┘
```

**軟殺與硬殺是兩個不同平面的動作，刻意不放在同一個交易裡：**

| | 誰做 | 動作 | 保證 |
|---|---|---|---|
| **軟殺** | gateway / 控制面 | 標記 `status`，之後拒發下一次 model call | 立即生效，不需要找到箱子 |
| **硬殺** | worker | `session.stop()` → 箱子消失 | 最終一致（看門狗 5s + 收屍 10s 兩層兜底） |

這是正確的切法：**gateway 不需要知道箱子在哪**（它甚至不需要能連到沙箱供應商），worker 不需要知道錢的事。兩者只看同一列的 `status`。

> ⚠️ 要守住的規則：**永遠不要為了「殺得更快」而讓 gateway 直接呼叫 sandbox provider。**
> 那會把 sandbox 的可用性變成計量面的依賴，一家 sandbox provider 掛掉會連帶讓 LLM 代理失效。

---

## 4. 三個插槽的可插拔程度（目前不對稱）

定位說「換掉任一格，其餘不動」。實際上三格的成熟度差很多：

| 插槽 | Port | 開放註冊表 | 落地實作 | 加一家要改幾個地方 |
|---|---|---|---|---|
| **3. Sandbox** | `SandboxProvider` / `SandboxSession`（`core/sandbox.ts`） | ✅ `registerSandboxProvider()` | `local`（預設關閉）、`docker` | **1**：寫一個 class + 一行 register |
| **2. Harness** | `HarnessManifest`（zod，存 DB） | ✅ 資料化，org 可覆寫內建 slug | 4 個內建 + 使用者上傳 | **0**：客戶自己 PUT，不用發版 |
| **1. LLM provider** | ❌ 無 port | ❌ 寫死的 `PROVIDER_ADAPTERS` | anthropic / openai / openrouter | **3**：contracts enum + gateway adapter + pricing 表 |

**插槽 1 是三格裡最不可插拔的一格，而它同時是錢流過的那一格。** 這個不對稱要收掉：

```ts
// 目標：ModelProvider 也走註冊表，形狀對齊 SandboxProvider
export interface ModelProviderAdapter {
  readonly providerId: string;
  defaultBaseUrl: string;
  authHeaders(apiKey: string): Record<string, string>;
  rewriteBody(body: unknown): unknown;        // 強制上游回報 usage
  extractUsage(chunk: unknown): TokenUsage | null;
  extractReportedCost(chunk: unknown): number | null;
  worstCaseTokens(body: unknown): { input: number; output: number };  // §5.2 需要
}
registerModelProvider(new AnthropicAdapter());
```

### 4.1 Conformance kit（把「中立」從口號變成可驗證的事實）

新增 `packages/conformance`：一組**任何 adapter 都必須通過**的測試套件。

```ts
import { runSandboxConformance } from "@nimplex/conformance";
runSandboxConformance(new E2bSandboxProvider());
// 驗：create→exec→readFile→stop 的完整循環
//     state 可序列化 → JSON round-trip → resume 後仍能 exec
//     delete(state) 不需先 resume
//     stop() 之後 exec 必須失敗
//     exec 的 signal/timeout 真的中止得了
```

**理由**：現在「換一格不用改其他格」是靠人記得，不是靠 build 會紅。等第三家 sandbox provider 進來、行為稍有差異（例如 `resume` 後 env 掉了），問題會以「某些 run 隨機殺不掉」的形式出現——那是最難查的一類 bug。conformance kit 是把 §2.1 的 I4 變成機械保證的唯一方法。

---

## 5. 錢的路徑

### 5.1 冷熱分離

| | 熱路徑（每次 model call） | 冷路徑 |
|---|---|---|
| 動作 | 認票 → 查預算 → reserve → 轉發 → settle | rollup、報表、稽核查詢 |
| 現況 | **4 次 Postgres round-trip**（authorize / gate / reserve / settle） | 直接查 `usage_records` |
| 目標 | 認票結果快取（run token → run 的 hot cache，TTL 秒級）；settle 批次化 | 不變 |

`usage_records` 每次呼叫寫一列是對的（稽核需要），但**認票不該每次都打 DB**——這是最容易先撞到的瓶頸，而它的修法（快取 + run 終態時主動失效）很便宜。

### 5.2 ⚠️ 硬上限現在其實不硬（要修的頭號問題）

`packages/gateway/src/index.ts` 的 reserve 邏輯：

```ts
const reserved = Math.min(costUsd, available);   // ← 問題在這行
```

`reserved` 被夾在「剩餘預算」以內，然後**照樣放行**。所以：

> 剩 $0.01，來一個 `max_tokens: 64000` 的請求 → 只預留 $0.01 → 放行 → 結算 $2.00 → **超支 $1.99**。

上限因此只在「多次呼叫之間」是硬的，「單次呼叫之內」是軟的。示範用 `$0.05` 跑得過去，是因為每次呼叫都很小。

**修法（用現有機制，不加新元件）**：gateway 已經會改寫 request body（它現在就會塞 `stream_options.include_usage`）。同一個機制可以做**預算感知的請求整形**：

```
worstCase = 估算input × 輸入單價 + max_tokens × 輸出單價
├─ worstCase ≤ available            → 放行，reserve = worstCase
├─ 可以把 max_tokens 夾小到塞得下   → 改寫 body 後放行，reserve = 夾小後的 worstCase
└─ 連最小可用輸出都塞不下           → 402 budget_exceeded（不放行）
```

這一步把「上限大致有效」變成「上限結構上不可能被穿透」，也才對得起 §2.1 的 I2。**這是 demo 驗收（`$0.05` 中途砍掉）真正該驗的東西。**

### 5.3 價目表要搬進資料庫

`core/pricing.ts` 的價目寫死在程式碼裡，但**美元上限的正確性完全依賴它**——改一次價要發一次版。`FALLBACK_RATE` 訂得貴（$15/$75 per Mtok）是正確的 fail-safe，保留。目標：`model_prices` 表 + 版本欄位，`lookupRate()` 介面不變。

---

## 6. 單一真理來源與 codegen 骨幹

`packages/contracts`（zod）已經是唯一真理來源，這點做對了。要補的是往外長：

```
packages/contracts (zod)
        │
        ├──► OpenAPI spec（用 hono-zod-openapi 從路由定義產生，不手寫）
        │        ├──► @nimplex/sdk（型別）
        │        ├──► @nimplex/mcp（tool catalog）
        │        └──► console 的 API client
        │
        └──► 執行期驗證（API 入口 + SDK 送出前）
```

**parity CI**：console 用到的每個 API 操作，都必須在 MCP catalog 有對應 tool；缺一個 build 就紅。這是 `2026-08-27-mvp-definition.md` §5 那三條規則唯一可機械執行的形式。

---

## 7. 資料層

### 7.1 租戶隔離目前只有應用層

沒有 RLS，每一句 query 都要自己記得 `where org_id = ?`。對一個賣「per-end-user 隔離 + 憑證保險庫」的產品，**一次忘記就是跨租戶洩漏**。

兩個選項，建議選 B：

| | A. Postgres RLS | **B. Scoped repository（建議）** |
|---|---|---|
| 做法 | `SET LOCAL app.org_id` + policy | 匯出的不是 `db`，是 `scopedDb(orgId)`；未帶 scope 的 query 型別上就寫不出來 |
| 成本 | 每個連線要設 session 變數，Drizzle 整合較繞 | 一層薄封裝 + ESLint 規則禁止直接 import 原始 `db` |
| 保證 | DB 層強制 | 編譯期強制 |

無論選哪個，**現在做很便宜，等 40 個路由之後做很貴**。

### 7.2 缺一張表：`outcomes`（護城河現在無處落地）

定位文件寫得很清楚：

> **護城河是勝率資料，不是 adapter。**「哪個 cloud agent 在我這個 repo 上真的好用」目前公開世界沒有答案。

但**現在的 schema 沒有任何地方存得下「這次 run 的結果好不好」**。`runs` 只有 `status`（技術上完成 ≠ 產出有用）。沒有這張表，飛輪永遠轉不起來——而它的成本是一張表加一個端點：

```
outcomes
  run_id        → runs.id
  verdict       accepted | rejected | partial      ← 整合方回報
  signal        jsonb（PR merged / tests passed / 人工評分 / 重跑次數）
  reported_by   integrator | end_user | automated
  created_at
```

SDK 加一個 `run.report({ verdict, signal })`。有了它，`(harness × model × 任務類型) → 勝率` 才算得出來，才有那個「公開世界沒有答案」的東西。**這張表要現在加，因為它蒐集的是時間序列——晚一個月加，就少一個月的資料。**

### 7.3 事件流：400ms 輪詢要換掉

`GET /v1/runs/:id/events` 每個連線每 400ms 打一次 DB。100 個併發觀看者 = 250 qps 的純輪詢。事件表已經有 `(run_id, seq)` 主鍵與原子 seq 配號（做得很好，可續傳），差的只是通知機制：改用 Postgres `LISTEN/NOTIFY`，輪詢降級成斷線兜底。

---

## 8. 要刪的東西

| 對象 | 為什麼 |
|---|---|
| `apps/runtime`（CF Workers + DO） | 已定案不當執行骨幹（DO 綁死 Cloudflare Sandbox，與插槽 3 衝突）。留著會讓「哪個是真的」持續發散。事件流/SSE 的作法已被 `apps/api` 吸收，可以刪 |
| `packages/core/src/executor.ts` 的 `RunExecutor` | **沒有任何東西實作它**——真正在跑的 `harness-executor.ts` 走的是另一條路。留著是假的抽象，會誤導下一個讀 code 的人 |
| `local` sandbox provider 在正式環境的存在 | 它自己的註解承認「沒有隔離」。開發用留著，但正式環境要在部署層擋掉（不是靠 env 記得不設） |

---

## 9. 部署拓撲

| 元件 | 放哪 | 為什麼 |
|---|---|---|
| `apps/site`、`apps/console` | CDN（Vercel / CF Pages 皆可） | 純靜態 Vite 產物 |
| `apps/api`（控制面） | 常駐 Node host（Fly.io / Railway） | 需要長連線 Postgres；不適合 serverless |
| `apps/gateway`（計量面） | **獨立部署**，同型 host | 熱路徑，擴縮容訊號與控制面不同；獨立爆炸半徑 |
| `apps/worker`（執行面） | 常駐 Node host | 長時間執行；若要用 `docker` provider，host 需要 Docker daemon |
| Postgres | Neon | 已定案 |

> **worker 的宿主選擇有一個隱含限制**：`docker` provider 是在 worker 自己的機器上開容器。正式環境若用它，等於在共用主機上跑使用者上傳的任意程式。
> 正式環境的預設應該是**遠端 sandbox provider**（E2B / Vercel / Daytona），worker 只做 API 呼叫、不需要 Docker daemon——這也讓 worker 可以放在任何 PaaS 上。

---

## 10. 落地順序

| 優先 | 項目 | 理由 |
|---|---|---|
| **P0** | 控制面認證（org API key）＋ scoped repository | 目前 `/v1/*` **完全沒有認證**，單一預設 org。在這之上蓋的每個功能都要重做一次 |
| **P0** | §5.2 預算感知的請求整形 | 頭條承諾現在有洞；且修法只在 gateway 一個檔案內 |
| **P1** | gateway 切成獨立部署 | 程式碼幾乎不動（`createGateway(db)` 已可獨立），越晚切越貴 |
| **P1** | `outcomes` 表 + `run.report()` | 蒐集時間序列資料，晚一天少一天 |
| **P2** | ModelProvider 註冊表 + `packages/conformance` | 把中立性變成 build 會紅的事 |
| **P2** | 價目表進 DB、事件流改 LISTEN/NOTIFY | 都是「現在便宜、以後貴」的改動 |
| **P3** | 刪 `apps/runtime`、刪 `RunExecutor` | 清理，不阻擋任何事 |

---

## 附：一句話回顧每個平面該守的線

- **控制面**：只做 CRUD 與授權，不碰錢也不碰箱子。
- **計量面**：只認 run token，只看得到錢；**不准依賴 sandbox provider**。
- **執行面**：只認資料庫上的狀態，不與 gateway 通訊；箱子的生死它全權負責。
- **共用核心**：`contracts` 是唯一真理來源，`core` 保持零 IO 的純函式。
