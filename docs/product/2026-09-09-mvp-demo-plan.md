# 2026-09-09 · MVP demo 衝刺計畫（deadline 2026-09-14 週一）

> 此為 9/9 的歷史進度與 demo 排程；現行實作與驗收見 [2026-09-10 harness runtime](2026-09-10-harness-runtime.md)。

> Kevin 2026-09-09 指示：下週一（9/14）前至少要有一個 MVP demo。本文是 5 天的切法（Kevin 的工作窗是 12:00 到最晚 02:00；主時段從 12:00 起排，每天再加一段 21:00–01:00 的 buffer）；行事曆已同步（每個時段一個事件，標題前綴 `nimplex MVP D-n`）。
> 範圍＝ `2026-09-06-harness-on-just-bash.md` 第 7 節的 **Slice 1**：Tier 0 + Tier 1 + Pi loop-outside + 日記在家，demo 是 `kill -9` worker 之後 run 接著跑完、錢停在上限。

## Demo 劇本（驗收標準）

```
1. POST /v1/runs：instructions「在 /workspace 建 hello.txt 寫入日期，再 grep 它」，budget_usd 0.20
2. 事件流開始滾：run.started → model.call → tool.call(write) → tool.result → …
3. 第 2 個 model.call 後 kill -9 worker
4. 起另一個 worker：60 秒內重領（lease 過期），從 run_events 重建 Pi 訊息、從 Tier 0 重建檔案
5. run 跑到 completed；GET /v1/runs/:id 顯示 spent_usd ≤ 0.20；Tier 0 裡有 hello.txt
6. 同一支腳本改 budget_usd 0.01 → killed(budget_exceeded)
```

無 key 模式（假上游）與真 key（Haiku）都要能跑；現場 demo 用真 key。

## 進度（2026-09-09 更新）

**D-5 當天 Slice 1 全部落地並通過驗收劇本**（原排到 D-3）：

- 決策閘：Pi `Agent` headless、`createBashTool(cwd,{operations})` 接 just-bash VFS、BYOK `base_url` 指假上游、usage 從 `message_end` 拿——四項 30 分鐘內全通（`sandbox/pi-spike/spike.ts`、`spike2.ts` 含 clean / dirty resume 兩種情境）。**定案：Pi 當 kernel。**
- Tier 0：`workspace_files`（bytea，migration 0007）+ `loadWorkspace` / `saveWorkspace`（差異寫回），與該 turn 的 events 同一個 transaction。
- Tier 1：`apps/worker/src/pi-executor.ts`——一個 work item ＝ 一個 turn；從 `run_events` 投影 Pi 訊息（`model.call.message` + `tool.result`），just-bash VFS 從 Tier 0 seed；事件 `model.call` / `message.delta` / `tool.call` / `tool.result` / `file.changed` / `spend.updated` / `run.resumed`。
- worker：lease heartbeat（20s 延一次，掉 lease 或 run 已終態就 abort 進行中的 model call）；stub executor 刪除。
- API / SDK：`GET /v1/runs/:id/files`、`GET /v1/runs/:id/file?path=`（Tier 0 對外可讀）；SDK `runs.files()` / `runs.readFile()`。
- testkit 假上游：`toolCalls`（腳本化 bash tool_use 序列，無狀態）、`delayMs`。
- `examples/quickstart/src/demo-kill.ts`：自動化整段劇本。**無 key 與真 key（Haiku）都過**：kill -9 worker A 後 worker B 在 lease 到期內 `run.resumed`，log 恰好 5 次 `model.call`、Tier 0 有 4 個檔／`hello.txt`，花費 $0.0175 / $0.006 ≤ $0.20。
- 尚未做：Opus code review、commit（含 09-06 的刪減）；README demo 段；錄影。

## 日程

| 日 | 時段 | 交付 | 完成判準 |
|---|---|---|---|
| 週三 9/9（D-5） | 12:00–15:00 | Opus `/code-review high` 09-06 的刪減，修完 commit | commit 落地 |
| | 17:00–21:00（15:30 有專題 meeting） | 在 `sandbox/` 試 Pi 當 library：`Agent` headless、`createBashTool(cwd,{operations})` 接自訂實作、BYOK base_url、usage 從事件拿得到 | **決策閘**：3 小時內四項都通就用 Pi，否則改自寫 ~200 行 loop（`@anthropic-ai/sdk` + bash/read/write/edit 四個工具） |
| | 21:30–01:00 | buffer：Pi 試探收尾，或提早開 Tier 0 | — |
| 週四 9/10（D-4） | 12:00–15:00 | Tier 0：`workspace_files` 表 + migration；`Workspace.load(runId)` / `save()`；write-through | 單測：寫 → 重新 load → 內容一致 |
| | 16:00–20:00 | Tier 1：just-bash `Bash({ files })` 掛 Tier 0；Pi remote ops（read/write/edit/bash/grep/find/ls）指向它；exec 後 diff 回寫 | 單測：`echo x > a; cat a` 跨兩個 Bash 實例一致 |
| | 21:00–01:00 | buffer：Tier 0 + Tier 1 收尾 | 兩個單測綠 |
| 週五 9/11（D-3） | 12:00–15:00 | worker `piExecutor`：Pi 事件 → `run_events`；每次 model call 用 usage × 價目表記 `usage_records`、更新 `spent_usd`；超額即 kill | e2e：budget 0.01 → killed |
| | 16:00–20:00 | resume from log：lease 重領時從 `run_events` 重建 Pi messages、從 Tier 0 重建檔案；懸空 tool call 標 interrupted 讓模型繼續 | 手動 kill -9 一次跑通 |
| | 21:00–01:00 | buffer：kill -9 跑通為止 | 手動 kill -9 一次跑通 |
| 週六 9/12（D-2） | 19:00–01:00（白天 Cake 就博會） | testkit 假上游加「腳本化 tool_use 序列」；`examples/quickstart/src/demo-kill.ts` 自動化整段劇本 | `demo-kill.ts` 無 key 全過 |
| 週日 9/13（D-1） | 12:00–15:00 | Opus review、修完 commit；README 加 demo 段 | commit 落地 |
| | 17:00–20:00 | 真 key（Haiku）彩排、錄 asciinema / GIF、buffer | 錄影檔在手 |
| | 21:00–01:00 | 最後 buffer：乾淨 DB 再跑一次 demo 劇本，之後不動 code | — |
| 週一 9/14 | 13:20–15:10 有課 | **Demo** | — |

主時段約 24 小時，加 buffer 約 40 小時。

## 刻意不做（MVP 之後）

- Tier 2 真箱子升級、git 同步、generation（Slice 2）
- compaction checkpoint、tool result 卸載（Slice 3）
- `npx nimplex dev` 單程序
- 部署到 dev droplet（demo 在本機跑）
- Tier 0 的 write 事件重放；MVP 直接 write-through 存整檔（ponytail：小工作區夠用，大 repo 再換 snapshot + replay）

## 風險

1. **Pi 的 library 介面**：文件說 `createBashTool(cwd,{operations})` 存在，但 headless 驅動 + 換 base_url + 拿 usage 沒實測。週三晚上的決策閘就是為這個。
2. **just-bash 改動偵測**：沒有 change hook，MVP 用 exec 後全樹 diff；工作區大就慢，先記 `ponytail:` 上限。
3. **週六幾乎整天不在**：只剩晚上 4 小時，所以 e2e 與 demo 腳本排那天，屬於可壓縮的工作。
