# loopbox

Open-source agent runtime with per-end-user isolation, dollar budgets, and swappable harnesses.

每個 run 綁定一個終端使用者（`end_user`）、一個美元硬上限（`budget_usd`）——超額即殺。
事件流 append-only、SSE 可續傳；worker 無狀態，隨時可死、隨處可復原。

## Quickstart

```bash
pnpm install
docker compose up -d        # Postgres on :5433
pnpm db:migrate
pnpm dev                    # api :8787 + worker
```

建一個 $0.30 上限的 run（stub executor 每步 $0.12，會在第 3 步後被 kill-switch 砍掉）：

```bash
curl -s -X POST localhost:8787/v1/runs \
  -H 'content-type: application/json' \
  -d '{"end_user":"usr_123","model":"stub","instructions":"demo","budget_usd":0.3}'

curl -N localhost:8787/v1/runs/<run_id>/events
```

## Layout

```
apps/api          Hono — POST /v1/runs · GET /v1/runs/:id/events (SSE, Last-Event-ID 續傳)
apps/worker       work-queue executor — 每步一個 work item，lease + fence，budget kill-switch
packages/contracts  zod schemas（API 契約，日後 SDK 的種子）
packages/db       Drizzle + Postgres — end_users 第一級物件、美元計量、append-only 稽核
packages/core     run 狀態機 · budget · RunExecutor 介面（未來箱內 harness 的掛點）
```
