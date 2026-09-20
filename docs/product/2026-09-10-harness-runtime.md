# 2026-09-10 · Pi + just-bash harness: implementation and acceptance

> The default terminal/headless architecture now follows [the 09-13 local runtime](2026-09-13-local-runtime.md). Hosted API/worker behavior and earlier acceptance records below retain their historical or hosted scope.

This document describes the implemented runtime, superseding the 09-09 implementation proposal. Pi owns the model/tool loop; nimplex owns durability, execution ownership, accounting, cancellation, and recovery.

## Execution path

```text
SDK → API → Postgres ← worker → Pi → Anthropic
                ↑          ↓
        events / workspace / model_calls
                           ↓
                 read / write / edit / bash
                           ↓
             just-bash VFS or isolated native sandbox
```

API and worker coordinate exclusively through Postgres. Provider keys stay within the API/worker trust boundary; tools do not inherit worker environment variables. The four tools share `/workspace`; `read_output` and `read_log` expose durable raw output.

## Commit and recovery contract

A work item drives one Pi turn, with multiple awaited commit boundaries:

| Boundary | Atomic writes | Recovery after a crash |
| --- | --- | --- |
| Before model dispatch | Call ID, `model_calls` intent, `model.started` | Calls without a saved response become unknown |
| Complete model response | Full assistant message, tool calls, usage, settlement, `model.call` | Reuse the saved response and finish pending tools first |
| Each completed tool | Tool result, file byte deltas, complete metadata, workspace revision | Skip committed tools; discard and rerun uncommitted private VFS changes |
| End of turn | Work-item completion and the next item, or terminal run state | Do not duplicate scheduling or overwrite an existing kill/terminal state |

Every write validates lease owner, fence, lease expiry, and organization. Tools execute sequentially; model messages commit before tools, and tool results commit with the workspace. Expired workers cannot write results. Heartbeats abort execution when the lease is lost or the run terminates.

Event sequence allocation and insertion share a transaction. SSE resumes through `after` / `Last-Event-ID`. Archived `file.changed` events contain base64 bytes and SHA-256; `workspace.committed` contains metadata. Current file projections are directly readable from the DB. Normal transcripts/SSE carry hashes and metadata without repeatedly transporting binary bytes; `read_log` paginates raw deltas when needed.

## Accounting and cancellation

Updated 2026-09-20: USD budgets and monetary reservations are removed.

- Every request commits a call ID and `model.started` before provider dispatch.
  A failed intent commit prevents the request. Pi's own output/thinking settings
  are preserved; model selection does not depend on nimplex's price table.
- Responses, tool intents, usage and settlement commit together. Cost estimates
  come from Pi usage; settlements round upward to micro-USD and deduplicate by ID.
- Hidden SDK retries remain disabled so Pi's durable retry policy identifies each
  attempt. Output-limited responses may continue; incomplete tool calls never run.
- Lost responses produce `model.unknown`; their actual provider charge remains
  unknown. Invoice reconciliation is not implemented. No amount is reserved.
- Model, sandbox, storage and network charges are separate.
- Kill and duration caps still cancel through heartbeats. Late responses cannot
  overwrite terminal state; the reaper destroys terminal sandboxes.

## Tier 0 / Tier 1 / native

Tier 0 is the durable Postgres workspace. Tools use a private Tier 1 just-bash VFS; changes become recoverable only after a successful commit.

Supported state includes regular and binary files, deletion, rename, empty directories, workspace-local symlinks, and mode bits. Limits are 2,000 entries and 32 MiB including metadata. Hard-link identity, sockets, and devices are not preserved. `node_modules` is a reconstructible cache inside the native environment.

Bash parses the full AST first. Native binaries and dynamic commands route the whole script to the configured sandbox before execution. The runtime never executes half a script locally and then replays the whole script remotely. Without an isolated provider, native commands return an explicit tool error; they never run directly on the worker host.

