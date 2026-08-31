# nimplex 定位與命名

> 2026-08-26 定案。取代 `2026-08-21-enduser-sdk-direction.md` 的商業模式部分。
> 技術架構見 `2026-08-24-nimplex-blueprint.html`（HTML 檔僅為示意展示用）。

---

## 一、定位：OpenRouter for cloud agents

### 1.1 先講清楚 OpenRouter 到底在賣什麼

**不是抽象層，是帳單。**

OpenAI-compatible schema 在 OpenRouter 出現前就已經是事實標準了 —— 它沒有創造中立性，它是**在既有的中立性上面收錢**。真正的價值是「一把 key、一張帳單、一次儲值，不用簽 40 份供應商合約」，加上路由 / failover，以及那個沒人有的公開排行榜。商業模式是**過路財**。

所以「OpenRouter for X」要成立，X 必須滿足三個條件：

1. 多個供應商，各自有帳單，而且簽約很煩
2. 真的可替換，路由 / fallback 才有意義
3. 解決 cold-start（讓人拿到原本拿不到的東西）

### 1.2 三個候選定位的評分

| | for Sandbox | for Harness | **for Cloud Agents** |
|---|---|---|---|
| 供應商各自有帳單 | 有但薄利 | ❌ 免費（Apache-2.0 npm 套件，$0） | ✅ **高單價** |
| 路由 / 替換有意義 | 部分 | ❌ 換 harness 是行為質變，不是價差 | ✅ **輸出統一為 PR** |
| 有可轉售的 API | ✅ | n/a | ⚠️ 混合，且有 ToS 風險 |
| 花費流過你 | compute 薄利 | ❌ | ✅ **厚** |
| **誰想弄死你** | 沒人特別 | **Vercel（免費吃掉）** | **供應商本人** |

**harness 層出局的關鍵**：harness 是 Apache-2.0 的 npm 套件，成本 $0、不計費、不可替換，而且 Vercel 的 `HarnessAgent` 已經免費把「一套 API 跨 harness」做完了（adapter 已 9 家：claude-code / codex / cursor / cline / fx / grok-build / opencode / pi / ACP）。**無法從 $0 抽成 —— 這是結構問題，不是執行問題。**

**cloud agent 層成立的關鍵**：Devin 的 ACU、Cursor 的 seat、Copilot 的 premium request、Codex 綁 ChatGPT 方案 —— 各自計費且昂貴。更重要的是它們的契約**統一在產出**（給 repo + issue，還一個 PR），而不是統一在 API。這個共同分母讓路由與 best-of-N 真的可行。

### 1.3 為什麼 Vercel 結構上不會做這個

**Vercel 的生意是賣 Vercel 的 compute。**

一個中立的計量層，讓客戶跑在 E2B、路由到 Codex、用 Anthropic 直連 —— 直接違背他們的利益。他們給出免費的 `HarnessAgent`，是為了讓你更容易落在他們的 sandbox 上。

這跟 OpenRouter 能在 OpenAI 旁邊活下來是同一個結構縫隙。**這是本定位最強的論證，比任何功能差異都強。**

### 1.4 但這一版的敵人是供應商本人

OpenRouter 能轉售，是因為模型商本來就想賣 API、想要 volume。

**cloud agent 廠商賣的是 seat。** 把 seat 打散成 usage 轉售，等於直接破壞他們的定價模型。一家 $500/user/mo 的公司有非常明確的動機在 ToS 裡封死你。

### 1.5 v1 因此走 BYOK

第一版**不轉售**。做 BYOK（客戶插自己的 Devin / Cursor / Codex 帳號）的編排 + 治理層：

- 客戶用**自己的合約** → **ToS 風險歸零、COGS 歸零、不用當 fintech**
- 我們提供：一個 API、fan-out best-of-N、per-user $ 上限、kill-switch、統一稽核
- 我們收走：**每一次 run 的真實勝率資料**

代價是放棄「一張帳單」的話術與抽成。換到的是**零風險地把飛輪先轉起來**。

> **護城河是勝率資料，不是 adapter。**
>
> 「哪個 cloud agent 在**我這個 repo** 上真的好用」目前公開世界沒有答案 —— SWE-bench 早已飽和且不反映真實 repo。作為中間層，我們是唯一產得出真實任務勝率資料的人。

等這份資料變成客戶留下來的理由，才有籌碼談轉售 —— 那時候是廠商想上架，不是我們求他們。

**先當編排層，再當通路。反過來會被 ToS 打死在第一天。**

---

## 二、目標客戶：B / C / D

三者的共同點是**真的需要聚合**。

### B. AI 產品公司（把 agent 嵌進自己產品賣給終端使用者）

「幫我做一個 app」類產品、Shopify app 生成器、內部工具生成器。

| | |
|---|---|
| 痛點 | per-end-user 預算不設就被燒爆；供應商掛掉＝自己產品掛掉；成本套利直接決定毛利 |
| 為何需要聚合 | 這三個痛點**沒有一個**能靠單一廠商解決 |
| 評價 | **最強的聚合買家**，也是真正的市場 |

### C. 50–500 人的工程組織（採購型）

| | |
|---|---|
| 痛點 | 四家供應商 = 四份合約、四個 dashboard、零個統一視圖；不知道哪家真的好；市場變太快不想鎖死 |
| 為何需要聚合 | 一張帳單 + 用量治理 + 供應商可替換 |
| 評價 | 單價最高，但銷售週期最長，不適合當第一個 |

### D. best-of-N 買家（高風險 codebase）

| | |
|---|---|
| 痛點 | 同一個任務要丟三家比 PR |
| 評價 | 量少、單價高、**demo 效果最好** —— 適合當行銷素材，不適合當商業模式 |

