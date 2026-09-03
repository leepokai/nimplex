# File structure

> 活文件：新增/搬移頂層目錄或 package 時同步更新。決策背景見 `docs/product/2026-09-01-architecture.md`。

```
nimplex/
├── apps/                          可部署的東西（不被別人 import）
│   ├── api/                       控制面 /v1/* + 計量面 /gw/*（Hono，port 8787）
│   │   └── src/
│   │       ├── index.ts           進入點；啟動時載入根目錄 .env
│   │       ├── app.ts             全部路由 + 認證/org 上下文 middleware
│   │       ├── auth.ts            Better Auth 實例（GitHub/Google；註冊即建 org hook）
│   │       ├── harnesses.ts       harness 註冊表的解析/覆寫邏輯
│   │       ├── registries.ts      工具 registry：skills / MCP servers 的 CRUD（org 層，PUT 冪等）
│   │       ├── usage.ts           帳務 rollup（GET /v1/usage）：usage_records 按 day/harness/external_user_id/model 分桶
│   │       └── pg-errors.ts       讀 SQLSTATE 一律經這裡（drizzle 0.45 把 pg 錯誤包在 cause）
│   ├── worker/                    執行面：領工作、開箱、跑 harness、硬殺、收屍（無對外 port）
│   │   └── src/
│   │       ├── index.ts           主迴圈（lease+fence 工作佇列）＋孤兒沙箱 reaper
│   │       ├── harness-executor.ts 沙箱路徑：install → command → 串事件
│   │       ├── managed-agent-executor.ts Claude Managed Agents 路徑：經閘道建 session、翻事件、殺（不開箱）
│   │       └── stub-executor.ts   內建 loop（5 步 × $0.12，驗計量與 kill 用）
│   ├── console/                   管理台（Vite + React，port 5173；/v1、/api 皆 proxy 到 8787）
│   │   └── src/
│   │       ├── client.ts          用「跟客戶同一個」@nimplex/sdk —— 無 /internal
│   │       ├── auth-client.ts     Better Auth 瀏覽器端（cookie session）
│   │       ├── AuthScreen.tsx     登入頁（按鈕由 /api/auth-providers 動態決定）
│   │       ├── usage-window.ts    Usage 頁的本地時區日期邊界（今日/本月/近 7 天）＋補零
│   │       └── views/             每頁一檔（Runs / Usage / Skills / McpServers / Harnesses…）——全部打真 API，無示意資料
│   ├── site/                      waitlist 首頁（GSAP，port 5176）
│   └── runtime/                   ⚠️ 已定案廢棄的 CF Workers 原型（架構文件 §8）——勿再擴充
├── packages/                      可被 import 的東西
│   ├── contracts/                 zod schemas＝唯一真理來源（run/harness/sandbox/key/member 契約）
│   ├── core/                      零 IO 純函式：budget、pricing、狀態機、harness 模板、SandboxProvider port、內建 harness 種子
│   │   └── src/managed-agent.ts   Managed Agents 事件 → nimplex 事件 union 的純翻譯（含 budget 分↔美元）
│   ├── db/                        Drizzle schema + migrations + BYOK 加密/token 雜湊
│   │   └── src/auth-schema.ts     Better Auth 四張表（user/session/account/verification），與業務表只靠 email 鬆耦合
│   ├── gateway/                   /gw LLM 代理：BYOK 解封、reserve/settle 記帳、軟殺
│   ├── sandbox/                   SandboxProvider 註冊表：docker、e2b（直接接）、computesdk.ts（一對多轉接頭 → daytona / vercel …）、local（dev）+ conformance.test.ts 同一把尺
│   ├── sdk/                       @nimplex/sdk：Nimplex client + CloudAgent（對齊 ai@7 Agent）+ SSE Transport
│   └── testkit/                   假的 Anthropic 上游（e2e 不用真 key）+ sandbox conformance kit（每家 provider 必過的契約測試）
├── examples/
│   └── quickstart/                src/index.ts 三插槽走一遍；src/e2e.ts 冒煙測試（無 key 時自動起假上游）；src/claude-code-e2b.ts 具體組合（claude-code × E2B × Haiku）
├── docs/
│   ├── product/                   決策與規格（日期前綴 .md；一律 Markdown 不用 HTML）
│   ├── competitor-analyze/        gitignored——絕不 commit
│   ├── file-structure.md          本文件
│   └── tech-stack.md              技術選型與理由
├── sandbox/                       gitignored 第三方工具試玩區（不進 pnpm workspace）
├── deploy/                        自架（VPS）用：docker-compose.yml（postgres+api+worker+caddy）、Caddyfile、.env.example
├── Dockerfile                     一份兩個 target（api / worker），跟 dev 一樣 tsx 直跑；.github/workflows/deploy.yml 推 GHCR 後 ssh 進 VPS 更新
├── docker-compose.yml             local Postgres（:5433）
├── .env.example                   全部環境變數的範本與註解（實際 .env gitignored）
├── turbo.json / biome.json        task runner 與 lint/format 設定
└── pnpm-workspace.yaml            apps/* + packages/* + examples/*
```

## 依賴方向（違反就是架構破口）

```
apps/*  ──►  packages/*        （apps 互相之間零依賴、零呼叫）
sdk     ──►  contracts         （SDK 只依賴契約，零其他依賴）
core    ──►  contracts         （core 保持零 IO）
db / gateway / sandbox ──► core + contracts
```

- api 與 worker **不互相呼叫**，只透過 Postgres 的 run 狀態機協調。唯一例外：Managed Agents 路徑的 worker 以 run token 打閘道 `/gw/anthropic`（換 key 用，真 key 不進 worker）。
- console 只 import `@nimplex/sdk`——console 能做的事＝客戶能做的事。
