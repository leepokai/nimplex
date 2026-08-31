# nimplex 協議策略（2026-08-18）

**依據**：`docs/competitor-analyze/haas-api/research-acp-protocol.md`、`research-anthropic-protocol-playbook.md`（均為當日 ego-browser 一手查證）。本文件回答兩個問題：(1) harness 適配層要不要押 ACP；(2) nimplex 自己的 API/manifest 要怎麼按 Anthropic 的方法制定。
**搭配文件**：`2026-08-18-haas-vision-critique-mvp.md`（MVP spec，方案 A「Per-End-User Agent Run API」）

---

## 1. 決策一：harness 適配層——「箱內 ACP、箱外自有 API」

### 結論

**sandbox 內用 stdio ACP 當主要 harness adapter，sandbox 外（control plane ↔ sandbox）用自有 HTTP+SSE API。現在不押 ACP-over-HTTP。**

### 理由

1. **ACP stdio v1 是穩定規格且生態最廣**：Gemini CLI、OpenCode、Goose 原生實作；Claude 走 `claude-agent-acp`、Codex 走 `codex-acp` adapter；Copilot CLI 也進了 public preview。一個 stdio ACP client 就能驅動幾乎所有主流 harness——比 rivet sandbox-agent（4 種）或 coder/agentapi（6 種）覆蓋更廣，而且 harness 廠商自己維護實作。
2. **ACP-over-HTTP 是 Active RFD，不能押**：可靠性機制（message replay、心跳、重連語意）全延到 v2；只有 Goose 一家 reference implementation；SDK 支援未完成；2026-04~07 架構大改至少 3 次。把 control plane 傳輸層綁上去等於跟著別人未定案的規格重構。
3. **ACP 的信任模型與 nimplex 相反**：ACP 假設「可信 client（編輯器）是安全邊界」；nimplex 的拓撲是「不可信 sandbox 裡的 harness，由遠端 control plane 統一授權」。ACP 的 permission request 語意可以沿用（把 control plane 當 client），但認證、多租戶、計量、配額 ACP 完全沒有——這些本來就是 nimplex 的產品層，不是協議層的缺陷。
4. **v1/v2 遷移期**：v2 Draft（2026-07-20）有破壞性變更。凍結在 v1、以 capability negotiation 檢測，v2 stabilize 後再遷移。

### 落地形狀

```
control plane ──(nimplex 自有 HTTP+SSE API：runs/events/budget/audit)──▶ in-sandbox supervisor
                                                                              │ stdio ACP (v1)
                                                                              ├─▶ opencode
                                                                              ├─▶ codex-acp → Codex CLI
                                                                              └─▶ (claude-agent-acp → Claude Agent SDK，僅客戶自帶 API key)
```

- **in-sandbox supervisor**：自己寫或評估直接採用/fork `rivet-dev/sandbox-agent`（它自己就是「箱內 HTTP+SSE 統一封裝多 harness」的目的性設計；差別是我們的 supervisor 還要做 budget kill-switch 與 secret-proxy 掛鉤）。決策點：先 spike 兩天評估 sandbox-agent 可否掛上我們的 enforcement，可就用它省掉 adapter 維護。
- **ACP 的 permission request 流**（`session/request_permission`）直接映射到 nimplex 的 policy 引擎：harness 要求權限 → supervisor 轉發 control plane → 按客戶設定的 policy 自動允/拒或升級 HITL。這是免費繼承的標準化語意。
- **對外相容性留口**：supervisor 的 API 設計成未來可加一個 ACP-over-HTTP bridge（等 RFD 到 Preview/Completed 再做），讓 Zed/JetBrains 等 ACP client 直接連 nimplex sandbox 成為可能的驚喜功能，而非現在的依賴。
- **追蹤**：ACP Transports WG（Zed+JetBrains+Block 三方主導）的 HTTP/WS RFD 狀態，每季 review 一次。

## 2. 決策二：nimplex 自己的規格——按 Anthropic playbook，但守住順序

