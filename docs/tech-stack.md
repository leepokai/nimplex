# Tech stack

> 活文件：換掉任何一項時同步更新「為什麼」。詳細決策見 docs/product/ 對應文件。

## Runtime 與工具鏈

| 項目 | 選擇 | 為什麼 |
|---|---|---|
| Runtime | Node ≥ 22 + tsx（dev 與 prod 都直跑 TS，無 build step） | monorepo 內部套件全走 source import，改 contracts 立即全域生效 |
| Package manager | pnpm 10（workspace: apps/* packages/* examples/*） | workspace protocol + 硬連結省空間 |
| Task runner | turbo 2（`pnpm check` 跑全 workspace tsc） | 增量快取 |
| Lint / Format | Biome 2（單工具取代 eslint+prettier；docs/ 與 migrations/ 排除） | 快、零設定衝突 |
| 測試 | vitest 4（純函式單測）＋ `examples/quickstart/src/e2e.ts`（冒煙 11 項） | 業務核心在 core 純函式，單測便宜；整合靠 e2e 腳本 |

## 後端

| 項目 | 選擇 | 為什麼 |
|---|---|---|
| HTTP framework | Hono 4 + @hono/node-server | 控制面與計量面共用 router 型別；未來 gateway 拆獨立部署時 `createGateway(db)` 直接搬走（架構文件 §1.1） |
| DB | Postgres 17（local docker :5433；prod 定案 Neon） | `DATABASE_URL` 驅動，換雲不改 code；不用 Supabase 因為租戶隔離在 app 層不靠 RLS |
| ORM | Drizzle 0.45 + drizzle-kit migrations + postgres.js driver | schema 即型別；migrations 進版控 |
| 契約 | zod 4（packages/contracts） | 唯一真理來源：API 驗證、SDK 型別、DB jsonb 型別同一份 |
| Auth（console 登入） | Better Auth 1.7：GitHub / Google 社群登入；email+password 僅 dev 後門 | 資料在自己 DB、無廠商鎖定（vs Clerk）；選型全文見 memory 與 `.env.example` 設定步驟 |
| Auth（程式化） | 自刻 org API key（`nmx_live_…`，sha256 落地、可撤銷）＋ run/sandbox 兩張短期票 | 這條路徑本來就該自己刻；per-key limit 是未來花費控制掛點 |
| 秘密保管 | AES-256-GCM 信封加密（BYOK vault），明文只在兩個瞬間存在於記憶體 | 架構不變式 I1/I3 |
| Sandbox | docker provider（預設 image `node:22-bookworm-slim`）；local provider 僅 dev；port 開放給 E2B/Vercel/Daytona | 插槽 3 可插拔；正式環境預設遠端 provider（架構文件 §9） |

## 前端

| 項目 | 選擇 | 為什麼 |
|---|---|---|
| Console | Vite 6 + React 19 + TanStack Query 5 + Phosphor icons | 純靜態產物上 CDN；自有 design token（styles.css），**不用** Tailwind/better-auth-ui |
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
2. **better-auth 帶進 kysely 會讓 drizzle-orm 在 pnpm 產生第二個 peer 實例**→ typecheck 大爆炸。修法：db/gateway/api/worker 四包的 devDependencies 都掛 `kysely`，統一 peer context。升級 drizzle 或 better-auth 時保持。
