# Local development runbook: topology, startup, and acceptance

> Historical, 2026-09-20: the hosted API, worker, PostgreSQL schema, SDK and VPS
> deployment described below were removed from the repository. The local `nimplex`
> CLI and its SQLite runtime are the only supported operation; see
> [local runtime](2026-09-13-local-runtime.md). This file is kept as a record of the
> earlier hosted setup and its acceptance steps.

> **2026-09-20:** USD budgets have been removed. Run migration 0012 before starting
> updated hosted services. `pnpm e2e` now checks uncapped execution/accounting,
> unknown outcomes, cancellation and recovery. Earlier budget acceptance below
> is historical. Local harness sessions select from Pi's installed provider catalog;
> use `nimplex login PROVIDER` and `NIMPLEX_ENGINE=pi-harness nimplex --model provider/id`.


> The default terminal/headless architecture now follows [the 09-13 local runtime](2026-09-13-local-runtime.md). Hosted API/worker behavior and earlier acceptance records below retain their historical or hosted scope.

> **Current acceptance as of 2026-09-10:** start Postgres with `docker compose up -d`, then run `pnpm e2e`. Use `pnpm e2e:e2b` for real E2B or `pnpm e2e:real` for Haiku + E2B.
> These commands create and clean up isolated DB/API/worker resources. Accounting now reserves before dispatch, and recovery uses model/tool checkpoints. The older descriptions below of rerunning whole turns and one-call overshoot are historical. See [the runtime contract](2026-09-10-harness-runtime.md).
> **09-06 removal notice:** console, /gw gateway, harness registry, Managed Agents, and db:seed were removed. Sections mentioning them record earlier behavior. Use the root README for the current shortest startup path.
> Originally recorded on 2026-09-01 after Better Auth/org keys, /v1 authentication, real console APIs, and 11/11 smoke acceptance. Follows the architecture and SDK documents of the same date.

## 1. Local topology

Postgres and per-run Docker sandboxes run in containers. API/worker and the historical console run as local Node processes; deployment containerization is described in architecture §9.

| Service | Location | Port | Command | Definition |
|---|---|---|---|---|
| Postgres | Docker Compose | 5433 | docker compose up -d | docker-compose.yml |
| API control plane | Local tsx | 8787 | pnpm --filter @nimplex/api start | apps/api |
| Worker execution | Local tsx | No public port | pnpm --filter @nimplex/worker start | apps/worker |
| Optional marketing site | Vite | 5176 | pnpm --filter @nimplex/site dev | apps/site |
| Run sandbox | Docker, worker-managed | — | Created/deleted on demand | packages/sandbox/src/docker.ts |

- The removed console proxied /v1 and /api to :8787 through Vite for same-origin cookies.
- Worker and API never call each other; Postgres coordinates run state.
- Docker's default image is node:22-bookworm-slim, overridable with NIMPLEX_DOCKER_IMAGE. The old gateway path used host.docker.internal:8787; current Pi model calls run in the worker.

## 2. Cold start

```bash
pnpm install
docker compose up -d          # Postgres on :5433
pnpm db:migrate               # Includes Tier 0 workspace_files
pnpm --filter @nimplex/api start &
pnpm --filter @nimplex/worker start &
```

The historical onboarding opened localhost:5173, signed in with GitHub/Google, created an organization automatically, and issued an nmx_live key on the API keys page. The console no longer exists; use the README's API onboarding and `nimplex login` for the terminal client.

## 3. Root environment file

API and worker load `.env` at startup; existing process variables take precedence. `.env.example` is the template; actual `.env` contains secrets and is ignored by Git.

| Variable | Purpose | Local state recorded on 09-01 |
|---|---|---|
| DATABASE_URL | Postgres connection | Defaults match Compose :5433 |
| NIMPLEX_MASTER_KEY | AES-256-GCM BYOK master key | Unset used a fixed development key with warning |
| BETTER_AUTH_SECRET | Session signing | Generated and saved |
| NIMPLEX_PUBLIC_URL | Public/OAuth callback base URL; formerly gateway too | Default localhost:8787 |
| NIMPLEX_TRUSTED_ORIGINS | Allowed /api/auth origins | Defaults included :5173 and :8787 |
| GITHUB_CLIENT_ID/SECRET | GitHub login | Configured in “nimplex local dev” OAuth app under leepokai |
| GOOGLE_CLIENT_ID/SECRET | Google login | Configured in nimplex-dev, project hopeful-seat-507308-v1 |
| NIMPLEX_DEV_EMAIL_AUTH=1 | Development email signup/login | Disabled except during E2E |
| NIMPLEX_ALLOW_LOCAL_SANDBOX=1 | Unisolated local sandbox | Disabled by default |