**建議順序：B → C**，D 全程當素材用。

### ⚠️ 關於 indie developer / 小團隊

原本考慮的兩個 persona（indie dev 要 browser + 突破 Vercel / Supabase timeout；小團隊要權限管理 + Slack bot，類 Omnara）——

**他們的痛點與「聚合」完全無關。** 前者買的是 runtime，後者買的是控制面，**兩者都會很開心地用一個綁死單一廠商的產品**。

這不代表 persona 錯了。OpenRouter 的用戶當初也不是為了聚合註冊的，是為了「一把 key 很好用」——**聚合是留下來的理由，不是進來的理由**。

所以：這兩類可以當**獲客入口**，但**架構第一天就必須多供應商**，絕不能讓他們的需求把產品塑造成單一廠商形態。這條線現在畫，之後來不及。

---

## 三、命名：nimplex

### 3.1 為什麼捨棄 loopbox

`loop` + `box` ＝「我在箱子裡跑 loop」。

但新產品**不跑 loop，它路由給跑 loop 的人**。這個名字已經從「不精確」變成「主動誤導」。專案只有一個 commit，現在改名幾乎零成本，往後每週都變貴。

### 3.2 命名條件

TA 是 B / C —— platform team 與工程主管，不是 indie hacker。名字必須讀起來像**正經基礎設施**，而且要是「一個名字」而非「一句描述」。

> `AgentRouter` 出局的原因：它是**描述句不是名字**，沒留任何解釋空間，第二次聽到不會更有感。

register 參照：Supabase / Vercel / Replicate / Turso / Groq —— 現代、短、造字、猜得到在幹嘛。

### 3.3 撞名檢查結果

| 候選 | 結果 |
|---|---|
| Agentry | ❌ **SAP Agentry**（Syclo 併購而來的企業行動平台，仍在服役） |
| Artery | ❌ **Akka Artery**（JVM 遠端傳輸層） |
| Agora | ❌ **Agora.io**（即時音視訊 SDK） |
| Conductor / Maestro | ❌ Netflix 兩個都有 |
| Corso | ⚠️ Alcion Corso（M365 備份，小眾 OSS） |
| Dispatch | ⚠️ Netflix Dispatch（事故管理） |
| Switchgear / Rotta | ✅ 空，但語感偏工業 / 復古 |

> 判準修正：**npm 被殭屍套件佔走不算撞名，撞到真實產品才算。**

### 3.4 nimplex 的構詞

```
nim  +  plex
```

- **`plex·`** —— 來自 multiplex / plexus，是唯一**字面上就是「多路徑在一點交會再散開」**的字根。中央 router 的語意直接內建，而且 multiplex 是每個工程師都懂的詞，零解釋成本。
- **`nim·`** —— 取自 **nimbus**（氣象學中「雲」的正式術語）。雲端語意百分之百在，但不直白。

**接合規則（`runplex` / `arcplex` 被否決的原因）**：真正的 -plex 字，前半都以母音或 `m` / `l` / `r` 收尾 —— com·plex、sim·plex、du·plex、multi·plex —— 會滑進 `pl` 讀成**一個字**。以硬爆破音收尾的前綴（run· / arc· / grid· / hub·）舌頭要停一下，會讀成**兩個字黏起來**。

其他「中央 router」字根候選（備查）：`xbar·`（crossbar switch，任意進任意出）、`spin·`（spine-leaf 的中央層）。`nex·` 已爛（Nexus / Nexo / Nexa 滿地）。

```
@nimplex/sdk
$ nimplex run --cap=5.00
```

---

## 四、動工前待驗證（優先序）

| # | 問題 | 為什麼重要 |
|---|---|---|
| 1 | `bespokelabsai/sandbox`（自稱 "OpenRouter for Sandbox"、8 backend、Apache-2.0）**只有 4 星的死因** | 死因若是「聚合層沒有錢流過」→ 本 reframe 正好跳過該坑，往下做；若是「根本沒人要中立」→ run-level 版本也會死，整條路重想。**同一份資料，兩個相反結論** |
| 2 | 各家 cloud agent 的 **ToS 禁不禁多租戶代理 / 轉售** | 直接決定 v1 只能 BYOK 還是可以走轉售 |
| 3 | 是否已有人在做 cloud agent 聚合 | **尚未查證，不應假設這塊是空的** |

---

## 附錄：技術面既有結論（2026-08-26 掃描）

- **不要在 `apps/runtime` 重寫 loop 與 session** —— 接 Vercel `HarnessAgent`。它已提供 session detach / stop / resume、`suspendTurn()` 跨 process 續跑、sandbox 模板快照（`onBootstrap` + `bootstrapHash`）、`permissionMode`、`toolApproval`、Workflow DevKit 持久化、useChat 串流。

- **sandbox 層是開放介面**，不是只有 Vercel。`HarnessV1SandboxProvider` 任何人可實作；官方有 `@ai-sdk/sandbox-vercel` 與 `sandbox-just-bash`，社群已有 Cloudflare bridge、Coder、Azure Container Apps、Apple Container 等。

- **Vercel 明確不做的三件事，就是差異化的全部**：
  1. **per-end-user $ 硬上限**
  2. **mid-run kill-switch**（`detach()` 不是 kill）
  3. **per-end-user credential vault** —— Vercel 只給 `credentialForwarding` 這根管線，不給保險庫；Composio 只解 SaaS OAuth 那半，且正在遮蔽 raw token（`mask_secret_keys_in_connected_account`），而 coding agent 在箱內跑 `gh` / `psql` / `terraform` 要的正是**原始憑證**。
