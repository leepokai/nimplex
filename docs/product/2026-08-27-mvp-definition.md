# nimplex MVP 定義

> 2026-08-27。承接 `2026-08-26-positioning-and-naming.md`（定位/命名）與
> `docs/competitor-analyze/2026-08-26-runloop-computesdk-omnara.md`（三層競品實地盤點）。
> 本文定義 **要蓋什麼、不蓋什麼、驗收長什麼樣**。

---

## 0. 先解三個矛盾（不解會蓋歪）

### 0.1「一把 overall key 就能完整使用」vs BYOK

這兩句字面上互斥：一把 key 全包 ＝ 你轉售 ＝ ToS 風險 + COGS + 要當 fintech，
而 08-26 已經定案 v1 **不轉售**。

**解法：把 key 的兩種語意拆開。**

| | 這一版 | 這一版不做 |
|---|---|---|
| **控制面身分** | ✅ 一把 `nimplex` key 打得動全部 API：開 sandbox、選 harness、跑 model、查帳、砍 run | |
| **付款工具** | | ❌ 一把 key 付全部供應商的錢 |

所以那句話的正確版本是：

> **一把 key 統一「操作面」，你的錢還是走你自己的合約。**

這不是妥協，反而是賣點：沙箱裡的 harness 拿到的是 nimplex 簽發的**短期票**，
真正的 Anthropic / E2B key 永遠不進箱子。順手解掉憑證外洩。

### 0.2 multi harness 是插槽，不是計費軸

你 08-26 自己的結論：harness 是 Apache-2.0 的 npm 套件，成本 $0、不可計費、
Vercel `HarnessAgent` 已免費做完跨 harness；`computesdk/sandbox-agent` 開九天就死。

**結論不變：支援多 harness ✅，靠多 harness 賺錢 ❌。**
它在 MVP 裡的角色是「證明我們的錶跟 harness 無關」，不是產品的存在理由。

### 0.3 Runloop 要挑著抄

你自己的判斷（Runloop＝科研、Omnara＝內部工具）跟你的 TA（B：把 agent 嵌進產品賣給終端使用者）
是錯開的。照抄會被拉去做科研工具。

| 抄 | 不抄 |
|---|---|
| OpenAPI-first → SDK 自動產生（Stainless 模式） | `organization → team → user` 席次身分模型 |
| `/org-setup/sandbox-provider` 這種「組織自填 provider key」的形狀 | CPU-hour 計價（他們花全部力氣在佔比 ~5% 的那筆錢） |
| `/me/model-provider-secrets` 的 `provider × type × scope` 三維憑證 | 170 個 endpoint 裡 budget/spend/cost 全部 = 0 |
| `/agents/{id}/stop` `/interrupt` `/stream` `/snapshots` | Blueprint / Devbox 這套科研向的名詞 |

---

## 1. 一句話

> **一把 key，在任何 sandbox 上用任何 harness、燒你自己的 model 額度，
> 而且每一個終端使用者都有一個跑到一半也砍得掉的美元硬上限。**

差異點**不是**雲中立（Runloop 的 `sandbox-options.ts` 已 provider-agnostic，這條護城河正在被填），
是**計費軸**：他們的錶是 CPU-hour 與席次數量，我們的錶是 per-end-user 美元。

---

## 2. 架構：關鍵零件是 gateway，不是 sandbox 抽象

### 2.1 為什麼

**你只能對「看得見的東西」收錢，也只能砍「經過你的東西」。**

Claude Code 在箱子裡直連 Anthropic → 你看不到任何一個 token → 美元上限是假的。
所以真正的核心零件不是三個 port，是**夾在 harness 與模型之間那條線**：

```
        ┌───────────── nimplex control plane ─────────────┐
        │  runs · end_users · budgets · events · prices   │
        └───────┬──────────────────────┬──────────────────┘
                │ 開/砍                 │ 每次 call 記帳 + 放行/拒絕
                ▼                      ▼
        ┌───────────────┐      ┌──────────────────┐
        │  Sandbox Port │      │  nimplex Gateway │──► Anthropic / OpenAI /
        │ (ComputeSDK)  │      │  (BYOK vault)    │    OpenRouter …（客戶自己的 key）
        └───────┬───────┘      └────────▲─────────┘
                │ 箱子裡跑              │ ANTHROPIC_BASE_URL 注入
                ▼                      │
        ┌───────────────────────────────┴──┐
        │  Harness (builtin / claude-code) │  ← 箱內只有 nimplex 短期票
        └──────────────────────────────────┘
```

**注入 base URL 是整個產品的支點。** 有了它：

- 計量與 harness 無關（換 Codex、換 OpenCode，錶照轉）
- 憑證不進箱子
- kill 有兩層：**軟殺**（gateway 拒發下一個 call）+ **硬殺**（`sandbox.destroy()`）

