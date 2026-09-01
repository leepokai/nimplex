# Local dev runbook：服務拓撲、啟動、e2e 驗收

> 2026-09-01。記錄本日落地後的**實際可跑狀態**：auth（Better Auth + org API key）接完、
> `/v1/*` 全面認證、console 接真 API、e2e 冒煙 11/11 通過。
> 承接 `2026-09-01-architecture.md`（架構切分）與 `2026-09-01-sdk-architecture.md`（SDK 定案）。

---

## 1. 服務拓撲（local dev）

**只有兩樣東西跑在 docker 裡**：Postgres 與「每個 run 的沙箱」。
api / worker / console 是本機 node process（dev 要熱重載，容器化是部署階段的事，見架構文件 §9）。

| 服務 | 跑在哪 | Port | 啟動指令 | 定義位置 |
|---|---|---|---|---|
| **postgres** | docker（`docker-compose.yml`） | 5433 | `docker compose up -d` | `docker-compose.yml` |
| **api**（控制面 + `/gw` 計量面） | 本機 node（tsx） | 8787 | `pnpm --filter @nimplex/api start` | `apps/api` |
| **worker**（執行面） | 本機 node（tsx） | 無對外 port | `pnpm --filter @nimplex/worker start` | `apps/worker` |
| **console** | vite dev server | 5173 | `pnpm --filter @nimplex/console dev` | `apps/console` |
| **site**（waitlist 首頁，可選） | vite dev server | 5176 | `pnpm --filter @nimplex/site dev` | `apps/site` |
| **run 沙箱** | docker container（worker 按需開/銷毀） | — | 由 worker 管生死 | `packages/sandbox/src/docker.ts` |

- console 的 `/v1`、`/api` 都由 vite proxy 轉到 :8787（`apps/console/vite.config.ts`）——瀏覽器視角同源，cookie 直接生效。
- worker 與 api **不互相呼叫**，全靠 Postgres 上的 run 狀態機協調（架構不變式，見架構文件 §0/§3）。
- docker sandbox 的預設 image 是 `node:22-bookworm-slim`（可用 `NIMPLEX_DOCKER_IMAGE` 覆寫）；箱內打回閘道走 `host.docker.internal:8787`。

## 2. 冷啟動順序

```bash
pnpm install
docker compose up -d          # Postgres on :5433
pnpm db:migrate && pnpm db:seed   # schema + 內建 harness（builtin / claude-code / opencode / codex）
pnpm --filter @nimplex/api start &
pnpm --filter @nimplex/worker start &
pnpm --filter @nimplex/console dev &
```

開 <http://localhost:5173> → GitHub 或 Google 登入 → 首次登入自動建 org →「API keys」頁發 `nmx_live_…`。

## 3. `.env` 定義（根目錄；api 啟動時自動載入，已存在的環境變數優先）

範本：`.env.example`。實際 `.env` **gitignored**，含 secrets 不進 repo。

| 變數 | 用途 | 現況（local） |
|---|---|---|
| `DATABASE_URL` | Postgres 連線 | 預設值即 compose 的 :5433 |
| `NIMPLEX_MASTER_KEY` | BYOK 保險庫 AES-256-GCM 主金鑰 | 未設→開發用固定金鑰（會警告） |
| `BETTER_AUTH_SECRET` | session 簽章 | ✅ 已生成寫入 |
| `NIMPLEX_PUBLIC_URL` | 閘道/OAuth callback 的 base URL | 預設 `http://localhost:8787` |
| `NIMPLEX_TRUSTED_ORIGINS` | 允許打 `/api/auth` 的來源 | 預設含 :5173 與 :8787 |
| `GITHUB_CLIENT_ID/SECRET` | GitHub 登入 | ✅ 已設（OAuth App「nimplex local dev」，leepokai 帳號下） |
| `GOOGLE_CLIENT_ID/SECRET` | Google 登入 | ✅ 已設（GCP 專案 `nimplex-dev`，ID `hopeful-seat-507308-v1`） |
| `NIMPLEX_DEV_EMAIL_AUTH=1` | 開發用 email 註冊/登入後門 | ❌ 已關（e2e 腳本要跑時暫開） |
| `NIMPLEX_ALLOW_LOCAL_SANDBOX=1` | 無隔離的 local sandbox | ❌ 關（預設） |

## 4. Auth 現況（2026-09-01 落地）

- **console 登入**：Better Auth 1.7.2，**只提供 GitHub / Google**。登入頁按鈕由公開端點 `GET /api/auth-providers` 動態決定——沒設憑證的 provider 不出現。
- **註冊即建 org**：`databaseHooks.user.create.after` 自動建 org + owner membership；同 email 的不同 provider 會被自動連結成同一個 user（已實測，不會裂成兩個 org）。
- **`/v1/*` 全面認證**：org API key（`Authorization: Bearer nmx_live_…`，sha256 落地、可撤銷、撤銷即 401）或 session cookie。兩種身分打同一組 endpoint（不變式 I5）。
- **租戶隔離**：所有 run 路由帶 `org_id` 過濾，跨租戶一律 404。
- ⚠️ **Google 在 Testing 模式**：只有測試使用者名單（目前僅 kevin2005ha@gmail.com）能登入；加人去 GCP「Google Auth Platform → 目標對象」。
- ⚠️ 上線到 nimplex.dev 時**另建正式 OAuth 憑證**（callback 換網域、Google app 要發布＋驗證），local 這組不上正式環境。

## 5. e2e 驗收

`examples/quickstart/src/e2e.ts`（冒煙腳本，可重複跑）：

```bash
# 需要 api + worker 在跑，且 NIMPLEX_DEV_EMAIL_AUTH=1（跑完關回去）
pnpm --filter @nimplex/example-quickstart exec tsx src/e2e.ts
```

涵蓋 11 項：無身分 401 → email 註冊即建 org → 發 API key → BYOK 落地 → harness 註冊表 →
sandbox providers → 內建 loop 跑完（$0.60/$1）→ **mid-run 預算殺**（$0.36 就停，$0.30 上限）→
docker sandbox 跑自上傳 harness（閘道 URL + run token 注入）→ 跨租戶 404 → 撤銷 key 即 401。

最近一次全綠：2026-09-01（本文撰寫當下）。OAuth 登入另以瀏覽器實測過 GitHub / Google 全程。

## 6. 常見問題

| 症狀 | 原因 / 解法 |
|---|---|
| api 起不來 `EADDRINUSE :8787` | 舊 process 佔 port：`kill $(lsof -tnP -iTCP:8787 -sTCP:LISTEN)` |
| console 開在 5174/5175 | 5173 被舊 vite 佔走，同上清掉重啟 |
| Google 登入 403 `access_denied` | 帳號不在測試使用者名單（§4） |
| e2e 腳本 sign-up 500/400 | email 後門沒開：`.env` 開 `NIMPLEX_DEV_EMAIL_AUTH=1` 後**重啟 api** |
| 改了 `.env` 沒生效 | api 是啟動時載入，要重啟 |
| docker run 卡住 | 先 `docker pull node:22-bookworm-slim`；Docker Desktop 要在跑 |