E2B / Docker native commands run under an in-sandbox supervisor whose journal is addressed by run ID and tool-call ID. Reconnection collects the same result, avoiding repeated side effects after worker death. E2B pauses between tools and reconnects/resumes on demand. Lifecycle operations validate leases before and after provider IO, without holding a DB row lock, so kill/cancel remains available. Only durable terminal state authorizes sandbox deletion; an old worker cannot destroy its successor's environment. A late pause can be recovered by reconnecting to the same journal.

Reconstruction occurs only when the provider explicitly reports that the environment no longer exists. A new environment increments `sandbox_generation`, emits `environment.reset`, and restores Tier 0. A dispatched command whose result was not saved has unknown external side effects after environment loss; the runtime reports that uncertainty instead of blindly replaying it. This is not an exactly-once guarantee for arbitrary external systems.

The supervisor accepts tool timeouts up to 120 seconds. Expiry stops only that command's process group, preserves the sandbox and native cache, and saves workspace results. Journals are untrusted input; the worker validates their types, paths, entry counts, and sizes independently.

## Context

Long histories produce versioned extractive checkpoints retaining the initial prompt, recent complete assistant/tool pairs, and excerpts of older content. This is not an additional model-generated summary and incurs no summarization-model cost.

A checkpoint records its high-water event sequence and canonical JSON SHA-256 digest over the event projection containing file hashes without binary bytes. Recovery verifies the digest; invalid checkpoints are ignored and rebuilt from the log. Original events are never deleted. Models normally see the first 12,000 characters of tool output and can retrieve more through `read_output(tool_call_id, offset, limit)` or `read_log(event:<seq>, offset, limit)`.

## Development and acceptance

Start local Postgres and install dependencies:

```bash
docker compose up -d postgres
pnpm install
pnpm db:migrate
pnpm check
pnpm lint
pnpm test
pnpm e2e
```

`pnpm e2e` creates a temporary database, applies migrations, starts its own API, worker, and fake Anthropic server, then removes its processes and database. It defaults to `localhost:5433`. `NIMPLEX_TEST_POSTGRES_URL` can select a test Postgres account with CREATE DATABASE permission; do not point it at production.

Cloud acceptance reads `E2B_API_KEY` from the root `.env`. Real-model mode also needs `ANTHROPIC_API_KEY`:

```bash
pnpm e2e:e2b
pnpm e2e:real
node --env-file=.env node_modules/vitest/vitest.mjs run packages/sandbox/src/conformance.test.ts -t e2b
```

Accounting and fault-injection cases still use fake models. `e2e:real` additionally uses Haiku through Pi to execute Node in E2B, write a file, and read it back. Cloud tests create paid sandboxes and clean up their own resources.

Acceptance covers all four tools, binary/rename/delete behavior, contiguous and resumable SSE, tenant isolation, context/output pagination, output-limit continuation, zero-budget dispatch prevention, mid-run budget exhaustion, SIGKILL during a model call, mid-VFS crashes within multi-tool responses, crashes after compaction, unknown reservations, kill, duration limits, cancel/completion races, and SIGSTOP lease takeover. Real E2B cases cover native execution, pause/resume, environment reconstruction, native lease takeover, timeouts preserving cache, and API cancellation of native tools. The 2026-09-10 Haiku + E2B functional test passed with $0.006898 in model cost; all 12 E2B conformance cases passed. At that checkpoint, `pnpm check` and `pnpm lint` passed and `pnpm test` reported 55 passed / 36 skipped (unconfigured providers). Local development migrations 0008 and 0009 were applied.

## Migrations and configuration