## 4. Authentication recorded on 09-01

- Better Auth 1.7.2 console login offered GitHub/Google only. Public GET /api/auth-providers determined available buttons from configured providers.
- databaseHooks.user.create.after created organization and owner membership. Same-email providers linked to one user, verified without duplicate organizations.
- Every /v1 route accepted either an org Bearer key or session cookie through the same endpoint. API keys are hashed, revocable, and return 401 immediately after revocation.
- Every run route scopes by organization; cross-tenant access returns 404.
- Google was in Testing mode with only the developer's own Google account on the test list. Add testers through Google Auth Platform → Audience.
- Production nimplex.dev needs separate OAuth credentials, production callbacks, and Google publication/verification rather than reusing local credentials.

## 5. Historical smoke acceptance, rewritten 09-09

```bash
# Requires a running API/worker and temporarily enabled development email auth.
pnpm --filter @nimplex/example-quickstart exec tsx src/e2e.ts
```

The recorded flow covered unauthenticated 401, signup/org creation, API key issuance, BYOK storage, providers, and a fake Pi loop with four bash tool calls and five model.call events. At the then-used Sonnet-5 prices, 1000 input/500 output tokens cost $0.007 per call, $0.035 total under a $1 cap. The old mid-run test used a $0.02 cap and killed after the third call at $0.021. Required budget, cross-tenant 404, and revoked-key 401 also passed on 09-09. Current reservation-based expectations live in harness-e2e.ts.

### 5.0 Fake upstream without real keys

The historical E2E/demo scripts could start a fake Anthropic server on :8790 and point BYOK base_url at it. Pi's adapter, worker accounting, budgets, and Tier 0 followed real code paths; only the final model-provider hop was fake.

- Official Messages API shapes, including nonstreaming and SSE with usage in message_start/message_delta.
- toolCalls=n emits bash tool_use while the conversation has fewer than n tool_result blocks, writing `echo "fake step k" > /workspace/step-k.txt`, then ends the turn. Stateless behavior isolates concurrent runs. delayMs gives crash demos time to intervene.
- Manual server: `pnpm --filter @nimplex/testkit start`; use any fake BYOK key and base_url=http://localhost:8790.
- Some historical demo modes switched to paid upstream when ANTHROPIC_API_KEY was present, so fixed-cost assertions applied only to fake mode. Current `pnpm e2e` deliberately uses the fake provider for accounting tests regardless of local model credentials.

### 5.3 Worker SIGKILL demo, added 09-09

The claim is recovery after worker death with bounded spending.

```bash
# Start API with development email auth, but no worker; the script manages workers A and B.
pnpm --filter @nimplex/example-quickstart exec tsx src/demo-kill.ts
# Real Haiku rehearsal; approximately $0.006 in the recorded run:
set -a; source .env; set +a; pnpm --filter @nimplex/example-quickstart exec tsx src/demo-kill.ts
```

Create a $0.20 run, wait for its second model.call, SIGKILL A, let the lease expire within 60 seconds, start B, observe run.resumed, rebuild Pi messages from events and VFS from Tier 0, then complete within budget. GET files shows four fake step files or real hello.txt with that day's date. The original implementation replayed an uncommitted turn and could pay for another model request; the 09-10 model/tool checkpoint contract supersedes that behavior.

### 4.1 Sandbox conformance, added 09-02

`pnpm vitest run packages/sandbox` uses testkit's describeSandboxConformance for local/Docker/E2B and ComputeSDK adapters. C0–C10 plus C1b cover lifecycle, env, working directory, JSON state round-trip/resume, delete without resume, exec failure after stop, real timeout/signal cancellation, live stdout, and idempotent deletion.

Unavailable providers skip: missing Docker daemon or E2B/DAYTONA/VERCEL credentials. Real E2B passed 12/12 on 09-02; Daytona/Vercel awaited keys. Add every provider to conformance.test.ts before assessing its gaps. Local declares absolutePaths:false because /workspace is a virtual mapping.

