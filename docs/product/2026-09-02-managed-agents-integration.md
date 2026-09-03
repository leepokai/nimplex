# Claude Managed Agents × nimplex：對照與整合路線

> 2026-09-02。依據 `claude-api` skill 內的官方參考（beta `managed-agents-2026-04-01`）逐項對照 nimplex 現況。
> 承接 `2026-09-01-architecture.md`（三平面、不變式）與 `2026-09-01-sdk-architecture.md` §1.1（早期對 Managed Agents 的調研）。
> 定案：**Managed Agents 同時是競品與插槽選項——列出的能力全部要支援，按下方順序落地。**

---

## 0. Managed Agents 的形狀（2026-04-01 beta）

```
Agent（版本化設定：model / system / tools / mcp / skills）
  └─ Session（有狀態；事件流 in/out；budget；resources；vault_ids）
       └─ Environment（cloud ＝ Anthropic 開箱；self_hosted ＝ 你的 worker 長輪詢 work queue、工具在你的容器跑）
            └─ Container（工具執行處；agent loop 不在這，在 Anthropic 編排層）
```

狀態機：`rescheduling → running ↔ idle → terminated`。`idle` 帶 `stop_reason`（等輸入 / 等 tool 結果或確認 / `budget_reached`）。

## 1. 逐項對照

| MA 能力 | nimplex 現況 | 差距 / 整合點 |
|---|---|---|
| **Session budget**：`max_list_cost`（USD 分，整數字串）；每次 model request 前把關；撞頂 → `idle(budget_reached)`，**不是終結**；改/移除 budget 即續跑；官方承認最多超出一個 in-flight request | `budget_usd` + gateway reserve/settle；撞頂 → `killed(budget_exceeded)` | (a) roadmap 的 `paused(budget_exceeded)` + 加預算續跑，MA 證明是正確語意；(b) 當 MA 是 harness 時，`budget_usd` → session budget 一比一映射，`session.usage.list_cost` 回填 `spent_usd` |
| **Self-hosted environment**：loop 在 Anthropic，工具在你的容器；worker 用 `ANTHROPIC_ENVIRONMENT_KEY` 長輪詢；per-session `work.secret` | worker + docker sandbox + reaper | worker 可兼職 `EnvironmentWorker`：MA session 跑在 nimplex 管的沙箱（插槽 3 反向）。限制：self-hosted 不支援 vault、不掛 file/repo resource |
| **Vault** `environment_variable`：secret 在 Anthropic 出口代入 | BYOK gateway + run token 注入（不變式 I1） | 同理念互證，不需整合 |
| **Outcomes**：`user.define_outcome` + rubric；獨立 grader；`satisfied / needs_revision / max_iterations_reached / failed / interrupted` | 架構文件 §7.2 規劃的 `outcomes` 表（尚未建） | `span.outcome_evaluation_end.result` 當 `reported_by: automated` 訊號；長期對**任何 harness** 提供 rubric 評分（MA 只評自己） |
| **Permission policy** `always_ask` → `session.status_idle` → `user.tool_confirmation` | SDK 文件 §2.3 `tool.approval_requested` / `resolveApproval`（未實作） | 形狀一致；per-tool policy 值得抄進 harness manifest |
| **事件命名** `{domain}.{action}`；`session.status_idle` 帶 `stop_reason`；`session.usage` 快照 | 已定案同款命名（未型別化） | 翻譯成本最低；`spend.updated` ≈ `session.usage` |
| **Webhooks**：session status / budget / deployment / vault 事件，簽章驗證 | 無（只有 SSE） | 真實缺口；run 資源上加 `run.status_changed` webhook 成本低 |
| **Scheduled deployments**：cron → session；deployment budget 複製到每次 session；`deployment_run` 紀錄 | 無 | run 上加 cron，成本低，優先度中 |
| **Agent overrides / 版本化**：session 可覆寫 model/system/tools，不動 agent 版本 | harness manifest 有 `version` 欄位，run 不記 harness 版本 | run 應記錄解析到的 harness 版本（可追溯性） |
| Memory stores / multiagent threads / advisor | 無 | harness 內部能力，不屬 nimplex 這層 |

## 2. 整合方式：`claude-managed-agent` 內建 harness（P0）

**關鍵事實**：gateway 是 `/:provider/*` 全路徑代理（`packages/gateway/src/index.ts`）。worker 對 `{{gateway.anthropic}}/v1/sessions…` 打 run token，gateway 換成 BYOK key 轉發——**真 key 不進 worker**，不變式 I1 不動。

```
worker（信任區 B）                      gateway（信任區 A）                Anthropic
  POST /gw/anthropic/v1/sessions  ───►  解封 BYOK、加 x-api-key ───►  POST /v1/sessions
  GET  …/sessions/:id/events(SSE) ◄───  tee 串流                  ◄───  事件流
  POST …/events {user.interrupt}  ───►  （軟殺）
  DELETE …/sessions/:id           ───►  （硬殺）
```

