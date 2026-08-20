# Harness as a Service — 願景、批判分析與 MVP 定位（2026-08-18）

**性質**：本文件是 loopbox HaaS 方向的完整 spec 前身——記錄原始願景、整合既有研究批判、補足缺席的競品視角、深化 persona、收斂 MVP 形態。
**前置文件**：`~/mycode/claude-daily-tasks/personal/product/harness-as-a-service.md`（主 memo）、`research/harness-as-a-service-report-2026-08-14.md`、`research/harness-as-a-service-critique-2026-08-17.md`、`research/haas-round2-competitors-persona-2026-08-17.md`、`loopbox/docs/competitor-analyze/*`
**本輪新研究（全文歸檔於 `docs/competitor-analyze/haas-api/`）**：`research-firstparty-runtimes.md`（AWS/Google/Azure/Cloudflare）、`research-startup-oss-layer.md`（Omnara/LangGraph/Letta/Runloop/Blaxel 等）、`research-glue-layer.md`（Arcade/Nango/metering/agent security）、`research-persona-subsegments.md`（P3 五個子區隔實名證據）
**狀態**：分析完成，MVP 形態待使用者選定（第 6 節）

---

## 1. 原始願景（2026-08-18 使用者原文整理，忠實記錄）

> 我要做 Harness as a Service：一個雲端平台，讓使用者部署自己選的 harness（Claude Code、OpenCode，甚至自己微調、帶大量 extension 的 Deep Harness）。我們做後台托管，使用者像用 Cloud Managed Agent 一樣，把 agent 直接整合進自己的 Web/App。定位像 Vercel，優勢是可以整合不同 agent，不侷限單一 harness。

**規劃的功能**：
1. 接入各種 Connection 與 OAuth 2.0，讓 agent 能連上不同工具鏈執行任務
2. 支援使用者部署自訂 harness（微調的 Deep Harness + extensions）
3. Monitor / Manage：評估每個 harness 的跑分與效果
4. 以 Sandbox + Computer Use 實現上述能力
5. 提供 API 讓其他 agent 系統調用，取得完整 computer use 等能力，作為 cloud agent 的基礎服務設施（比 Replicas、Capy 更具可操作性）

**Persona（原始）**：Web/App 開發者，想在產品裡加一個聰明、context management 很強的 agent；以及想做 cloud agent 的人。
**商業模式（原始）**：傾向開源。

---

## 2. 既有研究已確立的結論（不重新辯論，直接繼承）

三份 memo（8/14、8/17 ×2）與 loopbox 競品文件已用一手查證確立以下事實。本文件把它們當作已定案的前提：

### 2.1 原始形態已被證偽

- **同形狀公司死過一次**：Bloop AI（Vibe Kanban）支援 11 種 harness、有雲端有自架有投資人、$30/seat，2026-04 關門。創辦人原文：「絕大多數是免費用戶，我們找不到一個讓自己興奮的商業模式。」
- **價格帶結論**：Replicas $120–300/seat 活著、Vibe Kanban $30/seat 死了 → 低於 ~$100/seat 的多 harness 編排是死區；活著靠環境控制＋觸發整合＋企業合規，不是 harness 數量。
- **佔位者 ≥8 個，其中 4 個免費開源**：Replicas、Warp Oz、Coder、GitLab Duo、Omnigent（Databricks）、Omnara、agentrove、Otari（Mozilla）。原始規劃裡的**每一項功能**都已有人交付（14 項全中，見 round2 memo 第 4 節）。

### 2.2 原始願景六個組成部分的既有判定

