# 2026-09-09 · Pi + just-bash harness：實作建議

> 歷史規劃文件。2026-09-10 的實作與驗收狀態以 [harness runtime](2026-09-10-harness-runtime.md) 為準。

本文根據目前 working tree、9/6 第 7 節定案、9/9 demo 計畫與上游文件整理。
以下是實作建議；已驗證既有 Pi spike 的假上游呼叫與 usage，正式 harness 尚未實作。
不把建議當作 Kevin 已拍板的新決策。

## 產品邊界

建議把 nimplex 做成「以 Pi 為 agent kernel、具備持久化工作區的可恢復 runtime」。
Pi 負責模型與工具的對話迴圈；just-bash 負責虛擬 shell；nimplex 負責每一步的
持久化、執行所有權、預算、取消與恢復。第一個可展示成果是 worker 死掉後，
新 worker 能從已提交的訊息與檔案繼續完成工作。

```text
SDK → API → Postgres ← worker / nimplex harness → Pi → model provider
              ↑                 ↓
       events + workspace    tool adapter
                                ↓
                    Tier 1: just-bash / private VFS
                                ↓ later
                    Tier 2: SandboxProvider
```

Tier 0 是 durable workspace。VFS 是執行中的副本，Postgres 裡已提交的版本才可
用來恢復。工具環境不繼承 worker 的 provider key 或完整 process.env。

## 現有程式碼的接點與缺口

| 位置 | 目前行為 | Pi 接入前要補的事 |
| --- | --- | --- |
| `packages/core/src/executor.ts` | `step()` 回傳整批 events、cost、next；沒有 signal 或中途 checkpoint | 定義可等待的持久化介面、AbortSignal 與每個執行邊界的責任 |
| `apps/worker/src/index.ts` | 固定呼叫 stub；lease 60 秒；結果回來才寫 events | heartbeat、失去 lease 就取消、執行期間檢查 kill、每次持久化驗 fence |
| 同上：`processStep()` | 執行後才結算，且 complete 分支先於 exceeded | 執行前預留預算；終態及 kill 的競爭以交易/CAS 決定 |
| `packages/db/src/events.ts` | 事件序號與內容分兩個 query；呼叫端可傳交易 | 關鍵提交強制放同一交易，並與 workspace/usage/checkpoint 一起提交 |
| `packages/db/src/schema.ts` | 有 runs、work_items、events、usage_records、reserved_usd | 補 workspace 版本、工具執行識別與預留/結算的去重紀錄 |
| `apps/api/src/app.ts` | 初始工作 payload 是 stub 的 `{ step: 1 }` | 改成有版本的 harness 啟動契約，讓新 worker 能正確還原 |
| `packages/testkit/src/fake-anthropic.ts` | 已有假上游 | 補腳本化工具呼叫、usage、延遲、中斷與重試情境 |

不要把整次 `agent.prompt()` 塞進目前的 `step()` 然後最後一次寫 DB。
Pi 可能跑很多輪，期間 lease 過期、取消無法傳遞、已做的檔案修改也沒有提交邊界。

## Pi 接法：先完成小型可行性試驗

目前已有 `sandbox/pi-spike/spike.ts` 與安裝好的依賴：Pi 0.85.1、just-bash 3.4.2，
四個工具的 VFS adapter 也已寫好。沿用這份試驗補驗收，再加入正式 workspace 依賴。
優先使用
`@earendil-works/pi-agent-core` 的 `Agent` 與 `pi-ai`；按需取用 coding-agent
的工具工廠，不先導入整套 CLI session、擴充載入與本機設定。

本次以假 key、明確指定 localhost base URL 執行既有 spike：假上游收到一次請求，
Pi 回傳 input=1000、output=500 的 usage。`hello.txt` 沒建立，因為目前假上游只回
文字、不發 tool calls。這證明 headless/base URL/usage 路徑可用，尚未證明四工具、
恢復或取消。輸出裡的 cost 使用 spike 的手填價格，不是實際支出或正式帳本驗證。