| 元件 | 改動 |
|---|---|
| `core` | `BUILTIN_MANAGED_AGENT_COMMAND` 哨兵 + 內建 manifest（`provider: anthropic`、無 install、不開沙箱） |
| `contracts` | `metering` 加 `provider_reported`（花費來自上游回報的 list cost，非 gateway 實測）；`stop_reason` 封閉列舉 |
| `db` | `managed_agent_refs`：(org, harness, instructions_hash) → `agent_id`、`environment_id`（MA 要求 agent 一次建、多次用） |
| `worker` | 新 executor：建/取 agent 與 environment → 建 session（budget 映射、`initial_events` 帶 prompt）→ 串事件翻譯成 nimplex union → `session.usage` 回填 `spent_usd` → 看門狗殺：interrupt + delete |
| `gateway` | sessions 路徑不套 messages 的 usage 抽取，避免每次都記 `metering.gap` |
| e2e | 需要真 Anthropic key 與 MA beta 存取；會花真錢（分級） |

事件翻譯表：

| MA 事件 | nimplex 事件 |
|---|---|
| `agent.message` | `message.delta` |
| `agent.tool_use` / `agent.tool_result` | `tool.call` / `tool.result` |
| `agent.custom_tool_use` | `tool.approval_requested`（等 `user.custom_tool_result`） |
| `session.usage` | `spend.updated`（並更新 `runs.spent_usd`） |
| `session.status_idle` + `stop_reason` | `run.status`：等輸入 → `awaiting_input`；`budget_reached` → `paused(budget_exceeded)`（roadmap）或 v1 先 `killed` |
| `session.status_terminated` | `run.completed` / `run.failed`（看 session 物件分辨） |
| `session.error` | `run.failed` |

## 3. 落地順序

| 優先 | 項目 | 為什麼 |
|---|---|---|
| **P0 ✅ 2026-09-02 落地** | `claude-managed-agent` harness（§2） | 「OpenRouter for cloud agents」不含最大那家 cloud agent 是定位缺口。e2e 以假 key 走到上游 401 驗證閘道直通與 executor 路徑；真機需 org BYOK 放真 Anthropic key |
| **P0** | 事件 union + `stop_reason` 型別化，語意對齊 MA | P0 harness 本來就要翻譯事件，一次做 |
| **P1** | `paused(budget_exceeded)` + 加預算續跑 | MA 證明的產品語意；狀態機已預留邊 |
| **P1** | Webhooks `run.status_changed` | 生態普遍需求；成本低 |
| **P2** | Scheduled runs（cron） | 便宜；有需求再開 |
| **P2** | Outcomes 表 + MA grader 訊號攝取 | §7.2 護城河資料 |
| **P3** | Self-hosted environment 橋接 | 工作量大、限制多（無 vault / resource） |

## 3.1 落地時踩到的三個坑（都已修，記下來防回歸）

| 坑 | 症狀 | 修法 |
|---|---|---|
| executor setup 階段 throw 到 worker 主迴圈 | work item 標 failed 但 **run 停在 running**，SDK 無限輪詢 | executor setup 包 try → `failed`；worker 主迴圈 catch 一律 `failRun`（保護所有 harness 路徑） |
| `@anthropic-ai/sdk` 0.123 串流白名單沒有 `session.usage` | 事件被 SDK 靜默丟掉，`spent_usd` 永遠 0 | 花費以 `sessions.retrieve().usage.list_cost` 為權威：看門狗每 5s 同步 + 收尾同步 |
| **閘道閘門擋在直通分支前** | run 一被軟殺，閘道拒絕該 token 所有請求——包括 `user.interrupt` 與 `DELETE session`，硬殺到不了上游，**session 漏在 Anthropic 繼續計時** | 直通分支移到閘門前；終態 run 只放行收尾操作（GET / DELETE / 只含 `user.interrupt` 的 POST events），其餘 409 |

第三個坑是不變式 I4（「任何 worker 都能砍掉任何箱子」）在 MA 上的對應：**軟殺之後硬殺的通道不能被軟殺本身關掉**。

## 4. 要睜著眼的

- MA 是 **beta**（`managed-agents-2026-04-01`），API 會動；只跑 Anthropic 模型。
- `list_cost` 是**公開價**，不是客戶的合約價——與 gateway 實測價會有差，`metering: provider_reported` 要在 UI 講清楚。
- 撞頂語意：MA 是「暫停、可續」，nimplex v1 是「殺」——兩者要在 `stop_reason` 上區分，不能混。
- self-hosted 環境：無 vault、無 file/repo 掛載、只 Python/TS/Go SDK 有 `EnvironmentWorker`。