| # | 組成 | 判定 | 依據 |
|---|---|---|---|
| 1 | 「像 Vercel」類比 | ❌ 錯誤類比 | Vercel 托管自己擁有的 framework（Next.js 是分發管道）；我托管競爭對手擁有的 harness，上游隨時自己開雲（Managed Agents GA、Warp Oz、Ona 被 OpenAI 收購）。harness 對買家不可互換（工具集/權限/prompt 慣例/成本結構全變）→「支援很多 harness」不是賣點，是 N×M×K 支援矩陣的負債 |
| 2 | 自建 OAuth / Connection 層 | ❌ 不要自建 | 這是資安公司的生意：Arcade $60M（資安創投領投）、Composio 2026-05 外洩數千把 key。正確做法：整合 Arcade/Nango，secret 在防火牆層注入、永不進 sandbox |
| 3 | 使用者自帶自訂 harness | ⚠️ 唯一真空但需求未證實 | 供給側只有 pi 的 2,000+ extensions 等少數案例，幾百人的市場；且「接受任意使用者程式碼」= 多租戶不可信程式碼託管，成本曲線由 Modal/E2B/Daytona 定價 |
| 4 | Monitor / 跑分 | ⚠️ 論據極硬但不是產品 | harness 差異有硬數字（同模型跨 harness 差 16pp；arXiv 有專文）。但排行榜沒人付錢（htek 免費做更全）、Warp Oz 已內建、observability 已商品化（89% 組織已有）。正確位置：信任機制與獲客內容，不是收入來源 |
| 5 | Sandbox + Computer Use 實現監控 | Sandbox ✅ 買不要造；CUA 當監控 ❌ 技術錯誤 | OSWorld 2.0 長程任務 Opus 4.8 僅 20.6% binary accuracy、延遲數十分鐘、重跑不穩。要的東西（log/trace/成本/steering）ACP/OTel/serve mode 都有確定性介面。CUA 唯一正當位置：agent 任務本身要操作瀏覽器、或幫客戶做 E2E 驗證 |
| 6 | Persona = Web/App 開發者（P1） | ❌ 已刪除 | 終端使用者沒有 repo；coding harness 放進 SaaS 聊天框 = 付 repo 掃描與 bash 迴圈的成本換一個聊天機器人；免費方案（eve/Mastra/Cloudflare）就夠；付費證據為零 |

### 2.3 合規與經濟硬線（繼承，不可繞過）

- **Claude Code 不能安全托管**：專有 binary，為第三方托管＋訂閱 OAuth 已被禁止且實際執法（2026-02 明文、03/04 封 OpenClaw/OpenCode）。能安全托管的：Codex CLI（Apache-2.0）、OpenCode、Cline、Goose、Pi（MIT core）。唯一乾淨形狀：客戶自己的 API key，防火牆層 brokering 注入。
- **BYOK ⇒ token 毛利 = 0**：收入只剩 compute 加價＋平台費。AI 產品毛利基準 50–60%（SaaS 80–90%）。
- **閒置成本**：coding session 掛 10–40 分鐘，sandbox 大半在等模型。照 wall-clock 收沒競爭力；照 active-CPU 收，閒置由平台吸收。**毛利算不到 40% 不動工。**

### 2.4 Persona 定案：P3

**P3 = 正在把 agent 當產品功能出貨、且 agent 必須代表每個終端使用者行動的產品團隊**（B2B/垂直 SaaS，10–200 人，demo 跑通、正要開給付費使用者）。

**觸發的四道牆**（demo → 上線之間撞到的）：
1. 每個使用者的 OAuth token 怎麼隔離？agent 怎麼保證只用當前使用者的權限？（W1）
2. 一個使用者燒掉 $400 怎麼辦？per-user 上限、用量歸屬、向使用者收費？（W2）
3. agent 讀到使用者資料裡的惡意指令、外洩另一個使用者的 token 怎麼辦？（W3）
4. session 掛了、機器重啟，狀態怎麼續？（W4）

**計價**：錢來自產品 COGS 而非內部工具預算 → 按終端使用者/執行分鐘計價，跳出 $120/seat 價格戰。
**多 harness 的位置**：不是主賣點，是保險（不被單一模型商綁死），第三順位訊息。
**資格審查第一題**：「你們的 agent 需不需要代表每一個終端使用者去讀寫他們自己的第三方帳號／repo／瀏覽器 session？」答「不需要」直接淘汰。

### 2.5 本次會話的方向決定（2026-08-18）

使用者選定：
- **方向**：P3 的 API 化——MVP 是「agent 執行 API」，核心賣點是 per-end-user 隔離、計量額度、稽核（1 個 agent → 10,000 個），harness 可插拔降為保險
- **核心場景**：**通用任務執行 runtime**——客戶定義 agent 要做什麼（任意 harness/loop + 工具），平台提供 sandbox 執行 + per-end-user 憑證注入（防火牆層）+ 計量額度 + 稽核

