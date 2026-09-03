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
pnpm db:migrate && pnpm db:seed   # schema + 內建 harness（builtin / claude-code / opencode / codex / claude-managed-agent）；seed 冪等，加了新內建 harness 要再跑一次
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

涵蓋 23 項（有 `E2B_API_KEY` 時）：無身分 401 → 註冊即建 org → 發 API key → BYOK 落地 → harness 註冊表 → sandbox providers →
內建 loop 跑完（$0.60/$1）→ **mid-run 預算殺**（$0.36 就停）→ **usage rollup**（`GET /v1/usage` 的 harness / external_user_id / day 分桶一分不差對回前兩個 run；不認得的 tz 400）→
**工具 registry**（skills / MCP servers 上傳、覆寫、列表、刪除；缺 SKILL.md、路徑穿越、明文憑證都 400）→ **metering 守門**（沙箱 harness 帶 provider_reported → 400）→ docker sandbox 跑自上傳 harness →
**E2B 雲端沙箱**跑同一份 harness（只換 sandbox.provider，跑完並銷毀）→
**Managed Agents** completed（$0.42 回填）/ budget_reached → killed（$0.33）/ session 都刪掉 / **MA 花費也進 usage rollup**（session usage 的增量逐筆記帳）→
**閘道計量**（沙箱內 2 次 model call 經 reserve/settle，$0.014）/ **閘道軟殺**（第二次 call 402 → killed）→
**max_duration_seconds**（metering=none 的 run 超時 → killed(max_duration)）→ 跨租戶 404（run / skill）、usage 為 0 → 撤銷 key 即 401。

最近一次全綠：2026-09-03（23/23：LLM 走假上游、sandbox 含真 E2B；新增 usage rollup 與工具 registry 兩段）。OAuth 登入另以瀏覽器實測過 GitHub / Google 全程。

## 4.1 Sandbox conformance kit（2026-09-02 新增）

`pnpm vitest run packages/sandbox` 對 local / docker / e2b 三家 provider 跑同一把尺（`@nimplex/testkit` 的
`describeSandboxConformance`，C0–C10 + C1b）：完整循環、env 注入、workdir、state JSON round-trip 後 resume、
delete 不需先 resume、stop 後 exec 必失敗、timeout／signal 真的中止、stdout 即時回呼、delete 冪等。
provider 不可用（沒 docker daemon、沒 `E2B_API_KEY` / `DAYTONA_API_KEY` / `VERCEL_*`）整組自動 skip。E2B 已對真雲跑過 12/12（2026-09-02）；daytona / vercel 透過 ComputeSDK adapter，等 key。**接任何新 provider 先加一行進
`packages/sandbox/src/conformance.test.ts`，紅了才算知道差在哪。** local 以 `absolutePaths: false` 明示
它的 `/workspace` 只是虛擬映射。

## 5.0 無 key 測試模式：`@nimplex/testkit` 假上游（2026-09-02 新增）

`examples/quickstart/src/e2e.ts` 在沒有 `ANTHROPIC_API_KEY` 時會**自己起一個假的 Anthropic 上游**（:8790），
並把 BYOK 的 `base_url` 指過去。閘道 reserve/settle、預算軟殺、docker 沙箱、Managed Agents executor
全部走真實程式碢，只有 `api.anthropic.com` 那一跳是假的。因此本機 e2e **完全不需要任何真 key、不花錢**，
且能驗到以前驗不到的：沙箱內 model call 經閘道計量、超額 402 軟殺、MA 的 completed 與 budget_reached 兩種語意。

- 假上游的形狀照官方文件：Messages 非串流/串流 usage、MA 的 sessions/events/stream SSE（`event:` + `data:`）、
  `session.usage.list_cost`（分的整數字串）、`stop_reason.type`。一個 MA turn 固定 42 分；預算不足 → `budget_reached`（含 overshoot 3 分）。
- 也可獨立起來給手動測試：`pnpm --filter @nimplex/testkit start`，再在 console「LLM provider」放任意 key 並填 `base_url=http://localhost:8790`。
- 有 `ANTHROPIC_API_KEY` 時 e2e 自動改走真上游（會花錢）。

## 5.1 `claude-managed-agent` harness（2026-09-02 新增）

不開沙箱：worker 用官方 SDK 經閘道打 Anthropic Managed Agents，`budget_usd` 映射成 session budget，
花費由 `session.usage` 回填（`metering=provider_reported`）。**真機測試前置條件**：console「LLM provider」頁放一把
真的 Anthropic key（帳號需有 Managed Agents beta 存取）；會花真錢，建議 `budget_usd: 0.5` 起跳。
沒有真 key 時 e2e 走 §5.0 的假上游，可驗 completed / budget_reached 兩種語意。
設計與對照見 `2026-09-02-managed-agents-integration.md`。

## 5.2 具體組合驗證：claude-code × E2B × Anthropic 官方 API × Haiku（2026-09-03 新增）

```bash
# 1. E2B 雲端的箱子要打得回本機閘道：開一條 tunnel 指到 api
ngrok http 8787            # 拿到 https://xxx.ngrok-free.dev
# 2. worker 用 tunnel URL 重啟（只有 worker 需要；api 的 NIMPLEX_PUBLIC_URL 留給 OAuth callback）
cd apps/worker && NIMPLEX_PUBLIC_URL=https://xxx.ngrok-free.dev pnpm start
# 3. 跑組合
NIMPLEX_API_KEY=nmx_live_... ANTHROPIC_API_KEY=sk-ant-... \
  pnpm --filter @nimplex/example-quickstart exec tsx src/claude-code-e2b.ts
```

- 2026-09-03 實測全通：18 秒完成，閘道記帳 $0.0137 與 claude-code 自報一致（4 次 model call 逐筆 reserve/settle）。
- `cloudflared tunnel --url` 的 quick tunnel 在本機網路連不上（HTTP 000），ngrok 可用。
- E2B 預設 template 是 node 20.9，claude-code 2.x 宣告需要 node ≥ 22：目前只是 EBADENGINE 警告仍可跑，
  但這是「harness 預裝 image / E2B template」該優先做的原因之一（每次 run 都 `npm install -g` 約 6 秒）。
- 沒有真 key 時設 `ANTHROPIC_BASE_URL` 指到 testkit 假上游（`pnpm --filter @nimplex/testkit start`），同一條路徑照跑。

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
