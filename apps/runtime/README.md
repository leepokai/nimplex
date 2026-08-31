# @nimplex/runtime

Web 端 agent runtime 的第一個垂直切片：一個 end user 對應一個 Durable Object session，
agent 擁有一台持久的雲端電腦（Cloudflare Sandbox 容器），可跑 shell、讀寫檔案。

跑在 Cloudflare Workers 上：

- **`AgentSession`（Durable Object）** — 每個 session 一個實例，DO 單線程序列化＝天然不會有兩個 turn 打架。
  裡面有 agent 迴圈、不可變事件日誌、SSE 廣播、以及**電表**。
- **`Sandbox`（Durable Object + Container）** — agent 的雲端電腦，狀態跨工具呼叫持續。
- **Worker（Hono）** — HTTP 介面，外加一個 dev 測試頁。

## 為什麼電表在 DO 裡面

每次模型回應後就地累計花費，超過 `budget_usd` 直接終止跑到一半的 run（`budget_exceeded` 事件）。
代理型工具做不到這件事——它們只能在請求進門時擋，管不到已經在跑的迴圈。這是本專案的核心賣點。

## 本地開發

需要 Docker 在跑（容器沙箱要用）。

```bash
cp .dev.vars.example .dev.vars   # 填入真正的 ANTHROPIC_API_KEY
pnpm dev                          # 首次會建 container image，約 2–3 分鐘
```

開 http://localhost:8787 就是測試頁：建 session → 送訊息 → 看事件與電表即時跳動。

不想動模型、只想確認沙箱有沒有接通：

```bash
curl http://localhost:8787/__dev/sandbox-smoke
```

## HTTP 介面

| 方法 | 路徑 | 說明 |
| --- | --- | --- |
| `POST` | `/v1/sessions` | 建 session（`end_user`、`budget_usd`、`model`、`instructions`） |
| `POST` | `/v1/sessions/:id/messages` | 送一則訊息，非同步跑一個 turn（202） |
| `GET` | `/v1/sessions/:id/events` | SSE 事件流，`?after=<seq>` 可續傳 |
| `GET` | `/v1/sessions/:id` | 目前狀態與花費 |

事件型別：`session_created`、`user_message`、`assistant_text`、`tool_call`、`tool_result`、
`usage`、`budget_exceeded`、`turn_completed`、`refusal`、`error`。

## 已知邊界（刻意留著）

- **契約還沒上移** — 請求/回應形狀暫時定義在本套件內，`TODO(P0)` 標了要搬進 `@nimplex/contracts` 的位置。
- **三道閘只做了電表** — 門禁（工具權限 allow/ask/deny＋durable 審批）與鑰匙櫃（per-end-user 憑證注入）是 P3。
- **沒有驗證** — 目前任何人都能建 session。Server/Client SDK 的 token 分級是 P4。
- **egress 無管控** — 沙箱內可連任何地方，網控是 P3（M4）。
- 價格表寫死在 `session.ts`，之後應改用 AI Gateway 回報的實際成本。
