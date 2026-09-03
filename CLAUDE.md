# nimplex

**OpenRouter for cloud agents**：一把 key、一個統一 API 面，跑任何 harness × 任何 sandbox × 自己的 model key，配 per-run 美元硬上限 + mid-run kill。

@docs/file-structure.md
@docs/tech-stack.md

## 必讀文件

- 怎麼跑起來／服務拓撲／e2e 驗收：`docs/product/2026-09-01-local-dev-runbook.md`
- 架構切分與不變式（三平面不互相呼叫、錢的路徑）：`docs/product/2026-09-01-architecture.md`
- SDK 分層與事件契約定案：`docs/product/2026-09-01-sdk-architecture.md`

## 鐵則

- `packages/contracts` 是唯一真理來源；改 API 形狀先改 contracts。
- Console 能做的事＝SDK 能做的事——**沒有 `/internal`**，console 只 import `@nimplex/sdk`。
- api / worker / gateway 之間**不互相呼叫**，只透過 Postgres 的 run 狀態機協調。唯一例外：`claude-managed-agent` 路徑的 worker 以 run token 當閘道的客戶端（真 key 不進 worker，不變式 I1），詳見 `docs/product/2026-09-02-managed-agents-integration.md`。
- 每句 DB query 都要帶 `org_id` 過濾（租戶隔離在 app 層，沒有 RLS）。
- 使用者的真 provider key 永不離開信任區 A；沙箱裡只有短期 run token。
- 文件一律 Markdown（HTML 僅供示意展示）。
- `docs/competitor-analyze/` 與 `sandbox/` 是 gitignored——絕不 commit；第三方工具試玩放 `sandbox/`。
- Commit message 不帶 AI attribution trailer（commit-msg hook 會擋）。
- **程式碼註解、commit message、設定檔註解（Dockerfile / compose / workflow / .env.example）一律用 plain English**（2026-09-03 起）；既有中文註解碰到再改，`docs/product/` 的文件維持中文。

## 改完程式碼後：一律跑 code review

- 每次修改程式碼（含新增檔案、改 contracts / schema / migration）之後、commit 之前，**必跑 `/code-review medium`**；碰到錢的路徑（budget、gateway 記帳、run 狀態機）或改動範圍大時升到 `high`。
- Review **一律用 Opus 跑**。`/code-review` 沒有 `--model` 旗標，模型跟著 session 走：session 不是 Opus 時，跑 review 前先提醒 Kevin `/model opus` 再執行。
- 有 findings 先修完再 commit，不可只回報不修；修完若改動不小，再跑一次確認。