上游 `Agent` 支援自訂 `streamFn`、messages、sequential tools，以及會等待的
async subscribers。可用這些邊界接持久化。低階 `agentLoop()` 的 iterator
是觀察事件流，不會等你的 async consumer 完成才進入下一階段，不宜直接當 DB barrier。
[`Agent` 官方文件](https://github.com/earendil-works/pi/blob/main/packages/agent/README.md)

試驗通過條件：

1. 無 CLI、無真人 key，透過自訂 base URL 連到假 Anthropic 上游並讀取 usage。
2. 四個工具 `read/write/edit/bash` 都操作同一份 just-bash VFS，不碰 host workspace。
3. assistant 完整訊息持久化之後工具才開始；工具提交之後下一個模型請求才開始。
4. 從保存的完整 messages 建立新的 Agent 能繼續，tool call/result ID 不變。
5. `AbortSignal` 能停止 model stream 和工具；有 timeout，失敗不繼續自動呼叫模型。

`createBashTool(cwd, { operations })` 的替換點確實存在，但仍要檢查周邊行為：
目前上游 wrapper 會建立 shell env，長輸出也可能卸載到 host 暫存檔。adapter 必須
自行建立最小 env，輸出引用必須能跨 worker 讀取；必要時用自訂 AgentTool 包 just-bash。
[`BashOperations` 原始碼](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/tools/bash.ts)

## MVP 的持久化邊界

先限制同一 run 的工具循序執行。建議一次 claim 驅動至一個 Pi turn 結束，以
`shouldStopAfterTurn` 停下；turn 內仍然在模型與每個工具之間提交 checkpoint。
claim 重新領取時以持久化 phase 判斷是補做 pending tool 還是開始下一個 model call，
不能無條件重跑整個 turn。這會改變目前 work item 的語意，必須先更新 contracts/port。

1. **呼叫模型之前**：交易內驗證 org、run 狀態、lease owner/fence；建立 call ID 並預留額度。
2. **模型回應完成**：保存完整 assistant message、tool calls、provider metadata、usage，
   結算 reservation 並提交待執行的工具識別。SSE 的文字 delta 不能代替這份完整記錄。
3. **工具開始前**：記錄穩定的 tool call ID、輸入與執行狀態。
4. **工具結束後**：在一個短交易中驗 fence、workspace version 與 run 狀態，原子提交
   檔案差異、tool result、checkpoint 和下一步。不要在整段工具執行期間持有 DB 交易。
5. **繼續對話**：從已提交 log 投影 messages。assistant 留有 pending tools 時，先補齊
   對應結果，再繼續 Pi；不能只拿最後一條事件直接 `continue()`。

MVP 可用 workspace_files 整檔儲存：至少包含 org/run/path、檔案種類、內容 bytes、
必要 metadata，另有 workspace revision。每次工具使用私有 VFS，執行後 diff 整批提交。
讀取與變更都以 org 隔離；刪除、rename、空目錄、binary 與 symlink 要明訂支援範圍。
不要把 `sqlite` 寫出的 binary DB 用 UTF-8 字串保存。

這個 MVP 的真相是「已提交 event log + 同步提交的 workspace state」。若尚未保存
完整 write deltas，就不能聲稱任意歷史檔案版本都能只靠 log 重建；歷史 snapshot/replay
是之後的工作。

恢復時：

- 已有 tool result 的工具：讀回結果，不再執行。
- 純 VFS 工具執行中死亡、沒有提交：丟掉私有副本，從上一個 workspace revision 重做。
- 模型已受理但回應未保存：標記未知結果，保留 reservation；不可假設呼叫免費失敗。
- 未來真箱子或外部寫入工具結果未知：需 idempotency key 或查詢外部狀態；不能盲目重播。

因此恢復承諾是「從已提交的執行邊界繼續」，不是恰好從被殺掉的那個 token 繼續。

## 美元硬上限要先定義清楚

目前程式碼只保證步驟後停止；例如餘額 $0.01，下一步花 $0.12，結算時已經超額。
最後一步又可能先走 completed。現有 stub 驗收不能證明真 LLM 的硬上限。

建議第一版只支援能計算保守價格上界的模型與計費項目：

- 原子計算 `available = budget - settled - reserved`。
- 每次送出前預留輸入成本上界、輸出上限與適用的其他收費；依額度限制 max output tokens。
- 若無法給出輸入/其他費用的保守上界，就不宣稱該模型有嚴格成本保證。
- 以 call ID 去重結算；重試也必須有自己的 reservation，避免 SDK 隱藏重試繞過預算。
- crash 或取消不代表 provider 沒收費；結果未知的 reservation 不直接釋放，先 reconciliation。
- 超額、使用者 kill、正常完成都必須在同一終態協調規則下判定，避免互相覆寫。

這裡保證的範圍先是支援模型的 LLM 成本。真箱子的存活費、儲存與網路成本若未納入，
UI/文件須清楚標示。USD 精度、進位與安全餘量也要一致。

## just-bash 與後續升級

just-bash 提供可替換 FS、執行資源上限與可選網路，但完整 native binary 執行仍需
真正的 sandbox。依固定版本確認限制參數並實測取消；MVP 先關閉網路與額外執行器。
[`just-bash` 官方文件](https://github.com/vercel-labs/just-bash/blob/main/packages/just-bash/README.md)

9/6 的「先試 Tier 1，失敗再升 Tier 2」應修正為**執行前路由**。例如：

```bash
echo one >> a.txt; npm test
```

若先執行前半段，再把整句丟進真箱子，`one` 會被寫兩次。Slice 2 應在執行前
保守判斷整段指令的能力需求；無法判斷的動態 shell 直接走已授權的真箱子或回傳
明確的不支援結果。不能僅憑 exit code 非零就升級。能力路由也不能取代 sandbox 邊界。

同步先做單一 writer 與明確 checkpoint，包含 dirty/untracked/deleted/binary 檔案；
只做 git commit/checkout 不足以代表整份工作區。generation 表示執行環境替換，
workspace revision 表示檔案版本，兩者分開。

## 交付順序與驗收

| 順序 | 交付 | 必須通過 |
| --- | --- | --- |
| 1 | Pi adapter 試驗，固定版本 | 假上游、四工具、usage、async barrier、重建 messages、取消 |
| 2 | durable workspace + just-bash | write/delete/rename/binary 後重建一致；提交前 crash 不留半套檔案 |
| 3 | worker + checkpoint + budget | heartbeat；lease 被接管後舊 worker 寫入被拒；reservation/settle 去重 |
| 4 | 自動 crash demo | 工具前、執行中、提交後各 kill 一次，append 不重複；SSE 續傳；低預算不發出付不起的 call |
| 5 | Slice 2 真箱子 | 執行前路由、檔案同步、generation、environment.reset |
| 6 | Slice 3 context 管理 | compaction checkpoint、原始訊息/工具輸出歸檔、分頁讀取 |

對 9/14 demo，集中做前四項。第一個任務應可自動展示：建立並修改檔案 → worker
被 kill -9 → 另一個 worker 接手 → 完成且檔案不重複、事件不丟失、預算帳本一致。
模型呼叫未知結果的成本情境另外注入故障驗證，不能只在安全時機殺 worker 就宣稱全面恢復。

正式程式碼先放 `apps/worker/src/harness/`，ports 和純投影函式放 core，持久化放 db，
事件 schema 放 contracts；等有第二個真正使用者再拆 `packages/harness`。

## Codex 專案設定

已建立根目錄 `AGENTS.md` 與 `.codex/config.toml`。AGENTS 明確讀取共用 CLAUDE.md
及其參考文件；模型、權限與憑證沿用個人設定。既有 `.agents/skills` 已是 Codex 原生
位置，無需再複製。Claude 專案沒有 MCP、hooks、自訂 agents 或 commands 可遷移。
Codex review 不冒充原專案規定的 Opus commit 前 review。
