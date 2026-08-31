# 產品方向細化：end-user SDK 優先、harness marketplace 後置（2026-08-21）

**性質**：2026-08-18 spec（方案 A）與 2026-08-20 MVP 定案的後續細化。記錄使用者對定位的釐清、兩階段路線、以及兩個新增的必要功能面（權限管控、網路流量管控）。
**前置文件**：`2026-08-18-haas-vision-critique-mvp.md`、`2026-08-18-protocol-strategy.md`
**程式碼現況**：MVP 骨架已上 `github.com/leepokai/nimplex`（private）——runs/events/work-queue/budget kill-switch/per-end-user 計量已驗證。

---

## 1. 定位釐清：與 Omnara 的目標差異

讀完 Omnara 原始碼與文件後的判斷（2026-08-21 使用者定案）：

| | Omnara | nimplex |
|---|---|---|
| 服務對象 | **團隊內部**——讓團隊搭 cloud agent 更方便 | **product owner 的終端使用者**——讓別人把 agent 裝進自己的 web/app 出貨 |
| 使用者是誰 | org member（工程師、operator） | 客戶產品裡的每一個 end user |
| SDK 的角色 | 有 `frontend/packages/{sdk,react,cli}`，但都是**操作平台**用（org 層）——沒有 end_user 物件，SDK 不能安全地交到客戶產品的使用者手上 | SDK 本身就是產品：讓客戶在他們的 web/app 裡 serve 他們的 end users |
| harness | 不可選（自有 loop 寫死） | 可插拔是賣點之一 |
| 相對成熟度 | 比 Replicas/Capy 陽春；缺「拿來搭應用」的標準 SDK——這是它的明顯缺口 | 從缺口切入 |

**Capy 的新定位認知**：Capy 其實是「**monetize 一個 harness**」的範例——自有三角色 harness 本身就是收費單位。這給 Phase 2 的 harness marketplace 一個現成的商業原型：harness 可以是別人上架、被調用、被計費的商品。

## 2. 兩階段路線（定案）

### Phase 1（現在～）：end-user-facing agent infra + SDK

前期要做完善的是 **infra 層**。目標：product owner 用 SDK 就能在自己的 web/app 裡給每個 end user 一個 agent，計費、憑證、權限、稽核全部由 nimplex 承擔。

範圍（按優先序）：

1. **對 product owner 的 per-end-user 計費**——美元計量、硬上限、可轉售帳單匯出（骨架已有，要補匯出格式與 API）
2. **OAuth / MCP**——end user 的第三方帳號經 broker 連入（Nango/Arcade），agent 以該 user 的身分行動（W1）
3. **原生工具橋接**——客戶可以把**自己產品的 MCP server 或 CLI** 註冊成 agent 的工具：agent 能調用客戶 web/app 自己的功能。這是「agent 裝進產品」的關鍵閉環——agent 不只讀外部服務，還能操作宿主產品本身
4. **完整 SDK**（見 §3）
5. 權限管控（§4）與網路流量管控（§5）

### Phase 2（後期）：harness marketplace

- 別人可以**上架自己的 harness**，作為 cloud agent harness 被第三方調用——體驗對標「像用 Claude Managed Agents 一樣」，但 harness 是市場裡挑的
- nimplex 提供底層 cloud agent infra 搭建平台；harness 作者拿分潤（Capy 模式的平台化）
- 明確後置：先把 infra 做完善，marketplace 是 infra 成熟後的自然延伸
- 技術掛點已預留：`runs.harness` 欄位 + `RunExecutor` 介面

### 下一步行動

**先做 mock 前端網站**，把上述概念視覺化、想清楚（產品敘事、console 資訊架構、SDK DX 展示）。這在寫更多 infra 程式碼之前做。

## 3. SDK 的形狀（Phase 1 核心交付）

三個交付物，對應三種使用位置：