### 2.6 Capy（capy.ai，先前誤記為 caby.ai）

Scrapybara Inc.（YC F24，~$4.1M seed）轉型後的產品。三角色自有 harness（Captain 規劃 → Build 執行 → Review 驗收）、每任務一台 Ubuntu VM（宣稱 32 vCPU/128GB、<1s 開機）、原生 computer/browser use 以標註影片為驗收物、$20–2,000/mo credit 階梯。BYO ChatGPT/Copilot 訂閱但**不含 Claude 訂閱**（Anthropic 不允許）、BYOK 僅 Enterprise。

**對本案的兩個關鍵事實**：
1. 其前身 Scrapybara 就是「virtual desktops for AI agents 的 API」——**這個純 computer-use API 產品 2025-10 收掉**。這是「computer use as a standalone API」生意的唯一實證數據點，而且是負面的。
2. 證據面顯示其實際用戶是 solo founder/indie（X/IG 發布、Solo Founders program、零可歸屬企業 testimonial），不是企業——企業外皮下是 prosumer 生意。

### 2.7 loopbox 競品文件已確認的技術積木（買/採用，不重造）

- **in-sandbox control plane**：`rivet-dev/sandbox-agent`（Apache-2.0）把 Claude Code/Codex/OpenCode/Cursor/Amp/Pi 統一在一個 HTTP+SSE API 後面——「幾乎就是 loopbox 需要的 in-sandbox control plane」。備選：`coder/agentapi`、SWE-ReX。
- **sandbox**：E2B（`e2b-dev/infra` Apache-2.0 可自架）、Modal、Vercel Sandbox（active-CPU 計價）、Cloudflare Sandbox SDK；snapshot/branch 的設計標竿是 Morph（<250ms N-way CoW branch）。
- **OSS 真空（loopbox 原定位）**：沒有 OSS 專案同時具備 (a) VM sandbox + warm pool + snapshot versioning (b) BYO agent-CLI harness (c) event/cron loop engine。

---

## 3. 新研究：完整競品地圖（2026-08-18，三份報告的綜合）

_全文見 `docs/competitor-analyze/haas-api/` 三份報告；此處為決策用摘要。_

### 3.1 第一方雲端 runtime：品類已被驗證，四道牆沒有一家同時立起來

| | AWS AgentCore | Google Agent Runtime | Azure Foundry | Cloudflare |
|---|---|---|---|---|
| W1 per-user OAuth 隔離 | ◕（token vault + 3LO GA；但 SDK 路徑 token 會進 sandbox） | ◑（概念最對，仍 Preview） | ◑（Entra OBO；SaaS 顧客不在 tenant） | ○ |
| W2 per-user 上限/計量/轉售 | ◑（per-JWT-sub RPS/TPM，token 維度非美元；轉售 DIY） | ○ | ◔ | ◑（AI Gateway 美元 spend limits per user，beta、僅 LLM） |
| W3 爆炸半徑 | ●（microVM + gateway 層 Guardrails） | ◑ | ◔（偵測為主） | ◑（原語強、自行組裝） |
| W4 durable/resume | ◕ | ◕ | ● | ◕ |
| Harness 可插拔 | ●（**Claude Code/Codex/OpenCode/Cursor 官方支援＋受管 Harness GA**） | ○（只有 Antigravity） | ◑ | ◑ |
| BYO model keys | ● | ○ | ○（不支援） | ● |

**最重要的單一事實**：AWS AgentCore 12 個月內把品類每個名詞都佔了（Harness、Identity token vault、Policy、Payments、Registry），**preview→GA 平均約兩個月**。「原始願景」裡的多 harness 托管 + BYO keys，AgentCore 已經整包交付——但綁 AWS、有 IAM/Cognito 稅、無美元 per-user 上限、無可轉售帳務、「secrets 不進 sandbox」只是可選路徑。

**四家共同的三個結構性空白**：
1. **美元計價的 per-end-user 硬性成本上限 + 可轉售計量帳務**——沒有任何一家提供（Cloudflare 最接近但僅 LLM、beta）
2. **「secrets 一律防火牆層注入、絕不進 sandbox」作為預設架構**而非可選路徑
3. **跨雲中立 + 受管的多 coding-harness 託管**（AgentCore 做得到但綁 AWS；其他三家做不到）