### Removed 5.1 / 5.2

Managed Agents and claude-code × E2B CLI-in-a-box tests were removed on 09-06 (harness decision §6, historical commit 0f32657). Native Tier 2 integration was scheduled for Slice 2 and subsequently implemented in the 09-10 runtime.

## 7. Self-hosted cloud development: VPS and Compose

Added 09-03, removed 2026-09-20. The E2B sandbox needed a public API without tunnels, so one VPS (2 vCPU/4 GB on DigitalOcean) ran Postgres/API/worker/Caddy through `deploy/docker-compose.yml`, built and deployed by a `deploy-dev` GitHub workflow (two images to GHCR, then SSH pull → migrate → up) on every push to the `dev` branch. The workflow, `Dockerfile`, `.dockerignore`, `deploy/` and the hosted services themselves are no longer in the repository; the steps below are a record and cannot be followed against the current tree. Console was excluded, with SDK acceptance instead.

Recorded deployment: DO droplet nimplex-dev, sgp1, s-2vcpu-4gb. On 09-03 commit 0f32657, Caddy TLS and four healthy services passed; cloud claude-code-e2b.ts completed in 19 seconds at $0.049 without a tunnel.

```bash
# One-time Ubuntu 24.04 VPS setup
curl -fsSL https://get.docker.com | sh && usermod -aG docker $USER
mkdir -p /opt/nimplex && cd /opt/nimplex
# Copy deploy/docker-compose.yml and Caddyfile; create .env from deploy/.env.example.
# Generate NIMPLEX_MASTER_KEY, BETTER_AUTH_SECRET, POSTGRES_PASSWORD with openssl rand.
# Configure NIMPLEX_PUBLIC_URL and SITE_ADDRESS for automatic TLS, plus E2B credentials.
# Development email signup is optional and must be intentionally enabled.
echo $GHCR_TOKEN | docker login ghcr.io -u leepokai --password-stdin
docker compose pull && docker compose run --rm migrate && docker compose up -d

# Historical combination test, removed on 09-06
NIMPLEX_BASE_URL=http://<ip> NIMPLEX_API_KEY=nmx_live_... ANTHROPIC_API_KEY=sk-ant-... \
  pnpm --filter @nimplex/example-quickstart exec tsx src/claude-code-e2b.ts
```

- Local deploy validation on 09-03 passed build/up, migration/then-existing seed, API health through Caddy, worker startup, signup/key issuance, E2B availability inside containers, unavailable Docker/local as expected, and builtin-loop completion.
- Images were 1.38 GB because the whole workspace matched lockfile importers; build took 30 seconds. Consider pnpm deploy for slimming later.
- Worker containers lack a Docker daemon. Local Docker sandboxes on the VPS require a deliberate docker.sock mount; remote providers work without it.
- Enabling development email auth allows anyone with the URL to register and consume sandbox credentials. Keep that dev endpoint private and disable open signup in production.

## 6. Troubleshooting

| Symptom | Cause / resolution |
|---|---|
| API EADDRINUSE on :8787 | Inspect the old listener with lsof, then stop the identified stale process |
| Historical console starts on 5174/5175 | An earlier Vite process owns 5173; inspect and restart |
| Google 403 access_denied | Account absent from the test-user list in §4 |
| E2E signup 500/400 | Enable NIMPLEX_DEV_EMAIL_AUTH=1 and restart API |
| .env changes do not apply | Restart API/worker; files load at startup |
| Docker startup stalls | Ensure Docker Desktop is running and pull node:22-bookworm-slim first |

## 8. Terminal client

With services running, use `nimplex login` (Anthropic), `nimplex login openai` or `nimplex login codex`, then `nimplex`. `NIMPLEX_ENGINE=pi-harness` opts new sessions into the experimental Pi harness engine described in [the local runtime contract](2026-09-13-local-runtime.md#pi-harness-engine-opt-in-added-2026-09-17); existing sessions keep their recorded engine. OpenAI models (`--model openai/gpt-5.4-mini`) and `--thinking LEVEL` require that engine. `/help` lists commands. Conversations and preferences are stored under the user configuration directory, scoped to API endpoint and organization. Follow-ups seed new runs from the preceding terminal run. `@path` attaches selected local text files; local AGENTS.md/CLAUDE.md are reread on each task. Runtime code changes require service restart unless a separate development watcher is configured.