### 2.2 由此得到一個必須顯性化的產品事實：metered vs unmetered

| 模式 | 條件 | 我們能給什麼 |
|---|---|---|
| **Metered**（預設） | model 流量走 gateway（API key BYOK） | 美元硬上限、即時燒錢率、mid-run kill、精確帳 |
| **Unmetered** | 綁訂閱席次（Claude Max / Codex sub），流量不經過我們 | 只有 wall-clock / 次數上限 + 硬殺沙箱；**美元不可保證** |

Omnara 已經證明這個坑存在：他們的 log 裡有
`provider_reported_cost_usd.accounting_limitation: "byok_state_missing"` ——
**BYOK 時他們常常連成本是多少都不知道。**

我們的做法是**在 UI 與 SDK 回傳裡明確標示** `metering: "exact" | "none"`，
unmetered 的 agent 不准設 `budget_usd`（只能設 `max_duration` / `max_calls`）。
含糊帶過就是 Omnara 那個 bug 的來源。

### 2.3 ComputeSDK 實地確認（2026-08-27 讀原始碼）

拿到什麼：

- `compute.setConfig({ providers: [...], providerStrategy: 'priority' | 'round-robin', fallbackOnError: true })`
  —— 多供應商路由與 failover **是現成的**
- 統一 `Sandbox`：`runCommand(cmd, { cwd, env, background, onStdout, onStderr })`、
  `filesystem.{readFile,writeFile,readdir,mkdir,exists,remove}`、`getInfo()`、`getUrl({port})`、`destroy()`
- `snapshotId` 在 `CreateSandboxOptions`，`SnapshotMethods` 在 provider factory
- `defineProvider()` —— 自訂 provider 的門檻很低

**拿不到什麼（＝我們的位置）：**

- port 裡**沒有任何 cost / billing 概念**。`SandboxResourceOptions` 甚至混著
  provider 專屬欄位（如 Northflank 的 billing plan ID）→ **compute 的價格表要自己維護**
- 沒有 session / end_user / budget
- 沒有 process handle，殺不掉單一 background process ——
  **但這其實剛好：硬殺的正確原語就是 `destroy()` 整個箱子**
- README 開頭寫著 *"Gateway/control-plane transport has been removed from `computesdk`."*
  → **中立層自己退出控制面。那個位置是空的。**

**決策：sandbox port 直接用 ComputeSDK，一行都不自己寫。Day-one 只認真接兩家。**

---

## 3. 物件模型（MVP）

```
organization
 └── project
      ├── agent            版本化設定：harness + model + tools + skills + 預設預算
      ├── end_user         ★ 一級公民 —— 這是 Runloop / Omnara 三家都沒有的那一層
      │    ├── budget      period cap（$/day、$/month）+ 餘額
      │    └── credential  scope=end_user 的 BYOK
      └── run              一次執行，永遠掛在某個 end_user 底下
           ├── budget_usd / spent_usd / metering
           ├── events[]    不可變、有 seq、SSE 可續傳
           └── sandbox_ref / harness_ref
```

`packages/contracts` 的 `createRunRequest` 已經是對的形狀（`end_user` 必填、
`credentials` 只收 broker 引用不收明文）—— **沿用，不重寫**。要補的是：

- `sandbox`（provider + resource + snapshot）
- `harness`（目前寫死 `z.enum(["builtin"])`，要開成註冊表）
- `metering: "exact" | "none"`

憑證解析採 Runloop 的三維，**多加一層**：

```
scope 優先序：end_user  >  project  >  organization
type：apiKey | subscription | oauth_ref
provider：anthropic | openai | openrouter | …（MVP 只做前三）
```

---

## 4. 五個功能的 MVP 切法

每一格都寫清楚 **In / Out**，避免做到一半失焦。

### 4.1 Observability — monitoring cloud agent runs

| In | Out |
|---|---|
| run list（狀態、end_user、spent、burn rate） | 自訂 dashboard / 查詢語言 |
| run detail：不可變事件流 + SSE `?after=<seq>` 續傳 | trace 樹、span、OTel 匯出 |
| 每個 model call 記 `provider_reported_cost_usd`（Omnara 已驗證可行） | 取樣 / 保留策略 |
| per-end-user 花費 rollup + 排行 | 告警規則引擎 |
| `budget_exceeded` / `killed` 有專屬事件與原因 | |

`apps/runtime` 的 `AgentSession` DO 已經有事件日誌 + SSE + 電表 —— **這塊是既有資產，直接抬進 MVP**。

### 4.2 BYOK

