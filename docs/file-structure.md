# File structure

> 活文件：新增/搬移頂層目錄或 package 時同步更新。決策背景見 `docs/product/2026-09-01-architecture.md`；2026-09-06 的收斂（刪掉 CLI-in-box harness、Managed Agents、閘道、console、tool registry）見 `docs/product/2026-09-06-harness-on-just-bash.md`。

```
nimplex/
├── apps/                          可部署的東西（不被別人 import）
│   ├── api/                       控制面 /v1/*（Hono，port 8787）
│   │   └── src/
│   │       ├── index.ts           進入點；啟動時載入根目錄 .env
│   │       ├── app.ts             全部路由 + 認證/org 上下文 middleware
│   │       ├── auth.ts            Better Auth 實例（GitHub/Google；註冊即建 org hook）
│   │       └── pg-errors.ts       讀 SQLSTATE 一律經這裡（drizzle 0.45 把 pg 錯誤包在 cause）
│   ├── worker/                    執行面：領工作、跑一個 turn、記帳、硬殺、收屍（無對外 port）
│   │   └── src/
│   │       ├── index.ts           主迴圈（lease+fence 工作佇列、lease heartbeat）＋孤兒沙箱 reaper；model/tool checkpoint、預留額度與終態協調
│   │       ├── pi-executor.ts     Pi（@earendil-works）當 loop kernel、loop-outside：工具打在 just-bash VFS（Tier 1）上，從 run_events 投影回 Pi 訊息；透過注入的 persistence port 提交，不直接碰 DB
│   │       ├── checkpoints.ts     fenced DB 提交、reservation/settlement、workspace revision
│   │       ├── native-bash.ts     native supervisor、durable journal、pause/resume、environment reset
│   │       ├── bash-routing.ts    整段 bash AST 執行前路由
│   │       ├── context.ts         digest checkpoint、context 投影、原始工具輸出分頁
│   │       └── workspace.ts       binary、目錄、symlink 與 mode 的 snapshot/restore
│   └── site/                      行銷首頁（GSAP，port 5176；Vercel 部署 nimplex.dev）
├── packages/                      可被 import 的東西
│   ├── contracts/                 zod schemas＝唯一真理來源（run/event/key/org/member/sandbox 契約）
│   ├── core/                      零 IO 純函式：budget、pricing、狀態機、duration、shellQuote、SandboxProvider port、RunExecutor 型別（一個 turn 的輸入/輸出）
│   ├── db/                        Drizzle schema + migrations + BYOK 加密/token 雜湊 + append-only events + Tier 0 workspace（workspace.ts：load / 差異寫回）
│   │   └── src/auth-schema.ts     Better Auth 四張表（user/session/account/verification），與業務表只靠 email 鬆耦合
│   ├── sandbox/                   SandboxProvider 註冊表：docker、e2b（直接接）、computesdk.ts（一對多轉接頭 → daytona / vercel …）、local（dev）+ conformance.test.ts 同一把尺
│   ├── sdk/                       @nimplex/sdk：Nimplex client + CloudAgent（對齊 ai@7 Agent）+ SSE Transport
│   └── testkit/                   假的 Anthropic Messages 上游（e2e 不用真 key）+ sandbox conformance kit
├── examples/
│   └── quickstart/                src/index.ts 最小示範；src/harness-e2e.ts 自帶隔離 DB/API/worker 的完整驗收；src/e2e.ts 假上游冒煙；src/demo-kill.ts kill -9 續跑 demo
├── docs/
│   ├── product/                   決策與規格（日期前綴 .md；一律 Markdown 不用 HTML）
│   ├── competitor-analyze/        gitignored——絕不 commit
│   ├── file-structure.md          本文件
│   └── tech-stack.md              技術選型與理由
├── sandbox/                       gitignored 第三方工具試玩區（不進 pnpm workspace）
├── deploy/                        自架（VPS）用：docker-compose.yml（postgres+api+worker+caddy）、Caddyfile
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
db / sandbox ──► core + contracts
```

- api 與 worker **不互相呼叫**，只透過 Postgres 的 run 狀態機協調。
- 沒有 `/internal`：任何前端或工具只 import `@nimplex/sdk`——能做的事＝客戶能做的事。
