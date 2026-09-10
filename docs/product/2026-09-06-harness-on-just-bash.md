# 2026-09-06 · harness 建在 just-bash 上：調研結論與定案前提

> 承接 memory 的 09-06 修訂（開源可自架 coding agent 雲端 runtime）。本日 Kevin 提出：專案切換為「自己做一個 harness，搭在 just-bash 上，目標是最完善的 cloud agent harness 系統，比 Vercel 的 just-bash 方案多做 sandbox resume 管理，並參考 Apache Maka 的 log-is-the-runtime」。
> 本文回答六個問題，並記錄同日完成的程式碼刪減。**定案項目待 Kevin 拍板**，見文末。

---

## 1. just-bash 是不是「已被探索出的最優環境」？

**不是最優解，是分層設計裡最便宜的那一層。** 證據全部來自第一手：

- **Vercel 自己的定位**：`@ai-sdk/sandbox-just-bash` 標 experimental，README 明講「This provider does not expose ports, so it cannot be used with features that require actual network sandboxes」；just-bash README 的 Security Model 最後一條是「Use Vercel Sandbox if you need a full VM with arbitrary binary execution」；`Sandbox` 相容 API 的說明是「Start with just-bash for development and testing, swap in a real sandbox when you need a full VM」。`@ai-sdk/harness-pi` 文件把 `sandbox-vercel` 與 `sandbox-just-bash` 當可互換的兩個後端。
- **做得到**：60+ 指令（`grep/rg/sed/awk/jq/sqlite3/yq/xan/tar/gzip/curl`）、bash 語法（pipe、redirect、function、loop）、四種 FS（`InMemoryFs` / `OverlayFs` / `ReadWriteFs` / `MountableFs`）、可選 `python3`（CPython → WASM）與 `js-exec`（QuickJS），`defineCommand` 自訂指令、`AbortSignal` 取消、執行上限（`executionLimits`）。版本 3.4.2，仍標 beta；4.2k 星、每日 commit、主要由 Vercel CTO cramforce 維護。
- **做不到**：原生 binary、`npm install` / `pip install`、開 port、真程序；**沒有 `git`**（issue #83，維護者回「I heard it is very slow, but otherwise yes. Want to give it a go?」，社群另做了 `just-git` shim）；Python 在瀏覽器版不可用（#121）。
- **沒有的、而你要做的**：README 對 VFS 的 snapshot / serialize / persist 隻字未提——InMemoryFs 隨程序死。要「跨 worker resume」就得自己把檔案樹持久化。
- **社群**（HN 「Just-bash: Bash for Agents」124 分 69 則）：simonw 支持 bash 介面因「訓練資料最多，小模型也行」；resonious 指出 agent 常在 quoting/escaping 上浪費 token；真正上線的使用者 cjbell88（Elixir 移植）說「in-memory 換來瞬間啟動與零同步問題，但若要給 agent 真 Python 大概得換真箱子，介面已解耦讓換得便宜」。Reddit 無實質討論串。

**對 coding agent 的結論**：探索、讀碼、改檔、跑 jq/sqlite 這類資料處理在 VFS 內即可；build / test / install 一定要升級到真箱子。**完整方案 = just-bash 第一層 + 真箱子第二層 + 兩層共用一份工作區（git 同步）**。單層 just-bash 不是完整方案，Vercel 自己也沒把它當完整方案賣。

## 2. 誰在做這件事

| 誰 | 東西 | 架構 | 狀態 / resume |
|---|---|---|---|
| **Cloudflare** | **Project Think**（2026-04 Agents Week；roadmap 在 cloudflare/agents #1439）。Kevin 記的「project think」就是它 | 「execution ladder」：**Tier 0 durable VFS（SQLite + R2）** → Tier 1 Dynamic Worker（V8 isolate 內跑 LLM 生成的 JS，即 Code Mode）→ Tier 2 npm → Tier 3 headless browser → **Tier 4 full Sandbox（真容器，與 Tier 0 工作區雙向同步）** | Tier 0 就是「持久化的工作區」；沒有 bash 模擬器，綁 CF 平台 |
| **Vercel** | just-bash、bash-tool（AI SDK tool）、`@ai-sdk/harness-pi`、`@ai-sdk/sandbox-{just-bash,vercel}`、eve（durable agent framework） | Pi 在 host 程序跑，sandbox 只當遠端 FS + shell（`PiRemoteOps` 九個方法：`paths/readBuffer/writeFile/editFile/listDirectory/findFiles/grepFiles/access/exec`） | `pi-resume-state.ts` 把 Pi 的 session `.jsonl` **複製進箱子**私有目錄，換箱時拉回；`HarnessV1Session` 有 `doSuspendTurn / doDetach / doStop / doDestroy` |
| **Apache Maka**（incubating） | 本機優先的 agent workspace（Electron + TUI + CLI 都是 Runtime Host 的薄客戶端）；發起人 jackwener（Arrow/DataFusion/Doris PMC），非公司捐贈 | 工具跑在本機程序，靠 Seatbelt / bubblewrap / AppContainer 限制 | **只做 log**：`runtime_events`（SQLite，`event_seq`、`highWater`、digest）、compaction checkpoint、`ContextOffloadStore`；**工作區快照（Phase 4）未實作**，`.maka-workspace.json` 只存 UUID 證明「同一個工作區」，不證明檔案內容 |
| Anthropic Managed Agents | 託管 | Session＝durable event log、Harness 無狀態、Sandbox 不信任、無憑證 | session 撐過 harness/container 死亡 |
| OpenAI Codex cloud | 託管、closed | 每 task 一個 microVM，loop 在 OpenAI 端 | — |
| microVM 廠 | E2B、Fly Sprites、Blaxel、Runloop、Morph、Daytona | 真 VM，比的是 snapshot / pause / resume 速度 | E2B pause 1s resume；Sprites 閒置睡、~$0；Blaxel <25ms 喚醒 |
| 其他 | Omnara（自稱 open-source alternative to Managed Agents）、Pi / oh-my-pi / OpenClaw、WASM 類（wasmer/WASIX、v86、Runno、Conch） | — | — |

