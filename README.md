# nimplex

**A cloud coding-agent harness built on [Pi](https://github.com/earendil-works/pi), with a runtime that keeps runs alive when workers or sandboxes die, accounts for every model call durably, and can kill any run mid-flight.**

nimplex is inspired by [Cloudflare's Project Think](https://blog.cloudflare.com/project-think/): durable identity, persistence, and resumable execution for agents. It pursues the same promise for Pi agents while staying self-hostable (SQLite locally, PostgreSQL hosted) and keeping Pi's session and tool semantics; it does not use the Think harness or Durable Objects. See [the Think reference study](docs/product/2026-09-16-cloudflare-think-reference.md) for what was compared and what remains open.

nimplex runs the agent loop *outside* the sandbox. Pi drives the model and tools inside a nimplex worker; every model response, tool result, and file change is committed to an append-only event log in Postgres before the next step. The log is the runtime: the transcript, the model's context, the workspace, and crash recovery are all projections of the same history. Sandboxes are disposable compute. Provider keys never enter them.

```text
SDK / curl ──► API (/v1) ──► Postgres ◄── worker ──► Pi ──► Anthropic
                              ▲            │
                    run_events, workspace, model_calls
                                           │
                                 read / write / edit / bash
                                           │
                        just-bash VFS  ──or──  Docker / E2B / ComputeSDK sandbox

nimplex CLI ──► the same runtime in-process, SQLite instead of Postgres
```

## What the runtime guarantees

| Guarantee | How |
| --- | --- |
| **A run survives a dead worker** | Workers lease work items with fencing tokens and heartbeats. When a lease expires, another worker resumes from the log: committed model calls and tools are reused, only uncommitted tools re-execute. |
| **A run survives a dead sandbox** | Files live in a durable Postgres workspace (Tier 0). Native commands run under an in-sandbox supervisor whose journal is keyed by run and tool-call ID, so a second worker collects the same result instead of running the command twice. Confirmed sandbox loss creates a new generation, restores the workspace, and reports any command with unknown side effects instead of replaying it. |
| **Model usage is durable** | Each request has a committed call ID before dispatch. Responses and usage settle atomically, duplicate settlements are ignored, and lost responses remain explicit unknown outcomes. There is no USD spending limit. |
| **Any run can be killed** | `POST /v1/runs/:id/kill` writes terminal state to Postgres. Heartbeats cancel the model call and tool in flight on whichever worker owns the run; a late response cannot overwrite a terminal state. |

Recorded demo (`examples/quickstart/src/demo-kill.ts`, real Haiku, about $0.006):

```text
#1  run.started   by worker-A
#2  model.call    toolUse $0.0017
#4  tool.call     bash {"command":"date"}
#7  model.call    toolUse $0.0022
>>> kill -9 worker A
#9  tool.call     write {"path":"/workspace/hello.txt", ...}
#15 run.resumed   by worker-B            <- lease expires; another worker resumes from the log
#16 model.call    stop $0.0021
#19 run.completed spent $0.006
Tier 0 /workspace/hello.txt (28 B): Wed Sep  9 09:49:11 UTC 2026
```

## Features

**Harness**

- Pi (`@earendil-works/pi-agent-core`) is the loop kernel: one work item drives one turn, `read` / `write` / `edit` / `bash` are nimplex tools, and the transcript is projected from `model.call` and `tool.result` events on every turn. No in-memory state survives between turns by design.
- Bash is parsed as a full AST before execution. Pure shell runs in a [just-bash](https://github.com/vercel-labs/just-bash) in-memory VFS with no container; native binaries and dynamic commands route the whole script to an isolated sandbox. Nothing ever executes on the worker host.
- Long histories get versioned extractive context checkpoints with a digest over the event projection. Invalid checkpoints are ignored and rebuilt from the log. Full tool output is archived; the model reads more through `read_output` and `read_log`.
- A crash between an assistant message and its tool results is recovered exactly: only the missing tool calls execute, against the last committed workspace, before the model is asked again.

**Execution tiers**

| Tier | What | Persistence |
| --- | --- | --- |
| Tier 0 | Durable workspace in Postgres: files, binary content, empty directories, workspace-local symlinks, mode bits | Every tool commit writes the byte delta and a workspace revision |
| Tier 1 | just-bash VFS inside the worker process | Private per tool call; becomes durable only on commit |
| Native | Docker, E2B, or ComputeSDK (Daytona, Vercel) sandbox | Disposable. E2B pauses between tools and resumes on demand; `node_modules` is a reconstructible cache |

**Sandboxes**

- One `SandboxProvider` port, several implementations: `docker`, `e2b`, `daytona`, `vercel` (through ComputeSDK), and `local` for development. Every provider passes the same conformance kit (`packages/sandbox/src/conformance.test.ts`).
- Serializable session state in `runs.sandbox_state` lets any worker reconnect to, pause, resume, or destroy a sandbox it did not create. Only a durable terminal state authorizes deletion; an orphan reaper cleans up after terminal runs.
- Tool timeouts stop only that command's process group and preserve the sandbox. Sandbox journals are untrusted input and are validated by type, path, count, and size.

**Accounting**

- Local harness sessions use the installed Pi provider/model catalog and native provider adapters. Hosted dispatch currently supports Anthropic and OpenAI; the default legacy executor supports Anthropic and Codex.
- `spent_usd` records Pi's catalog-based model cost estimates, rounded upward to micro-USD per call. Call IDs deduplicate settlement; unknown outcomes do not imply a free request. Provider invoices remain authoritative.
- `max_duration_seconds` caps wall-clock time. Model, sandbox, storage, and network charges are separate. There is no monetary admission gate or output cap imposed by nimplex.


**Continuation**

- `parent_run_id` seeds a new run with a terminal run's workspace and conversation. `context_mode` is `continue`, `reset`, or `compact`; `execution_mode: read_only` removes `write`, `edit`, and `bash`.
- Attachments upload local files into `/workspace` at run creation.

**Control plane, SDK, auth**

- `/v1` API on Hono with resumable SSE: `GET /v1/runs/:id/events` honors `Last-Event-ID`, using the event sequence as cursor.
- `@nimplex/sdk` follows the Vercel AI SDK v7 `Agent` shape (`version`, `generate`, `stream`); it depends only on `@nimplex/contracts`, the zod source of truth for every API shape.
- Better Auth login (GitHub, Google) creates an organization; programmatic access uses revocable `nmx_live_…` keys. BYOK provider keys are envelope-encrypted (AES-256-GCM) and decrypted only inside the API/worker trust boundary. Every query is scoped by `org_id`.
- There is no `/internal`. Anything a first-party tool can do, a customer can do through the SDK.

**Terminal**

- `nimplex` runs the same harness on your laptop with SQLite instead of Postgres: sessions, resume, fork and rewind, background turns, `@path` attachments, and the same just-bash-first routing with Docker or E2B for native commands. No API server or worker is required.

## Quickstart (hosted)

Requirements: Node 22.13+, pnpm 10, Docker.

```bash
pnpm install
docker compose up -d        # Postgres on :5433
pnpm db:migrate
NIMPLEX_DEV_EMAIL_AUTH=1 pnpm --filter @nimplex/api start &
pnpm --filter @nimplex/worker start &
pnpm --filter @nimplex/example-quickstart exec tsx src/e2e.ts   # signup, API key, Pi loop, tenant isolation; fake upstream, no charges
```

There is no console yet. Obtain a session with `POST /api/auth/sign-up/email` (requires `NIMPLEX_DEV_EMAIL_AUTH=1`), then mint an `nmx_live_…` key through `POST /v1/api-keys`.

```bash
export NIMPLEX_API_KEY=nmx_live_...

# Store your model credential. Plaintext travels in this one request only.
curl -X PUT localhost:8787/v1/provider-keys \
  -H "authorization: Bearer $NIMPLEX_API_KEY" -H 'content-type: application/json' \
  -d '{"provider":"anthropic","api_key":"sk-ant-...","scope":"org"}'

# Start a run.
curl -X POST localhost:8787/v1/runs \
  -H "authorization: Bearer $NIMPLEX_API_KEY" -H 'content-type: application/json' -d '{
  "model":{"provider":"anthropic","id":"claude-sonnet-5"},
  "sandbox":{"provider":"docker"},
  "instructions":"Create hello.txt in /workspace"
}'

# Follow the log; reconnect with Last-Event-ID to resume.
curl -N -H "authorization: Bearer $NIMPLEX_API_KEY" localhost:8787/v1/runs/<run_id>/events

# Stop it.
curl -X POST -H "authorization: Bearer $NIMPLEX_API_KEY" localhost:8787/v1/runs/<run_id>/kill
```

Full topology, environment variables, and acceptance steps: `docs/product/2026-09-01-local-dev-runbook.md`. Self-hosting on a VPS with docker compose (Postgres, API, worker, Caddy): `deploy/`.

## SDK

```ts
import { Nimplex } from "@nimplex/sdk";

const nimplex = new Nimplex({ baseUrl: process.env.NIMPLEX_BASE_URL });

const agent = nimplex.agent({
  model: { provider: "anthropic", id: "claude-sonnet-5" },
  sandbox: { provider: "e2b" },
  instructions: "Fix CI",
});

const run = await agent.stream({ prompt: "The tests keep failing" });
for await (const event of run.events) console.log(event.seq, event.type, event.payload);
console.log(await run.wait()); // status, spent_usd
```

`run.kill()` and `run.cancel()` terminate from the client. `nimplex.sandbox.listProviders()` reports which providers are configured on the server. See `examples/quickstart/src/index.ts`.

## Terminal

`/reload` refreshes terminal preferences, prompt templates and skill instructions
without dropping the current session. `/hotkeys`, `/name`, `/session`, `/tree`
and `/clone` provide Pi-style command entry points. See the
[resource reload guide](docs/product/2026-09-14-pi-resources.md) for paths,
template examples, command differences and the limits of hot reload.

The terminal uses distinct prompt blocks, compact tool previews, expandable
output, and a multiline composer. Press `?` on empty input for shortcuts,
`Alt+R` for tool details, or `Ctrl+S` to stash a draft. `/keymap claude` and
`/keymap codex` select familiar bindings. See the
[terminal controls guide](docs/product/2026-09-13-terminal-controls.md) for the
complete mapping, terminal setup and supported capabilities.

```bash
pnpm install
pnpm --filter @nimplex/cli start          # or: pnpm dev
pnpm --dir apps/cli link --global         # puts `nimplex` on PATH

nimplex
nimplex "Create /workspace/hello.js and run node hello.js to verify it"
nimplex --timeout 300 "Your task"
printf 'Inspect the workspace' | nimplex
nimplex --resume SESSION_ID "Continue this task"
nimplex --resume SESSION_ID --request-id task-001 "Run this task once"
```

For headless retries, reuse the same session, `--request-id`, prompt and options.
The CLI returns the original turn and replays its committed events. Reusing an ID
with changed content fails. Retrying acceptance never restarts interrupted work;
explicitly resume that turn separately. The CLI prints the generated request ID
when one was not supplied.

Set `ANTHROPIC_API_KEY`, run `nimplex login`, or keep the credential in the project's `.env`; `ANTHROPIC_BASE_URL` selects a compatible endpoint. Defaults are Haiku 4.5, E2B for native commands (`E2B_API_KEY`) or `--sandbox docker`, a 180-second execution limit. just-bash-only tasks create no sandbox at all.

For personal Codex subscription access, run `nimplex login codex`, then
`nimplex --model openai-codex/gpt-5.6-sol`. `/model` also lists the installed Pi
Codex catalog. Subscription quota is provider-managed. See [Codex subscription setup](docs/product/2026-09-15-codex-subscription.md).
For the full installed Pi provider catalog, create a harness session:

```bash
nimplex login groq
NIMPLEX_ENGINE=pi-harness nimplex --model groq/llama-3.3-70b-versatile "Your task"
```

`nimplex login PROVIDER` delegates additional provider login to Pi (OAuth when
available, otherwise API-key setup). Pi environment credentials, including ambient
cloud credentials, also work. Provider IDs and model IDs come from the installed
catalog; `/model` lists them. Existing sessions retain their engine. Credentials
stay in nimplex's private configuration files and are never passed to tools.

Current Pi support and remaining gaps are tracked in the
[Pi compatibility inventory](docs/product/2026-09-15-pi-compatibility.md).

Inside the TUI: `/new`, `/resume`, `/fork`, `/rewind`, `/plan` (read-only tools), `/compact`, `/background`, `/help`. `@path` attaches a local file to `/workspace/path`. Local state lives in `~/.local/state/nimplex/<project-hash>` (override with `NIMPLEX_STATE_DIR`); one runtime owns a state root at a time. Details: `docs/product/2026-09-13-local-runtime.md` and `docs/product/2026-09-12-terminal-experience.md`.

## Verification

```bash
pnpm check && pnpm lint && pnpm test
pnpm e2e          # isolated local DB, API, worker, fake model; no LLM charges
pnpm e2e:e2b      # real E2B: native tools, worker crashes, pause/resume, environment loss
pnpm e2e:real     # also real Haiku + E2B; reads credentials from .env
NIMPLEX_TEST_NATIVE=docker pnpm exec vitest run packages/runtime/src/native.integration.test.ts
```

`e2e` needs only local Postgres on :5433; it creates and removes its own database. `e2e:e2b` needs `E2B_API_KEY`, `e2e:real` also `ANTHROPIC_API_KEY`. Cloud tests clean up the sandboxes they create. The money path is tested against `@nimplex/testkit`, a fake Anthropic Messages upstream, so accounting and settlement logic never needs a real key.

## Repository

| Directory | Contents |
| --- | --- |
| `apps/api` | `/v1` control plane: Better Auth, org API keys, BYOK keys, runs, resumable SSE (Hono, :8787) |
| `apps/worker` | Work queue with leases, fencing, and heartbeats; drives the shared Pi executor one turn at a time; usage accounting, cancellation, orphan sandbox reaper |
| `apps/cli` | `nimplex` terminal and headless mode on the local runtime |
| `apps/site` | Marketing site (nimplex.dev) |
| `packages/contracts` | Zod schemas for runs, events, keys, organizations, sandbox specs. The single source of truth for API shapes |
| `packages/core` | Pure functions, zero IO: pricing, run state machine, conversation projection, `SandboxProvider` port |
| `packages/runtime` | Shared Pi executor, tools, context checkpoints, native execution; local session ownership on SQLite |
| `packages/db` | Drizzle schema and migrations, BYOK encryption, append-only events, Tier 0 workspace |
| `packages/sandbox` | `SandboxProvider` implementations: Docker, E2B, ComputeSDK (Daytona, Vercel), local; shared conformance tests |
| `packages/sdk` | `@nimplex/sdk`: client, `CloudAgent`, SSE transport |
| `packages/testkit` | Fake Anthropic upstream and sandbox conformance kit |
| `examples/quickstart` | `index.ts` minimal SDK example, `harness-e2e.ts` isolated acceptance suite, `e2e.ts` smoke test, `demo-kill.ts` worker SIGKILL recovery |
| `deploy/` | docker-compose and Caddyfile for a single-VPS self-host |

Dependency direction: `apps/* → packages/*`; `sdk → contracts` only; `core → contracts`; `db`, `sandbox`, `runtime → core + contracts`. `api` and `worker` never call each other; they coordinate only through the run state machine in Postgres.

## Current limits

- Anthropic models only (BYOK, optional `base_url`).
- Tier 0 workspace is capped at 2,000 entries and 32 MiB; large dependency trees live in the sandbox as a rebuildable cache.
- Each native command ships the workspace into the sandbox and reads it back. Fine for the workspace size above, not for monorepos yet.
- E2B sandboxes have a provider lifetime (1 hour on Hobby, `NIMPLEX_E2B_LIFETIME_MS` to override); the runtime handles expiry as environment loss.
- Exactly-once holds for nimplex's own commits, not for arbitrary external side effects. A command whose journal was lost is reported as unknown, never silently replayed.
- No web console. The API and SDK are the product surface.

## Design sources

- **Durable cloud agents**: [Cloudflare Project Think](https://developers.cloudflare.com/agents/harnesses/think/) and its [announcement](https://blog.cloudflare.com/project-think/). nimplex borrows the shape of the promise, durable identity, persistence, resumable interaction, and tool integration, and implements it on Pi with explicit commit barriers and a durable workspace instead of platform-owned actors. Comparison and open questions: [`docs/product/2026-09-16-cloudflare-think-reference.md`](docs/product/2026-09-16-cloudflare-think-reference.md), positioning: [`docs/product/2026-09-16-positioning-map.md`](docs/product/2026-09-16-positioning-map.md).
- **Log is the runtime**: Apache Maka, [`docs/blogs/log-is-the-runtime.md`](https://github.com/apache/maka/blob/main/docs/blogs/log-is-the-runtime.md). nimplex adds what a cloud runtime needs on top of the event log: durable workspace, sandbox generations, and lease fencing across workers.
- **Loop kernel**: [Pi](https://github.com/earendil-works/pi) with custom tool `operations` and one-turn-per-work-item scheduling.
- **Agent interface**: Vercel AI SDK v7 `Agent`; `version` keeps interface evolution explicit.
- **Sandbox port**: OpenAI Agents SDK `SandboxClient` / `SandboxSession`; serializable session state is what makes cross-worker resume possible.

Runtime contract and migration notes: `docs/product/2026-09-10-harness-runtime.md`. Architecture invariants: `docs/product/2026-09-01-architecture.md`.

Long-term cloud direction and alternatives: [cloud agent architecture candidates](docs/product/2026-09-15-cloud-agent-candidates.md).
Reference study: [Grok Bot host, scheduling, and persistence](docs/product/2026-09-15-grok-bot-reference.md).
These records distinguish the current implementation from proposed changes.

## License

Apache-2.0.
