# Tech stack

> 活文件：換掉任何一項時同步更新「為什麼」。詳細決策見 docs/product/ 對應文件。

## Runtime 與工具鏈

| 項目 | 選擇 | 為什麼 |
|---|---|---|
| Runtime | Node ≥ 22 + tsx（dev 與 prod 都直跑 TS，無 build step） | monorepo 內部套件全走 source import，改 contracts 立即全域生效 |
| Package manager | pnpm 10（workspace: apps/* packages/* examples/*） | workspace protocol + 硬連結省空間 |
| Task runner | turbo 2（`pnpm check` 跑全 workspace tsc） | 增量快取 |
| Lint / Format | Biome 2（單工具取代 eslint+prettier；docs/ 與 migrations/ 排除） | 快、零設定衝突 |
| 測試 | vitest 4（純函式單測）＋ `examples/quickstart/src/e2e.ts`（冒煙）＋ `@nimplex/testkit` 假上游 | 業務核心在 core 純函式，單測便宜；整合靠 e2e 腳本。**錢的路徑不用真 key**：testkit 仿 Anthropic Messages API 的官方形狀，BYOK `base_url` 指過去，worker 零改動地走真實路徑 |

## 後端

| 項目 | 選擇 | 為什麼 |
|---|---|---|
| HTTP framework | Hono 4 + @hono/node-server | 控制面 `/v1` 與 Better Auth 共用一個 app；SSE 用 `hono/streaming` |
| DB | Postgres 17（local docker :5433；prod 定案 Neon） | `DATABASE_URL` 驅動，換雲不改 code；不用 Supabase 因為租戶隔離在 app 層不靠 RLS |
| ORM | Drizzle 0.45 + drizzle-kit migrations + postgres.js driver | schema 即型別；migrations 進版控 |
| 契約 | zod 4（packages/contracts） | 唯一真理來源：API 驗證、SDK 型別、DB jsonb 型別同一份 |
| Auth（人的登入） | Better Auth 1.7：GitHub / Google 社群登入；email+password 僅 dev 後門（e2e 用） | 資料在自己 DB、無廠商鎖定（vs Clerk）；選型全文見 memory 與 `.env.example` 設定步驟 |
| Auth（程式化） | 自刻 org API key（`nmx_live_…`，sha256 落地、可撤銷） | 這條路徑本來就該自己刻；per-key limit 是未來花費控制掛點 |
| 秘密保管 | AES-256-GCM 信封加密（BYOK vault），明文只在兩個瞬間存在於記憶體 | 架構不變式 I1/I3 |
| Harness loop | **Pi** `@earendil-works/{pi-agent-core,pi-ai,pi-coding-agent}` 0.85.1（MIT），`Agent` class 在 worker 程序內驅動，`shouldStopAfterTurn` 一次只跑一個 turn；read/write/edit 的 `operations` 掛點換成 VFS，bash 使用自訂 execute | 09-09 決策閘實測：headless、自訂 ops、BYOK base_url、usage 全通（`sandbox/pi-spike/`）；不 fork、不自寫 loop。grep/find/ls 工具不掛（Pi 的 grep 直接 spawn ripgrep），模型用 bash 裡的 `grep`/`rg` 即可 |
| Tier 1 VFS | **just-bash** 3.4.2（`Bash({ cwd, files })`，`InMemoryFs`） | 60+ 指令、毫秒啟動、零成本；沒 git / npm / 網路 / binary，native 指令執行前路由至 Tier 2。VFS 本身無快照 API，靠 Tier 0（`workspace_files` + metadata）每個工具原子寫回 |
| Sandbox | docker provider（預設 image `node:22-bookworm-slim`）；**e2b provider**（`e2b` SDK 2.46）；**ComputeSDK adapter**（`computesdk` 4.1 + `@computesdk/{daytona,vercel}` 1.7）填長尾；local 僅 dev | 插槽 3 可插拔；正式環境預設遠端 provider（架構文件 §9）。每家都要過 `@nimplex/testkit` 的 conformance kit（C0–C10）。ComputeSDK 沒有 stdin／per-exec signal：adapter 用「寫檔 + `<`」與 `Promise.race` 繞，實際差幾條由 conformance 說話 |

## 前端

| 項目 | 選擇 | 為什麼 |
|---|---|---|
| Site | Vite + React + GSAP ScrollTrigger | 行銷頁動效 |
| SDK 瀏覽器線 | 規劃中：`@nimplex/sdk/browser`（run-scoped viewer token，型別上無 apiKey 欄位） | SDK 架構文件 §2.5 |

## SDK

| 項目 | 選擇 | 為什麼 |
|---|---|---|
| 介面形狀 | 對齊 Vercel AI SDK v7 `Agent`（version/generate/stream） | SDK 架構文件 §1.2 |
| 事件流 | SSE + 原生 `Last-Event-ID` 續傳（seq 為游標） | 四家競品皆無乾淨可續傳事件流，是差異化（§8.1） |
| 依賴 | 只依賴 `@nimplex/contracts` | 客戶安裝零拖累 |

## 已知踩坑（改動這些依賴前先讀）

1. **better-auth 1.7 的 account 表需要 `issuer` 欄位**（多數網路範例是舊版）；schema 在 `packages/db/src/auth-schema.ts`。
2. **better-auth 帶進 kysely 會讓 drizzle-orm 在 pnpm 產生第二個 peer 實例**→ typecheck 大爆炸。修法：db/api/worker 三包的 devDependencies 都掛 `kysely`，統一 peer context。升級 drizzle 或 better-auth 時保持。
3. （已移除：Managed Agents 路徑 2026-09-06 刪掉，其 SDK 白名單踩坑見 git 歷史 `0f32657` 的本文件。）
4. **E2B 真雲兩個坑（conformance kit 抓到）**：(a) Hobby 方案 sandbox 壽命上限 1 小時，超過 400 `Timeout cannot be greater than 1 hours`——預設壽命改 1h，`NIMPLEX_E2B_LIFETIME_MS` 可覆寫；(b) 預設使用者是非 root 的 `user`，`/workspace` 要用 `user: "root"` 建再 `chown` 回去。
5. **worker 原本沒載入根目錄 `.env`**（只有 api 有）→ sandbox provider 的 key 在 worker 看不到。已補同一套 `process.loadEnvFile`。
6. **遠端 provider 的 `create()` 在箱子建好後任何一步失敗，必須自己 kill 再 throw**——否則沒人拿到 id、沒人砍，箱子漏在雲端燒額度。E2B 首次真雲測試就漏了 12 個（mkdir 失敗那輪），已修（e2b.ts / computesdk.ts）。接新 provider 時這條要抄。
7. **drizzle 0.45 把所有 query 錯誤包成 `DrizzleQueryError`，Postgres 的 SQLSTATE 在 `err.cause.code`**——直接讀 `err.code` 永遠對不到（app.ts 的 `isUniqueViolation` 曾因此讓 409 變 500）。讀錯誤碼一律走 `apps/api/src/pg-errors.ts` 的 `pgErrorCode()`。

## 2026-09-10 harness 落地

- Pi 0.85.1 + just-bash 3.4.2；模型與每個工具各自形成 durable checkpoint。
- `model_calls` 保存 reservation、settled 與 unknown；已結算與預留額度分開對外回傳。
- native 路由解析完整 shell AST。E2B 執行器使用持久化 supervisor journal，支援 pause/resume 與確認環境丟失後重建。
- workspace 保留 binary、空目錄、symlink 與權限；`node_modules` 是 native 箱子的可重建快取。
- context 使用可驗 digest 的 extractive checkpoint，完整原始 log 保留，`read_output` / `read_log` 分頁讀取。
- 驗收：`pnpm e2e` / `pnpm e2e:e2b` / `pnpm e2e:real`。細節見 `docs/product/2026-09-10-harness-runtime.md`。