| In | Out |
|---|---|
| anthropic / openai / openrouter 三家 | 11 家（Runloop 的規模）、Bedrock / Vertex |
| 三層 scope 解析 + 「這個 run 用了誰的 key」可稽核 | SCIM / IdP / 企業目錄同步 |
| key 只存在 gateway，**永不進沙箱** | 訂閱席次（`claude-max` / `codex-sub`）→ M6 |
| 存前驗證（validate endpoint，抄 Runloop） | |

### 4.3 Spend limit ← **這是產品的存在理由，優先度最高**

| In | Out |
|---|---|
| per-run 硬上限 | 團隊/部門預算樹 |
| per-end-user rolling cap（$/day、$/month） | 超額後計費、儲值、發票 |
| 觸線時：軟殺（gateway 拒發下一 call）→ 硬殺（`destroy()`）→ 發事件 | 預測性節流、動態降級模型 |
| 預留（reserve）機制：呼叫前先扣估計值，避免併發超燒 | |
| unmetered 模式改用 `max_duration` / `max_calls` | |

**驗收就是那個 demo：設 `$0.05`，一個正在跑的 run 中途被砍，事件流看得到原因。**
三家競品、200+ endpoint、一整個 Go monorepo，沒有任何一條路徑做得到這件事。

### 4.4 Automated calculator

跟 4.3 共用同一份 price registry，所以它幾乎是免費的副產品。

| In | Out |
|---|---|
| price registry：model token 價 + 各 sandbox provider 的機時價 | 即時抓各家 pricing 頁（先手動維護 + 版本化） |
| **跑前試算**：這個 agent config 一次 run 大概多少錢 | 保證不超（試算是估計，硬上限才是保證） |
| **跑中投影**：以目前燒錢率，還剩多久撞頂 | |
| **跨 provider 比價**：同一個 run 在 E2B vs Vercel、sonnet vs opus 差多少 ← 最好的行銷素材 | |

> 記一個數字：SMALL devbox 1 CPU/2GB 跑 26 分鐘 ≈ **$0.07**，
> 同時間的一次 coding agent run，token 成本高一到兩個數量級。
> **試算的預設視圖必須是 token 為主、機時為輔** —— 反過來就變成 Runloop 了。

### 4.5 SDK

| In | Out |
|---|---|
| OpenAPI 為單一事實來源 → TS SDK 自動產生 | 手寫多語言 SDK |
| **Server SDK**（org key）：建 run、設預算、砍 run、查帳 | |
| **Client SDK**（end-user session token，短期、只能碰自己的 run）| |
| 串流：`for await (const ev of run.events())` | |
| Python SDK → M6 | |

---

## 5.「Console 每一個操作都是 AI-tools-native」的可執行定義

這是個好約束，但必須機械化，否則第三週就會漂掉。**定義成三條硬規則：**

### 規則 1：Console 只能呼叫公開 API，不准有私有 endpoint

Console 與客戶的 SDK 走**同一個** API 面。沒有 `/internal/*`。
違反了就是「console 做得到但 agent 做不到」，AI-native 立刻破功。

### 規則 2：MCP tool catalog 由 OpenAPI 產生，不手寫

```
OpenAPI spec ──┬──► TS SDK（Stainless 風格）
               ├──► MCP server（@nimplex/mcp）
               └──► Console 的 API client
```

**CI 檢查：console 用到的每一個 API 操作，都必須在 MCP catalog 裡有對應 tool。**
parity 不靠自律，靠 build 會紅。

### 規則 3：每一個會改狀態的 UI 控制項，旁邊都有「複製這一次呼叫」

按鈕不只做事，還要告訴你**它剛剛做了什麼**：

```
[ Kill run ]  ⧉ copy as → MCP call │ SDK snippet │ curl
```

副作用是文件永遠不會過期 —— 因為它是從真的呼叫產生的。

### 5.1 Skill 安裝卡（你指名要的那個）

Console 首頁固定一張卡，一鍵拿到接好 key 的安裝指令：

```
┌────────────────────────────────────────────────┐
│  在你的 AI 工具裡直接操作 nimplex               │
│                                                 │
│  $ claude plugin install nimplex               │
│  $ nimplex login --key nmx_live_••••••••       │
│                                                 │
│  裝完可以直接說：                                │
│   「把 user_8f2 的日上限調到 $2」                │
│   「列出今天燒超過 $1 的 run」                   │
│   「砍掉所有 running 超過 30 分鐘的 run」        │
│                                                 │
│  [ 複製指令 ]   [ 看 skill 內容 ]                │
└────────────────────────────────────────────────┘
```

`apps/console/src/views/Skills.tsx` 現在管的是「agent 用的 skill」，
這張卡是**另一件事**：「使用者拿來管 nimplex 的 skill」。別混在同一頁。

> **對 TA B 的意義**：他們的 platform team 本來就活在 Claude Code / Codex 裡。
> 「你的控制面可以被 agent 操作」對這群人不是花招，是採購條件。

