# Local dev runbook：服務拓撲、啟動、e2e 驗收

> **2026-09-10 現行驗收**：先 `docker compose up -d`，再 `pnpm e2e`；真 E2B 用 `pnpm e2e:e2b`，真 Haiku + E2B 用 `pnpm e2e:real`。
> 這些命令自建獨立 DB／API／worker，並自動清理。預算已改為呼叫前預留，恢復邊界已改為 model/tool checkpoint；下方 9/9 的「每 turn 重做、最多超出一次模型費用」描述為歷史行為。
> 詳見 [2026-09-10 harness runtime](2026-09-10-harness-runtime.md)。


> **2026-09-06 註**：console、閘道（`/gw`）、harness 註冊表、Managed Agents、`db:seed` 已全部移除，
> 本文提到它們的段落已過期；現行最短啟動路徑見根目錄 `README.md`。

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
| **api**（控制面） | 本機 node（tsx） | 8787 | `pnpm --filter @nimplex/api start` | `apps/api` |
| **worker**（執行面） | 本機 node（tsx） | 無對外 port | `pnpm --filter @nimplex/worker start` | `apps/worker` |
| **site**（waitlist 首頁，可選） | vite dev server | 5176 | `pnpm --filter @nimplex/site dev` | `apps/site` |
| **run 沙箱** | docker container（worker 按需開/銷毀） | — | 由 worker 管生死 | `packages/sandbox/src/docker.ts` |

- console 的 `/v1`、`/api` 都由 vite proxy 轉到 :8787（`apps/console/vite.config.ts`）——瀏覽器視角同源，cookie 直接生效。
- worker 與 api **不互相呼叫**，全靠 Postgres 上的 run 狀態機協調（架構不變式，見架構文件 §0/§3）。
- docker sandbox 的預設 image 是 `node:22-bookworm-slim`（可用 `NIMPLEX_DOCKER_IMAGE` 覆寫）；箱內打回閘道走 `host.docker.internal:8787`。

## 2. 冷啟動順序

```bash
pnpm install
docker compose up -d          # Postgres on :5433
pnpm db:migrate               # schema（含 Tier 0 的 workspace_files）
pnpm --filter @nimplex/api start &
pnpm --filter @nimplex/worker start &
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

## 5. e2e 驗收（2026-09-09 改寫：Pi loop + just-bash + Tier 0）

`examples/quickstart/src/e2e.ts`（冒煙腳本，可重複跑）：

```bash
# 需要 api + worker 在跑，且 NIMPLEX_DEV_EMAIL_AUTH=1（跑完關回去）
pnpm --filter @nimplex/example-quickstart exec tsx src/e2e.ts
```

涵蓋：無身分 401 → 註冊即建 org → 發 API key → BYOK 落地 → sandbox providers →
**Pi loop 跑完**（假上游腳本 4 次 bash tool_use：5 次 `model.call`、4 個 `tool.result`，每次 1000 in / 500 out，claude-sonnet-5 價 $0.007/次 → $0.035，cap $1）→
**mid-run 預算殺**（cap $0.02，第 3 次 call 後 $0.021 → `killed(budget_exceeded)`）→ `budget_usd` 必填 → 跨租戶 404 → 撤銷 key 即 401。

最近一次全綠：2026-09-09。

## 5.0 無 key 測試模式：`@nimplex/testkit` 假上游

沒有 `ANTHROPIC_API_KEY` 時 e2e / demo 會**自己起一個假的 Anthropic 上游**（:8790），把 BYOK 的 `base_url` 指過去；
Pi 的 Anthropic adapter、worker 記帳、預算殺、Tier 0 寫回全部走真實程式碼，只有 `api.anthropic.com` 那一跳是假的。本機驗收**不需要真 key、不花錢**。

- 形狀照官方 Messages API（非串流 / 串流 SSE，usage 在 `message_start` + `message_delta`）。
- `toolCalls: n`：對話裡的 `tool_result` 少於 n 個就回一個 `bash` tool_use（`echo "fake step k" > /workspace/step-k.txt`），否則 `end_turn`——無狀態，同時多個 run 互不干擾。`delayMs`：每次回應加延遲，給 kill -9 demo 留手。
- 也可獨立起來給手動測試：`pnpm --filter @nimplex/testkit start`，BYOK 放任意 key 並填 `base_url=http://localhost:8790`。
- 有 `ANTHROPIC_API_KEY` 時自動改走真上游（會花錢；e2e 的數字斷言只在無 key 模式成立）。