### 3.2 Startup/OSS 層：碎片化，不是空白

- **Omnara**（YC S25、4 人、Apache-2.0）：架構最接近（control plane 跑 loop、event-log durable execution、BYO keys/machines）——但 **identity 模型止於 org/project/member，完全沒有 end-user 物件**；secrets 是環境變數注入（會進執行環境）。
- **Runloop Agent Gateway**：憑證代理（sandbox 只拿 opaque token、真 key 不進 sandbox + egress allowlist）——**正是 W1/W3 的正確機制，但只到 org 層級**，無 end-user 物件。
- **專門玩家各佔一牆**：Agentic Fabriq（YC W26，"Okta for agents"，W1 治理）、Nevermined/Paid.ai（W2 billing）、Temporal/Inngest（W4，已商品化）、E2B/Daytona/Blaxel（W3 compute）。
- **結論**：**沒有任何人把「end-user 身分＋brokered 憑證不進 sandbox＋美元花費上限＋可續 session」組合在一個 API 呼叫裡、包在可插拔 harness 外面。** 但 Omnara 或 Runloop 距離補上 end-user 物件「只差一個季度的 roadmap」。

### 3.3 Glue 層：四道牆的單品化程度（決定「自拼」的難度）

| 牆 | 買得到嗎 | 整合痛感 |
|---|---|---|
| W1 憑證隔離 | 成熟（Arcade/Nango/Auth0 Token Vault/Scalekit） | 中（數天-數週）；但 hosted vault = 集中靶心（Drift、Composio、Vercel Connect 三起實名事故） |
| W2 per-user 計量/額度/計費 | **只有零件**（OpenMeter entitlements、LiteLLM budgets、Stripe-Metronome）；attribution tagging 全自建 | **高——四牆中最沒有 agent-native drop-in 的一面** |
| W3 爆炸半徑 | 零件齊全且 pattern 已定型開源（Infisical Agent Vault、Pipelock、eve 防火牆注入） | 中高；對映到 per-end-user 邊界要自組 |
| W4 durable | 完全商品化 | 低——隨 framework 免費附帶 |

**Glue 報告最刺的一句**：unified runtime 最大的競爭者不是四家 vendor，而是「**framework 把 glue 變薄**」——Vercel eve 已把 durable session + per-agent sandbox + connection 層 secret brokering + approvals 綁進一個開源 framework。單獨的 W2 縫是 "feature-sized"，不是 "platform-sized"。

**痛點實證**（自建案例）：Browser Use 自建 per-session microVM + 零憑證 control plane（自承「三個服務、每個操作多一跳」）；Braintrust 把 per-user cost caps 寫成自建 playbook；TrueFoundry：「大多數團隊在第一張意外帳單後加 token rate limit、第二張後加 budget caps」；IETF 已有 draft-oauth-ai-agents-on-behalf-of-user。

### 3.4 空位的精確定義與威脅清單

**空位（本案要佔的）**：一個 API 呼叫綁定 `{end-user 身分 + brokered 憑證（絕不進 sandbox）+ 美元硬上限 + 可續 session + 稽核 log}`，包在可插拔 harness/loop 外面，跨雲中立、OSS 可自架、帳務輸出可直接轉售給客戶的終端使用者。

**威脅（按急迫排序）**：
1. AgentCore 的迭代速度（窗口以季為單位收窄）
2. Omnara/Runloop 補上 end-user 物件（一個 roadmap 季度）
3. Claude Managed Agents 以 $0.08/session-hr 把 runtime 商品化（W3/W4 免費化）
4. eve/framework 趨勢把 glue 變薄（買 runtime 的理由變弱）
5. 集中托管憑證 = 超級靶心（Composio/Drift 級事故對小公司是即死）

---

## 4. Persona 深化：「做 web/app 的人，用這個工具 serve 他們的 customer」

### 4.1 這句話橫跨兩個命運不同的 persona——必須先切開

| | 「serve customer」的方式 | 判定 |
|---|---|---|
| **P1 形態** | agent 是產品裡的聰明助手：讀自家 DB、回答問題、產內容。用的是**產品自己的**權限 | ❌ 已刪除——免費框架就夠，付費證據為零 |
| **P3 形態** | agent **代表每一個 customer 行動**：用該 customer 自己的憑證讀寫他的第三方帳號、在隔離環境跑程式碼、替他操作瀏覽器 | ✅ 四道牆真實存在，錢從產品 COGS 出 |