- `0008_supreme_korvac.sql`: adds `model_calls`, workspace revision, and sandbox generation.
- `0009_long_carmella_unuscione.sql`: adds workspace metadata.
- Both are additive migrations after `0007`; earlier changes remain managed by their own migrations.
- `NIMPLEX_LEASE_SECONDS`: default 60, minimum 3; acceptance uses 3 seconds for faster recovery.
- `NIMPLEX_CONTEXT_CHARS`: history JSON threshold in UTF-8 bytes, default 64000; the existing environment variable name is retained.
- `.codex/config.toml` and `AGENTS.md` provide Codex configuration, sharing `CLAUDE.md` architecture guidance and `.agents/skills`.

## Review record

The 09-10 implementation received an Opus high review and a follow-up review after fixes. Actionable findings included cancellation races, SSE disconnect polling, native timeouts, DB lock scope during pause/delete, result loss after pause failure, tool argument descriptions, truncated-response continuation, and unknown model outcomes. These were fixed, with fault-injection coverage for truncation, cancellation races, and sandbox lifecycle behavior. This record applies to that implementation, not to later unreviewed changes.

Historical note: before 2026-09-20, unknown reservations retained budget because the provider might have billed a lost response. Monetary reservations have since been removed. Pi 0.85.1's `failToolCallsFromTruncatedMessage` rejects truncated tools in live turns; recovery applies the same rule, and E2E covers live turns. No new model calls after terminal state and lease checks before lifecycle operations remain required.

The test-only `examples/quickstart/src/pause-fault.ts` uses Node preload to inject failed or delayed E2B pause calls; production workers never load it. Pause failure records `sandbox.pause_failed` while committing the completed tool result normally. API kill can still update terminal state immediately during a slow pause.

## Terminal continuation (2026-09-13)

A new run can reference `parent_run_id`. The API locks the organization-scoped parent, requires terminal state, and atomically seeds its workspace and canonical conversation into the child. Branches have independent workspace rows; attachment overrides affect only the child. `context_mode: reset` omits inherited messages; `compact` requests extractive compaction. `execution_mode: read_only` removes write, edit, and bash tools in the worker. Continuation history does not trigger completed-turn recovery when a new user message follows it.

## Scheduled start (2026-09-18)

`POST /v1/runs` accepts `start_at` (ISO 8601 with offset; SDK `startAt`). The run
and its work item are created immediately, so the schedule survives API and worker
restarts, and the item carries `available_at`. Workers claim only items whose
`available_at` has passed, ordered by that time, so a scheduled run stays `queued`
until then and runs like any other run afterwards (accounting, lease, fence, takeover).
An invalid timestamp is a 400. This is the durable primitive for wake-ups; an
agent-facing "schedule a follow-up" tool is not implemented yet. Verified by the
scheduled-start scenario in `examples/quickstart/src/harness-e2e.ts`
(migration `0011_empty_bastion.sql`).

## Pi harness on the hosted worker (2026-09-18)

A run created with `engine: "pi-harness"` (`POST /v1/runs`, SDK `engine`) is one
leased work item of kind `harness`: the worker drives the whole Pi operation under
a single lease with heartbeat, instead of scheduling a work item per model/tool
step. `apps/worker/src/pi-harness-host.ts` implements the engine's host port on
PostgreSQL: Pi's session writes (`pi_*` tables, tenant-scoped by organization) and
nimplex's events, reservations, settlements and workspace snapshots commit in one
fenced transaction (`lockOwnedRun`), so a worker whose lease was taken over cannot
commit a stale boundary. Run configuration records `engine`, `context_mode`,
`thinking` and the Pi `session` id (the root run's id); continuations inherit the
engine (`engine_mismatch_with_parent` otherwise) and share the Pi session tree.
Lease loss detaches the operation, which the successor resumes from committed
state without repeating requests or tools; SIGKILL and SIGSTOP takeover are covered
by the `Pi harness` scenarios in `examples/quickstart/src/harness-e2e.ts`. Pi
extensions do not run on the hosted worker: they are tenant-supplied host code and
would need a per-tenant extension host. OpenAI models and thinking levels are
accepted for harness runs only; the legacy executor returns
`provider_requires_harness` / `thinking_requires_harness`.
