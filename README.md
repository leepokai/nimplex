# nimplex

**A durable coding-agent harness built on top of [Pi](https://github.com/earendil-works/pi).**

Pi drives the model and the tools. nimplex commits every model response, tool
result and file change to a log before the next step happens, so a run survives
a dead worker, a dead sandbox or a `kill -9`, every model call is accounted for
exactly once, and any run can be stopped mid-flight. The same runtime runs on a
laptop with SQLite and in the cloud with PostgreSQL.

> Status: early and pre-release. Open-sourced on 2026-09-20. Contracts, schemas
> and CLI flags change without notice. Read [What is not done yet](#what-is-not-done-yet)
> before relying on anything.

```text
SDK / curl ──► API (/v1) ──► Postgres ◄── worker ──► Pi ──► model provider
                              ▲            │
                    run_events, workspace, model_calls
                                           │
                                 read / write / edit / bash
                                           │
                        just-bash VFS  ──or──  Docker / E2B / ComputeSDK sandbox

nimplex CLI ──► the same runtime in-process, SQLite instead of Postgres
```

## Built on Pi

[Pi](https://github.com/earendil-works/pi) describes itself as "a minimal
terminal coding harness": a model/tool loop, a provider catalog, sessions with
branching and compaction, and TypeScript extensions, skills and prompt templates.
nimplex uses Pi's published packages (`@earendil-works/pi-agent-core`, `pi-ai`,
`pi-coding-agent`, `pi-tui`, pinned to 0.85.1, MIT) through their public APIs.
There is no fork and no patched internals.

| Comes from Pi | Added by nimplex |
| --- | --- |
| The agent loop: model requests, tool calls, streaming, retries | Commit barriers around every step: a model response is durable before its tools run, a tool result and workspace revision are durable before the next model call |
| Provider catalog and authentication: every built-in Pi provider, API keys, OAuth logins, Codex subscription | Call identity and settlement: a committed call ID before dispatch, atomic usage settlement, lost responses recorded as explicit unknown outcomes |
| Thinking levels, model switching, session tree, branch summaries, compaction, steering and follow-up queues | Ownership: an OS lock per state root locally, leases with fencing tokens and heartbeats in the hosted worker, so only one executor commits to a session at a time |
| Extensions, skills, prompt templates, context files, the terminal editor | Tiered tool execution: pure shell in an in-process VFS, native commands in a disposable sandbox, files in a durable workspace that outlives both |
| Session persistence through the public `AgentHarness` and its async `Storage` port | SQLite and PostgreSQL implementations of that port, sharing one transaction with nimplex's own events, accounting and workspace commits |
|  | Recovery after process death, durable cancellation, a hosted `/v1` API with resumable SSE, and a TypeScript SDK |

Two engines exist while the migration completes. `pi-executor` is the current
default: a host-owned Pi `Agent`, one turn per work item, nimplex-owned
persistence. `pi-harness` (`NIMPLEX_ENGINE=pi-harness`) runs Pi's public
`AgentHarness` on the same transaction; it is where Pi-native sessions,
compaction, branching, steering, thinking levels, the full provider catalog and
trust-gated extensions live. Existing sessions keep the engine they were created
with. The row-by-row state of Pi compatibility is tracked in the
[Pi compatibility inventory](docs/product/2026-09-15-pi-compatibility.md); a
command name alone is never counted as compatibility.

## What the harness guarantees

| Guarantee | How |
| --- | --- |
| **A run survives a dead worker** | Workers lease work items with fencing tokens and heartbeats. When a lease expires, another worker resumes from the log: committed model calls and tools are reused, only uncommitted tools re-execute. Locally, the runtime reopens the state root and resumes the interrupted turn. |
| **A run survives a dead sandbox** | Files live in a durable workspace (Tier 0), not in the sandbox. Native commands run under an in-sandbox supervisor whose journal is keyed by run and tool-call ID, so a second worker collects the same result instead of running the command twice. Confirmed sandbox loss creates a new generation, restores the workspace, and reports any command with unknown side effects instead of replaying it. |
| **Model usage is durable** | Each request has a committed call ID before dispatch. Responses and usage settle atomically, duplicate settlements are ignored, and lost responses remain explicit unknown outcomes. There is no USD spending limit. |
| **Any run can be killed** | `POST /v1/runs/:id/kill` (or cancelling a local turn) writes terminal state first. Heartbeats cancel the model call and tool in flight on whichever worker owns the run; a late response cannot overwrite a terminal state, and a cancelled tool never publishes a partial workspace. |
| **Accepted input is not duplicated** | Headless requests carry a session-scoped `--request-id`. Retrying the same ID replays the original turn's committed events; reusing it with different content fails. |

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

## Harness properties

**The log is the runtime.** The transcript, the model's context, the workspace
and crash recovery are all projections of one append-only history. No in-memory
state survives between turns by design. A crash between an assistant message
and its tool results is recovered exactly: only the missing tool calls execute,
against the last committed workspace, before the model is asked again.

**Execution tiers.**

| Tier | What | Persistence |
| --- | --- | --- |
| Tier 0 | Durable workspace in SQLite or Postgres: files, binary content, empty directories, workspace-local symlinks, mode bits | Every tool commit writes the byte delta and a workspace revision |
| Tier 1 | [just-bash](https://github.com/vercel-labs/just-bash) VFS inside the runtime process; 60+ commands, millisecond startup, no container | Private per tool call; becomes durable only on commit |
| Native | Docker, E2B, or ComputeSDK (Daytona, Vercel) sandbox | Disposable. E2B pauses between tools and resumes on demand; `node_modules` is a reconstructible cache |

Bash is parsed as a full shell AST before execution. Pure shell runs in the VFS;
native binaries and dynamic commands route the whole script to an isolated
sandbox. Nothing ever executes on the host that holds provider keys, and keys
never enter a sandbox.

**Context.** Long histories get versioned extractive context checkpoints with a
digest over the event projection; invalid checkpoints are ignored and rebuilt
from the log. Full tool output is archived and the model reads more through
`read_output` and `read_log`. On the harness engine, compaction and branch
summaries are Pi's own, committed durably.

**Sandboxes.** One `SandboxProvider` port, several implementations: `docker`,
`e2b`, `daytona`, `vercel` (through ComputeSDK) and `local` for development.
Every provider passes the same conformance kit
(`packages/sandbox/src/conformance.test.ts`). Serializable session state lets any
worker reconnect to, pause, resume or destroy a sandbox it did not create; only
a durable terminal state authorizes deletion, and an orphan reaper cleans up
after terminal runs. Sandbox journals are untrusted input, validated by type,
path, count and size.

**Accounting.** `spent_usd` records Pi's catalog-based model cost estimates,
rounded upward to micro-USD per call; call IDs deduplicate settlement and unknown
outcomes never imply a free request. Provider invoices remain authoritative.
`max_duration_seconds` caps wall-clock time. There is no monetary admission gate.

**Continuation.** `parent_run_id` seeds a new run with a terminal run's workspace
and conversation. `context_mode` is `continue`, `reset` or `compact`;
`execution_mode: read_only` removes `write`, `edit` and `bash`. `start_at`
schedules a hosted run. Attachments upload local files into `/workspace`.

**Control plane, SDK, auth.** A `/v1` API on Hono with resumable SSE
(`GET /v1/runs/:id/events` honors `Last-Event-ID`; the event sequence is the
cursor). `@nimplex/sdk` follows the Vercel AI SDK v7 `Agent` shape and depends
only on `@nimplex/contracts`, the Zod source of truth for every API shape.
Better Auth login (GitHub, Google) creates an organization; programmatic access
uses revocable `nmx_live_…` keys; BYOK provider keys are envelope-encrypted
(AES-256-GCM) and decrypted only inside the API/worker trust boundary. Every
query is scoped by `org_id`. There is no `/internal`: anything a first-party tool
can do, a customer can do through the SDK.

**Measured overhead** (`pnpm bench`, fake upstream with zero model latency, so
the numbers isolate nimplex's own durability cost): a six-tool turn costs about
36 ms and 89 durable commits on local SQLite; recovery after SIGKILL takes about
13 ms with no repeated side effects. Real provider latency dominates in
production. Details and caveats: [harness benchmark](docs/product/2026-09-18-harness-benchmark.md).

## Quickstart: terminal

Requirements: Node 22.13+ (for `node:sqlite`), pnpm 10. No server, no Postgres.

```bash
pnpm install
pnpm --dir apps/cli link --global         # puts `nimplex` on PATH (or: pnpm dev)

nimplex                                   # interactive
nimplex "Create /workspace/hello.js and run node hello.js to verify it"
printf 'Inspect the workspace' | nimplex
nimplex --resume SESSION_ID "Continue this task"
nimplex --resume SESSION_ID --request-id task-001 "Run this task once"
```

Set `ANTHROPIC_API_KEY`, run `nimplex login`, or keep the credential in the
project's `.env`. Defaults are Haiku 4.5 and E2B for native commands
(`E2B_API_KEY`) or `--sandbox docker`; just-bash-only tasks create no sandbox at
all. Local state lives in `~/.local/state/nimplex/<project-hash>`
(`NIMPLEX_STATE_DIR` overrides it); one runtime owns a state root at a time.

For the full installed Pi provider catalog, Pi-native sessions and extensions,
create a harness session:

```bash
nimplex login groq                         # delegates to Pi's OAuth or API-key flow
NIMPLEX_ENGINE=pi-harness nimplex --model groq/llama-3.3-70b-versatile "Your task"
nimplex login codex                        # personal Codex subscription
nimplex --model openai-codex/gpt-5.6-sol "Your task"
```

Inside the TUI: `/new`, `/resume`, `/fork`, `/rewind`, `/tree`, `/plan`
(read-only tools), `/compact`, `/background`, `/thinking`, `/model`, `/trust`,
`/extensions`, `/reload`, `/help`. `@path` attaches a local file to
`/workspace/path`. `/keymap claude` and `/keymap codex` select familiar bindings.
Guides: [local runtime](docs/product/2026-09-13-local-runtime.md),
[terminal controls](docs/product/2026-09-13-terminal-controls.md),
[resource reload](docs/product/2026-09-14-pi-resources.md),
[Codex subscription](docs/product/2026-09-15-codex-subscription.md).

## Quickstart: hosted

Requirements: Docker for Postgres.

```bash
docker compose up -d        # Postgres on :5433
pnpm db:migrate
NIMPLEX_DEV_EMAIL_AUTH=1 pnpm --filter @nimplex/api start &
pnpm --filter @nimplex/worker start &
pnpm --filter @nimplex/example-quickstart exec tsx src/e2e.ts   # signup, API key, Pi loop, tenant isolation; fake upstream, no charges
```

There is no console yet. Obtain a session with `POST /api/auth/sign-up/email`
(requires `NIMPLEX_DEV_EMAIL_AUTH=1`), then mint an `nmx_live_…` key through
`POST /v1/api-keys`.

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

`run.kill()` and `run.cancel()` terminate from the client;
`nimplex.sandbox.listProviders()` reports which providers the server has
configured. Full topology, environment variables and acceptance steps:
[local dev runbook](docs/product/2026-09-01-local-dev-runbook.md). A
single-VPS docker compose setup (Postgres, API, worker, Caddy) is in `deploy/`.

## Verification

```bash
pnpm check && pnpm lint && pnpm test
pnpm e2e          # isolated local DB, API, worker, fake model; no LLM charges
pnpm e2e:e2b      # real E2B: native tools, worker crashes, pause/resume, environment loss
pnpm e2e:real     # also real Haiku + E2B; reads credentials from .env
pnpm bench        # durability overhead, recovery time, storage growth
NIMPLEX_TEST_NATIVE=docker pnpm exec vitest run packages/runtime/src/native.integration.test.ts
```

`e2e` needs only local Postgres on :5433 and creates its own database.
`e2e:e2b` needs `E2B_API_KEY`; `e2e:real` also needs `ANTHROPIC_API_KEY`. Cloud
tests clean up the sandboxes they create. Accounting and recovery are tested
against `@nimplex/testkit`, a fake Anthropic Messages upstream, so the money path
never needs a real key. Process-death tests use real `SIGKILL` and `SIGSTOP`.

## Repository

| Directory | Contents |
| --- | --- |
| `apps/cli` | `nimplex` terminal and headless mode on the local runtime |
| `apps/api` | `/v1` control plane: Better Auth, org API keys, BYOK keys, runs, resumable SSE (Hono, :8787) |
| `apps/worker` | Work queue with leases, fencing and heartbeats; hosted Pi execution, usage accounting, cancellation, orphan sandbox reaper |
| `apps/site` | Marketing site (nimplex.dev) |
| `packages/runtime` | Pi execution (both engines), tools, context checkpoints, native execution, SQLite persistence and Pi `Storage` |
| `packages/contracts` | Zod schemas for runs, events, keys, organizations, sandbox specs: the single source of truth for API shapes |
| `packages/core` | Pure functions, zero IO: pricing, run state machine, conversation projection, `SandboxProvider` port |
| `packages/db` | Drizzle schema and migrations, BYOK encryption, append-only events, Tier 0 workspace, hosted Pi storage tables |
| `packages/sandbox` | `SandboxProvider` implementations: Docker, E2B, ComputeSDK (Daytona, Vercel), local; shared conformance tests |
| `packages/sdk` | `@nimplex/sdk`: client, `CloudAgent`, SSE transport |
| `packages/testkit` | Fake Anthropic upstream and sandbox conformance kit |
| `examples/quickstart` | SDK example, isolated acceptance suite, smoke test, worker `SIGKILL` demo, benchmark |
| `deploy/` | docker-compose and Caddyfile for a single-VPS self-host (manual deployment) |
| `docs/product` | Dated design records and the implemented runtime contracts |

Dependency direction: `cli → runtime → core/contracts/sandbox`; `worker → runtime + db`;
`api → db/core/contracts/sandbox`; `sdk → contracts`. `api` and `worker` never
call each other; they coordinate only through Postgres. See
[file structure](docs/file-structure.md) and [tech stack](docs/tech-stack.md).

## What is not done yet

- **Default engine.** `pi-executor` is still the default; the durable
  `pi-harness` engine is opt-in per new session. Cutover is pending.
- **Sandbox usage is not metered.** `spent_usd` is model cost only; sandbox,
  storage and network usage are not recorded.
- **Hosted providers.** Hosted dispatch supports Anthropic and OpenAI on the
  harness engine and Anthropic and Codex on the default engine. The full Pi
  catalog is local-only for now.
- **Extensions are partially bridged.** Local harness sessions load user
  extensions and, after `/trust`, project extensions: registered tools,
  system-prompt and provider-request hooks, tool call/result hooks and
  steer/follow-up messages work. Extension commands, UI, `setModel`, Pi packages
  and themes are not bridged, and the hosted worker does not run extensions.
- **Recovery restores files, not environments.** Native sandbox snapshots and
  browser session state are specified but not implemented.
- **No subagents, no web console, no journal pruning.** Storage grows about
  195 KiB per six-tool turn on SQLite until a pruning policy exists.
- **Workspace limits.** Tier 0 is capped at 2,000 entries and 32 MiB; each
  native command ships the workspace into the sandbox and reads it back. Fine for
  small projects, not monorepos.
- **Exactly-once holds for nimplex's own commits**, not for arbitrary external
  side effects. A command whose journal was lost is reported as unknown, never
  silently replayed. Arbitrary trusted extension IO is outside replay guarantees.

The implementation plan, gates and acceptance criteria are in
[durable Pi implementation plan](docs/product/2026-09-16-durable-pi-implementation-plan.md).
Dated documents under `docs/product/` describe decisions as they were made; the
implemented runtime contracts and current source win when they disagree.

## Design sources

- **Loop kernel**: [Pi](https://github.com/earendil-works/pi). Everything the
  model sees and every tool it calls goes through Pi; nimplex owns commit,
  ownership and recovery.
- **Durable cloud agents**: [Cloudflare Project Think](https://developers.cloudflare.com/agents/harnesses/think/)
  and its [announcement](https://blog.cloudflare.com/project-think/). nimplex
  borrows the shape of the promise (durable identity, persistence, resumable
  interaction, tool integration) and implements it on Pi with explicit commit
  barriers and a durable workspace instead of platform-owned actors.
  Comparison: [Think reference study](docs/product/2026-09-16-cloudflare-think-reference.md);
  positioning: [positioning map](docs/product/2026-09-16-positioning-map.md).
- **Log is the runtime**: Apache Maka, [`log-is-the-runtime.md`](https://github.com/apache/maka/blob/main/docs/blogs/log-is-the-runtime.md).
  nimplex adds what a cloud runtime needs on top of the event log: durable
  workspace, sandbox generations and lease fencing across workers.
- **Tier 1 shell**: [just-bash](https://github.com/vercel-labs/just-bash).
- **Agent interface**: Vercel AI SDK v7 `Agent`; `version` keeps interface
  evolution explicit.
- **Sandbox port**: OpenAI Agents SDK `SandboxClient` / `SandboxSession`;
  serializable session state is what makes cross-worker resume possible.

## License

[MIT](LICENSE). Pi, just-bash and the other dependencies keep their own licenses.