**分界測試**（資格審查第一題）：「你的 agent 需不需要代表每一個終端使用者，去讀寫**他們自己的**第三方帳號／repo／瀏覽器 session？」

### 4.2 P3 五個子區隔（實名證據，全文見 `research-persona-subsegments.md`）

| 子群 | 定義 | 實名例子 | 最痛的牆 | 已證實的採購 | 灘頭堡評分 |
|---|---|---|---|---|---|
| **E. Coding-agent-as-feature** | 把 coding agent 當功能賣給自己使用者 | CodeRabbit、Codegen、Sentry Seer、Factory、Tembo、Charlie Labs、cubic | **四牆全中**（CodeRabbit RCE：一個惡意 PR → 100 萬 repo 寫入權；Replit 刪 SaaStr production DB） | Northflank（Sentry/Writer）、Daytona（Trajectory 4,000 sandbox/月）、E2B | ⭐ **最佳**——形狀完全同構（sandbox 裡跑 harness + per-user GitHub token + cap 成本 + resume），買家是開發者 = OSS 天然通路 |
| **C. Vertical SaaS 加 agent 功能** | 既有 SaaS 的 agent 連進每個使用者的 Gmail/Slack/CRM/QuickBooks | Motion、Athena Intelligence、Copy.ai、tl;dv、Credal、Plain、Vapi | W1、W2 | Nango（$500+/月起）、Paragon ActionKit（100+ SaaS）——量體五段最大 | **擴張市場**——注意：只有做 code-execution/browser 的子集需要 runtime，純 API tool-calling 不需要 |
| **A. Agent-native B2B SaaS** | 產品本身就是替客戶行動的 agent | 11x、Artisan、Decagon、Sierra、Intercom Fin、Truewind | W1、W3、W2 | LangGraph/LangSmith 全家桶（11x）、Nango | 設計夥伴可以；頭部自建、CAC 高 |
| **B. App builders** | 每個 end user 一個可執行專案 | Lovable、Bolt、v0、Replit、Manus、Gumloop | W3、W2 | **Lovable×Modal：週末 100 萬 sandbox、2 萬並發**——per-user sandboxed execution 有人大規模掏錢的鐵證 | 當「市場存在」的證據引用，不當目標（已被 E2B/Modal 服務好） |
| **D. Consumer computer-use 助理** | 替消費者操作網頁 | Manus、Genspark、Lindy、Benny | W1、W3 | Browserbase（5,000 萬 sessions、$300M 估值）、Anchor、Kernel | 不建議——客戶少、credential 牆已被 browser 商內建吃掉 |

### 4.3 灘頭堡結論

**E → C 的打法**：先佔 E（coding-agent-as-feature 的小團隊：Tembo/Charlie/cubic 規模），用 CodeRabbit RCE 與 Replit 事故當銷售素材；等 C 段的 SaaS「agent 開始執行程式碼／操作瀏覽器的那一天」再收割 C。B 段當證據，A 段找 1-2 家設計夥伴，D 段放棄。

### 4.4 資格訪談名單（10 家）

Gumloop、Athena Intelligence、Lindy、Aomni、Truewind、Parcha、Benny、Tembo/Charlie Labs/cubic 任一、Sintra.ai、Open-Inspect。
（第一題一律問：「你們的 agent 需不需要代表每個使用者讀寫他們自己的帳號/repo？」第二題：「per-user token 隔離、成本上限、injection 爆炸半徑，現在誰在做？花了幾人月？」）

### 4.5 反面證據（誠實記錄，訪談時要正面驗證）

- 拼裝方案確實可用：11x 用 LangGraph 全家桶重寫成功、Lovable 對 Modal「整週末零 page」——單點供應商夠好。統一 runtime 的價值必須來自**四牆的交集**（injection 隔離必須同時知道這個 sandbox 綁哪個使用者的 token 與預算），否則只是又一層抽象。
- 贏家自建：Vercel（Hive）、Replit、Codegen 規模化後都自建 sandbox 層。
- C 段隱憂：多數 vertical SaaS agent 只做 API tool-calling——「需要 sandboxed execution 的 per-user agent」是子集，比例待訪談驗證。