## 5.3 kill -9 demo：`demo-kill.ts`（2026-09-09 新增）

MVP 的主張：run 不因 worker 死掉而死、錢停在上限。

```bash
# 只起 api（NIMPLEX_DEV_EMAIL_AUTH=1）；不要自己起 worker——腳本會自己起 worker A、殺掉、再起 worker B
pnpm --filter @nimplex/example-quickstart exec tsx src/demo-kill.ts
# 真 key 彩排（Haiku，約 $0.006）：
set -a; source .env; set +a; pnpm --filter @nimplex/example-quickstart exec tsx src/demo-kill.ts
```

劇本：建 run（budget $0.20）→ 事件流滾到第 2 次 `model.call` → `SIGKILL` worker A → lease 60s 內到期 → worker B 重領、寫 `run.resumed` → 從 `run_events` 投影 Pi 訊息、從 Tier 0 seed VFS 接著跑 → `run.completed`、spent ≤ 0.20 → `GET /v1/runs/:id/files` 列出 Tier 0 檔案（假上游 4 個 `step-k.txt`；真 key `hello.txt` 含當天日期）。
被殺那一刻進行中的 turn 沒 commit，worker B 會**重做那個 turn**（多花一次 model call，這就是「最多超出一個 in-flight call」的 overshoot）。

## 4.1 Sandbox conformance kit（2026-09-02 新增）

`pnpm vitest run packages/sandbox` 對 local / docker / e2b 三家 provider 跑同一把尺（`@nimplex/testkit` 的
`describeSandboxConformance`，C0–C10 + C1b）：完整循環、env 注入、workdir、state JSON round-trip 後 resume、
delete 不需先 resume、stop 後 exec 必失敗、timeout／signal 真的中止、stdout 即時回呼、delete 冪等。
provider 不可用（沒 docker daemon、沒 `E2B_API_KEY` / `DAYTONA_API_KEY` / `VERCEL_*`）整組自動 skip。E2B 已對真雲跑過 12/12（2026-09-02）；daytona / vercel 透過 ComputeSDK adapter，等 key。**接任何新 provider 先加一行進
`packages/sandbox/src/conformance.test.ts`，紅了才算知道差在哪。** local 以 `absolutePaths: false` 明示
它的 `/workspace` 只是虛擬映射。

## 5.1 / 5.2（已移除）

Managed Agents 路徑與 claude-code × E2B CLI-in-box 組合在 2026-09-06 刪掉（見 `2026-09-06-harness-on-just-bash.md` §6；歷史在 git `0f32657`）。真箱子（Tier 2）路徑在 Slice 2 重接，屆時補回組合驗證。

## 7. 自架雲端 dev 環境（VPS + docker compose + GitHub Actions，2026-09-03 新增）

上雲後 E2B 的箱子直接打回公網 api，不再需要 tunnel。形狀：一台 VPS（DigitalOcean / Linode，建議 2 vCPU / 4 GB），
`deploy/docker-compose.yml` 跑 postgres + api + worker + caddy；`.github/workflows/deploy.yml`（`deploy-dev`）在 **push `dev` branch** 時
build 兩個映像檔推 GHCR，再 ssh 進 VPS `pull → migrate → up`。console 這輪不上（走 SDK 驗證）。

