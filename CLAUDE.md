# nimplex

開源、可自架的 coding agent 雲端 runtime：run 不會因為 worker 或箱子死掉而死、錢有美元硬上限、隨時殺得掉。2026-09-06 起 harness 自己寫、跑在 worker（loop-outside）；工具面 just-bash 第一層、真箱子第二層；append-only run events 是 runtime 的唯一真相。

@docs/file-structure.md
@docs/tech-stack.md

## 必讀文件

- 怎麼跑起來／服務拓撲／e2e 驗收：`docs/product/2026-09-01-local-dev-runbook.md`
- 架構切分與不變式（三平面不互相呼叫、錢的路徑）：`docs/product/2026-09-01-architecture.md`
- SDK 分層與事件契約定案：`docs/product/2026-09-01-sdk-architecture.md`

## 鐵則

- `packages/contracts` 是唯一真理來源；改 API 形狀先改 contracts。
- **沒有 `/internal`**：任何前端或工具都只 import `@nimplex/sdk`，能做的事＝客戶能做的事。
- api / worker 之間**不互相呼叫**，只透過 Postgres 的 run 狀態機協調。
- 每句 DB query 都要帶 `org_id` 過濾（租戶隔離在 app 層，沒有 RLS）。
- 使用者的真 provider key 永不離開信任區 A（api / worker）；沙箱裡永遠沒有它。
- 文件一律 Markdown（HTML 僅供示意展示）。
- `docs/competitor-analyze/` 與 `sandbox/` 是 gitignored——絕不 commit；第三方工具試玩放 `sandbox/`。
- Commit message 不帶 AI attribution trailer（commit-msg hook 會擋）。
- **程式碼註解、commit message、設定檔註解（Dockerfile / compose / workflow / .env.example）一律用 plain English**（2026-09-03 起）；既有中文註解碰到再改，`docs/product/` 的文件維持中文。

## 改完程式碼後：一律跑 code review

- 每次修改程式碼（含新增檔案、改 contracts / schema / migration）之後、commit 之前，**必跑 `/code-review medium`**；碰到錢的路徑（budget、記帳、run 狀態機）或改動範圍大時升到 `high`。
- Review **一律用 Opus 跑**。`/code-review` 沒有 `--model` 旗標，模型跟著 session 走：session 不是 Opus 時，跑 review 前先提醒 Kevin `/model opus` 再執行。
- 有 findings 先修完再 commit，不可只回報不修；修完若改動不小，再跑一次確認。
