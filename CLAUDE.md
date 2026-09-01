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
- api / worker / gateway 之間**不互相呼叫**，只透過 Postgres 的 run 狀態機協調。
- 每句 DB query 都要帶 `org_id` 過濾（租戶隔離在 app 層，沒有 RLS）。
- 使用者的真 provider key 永不離開信任區 A；沙箱裡只有短期 run token。
- 文件一律 Markdown（HTML 僅供示意展示）。
- `docs/competitor-analyze/` 與 `sandbox/` 是 gitignored——絕不 commit；第三方工具試玩放 `sandbox/`。
- Commit message 不帶 AI attribution trailer（commit-msg hook 會擋）。