---

## 5. 批判分析：這個 MVP 必須回答的五個問題

**Q1：「為什麼不用 E2B + Nango + LiteLLM 自拼？」**
唯一站得住的答案是**交集論**：美元硬上限的 enforcement 必須同時控制 LLM proxy 與 sandbox 生命週期（超額要能當下殺掉正在跑的 session）；injection 爆炸半徑的界定必須知道這個 sandbox 綁哪個使用者的哪些 token；稽核要橫跨憑證使用×花費×動作。這三件事都要求「同一個控制面」。如果訪談發現客戶對交集無感、只想要單品，本案不成立。

**Q2：「AgentCore 已經做了多 harness + token vault，為什麼還有你？」**
答案只能是：零 IAM 稅（10 分鐘上手 vs Cognito/IAM 佈線）、跨雲中立（客戶的客戶不想資料進 AWS）、美元 per-user 上限與**可轉售帳務**（AgentCore 沒有）、secrets 不進 sandbox 是**預設**而非可選、OSS 可自架。這些對 10-200 人非 AWS 大戶團隊是真差異，但窗口以季收窄——**速度就是策略**。

**Q3：「eve 這類 framework 把 glue 變薄之後，還有人買 runtime 嗎？」**
framework 給的是**程式庫**，不給 enforcement：eve 的 spend 治理綁 Vercel 生態、不含 per-end-user 轉售帳務、不含多 harness。runtime 的辯護是「framework-agnostic 的 enforcement 層」——客戶用 eve/LangGraph 寫 loop，跑在本 runtime 上拿四牆。此答案成立與否取決於客戶是否願意為 enforcement 單獨付錢（訪談驗證）。

**Q4：「Omnara/Runloop 一個季度就能補上 end-user 物件，怎麼辦？」**
不能靠功能競賽。可守的位置：(a) **把 per-end-user 當第一天的資料模型**（他們是事後補裝，稽核/計費/隔離全要重排）；(b) E 段的 OSS 分發與社群先佔；(c) 帳務轉售這種「無聊但黏」的深度。若三者都守不住，這題就是「比誰快」。

**Q5：「經濟與合規算得過嗎？」**
- BYOK ⇒ token 毛利 0，收入 = compute 加價 + 平台費（per-run 或 per-active-user）
- 必須 active-CPU 計價採購（E2B/Cloudflare Sandbox），否則閒置吃掉毛利——**動工前先拿報價算：session 40 分鐘、活躍 CPU 8 分鐘，毛利 ≥40% 才做 hosted**
- 托管 harness 限 Apache/MIT 系（Codex CLI、OpenCode、Goose、Pi）；Claude 只能走客戶自己的 API key + 防火牆注入，且不得稱 "Claude Code hosting"
- **不自建 token vault**：W1 一律 broker 給 Nango/Arcade 或客戶自己的 vault，本平台只做「注入而不保管」——這同時是安全姿態與差異化敘事（Composio/Drift 事故的反面）

---

## 6. MVP 形態選項（待使用者選定）

### 方案 A（推薦）：最小交集 runtime——「Per-End-User Agent Run API」

一個 API 打包四牆交集，灘頭堡 = E 段：

```
POST /v1/runs
{
  "end_user": "usr_123",              # 第一級物件
  "harness": "codex-cli | opencode | custom-container",
  "task": {"repo": "...", "prompt": "..."},
  "credentials": ["nango:conn_abc"],   # broker 引用，永不進 sandbox
  "budget_usd": 2.50,                  # 美元硬上限（LLM+compute 合併），超額即殺
  "model_key_ref": "byok:anthropic"    # BYO keys
}
→ SSE 事件流 + 稽核 log + per-user 用量匯出（可轉售格式）
```