| SDK | 跑在哪 | 拿什麼憑證 | 功能 |
|---|---|---|---|
| **Server SDK**（TS 先行，Python 次之） | 客戶的產品後端 | org API key | 建 run、管 end user 與預算、串事件、resolve approvals、拉帳單匯出 |
| **Client SDK** | 客戶產品的 web/app 前端 | **end-user-scoped 短效 token**（由客戶後端向 nimplex 換發） | 連 run 事件流、送輸入、渲染 approval UI |
| **原生工具橋接** | 客戶的產品內 | 工具註冊 | 把客戶自己的 MCP server / CLI 註冊為 agent 工具 |

**安全鐵則（day one）**：org API key 永遠不進瀏覽器/app。Client SDK 只認短效、綁單一 end_user、綁 scope 的 token——這是 W1 在 SDK 層的投影，也是 Omnara SDK 做不到的事（他們沒有 end_user 物件可綁）。

`packages/contracts`（zod → OpenAPI）與 `packages/api-client` 就是 Server SDK 的種子，已在 repo。

## 4. 權限管控（新增需求，2026-08-21）

使用者明確要求提供的操作與功能。分四層，全部以 `end_user` 為第一維度：

1. **工具政策**：每個 agent config 對每個工具宣告 `always_allow / always_ask / always_deny`，由平台強制（不是 prompt 裡拜託）。`always_ask` → run 進 `awaiting_input`（狀態機已支援），透過 API/SDK resolve。對映協議策略文件裡 ACP `session/request_permission` → policy 引擎的設計——箱內 harness 時代同一套語意直接沿用。
2. **憑證範圍**：替 usr_123 跑的 run **只能**引用 usr_123 的 `credential_refs`——DB 層強制（查詢必帶 end_user_id，用 lint 規則固定），不是應用層自律。
3. **Token 分級**：org key（後端）/ end-user session token（前端，短效）/ 未來 sandbox 內的 opaque token（防火牆層換發）。三種 token 能做的事嚴格遞減。
4. **Console 的角色權限**：org member 的 owner/admin/member 角色（表已建）；之後補 project 層 grant。

## 5. 網路流量管控（新增需求，2026-08-21）

同樣是使用者明確要求。分兩個階段實作，因為 MVP 的 loop 在 worker、未來在 sandbox：

**現階段（loop in worker）——工具呼叫層的管控**：
- **Egress allowlist**：每個 agent config 宣告工具可以打的 domain 清單；worker 在執行 ToolWork 前檢查，不在清單內直接拒絕並記稽核
- **MCP endpoint allowlist**：agent 只能連客戶註冊過的 MCP server
- **Per-end-user rate limit**：單一 end user 的工具呼叫 QPS / 每 run 呼叫數上限（防失控迴圈燒錢，與 budget kill-switch 互補）
- **流量稽核**：每一次外呼記 `audit_events`——目標、動詞、end_user、run——「憑證 × 花費 × 動作」的第三軸補齊

**未來（箱內 harness）——網路層的管控**：
- Sandbox egress 一律經防火牆代理；allowlist 按該 end user 綁定的憑證範圍推導
- Secret 注入在代理層發生（分岔二：明文永不進箱）
- 超額/違規 → 代理層直接斷網 + 殺 sandbox（enforcement 擁有執行路徑的落實）

**設計原則**：兩個階段共用同一套宣告格式（config 裡的 allowlist/policy schema 一次定好），只是 enforcement 點從 worker 移到防火牆——客戶的設定不用改。

## 6. 開放問題（下次處理）

1. 短效 end-user token 的形狀：JWT self-contained vs opaque + introspection？（傾向 opaque，好撤銷）
2. 原生工具橋接的傳輸：客戶的 MCP server 是 nimplex 去連（需要 reachable endpoint），還是客戶後端長連線進來（適合 CLI/內網）？兩種都要嗎？
3. 帳單匯出格式：對齊 Stripe metered billing 的 usage record 形狀，讓客戶直接轉拋給他們的計費系統？
4. mock 前端網站的範圍：只做 console 的 IA，還是連 landing 敘事一起？
