# 2026-09-10 · Pi + just-bash harness：實作與驗收

這份文件描述 working tree 已落地的 runtime，取代 9/9 的實作建議。Pi 負責模型與工具迴圈；nimplex 負責持久化、執行所有權、費用、取消及恢復。

## 執行路徑

```text
SDK → API → Postgres ← worker → Pi → Anthropic
                ↑          ↓
        events / workspace / model_calls
                           ↓
                 read / write / edit / bash
                           ↓
             just-bash VFS 或隔離 native sandbox
```

API 和 worker 只透過 Postgres 協調。provider key 留在 API/worker 的信任區，工具不繼承 worker 的環境變數。四工具共用 `/workspace`；另外提供 `read_output`、`read_log` 查詢持久化原始輸出。

## 提交與恢復契約

一個 work item 驅動一個 Pi turn，turn 內有多個可等待的提交邊界：

| 邊界 | 原子寫入 | crash 後 |
| --- | --- | --- |
| 模型發送前 | call ID、`model_calls` reservation、`reserved_usd`、`model.reserved` | 已預留但無回應的呼叫列為 unknown，保留額度 |
| 模型回應完成 | 完整 assistant message、tool calls、usage、費用結算、`model.call` | 沿用已保存的模型回應，先補 pending tools |
| 每個工具完成 | tool result、檔案 bytes 差異、完整 metadata、workspace revision | 已提交的工具跳過；純 VFS 未提交副本丟棄重做 |
| turn 結束 | work item 結束與下一個工作，或 run 終態 | 不重複排程、不覆寫已存在的 kill/終態 |

每次寫入均驗 lease owner、fence、未過期 lease 與 org。工具循序執行，模型訊息先提交、工具結果與 workspace 一起提交。過期 worker 的結果不能寫回；heartbeat 發現 lease 丟失或 run 終止便中止執行。

事件序號分配與事件 insert 在同一交易，SSE 可從 `after` / `Last-Event-ID` 續傳。`file.changed` 歸檔保存 base64 bytes 與 SHA-256，`workspace.committed` 保存 metadata；當前檔案投影可直接從 DB 讀取。一般 transcript / SSE 只帶檔案 hash 與 metadata，避免每輪重新傳輸 binary；需要原始 delta 時可透過 `read_log` 分頁讀取。

## 費用與取消

- 第一版支援已知價格的 Anthropic 模型；未知價格在發送前拒絕。
- 每次請求依實際序列化 payload 的 UTF-8 bytes 加 4096 framing allowance 計算保守輸入上界，並在可用額度內限制 `max_tokens`（最多 4096）。
- 可用額度為 `budget - spent - reserved`；不足時不發付費請求。保守上界可能高於實際 token 數，因此即使已花費金額低於上限，也可能因無法預留下一個請求而停止。以 micro-USD 向上進位，call ID 去重結算。
- 關閉 SDK 隱藏 retries、prompt cache 與額外付費 server tools。若 provider 回報費用超出 reservation，保留真實費用並令 run 失敗，不掩蓋超額。
- 回應達到 output limit 時，在剩餘預算內接續；截斷的 tool call 不執行，回報工具錯誤讓模型拆成較小步驟。
- 回應丟失不代表免費：錯誤／中斷回應記為 `model.unknown`，不冒充完成的 `model.call`；unknown 的未結算 reservation 保留，不會自動釋放。目前未實作 provider 帳單 reconciliation。
- `budget_usd` 範圍是模型費用；E2B、Docker、儲存與網路費用另計。價格表與輸入上界是此保證的前提。
- kill 與 duration cap 經 heartbeat 取消模型/工具，已寫入的終態不被晚到回應覆寫。terminal sandbox 由 worker reaper 回收；預設間隔 10 秒。

## Tier 0 / Tier 1 / native

Tier 0 是 Postgres 的 durable workspace。每個工具使用 Tier 1 私有 just-bash VFS，成功提交後才成為可恢復版本。

支援一般檔案（含 binary）、刪除、rename、空目錄、workspace 內 symlink、mode bits。限制為 2000 個 entry、32 MiB（含 metadata）。不保存 hard link 關係、socket 或 device；`node_modules` 是 native 環境內的可重建快取。

bash 先解析完整 AST。遇到 native binary 或動態命令，整段 script 執行前路由至設定的 sandbox；不在執行半段 shell 後重播整句。未設定隔離 sandbox 時回傳明確工具錯誤，native 不會直接跑在 worker host。

E2B / Docker 的 native 命令由箱內 supervisor 執行，journal 以 run ID + tool call ID 定址；重連會收集同一份結果。worker 在 command 執行中死亡，不需要重複 side effect。E2B 在工具之間 pause，下一次 connect/resume；生命周期操作前後驗證 lease，provider IO 不佔住 DB row lock，讓 kill/cancel 保持可用。只有已持久化的終態允許刪箱，舊 worker 不能砍掉接管者的箱子；晚到的 pause 可透過 reconnect 恢復同一 journal。