**看板上的縫**：Cloudflare 的 Tier 0（durable VFS）+ Tier 4（雙向同步的真箱子）正是 Kevin 要的「sandbox resume 管理」的形狀，但綁 CF；Vercel 有分層卻沒有 durable VFS、日記在箱子裡；Maka 有日記卻沒有世界狀態。**三者的交集——日記在家 + VFS 快照 + 分層升級——目前沒有開源可自架的實作。**

## 3. Maka 的〈Log Is the Runtime〉

已記入 memory（reference）與本文。三句話：

1. `State(n) = Apply(Snapshot(k), Log[k+1..n])`——agent 狀態是 append-only `RuntimeEvent` log 的**投影**，UI、下一次 model context、終態判定、crash recovery 各自是同一份 log 的不同投影函式。
2. compaction 只改「模型怎麼讀 log」不改 log；checkpoint 記 `highWater` + digest，丟了可重算。
3. 大 tool result 走「先歸檔、再換 placeholder」，模型要細節再分頁讀；log 永遠留原文。

對 nimplex 的意義：這正是 `run_events`（Postgres、seq 游標、SSE 續傳）已經有的骨架；缺的是投影函式（context 重建、continuation）與 Maka 明說沒做的部分——**世界狀態**。這就是第 4 節。

## 4. 比 Vercel 的 just-bash 方案多做什麼

| 能力 | Vercel（harness-pi + sandbox-just-bash） | nimplex 要做 |
|---|---|---|
| 日記在哪 | `.jsonl` 複製進箱子；箱子死＝日記跟著死 | **日記在家**：Postgres `run_events`，箱子可丟 |
| VFS 持久化 | 無（InMemoryFs 隨程序死） | **VFS 快照**（generation k）+ log 重放；`sandbox_generation` 進每條事件 |
| 分層 | just-bash / Vercel Sandbox 二選一 | **tiered**：VFS 第一層，需要 build/test 才開真箱子，工作區用 git 同步 |
| 環境丟失 | 無兜底 | 三層：`provider.resume` → 快照/pause → `environment.reset` 進 model context |
| 錢 | 無 | per-run USD 硬上限 + mid-run kill（已有） |
| 事件續傳 | 無 | SSE `Last-Event-ID`（已有） |
| 大輸出 | 無 | Maka 式 tool-result offload（placeholder + 分頁讀） |

## 5. 要不要建在 Pi 上

**建議：用 Pi 當 loop kernel，不 fork、不自寫 loop。** 理由：

- Pi 已搬到 `@earendil-works/*`（0.85.1，2026-09-05 發）、MIT、約 10 萬星、每日更新。`pi-agent-core` 的 `Agent` class 可在自己的程序內驅動（`streamFn / convertToLlm / beforeToolCall / afterToolCall`），事件流完整；`agentLoop` / `agentLoopContinue` 是更低階的 generator。
- **正式掛點就是為這件事設計的**：`createBashTool(cwd, { operations })`、`createReadTool(cwd, { operations })` 等，型別化的 `BashOperations / ReadOperations / EditOperations / GrepOperations / FindOperations / LsOperations`；官方 containerization 文件的 Gondolin 範例就是「Pi 在 host、工具進 micro-VM」。Vercel `harness-pi` 的 `PiRemoteOps` 照抄形狀、把後端換成 nimplex 的分層即可。
- compaction（`session_before_compact` 可自訂摘要器）、session `.jsonl`（tree、`SessionManager.inMemory(cwd?)`）都現成。

反方與對策：

- Pi 的 session 格式與事件是 Pi 的，不是 nimplex 的 log → 做「Pi events → `run_events`」翻譯層（與之前 `managed-agent.ts` 同構），日記仍在家；Pi 重啟時用 `SessionManager.inMemory` 從 `run_events` 投影回 Pi 的 entries。
- 若要 Maka 級的 context 投影（compaction checkpoint 帶 digest、tool result prune）：先用 Pi 的掛鉤做，真不夠再自寫——不要一開始就自寫 loop。