**分支策略（2026-09-03 定案）**：日常工作推 `dev`，push 就自動部署到 `api-dev.nimplex.dev`；`main` 保留給正式環境，
prod 的 workflow 等機器開了再加（同一份 compose，`.env` 換成 api.nimplex.dev + Neon）。功能穩了再 `dev → main`。

現況：DO droplet `nimplex-dev`（sgp1，s-2vcpu-4gb，IP 168.144.107.105），2026-09-03 第一次部署（commit `0f32657`）全通：
Caddy 自動拿到憑證、四個 service healthy、雲端跑 `claude-code-e2b.ts` completed（19 秒，$0.049，不需 tunnel）。

```bash
# ---- VPS 一次性（Ubuntu 24.04）----
curl -fsSL https://get.docker.com | sh && usermod -aG docker $USER
mkdir -p /opt/nimplex && cd /opt/nimplex
# 放 deploy/docker-compose.yml、deploy/Caddyfile，並依 deploy/.env.example 寫 .env：
#   NIMPLEX_MASTER_KEY / BETTER_AUTH_SECRET / POSTGRES_PASSWORD 全部現生（openssl rand）
#   NIMPLEX_PUBLIC_URL=http://<ip>（或網域 + SITE_ADDRESS=網域 讓 Caddy 自動 TLS）
#   E2B_API_KEY、NIMPLEX_DEV_EMAIL_AUTH=1
echo $GHCR_TOKEN | docker login ghcr.io -u leepokai --password-stdin
docker compose pull && docker compose run --rm migrate && docker compose up -d

# ---- GitHub repo secrets（之後每次 push main 自動部署）----
gh secret set DEPLOY_HOST   --body <ip>
gh secret set DEPLOY_USER   --body <ssh user，需在 docker group>
gh secret set DEPLOY_SSH_KEY < ~/.ssh/nimplex_deploy   # 私鑰全文

# ---- 驗證：本機跑組合，只把 base URL 指到雲端 ----
NIMPLEX_BASE_URL=http://<ip> NIMPLEX_API_KEY=nmx_live_... ANTHROPIC_API_KEY=sk-ant-... \
  pnpm --filter @nimplex/example-quickstart exec tsx src/claude-code-e2b.ts
```

- 本機驗證（2026-09-03）：`cd deploy && docker compose up --build -d` 全通：migrate + seed、api 經 Caddy 健康、
  worker 起來、email 註冊發 key、`/v1/sandbox-providers` 在容器內 e2b 可用（docker / local 不可用，符合預期）、內建 loop run 跑完。
- 映像檔 1.38 GB（整個 workspace 一起裝，因為 lockfile 的 importers 必須跟 workspace 一致）；build 30 秒。要瘦身再用 pnpm deploy。
- worker 容器裡沒有 docker daemon，sandbox 只能用遠端 provider；要在 VPS 上用 docker provider 得掛 `/var/run/docker.sock`，另議。
- `NIMPLEX_DEV_EMAIL_AUTH=1` 代表任何拿到 URL 的人都能註冊並用你的 E2B key 開箱：dev 環境別外流 URL，正式環境關掉。

## 6. 常見問題

| 症狀 | 原因 / 解法 |
|---|---|
| api 起不來 `EADDRINUSE :8787` | 舊 process 佔 port：`kill $(lsof -tnP -iTCP:8787 -sTCP:LISTEN)` |
| console 開在 5174/5175 | 5173 被舊 vite 佔走，同上清掉重啟 |
| Google 登入 403 `access_denied` | 帳號不在測試使用者名單（§4） |
| e2e 腳本 sign-up 500/400 | email 後門沒開：`.env` 開 `NIMPLEX_DEV_EMAIL_AUTH=1` 後**重啟 api** |
| 改了 `.env` 沒生效 | api 是啟動時載入，要重啟 |
| docker run 卡住 | 先 `docker pull node:22-bookworm-slim`；Docker Desktop 要在跑 |