---

## 6. 里程碑與驗收

每個里程碑的驗收都是**一個可以錄下來的 demo**，不是「功能完成」。

| # | 內容 | Demo 驗收 |
|---|---|---|
| **M0** | 三個 port 介面定義 + contracts 上移（`apps/runtime` 的 `TODO(P0)` 清掉）+ OpenAPI 骨架 | `pnpm check` 綠，OpenAPI 產得出 SDK 與 MCP catalog 的空殼 |
| **M1** | **Gateway + 硬上限**（price registry、記帳、reserve、軟殺+硬殺、`budget_exceeded`） | 設 `$0.05`，run 跑到一半被砍；事件流有原因；帳對得起來 |
| **M2** | ComputeSDK 接兩家真的 provider；`destroy()` 當硬殺原語 | 同一個 agent config，改一行換 provider 跑起來；砍 run 時箱子真的沒了 |
| **M3** | Harness registry：`builtin`（既有 loop）+ `claude-code`（base URL 注入） | Claude Code 在箱子裡跑，錶在轉，撞頂被砍 → **證明錶與 harness 無關** |
| **M4** | BYOK vault + 三層 scope 解析 + validate | end_user 的 key 覆蓋 org key；箱內 `env` 抓不到任何真 key |
| **M5** | Console 骨架接真 API（換掉 mock）+ `@nimplex/mcp` + skill 安裝卡 + parity CI | 在 Claude Code 裡用自然語言做完 console 的每一件事 |
| **M6** | Calculator 完整版（跑前試算 / 跨 provider 比價）+ 訂閱席次 unmetered 模式 | 「這個 run 在 E2B+sonnet vs Vercel+opus 差多少」一頁出來 |

**順序的理由**：M1 先於 M2。先證明錶是真的，再證明它到處都能用。
反過來做，你會先蓋出一個「又一個雲中立 sandbox 包裝層」——那個位置 ComputeSDK 已經坐著了。

---

## 7. 明確不做（MVP 期間）

| 不做 | 理由 |
|---|---|
| 轉售 / 一張帳單 / 儲值 | ToS 風險 + 要當 fintech。等勝率資料變成留存理由再談 |
| best-of-N fan-out | D persona 是行銷素材不是商業模式；且需要多家 cloud agent 帳號 |
| Marketplace | 08-21 已定案後置 |
| MCP 權限引擎（allow/ask/deny）+ durable 審批 | P3。mock 已在 console 裡，先留著當 sample data |
| Egress 網控 | P3 |
| 排程 / cron | 有了預算才有意義，不是反過來 |
| 自己寫 sandbox 抽象層 | ComputeSDK 已成熟，96 forks、vendor 自己貢獻 adapter |
| 自己寫 harness 中立層 | `sandbox-agent` 開九天就死；Vercel `HarnessAgent` 免費 |

---

## 8. 動工前還沒驗的（沿用 08-26，一項都還沒消）

| # | 問題 | 為什麼卡住動工 |
|---|---|---|
| 1 | **是否已有人在做 cloud agent 聚合** | 08-26 標注「尚未查證，不應假設這塊是空的」。仍未查 |
| 2 | 各家 cloud agent 的 ToS 禁不禁多租戶代理 | 決定 M6 之後能不能碰轉售 |
| 3 | `bespokelabsai/sandbox` 只有 4 星的死因 | 同一份資料兩個相反結論：是「聚合層沒錢流過」（→ 我們跳過該坑）還是「沒人要中立」（→ 整條路重想） |
| 4 | **新增**：`ANTHROPIC_BASE_URL` 注入對 Claude Code / Codex 是否穩定可用 | **這是 M3 的地基，也是整個計費軸的支點。塌了要立刻改設計** |

第 4 項最急 —— 它是唯一一個**技術上可能直接否決架構**的問題，而且半天就能驗完。

---

## 附：既有資產盤點

| 位置 | 狀態 | MVP 怎麼用 |
|---|---|---|
| `packages/contracts` | run 狀態機、`createRunRequest`（end_user 必填、憑證只收引用） | ✅ 形狀正確，擴充即可 |
| `packages/core/status.ts` | run 狀態轉移表（含 `killed`） | ✅ 直接用 |
| `apps/runtime`（CF Workers + DO） | 事件日誌、SSE、**電表已在 loop 裡** | ✅ M1 的種子。README 自己寫了「電表在 DO 裡」就是核心賣點 |
| `apps/console` | 15 個 view，全 mock | ✅ M5 換掉 mock。導覽已是 org/project 兩層，**要補 end_user 那層的預算 UI** |
| `apps/api` / `apps/worker` | 早期 loopbox 骨架 | ⚠️ 與 `apps/runtime` 職責重疊，M0 要決定留哪個 |