## 6. 本日已刪什麼、留什麼

**刪（`git rm`，已 stage 未 commit；歷史在 `0f32657`）**：`apps/runtime`（CF 原型）、`apps/console`（管理台）、`packages/gateway`（`/gw` BYOK 代理、reserve/settle 帳本）、CLI-in-box harness 路徑（`harness-executor.ts`、`core/harness.ts`、`builtin-harnesses.ts`、`gateway-urls.ts`、`api/harnesses.ts`、`db/harness-registry.ts`、`bootstrap.ts`、`seed.ts`）、Managed Agents 路徑（`managed-agent-executor.ts`、`core/managed-agent.ts`）、tool registry（`api/registries.ts`、skills / mcp_servers）、usage rollup（`api/usage.ts`）、`examples/quickstart/src/claude-code-e2b.ts`。DB：migration `0006` drop `harnesses / managed_agent_refs / skills / mcp_servers / credential_refs` 五張表與 `runs.{harness,metering,run_token_hash,sandbox_token_hash}`。contracts：拿掉 harness manifest、metering、usage、skills、mcp；`budget_usd` 改必填。

**留**：api（auth、org / api key / member、BYOK provider key、runs、SSE）、worker（lease+fence、預算硬上限、kill、reaper、stub executor）、contracts、core（budget / pricing / status / duration / sandbox port / RunExecutor / shellQuote）、db、sandbox（docker / e2b / computesdk / local + conformance）、sdk、testkit（假 Messages API 上游 + conformance kit）、deploy / Dockerfile / workflow、**apps/site**（沒刪：nimplex.dev 從這個 repo 的 `apps/site` 部署，刪了 Vercel build 會壞——要不要留是 Kevin 的決定）。

**驗證**：`pnpm check` 10/10、`pnpm test` 31 passed、`pnpm lint` 乾淨、e2e 冒煙（註冊 → 發 key → BYOK → 跑完 $0.60 → 預算殺 $0.36 → budget_usd 必填 → 租戶隔離 → 撤銷 401）全過。程式碼從 13.3k 行降到 5.6k 行。

## 待 Kevin 定案

1. Pi 當 kernel（第 5 節建議）還是自寫 loop。→ **2026-09-09 定案：Pi 當 kernel**（Kevin 當日指示「在 Pi 上搭 just-bash harness」；決策閘四項在 `sandbox/pi-spike/` 30 分鐘內全通，Slice 1 同日落地，見 `2026-09-09-mvp-demo-plan.md`）。
2. `apps/site` 留在 repo 還是搬走。
3. `end_users` 表與 `runs.end_user_id` 仍在（09-01 已降級為歸因標籤）；要不要順手改成 `runs.external_user_id text`。
4. 第一週交付物是否維持 memory 的順序：`mode: box` + 日記在家 + kill → generation + `environment.reset` + pause/resume → tiered（just-bash 第一層）。

---

## 7. 定案：走 ladder（Kevin，2026-09-06）

Kevin 拍板採用 Cloudflare Project Think 的 execution ladder 模式。nimplex 的階梯照「這一步需要什麼能力」排，每層都要能自架：

| 層 | 後端 | 做什麼 | 成本 |
|---|---|---|---|
| **Tier 0 · durable workspace** | Postgres 檔案樹快照 + `run_events` 裡的 write/edit 事件；`Files(n) = Apply(Snapshot(k), Writes[k+1..n])` | 檔案的唯一真相，永遠存在 | 零 |
| **Tier 1 · just-bash** | worker 程序內，FS 掛在 Tier 0 上 | read / grep / edit / jq / sqlite / awk，可選 QuickJS、CPython-WASM | 零、毫秒 |
| **Tier 2 · 真箱子** | 現有 `SandboxProvider` port（docker+gVisor 自架、E2B / Sprites / Blaxel 雲端） | git、npm / pip、build、test、網路；惰性開箱、用完 pause；git 與 Tier 0 同步；每次開箱 `generation+1` | 用到才付 |

CF 的 npm 層與 browser 層 v1 不做。

不變式：
1. **Tier 0 是真相，箱子是快取**：箱子死只丟可重建物（`node_modules` 靠 prebuild image 補），檔案從 Tier 0 重放。
2. **升級由 runtime 決定，不由模型決定**：每個 bash 呼叫先試 Tier 1；不支援的指令、明確清單（git / npm / node / make / 非白名單 curl）或需要網路才升 Tier 2，並寫 `tier.escalated` 事件。

交付順序改為：
- **Slice 1**：Tier 0 快照表 + just-bash 掛 Tier 0 + Pi remote ops → Pi events 翻成 `run_events` → `kill -9` worker 後另一個 worker 從最後一條事件接著跑（不需任何 sandbox provider）。
- **Slice 2**：Tier 2 升級路徑（接現有 docker / E2B）、git 同步、generation、`environment.reset`。
- **Slice 3**：Maka 式投影：compaction checkpoint 帶 digest、大 tool result 卸載。