- **範圍內（v1）**：W2 全套（美元計量、硬上限、per-user 歸因、用量匯出）＋ W3 預設（sandbox + egress 防火牆 + secret 注入代理）＋ 1-2 個 harness（Codex CLI/OpenCode，經 rivet sandbox-agent）＋ BYO model keys ＋ 稽核 log。
- **範圍外（v1 明確不做）**：自建 OAuth（integrate Nango）、W4 精緻 resume（先只做 snapshot 粗粒度）、computer use、自訂 harness 上傳、Monitor 跑分、marketplace。
- **交付**：OSS control plane（可自架，Apache-2.0）＋ hosted cloud（active-CPU 轉售 + 平台費）。
- **理由**：enforcement 需要擁有執行路徑（Q1 交集論）→ 只做 gateway 不夠；E 段形狀完全同構；保留 loopbox 的 sandbox/loop 工程認同。
- **風險**：範圍仍大（solo founder 約 2-3 個月到可 demo）；毛利與訪談兩道門檻未過前不該全速寫。

### 方案 B：只做經濟層——「Agent Spend Gateway」

LLM proxy + sandbox 供應商帳單彙整，提供 per-end-user 美元上限、歸因、轉售帳務；不跑 runtime。
- **優點**：4-8 週可上線；正中「四牆中最沒有 drop-in 的一面」。
- **缺點**：enforcement 弱（殺不掉別人家的 sandbox）；縫是 feature-sized，Cloudflare spend limits/Stripe-Metronome 正面壓過來；放棄 loopbox 的 sandbox 工程資產。

### 方案 C：OSS 優先——自架版四牆 runtime（先不做 hosted）

把方案 A 的 control plane 純開源交付（docker compose 自架），先攢 E 段開發者社群與 GitHub 分發，hosted 等自架用戶過千再說。
- **優點**：solo founder 成本最低；分發先行；避開托管合規與毛利問題。
- **缺點**：既有研究的警告——「若 runner 開源，企業自架不付錢」；轉換率殘酷（自架→cloud 約 2-5%）；且 Omnara 已佔「開源 agent API」心智。

**推薦**：**A，但以「A 的骨架、C 的順序」執行**——先開源最小交集（一個 harness、美元上限、secret 注入代理、稽核），用 E 段訪談與 GitHub 反應決定 hosted 的時機；B 作為 A 裡第一個收錢的模組而非獨立產品。

---

## 7. 驗證計畫（動工門檻，按順序）

1. **資格訪談（本週，最便宜）**：拿 4.4 的 10 家名單問兩題（代表使用者行動？四牆現在誰在做、幾人月？）。**門檻：10 家裡 ≥4 家答「是」且說得出自建成本，否則回到桌上。**
2. **交集驗證（訪談內嵌）**：問「如果 per-user 上限、憑證隔離、稽核分三家買，你要嗎？」——測 Q1 的交集論是否真的值錢。
3. **毛利計算（動工前）**：拿 E2B/Cloudflare active-CPU 報價，用「session 40 分、活躍 8 分」算 hosted 毛利。**<40% 就只做 OSS（方案 C）。**
4. **法律邊界（一封信）**：問 Anthropic sales「客戶自己的 API key、防火牆注入、托管執行」的允許形狀——回覆界定 harness 支援清單。
5. **皇冠測試（延後）**：多 harness 已降為保險，此測試改為決定 v1 支援 1 個還是 2 個 harness，不再是產品存亡題。

---

## 8. 追加收斂（2026-08-18 晚間）：Agent Computer as a Service——方案 A 的再定形

### 8.1 使用者的收斂陳述

> 「先瞄準一個準確且專一的需求：很多人想要讓他們的 agent 能夠有一個完整的 sandbox 做操作、有很強的功能。」「其實就是 Vercel eve，但是可以使用不同的 harness。」

### 8.2 產品定義（取代方案 A 的 run-centric 表達）

**第一級物件從「run」改為「sandbox（agent 的電腦）」**：客戶的 agent（任何 framework）透過一個 MCP connect 或一個 API call，拿到一台**開機即用的 agent 電腦**。四道牆不再是獨立的「runtime 產品」，而是這台電腦的**預設屬性**。

```
POST /v1/sandboxes          # 或 MCP: loopbox_computer 工具組
{
  "end_user": "usr_123",             # per-end-user 綁定（W1/W3 邊界）
  "budget_usd": 2.50,                # 美元硬上限，超額殺箱（W2）
  "credentials": ["nango:conn_abc"], # secret-proxy 注入，永不進箱（W1）
  "harness": "opencode | codex-cli | none",  # none = 純電腦，agent 自帶腦
  "snapshot_from": "snap_xyz"        # 狀態是一級物件（W4）
}
→ MCP tools: bash / files / git / browser(a11y tree) / harness.prompt / snapshot
→ SSE 事件流 + 稽核 log + per-user 用量匯出
```