只有 provider 明確表示環境不存在時才重建。新環境增加 `sandbox_generation`、發出 `environment.reset`，並從 Tier 0 還原。若遺失的是已 dispatch、尚未保存結果的命令，其外部副作用屬於未知結果，回傳明確錯誤，不盲目重跑。這不是任意外部系統的 exactly-once 保證。

Supervisor 接受工具 timeout（最多 120 秒），到期只停止該指令的 process group，保留箱子與 native 快取，並保存工作區結果。journal 是不可信資料，worker 對型別、路徑、檔案數、大小另行驗證。

## Context

較長的歷史會形成有版本的 extractive checkpoint：保留初始 prompt、近期完整 assistant/tool pairs，摘錄較早內容。這不是額外模型生成的摘要，不產生摘要模型費用。

checkpoint 保存 high-water event 序號及 canonical JSON SHA-256 digest（針對帶檔案 hash、移除 binary bytes 的事件投影）；恢復時驗 digest，損壞的 checkpoint 忽略並從 log 投影。原始事件不刪除。模型通常只看工具輸出的前 12000 字元，可用 `read_output(tool_call_id, offset, limit)` 或 `read_log(event:<seq>, offset, limit)` 分頁取得其餘內容。

## 開發與驗收

先啟動本機 Postgres，再安裝依賴：

```bash
docker compose up -d postgres
pnpm install
pnpm db:migrate
pnpm check
pnpm lint
pnpm test
pnpm e2e
```

`pnpm e2e` 自動建立臨時 DB、migration、API、worker、fake Anthropic，結束時清理自己的程序與 DB。預設連 `localhost:5433`；可用 `NIMPLEX_TEST_POSTGRES_URL` 指定具備 CREATE DATABASE 權限的測試 Postgres。不要將它設為正式 DB。

雲端驗收使用根目錄 `.env` 的 `E2B_API_KEY`；真實模型模式另需 `ANTHROPIC_API_KEY`：

```bash
pnpm e2e:e2b
pnpm e2e:real
node --env-file=.env node_modules/vitest/vitest.mjs run packages/sandbox/src/conformance.test.ts -t e2b
```

費用與故障注入仍使用 fake model；`e2e:real` 額外讓 Haiku 經 Pi 在 E2B 執行 Node 寫檔，再讀回驗證。雲端測試會建立付費 sandbox，結束時清理其自身資源。

目前驗收涵蓋四工具、binary/rename/delete、SSE 連續與續傳、tenant 隔離、context 與輸出分頁、截斷回應接續、零額度不發 call、途中額度不足、模型期間 SIGKILL、同一回應多工具的 VFS 中途 crash、context 壓縮後 crash、unknown reservation、kill、duration cap、cancel 與完成競爭、SIGSTOP lease takeover，以及真 E2B 的 native 執行、pause/resume、環境重建、native lease takeover、timeout 保留快取、API kill 中止 native 工具。2026-09-10 的真 Haiku + E2B 功能測試成功，該次模型費用 $0.006898；E2B conformance 12 項通過。`pnpm check`、`pnpm lint` 全過；`pnpm test` 為 55 passed / 36 skipped（未設定的 provider）。本機開發 DB 已套用 0008、0009。

## Migration 與設定

- `0008_supreme_korvac.sql`：新增 `model_calls` 與 workspace revision / sandbox generation。
- `0009_long_carmella_unuscione.sql`：新增 workspace metadata。
- 兩者為 additive migration，接在現有 `0007` 之後；舊版本的變更由其各自 migration 管理。
- `NIMPLEX_LEASE_SECONDS`：預設 60，最小 3；驗收用 3 秒加快故障恢復。
- `NIMPLEX_CONTEXT_CHARS`：歷史 JSON 的 UTF-8 byte 門檻，預設 64000；保留既有環境變數名稱。
- `.codex/config.toml` 與 `AGENTS.md` 提供 Codex 專案設定，共用 `CLAUDE.md` 架構指引和 `.agents/skills`。

## Review 記錄

已執行 Opus high review 與修正後複查。有效 findings 包含 cancel 終態競爭、SSE 斷線輪詢、native timeout、pause/delete 的 DB lock 範圍、pause 失敗遺失結果、工具參數說明、截斷回應接續與未知模型結果記錄；均已修正，並補上截斷回應、取消競爭與 sandbox lifecycle 的故障驗證。

unknown reservation 保留額度：worker 沒收到或沒保存回應時，provider 仍可能已計費。Pi 0.85.1 的 `failToolCallsFromTruncatedMessage` 會拒絕 live turn 的截斷工具，恢復路徑也有相同處理；live turn 已以 E2E 驗證。保守 input 上界、終態後不再發新請求，以及 lifecycle 操作前的 lease 檢查，均保留其原本責任。

測試專用的 `examples/quickstart/src/pause-fault.ts` 透過 Node preload 注入失敗／延遲的 E2B pause，正式 worker 不會載入它。pause 失敗只記錄 `sandbox.pause_failed`，已完成的工具結果照常提交；慢 pause 期間 API kill 仍能立即更新 run 終態。