### 適用的 playbook 原則（對映到 nimplex）

| # | Anthropic 原則 | nimplex 落地 |
|---|---|---|
| 1 | 核心小到一天可實作，能力全可選 | v1 API 面只有：`POST /v1/runs`＋`GET /v1/runs/{id}/events`（SSE）＋end_user 物件＋`budget_usd`。credentials broker、多 harness、resume 全是宣告式 capability，不做強制 |
| 2 | Day-one 給滿：spec + SDK + reference impl + 旗艦使用場景 | 開源日同步出：API spec（OpenAPI）＋ TS/Python SDK＋可 docker compose 自架的 control plane＋一個吃自家 API 的 demo 產品（例如 nimplex 自己的 PR auto-fix loop——同時回收 nimplex 原本的 loop engineering 定位） |
| 3 | **先驗證、後開放**（Skills 模式，不是 MCP 模式） | nimplex 是 solo 專案、還沒過訪談與毛利門檻——**不要第一天喊「開放標準」**。先當「一個好用的開源產品的 API」，等 E 段有真實使用者再把 manifest 抽成 spec。這同時呼應 8/17 批判裡「標準賽局需要分發，你還沒有」的警告 |
| 4 | Date-based versioning | API 與 manifest 都用 `2026-XX-XX` 版本；每請求帶版本 header（學 MCP 2026-07-28 的無狀態方向） |
| 5 | 擴充機制第一天就有 | `_meta` 欄位＋`x_` 前綴自訂欄位，第三方不 fork 就能擴充 |
| 6 | 治理先輕後重 | 現在：GitHub PR + CHANGELOG 誠實寫「上一版哪裡不夠」。SEP/conformance test 那套等有跨廠商爭議再說（MCP 也是滿一年才制度化） |
| 7 | 破壞性變更制度化 | 有付費使用者後承諾 deprecation window（照 MCP 的 12 個月太長，solo 專案先承諾 3 個月） |

### 直接可抄的技術決定

- **Auth 設計抄 MCP 2025-06-18 的教訓**：nimplex control plane 是 OAuth **Resource Server**（不是 client）；對外部 credential broker（Nango/Arcade）的 token 一律做 audience 綁定（RFC 8707 Resource Indicators 的精神），防 confused-deputy——MCP 被打臉過的地方我們第一天就做對。
- **事件流設計參考兩邊的取捨**：MCP 走「無狀態請求＋單一通知流」、ACP HTTP RFD 走「長連線 GET 串流＋202 Accepted」。nimplex 的 `runs/{id}/events` 用 SSE＋`Last-Event-ID` 續傳（MCP 拿掉了 resumability，但我們的 W4「durable session」是賣點，不能拿掉）。
- **Manifest（未來的 harness/loop 封裝格式）**學 SKILL.md：一個資料夾＋一個 markdown/YAML 檔＋progressive disclosure，最低欄位只有 name/description/harness/credentials 宣告。

## 3. 一句話總結

> **協議上：消費 ACP（stdio、箱內），不生產 ACP；自己的 API 按 MCP 的技術紀律設計（最小核心、date versioning、能力協商、resource-server auth），但按 Skills 的順序推出（先產品驗證、後開放規格）。**

## 4. 待辦（併入 spec 第 7 節驗證計畫）

1. Spike（2 天）：`rivet-dev/sandbox-agent` 能否掛 budget kill-switch 與 secret-proxy？可 → 採用；不可 → 自寫 supervisor＋stdio ACP client（用官方 TS/Rust SDK）。
2. Spike（1 天）：`claude-agent-acp` 在「客戶自帶 API key、防火牆注入」形狀下是否可用（不碰訂閱 OAuth）——結果餵給 spec 第 7 節第 4 項的 Anthropic sales 詢問信。
3. 每季 review：ACP HTTP/WS RFD 狀態、ACP v2 stabilize 進度、MCP 下一個年度版本方向。