**v1 能力範圍（使用者 2026-08-18 選定，四項全要）**：
1. **Code 執行工作區**：bash/files/git/依賴安裝 + repo clone
2. **Browser（含 a11y tree）**：headless Chrome + 結構化 accessibility tree（學 Replicas `browser-state`）
3. **Harness 預裝（ACP）**：箱內 supervisor 以 stdio ACP 驅動 Codex CLI/OpenCode（照 protocol-strategy）；`harness: none` 時客戶的 agent 直接當腦
4. **桌面 GUI/computer-use**：⚠️ 使用者堅持納入 v1；分析側保留意見已記錄（Scrapybara 收掉的正是 desktop-as-API；OSWorld 2.0 CUA 可靠性硬證據）。**執行建議：v1 內部再分兩階——code+browser+harness 先出，desktop 掛 beta flag 後出**，砍掉不影響前三項的架構。

**介面順序（使用者選定）**：**MCP server 優先**——任何支援 MCP 的 agent framework 一行接入，吃 MCP 生態的分發；REST + TS/Python SDK 作為底層同步提供（MCP 只是它的一層皮）。

### 8.3 「就是 eve 但可換 harness」——定位的誠實判定

既有研究（round2 memo 第 3 節）已對這句話判過：**弱**。三個理由仍然成立：多 harness 不獨特（8+ 家在做、4 家免費）、不是付費理由（Replicas 收錢靠環境控制不靠 harness 數）、eve 免費靠的是 runtime 計量底座——「要像 eve，得複製的是計量底座，不是多 harness」。

**可守的版本是換一個對比軸**：
- eve/LangGraph 是「**自己寫 loop**」的框架——買家是要打造自有 agent 的工程師；
- loopbox 是「**帶現成 harness 的電腦**」——買家是不想寫 loop、想直接讓 Codex/OpenCode 級的現成大腦在一台受控電腦裡替使用者幹活的產品團隊。
- 經濟模式**抄 eve 而不是對抗 eve**：OSS 框架/control plane 免費 + hosted metered compute 收錢（active-CPU 轉售 + 平台費）——這正是 eve 的「免費框架、計量底座收錢」結構，loopbox 的底座 = sandbox 層（自己的工程資產所在），不是轉售。
- 對外話術不說「eve alternative」（會被拿去跟免費框架比），說「**your agent's computer**」。

### 8.4 與競品的一句話切分（皆出自本輪研究）

E2B/Daytona 給裸 VM（無 harness、無 per-user、無美元上限）；Browserbase 只有 browser 這一塔；AgentCore 有整包但綁 AWS + IAM 稅、無美元 per-user 上限、secrets 進箱是預設；eve 要你自己寫 loop 且綁 Vercel 生態；Scrapybara 之死界定了 desktop-only API 不是生意。**loopbox = 開源、跨雲、harness-ready、四牆預設全開的 agent 電腦，MCP 一行接入。**

### 8.5 對驗證計畫的影響（第 7 節微調）

- 訪談第二題改為：「你們的 agent 現在用什麼當『手』？E2B 自拼的話，上面自己搭了哪些東西（browser、harness、secret 注入、成本上限）？花了幾人月？」——直接驗「電腦 vs 裸機」的溢價是否存在。
- 毛利計算不變（active-CPU、40% 門檻）；desktop GUI 的 streaming 成本另計一條（它是四項裡最貴的 idle 成本來源）。

---

## 附：本輪研究檔案清單

- `docs/competitor-analyze/haas-api/research-firstparty-runtimes.md` — AWS AgentCore / Google / Azure / Cloudflare 四家對照
- `docs/competitor-analyze/haas-api/research-startup-oss-layer.md` — Omnara/LangGraph/Letta/Runloop/Blaxel/E2B/Daytona + 2026 新進者
- `docs/competitor-analyze/haas-api/research-glue-layer.md` — Arcade/Nango/Composio/metering/agent security + 痛點實證
- `docs/competitor-analyze/haas-api/research-persona-subsegments.md` — P3 五子群實名證據 + 訪談名單
