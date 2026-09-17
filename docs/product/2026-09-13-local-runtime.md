# Local runtime architecture

Status update, 2026-09-15: the
[cloud agent direction](2026-09-15-cloud-agent-candidates.md) supersedes this
document's primary-product framing. The local behavior described here remains
implemented. The new direction does not migrate CLI storage or select a final
cloud execution topology.

The primary product is an interactive coding agent. `nimplex` must start a local
runtime without an HTTP API, Postgres, or a leased work queue. TUI and headless
entry points share session operations, durable events, tools, and recovery.

## Implementation requirements

- Extract the existing Pi, context, workspace, and native execution code into
  `@nimplex/runtime`. Keep the hosted worker as an adapter to the same executor.
- Give the local runtime ownership of sessions, turn history, workspace snapshots,
  cancellation, branching, and recovery. UI state is a projection, not authority.
- Use local SQLite transactions for event, accounting, and workspace commits.
  Prevent concurrent writers to the same state root with a process-owned lock;
  do not introduce polling workers, expiring task leases, or automatic paid retries.
- Keep one active turn per session. Independent sessions may execute concurrently.
- Retain just-bash-first routing and isolated native execution. Share the native
  environment between turns in a session, with explicit lifecycle cleanup.
- Preserve conservative model reservations and uncertain outcome accounting.
  Resume interrupted work explicitly from committed facts; never blindly replay
  native effects after loss of their execution journal.
- Make both the TUI and one-shot/piped commands work without remote services.
  Provide local session resume and usable credential configuration.
- Keep existing cloud endpoints and SDK compatible. Do not discard existing data
  or silently import private remote history into the new local state root.
- Update current instructions and docs in English, then verify type checks, lint,
  unit/integration tests, cloud regression tests, and real terminal behavior.

## Design evidence

- [Codex shared in-process client](https://github.com/openai/codex/blob/main/codex-rs/app-server-client/README.md)
- [Maka Runtime Host ownership](https://github.com/apache/maka/blob/main/docs/architecture/runtime-host-architecture.md)
- [Grok portable agent definition](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-agent/README.md)

These projects motivate shared execution authority and separate product surfaces.
Their complete implementations are not templates to copy into this smaller runtime.

## Implemented behavior

`NimplexRuntime` is the single execution owner for a local state root. TUI and
headless mode call its session/turn methods directly and observe committed events.
The runtime uses `Sessions` for immutable turn snapshots and conversation
projections, `RuntimeStore` for SQLite transactions, and the shared Pi executor
for each inference/tool batch. One user turn can contain many executor steps.

Local ownership uses a held SQLite OS write lock in `owner.sqlite`; application
transactions use `runtime.sqlite`. This is not an expiring task lease or a work
queue. One session admits one active turn, while distinct sessions can progress
concurrently. A second process targeting the same root fails clearly. Automatic
attachment to a running host is not implemented.

### Durable input acceptance, added 2026-09-16

`startTurn` accepts an optional stable `requestId` and returns both `runId` and
`requestId`. Resubmitting the same normalized request under the same session and
ID returns the original acceptance, including while the turn is running or after
restart. Changed content under an accepted ID is rejected. Retrying acceptance
does not resume an interrupted turn; `resumeTurn` remains explicit. A branch has
its own request-ID scope. Without a caller ID, each submission receives a new ID.

Headless clients can supply `--request-id ID`; the CLI prints the accepted ID.
Retry with `--resume SESSION_ID --request-id ID` and the same task/options.
An ID without a one-shot task is rejected rather than interpreted as resume.

SQLite schema version 2 adds `accepted_inputs` without rewriting old turns or
events. Accepted input, seeded turn/workspace, and `input.accepted`/`run.started`
events commit in one transaction before model dispatch. Migration itself is
transactional; a newer schema is rejected. Acceptance records are retained with
the state root, with no automatic expiration. Old histories remain readable but
do not acquire invented request IDs. Older version-1 runtimes cannot reopen a
version-2 root; back up a closed state root before upgrading if rollback is needed.

This is the first additive Phase 1 slice. It does not implement in-flight
steering/follow-up delivery or the future hosted session inbox. The
[Pi composition gate](2026-09-16-pi-composition-gate.md) still prevents an
AgentSession migration.

### Pi harness engine, opt-in, added 2026-09-17

Each session records its execution engine. Existing sessions and the default
remain `pi-executor`. `NIMPLEX_ENGINE=pi-harness` (or `RuntimeOptions.engine`)
makes new sessions run on Pi's public `AgentHarness` through
`packages/runtime/src/pi-harness-engine.ts`; a session never changes engine, and
the recorded engine wins over the environment on resume. SQLite schema version 3
records this field, so a version-2 runtime cannot reopen a root that may contain
harness-owned sessions. Migration from version 2 is additive.

Commit contract of the harness engine:

- Pi's session writes and nimplex's projection share one SQLite transaction. The
  `SqlitePiStorage` adapter runs inside `RuntimeStore.transaction`; the turn must
  still be running at both ends of the transaction.
- Reservation is enforced inside the `Models` port Pi must call, not in a Pi hook:
  `pi-harness-models.ts` reserves from the final serialized payload, injects the
  budgeted `max_tokens`, and turns a denied reservation into an error response
  that Pi settles without any HTTP dispatch. The reservation event records Pi's
  usage id so a restart can settle it.
- Pi's usage row, its assistant entry and nimplex's `model.call`/`spend.updated`
  events commit together. A zero-usage error response without a reservation is a
  denied or pre-dispatch failure; any other unreserved usage rejects the commit.
- A tool outcome commits with the workspace snapshot, `tool.result`, `file.changed`
  and `workspace.committed` in the same transaction as Pi's pending result entry.
  Tool intents append `tool.started` in Pi's intent transaction.
- Turn identity is the Pi operation id. Cancellation and the duration cap request
  a durable Pi abort; runtime shutdown closes the harness without cancelling, so
  the operation stays resumable through `resumeTurn`.
- After a crash during a model request, recovery settles the reservation as
  `model.unknown` (retained) and Pi's durable retry issues one new identified
  attempt. Committed responses and tool outcomes are never re-requested or
  re-executed; native bash reattaches to its supervisor journal by tool call id.
- Summary requests (compaction, branch summaries, overflow recovery) pass through
  the same reservation boundary via `completeSimple`; Pi settles their usage without
  storing the response, so the engine keeps the delivered response until that
  settlement and records `model.call` with `step: "summary"` plus
  `context.compacted`. Pi never settles an interrupted summary request, so recovery
  records that reservation as `model.unknown` before resuming. Truncated or
  tool-calling summaries are rejected as in legacy Pi through `pi-summary-models.ts`.
- Context modes map to Pi operations owned by the turn: `reset` navigates the lane
  to its root (`<turn>:reset`) so the earlier history stays in Pi's tree, and
  `compact` runs a manual compaction (`<turn>:compact`) that summarizes everything
  before the latest turn boundary. Both happen before the prompt is accepted and
  survive a crash between them and the prompt.
- Codex subscription models run through the same engine with zero-dollar
  reservations and no injected output cap; quota remains provider-managed.
- Branching copies the Pi path that ended the selected turn into the branch's own
  Pi scope using Pi's fork policy (`SqlitePiStorage.importForkSync`), in the same
  transaction as the branch record. Entries keep their identity and timestamps;
  operations, pending inbox items and results are not copied.
- `queueInput(sessionId, { kind: "steer" | "followUp", text })` queues durable
  in-flight input on the active turn's lane; `cancelQueuedInput(sessionId, entryId)`
  removes it while Pi has not consumed it. Pi delivers steering at its next
  boundary and follow-ups when the run would otherwise end; delivery and
  cancellation are recorded as `input.queued` and `input.consumed` events
  (`delivered: false` for a cancellation) and survive a restart. In the terminal,
  Enter during a running harness turn steers and `/followup` queues a follow-up.

Verified by `pi-harness-engine.test.ts`, `pi-harness-engine-crash.test.ts`
(real SIGKILL after a committed response, after a committed tool result, during a
request, after a committed cancel request and during a summary request),
`pi-harness-models.test.ts`, `codex.test.ts`, the host-transaction and fork cases
in `pi-storage/sqlite-durability.test.ts` and the engine suite, the steering case
in `apps/cli/src/terminal/controller.test.ts`, and the `NIMPLEX_ENGINE` case in
`apps/cli/src/cli.test.ts`.

Not supported by this engine yet, rejected or absent rather than approximated:
executable extensions and Pi resources through the production bridge, hosted
execution of harness sessions (the PostgreSQL Storage adapter exists in
`apps/worker/src/pi-storage.ts` but the worker still runs the default executor),
and native/browser snapshot recovery. Pi's own history is the context
authority for these sessions; the nimplex extractive checkpoint is not applied to
them. Automatic threshold compaction uses Pi's default settings and is exercised
only through Pi's own tests; the budgeted summary path is verified through manual
compaction.

Models settle before tools; tool outcomes, file changes, metadata, and workspace
revisions commit atomically. Interrupted processes leave their committed state
recoverable. Opening the runtime does not make model calls: `/resume` explicitly
confirms continuation, and headless `--resume SESSION_ID` explicitly requests it.
Unknown model reservations remain allocated. An interrupted turn cannot be forked
or superseded before explicit recovery; this preserves branch snapshot immutability
and avoids overlapping an unknown native command with new work.

Native environments belong to the session and survive completed turns while the
runtime remains open. E2B pauses between native tools; Docker keeps its container.
Forks start with an independent environment and the selected durable workspace.
Closing the runtime interrupts active turns. It deletes the environments of idle
sessions, but keeps the environment of a session whose last turn was interrupted,
so an explicit resume can reattach to a journaled native command instead of
reporting an unknown outcome; once that turn has settled, the next close deletes
the environment as usual. Untouched default-titled sessions with no turns are
pruned on close.
After close/restart, dependency caches of idle sessions need reconstruction.
Recovery of a previously dispatched native command whose journal is gone reports
uncertainty; it never treats a cleared sandbox handle as permission to replay
external effects.
A process crash cannot promise cleanup of arbitrary external resources: durable
provider handles are retained for later recovery/cleanup. A new runtime does not
silently launch background resource-maintenance workers.

The CLI loads the current project's `.env` or an explicit `--env-file`, honoring
existing environment variables. Provider credentials stay in the host; tools never
inherit them. A saved model key is bound to its endpoint. The existing cloud
connection configuration and Postgres history remain intact and are not imported
into local sessions. Only local preferences are written by the UI; saving a UI
snapshot cannot rewrite runtime events or workspace data.

## Verification record — 2026-09-13

| Requirement | Evidence |
| --- | --- |
| Shared executor; no default API/queue dependency | Runtime package imports no Postgres package; CLI imports runtime/contracts; cloud worker imports shared executor subpaths |
| Local TUI and headless use one session authority | `apps/cli/src/terminal/controller.test.ts`, `apps/cli/src/cli.test.ts`; actual two-turn PTY session |
| Persistent conversation and branch isolation | `packages/runtime/src/runtime.test.ts`; reopen SQLite, continue the same session, preserve source snapshot |
| Atomic workspace/event commits | `packages/runtime/src/store.test.ts`; injected transaction failure leaves both unchanged |
| Ownership and explicit crash recovery | Real CLI SIGKILL/restart test, second-owner rejection, interrupted-turn tests |
| Budget, cancellation, read-only execution | Real Pi plus fake-model tests; zero unaffordable dispatch, retained unknown allowance, rejected write tool |
| Native lifetime and dependency reuse | Docker and E2B integration: first turn cache counter 1, second turn 2 with one environment; independent branch counter 1; close deletes both |
| No native replay after journal loss | `packages/runtime/src/native-bash.test.ts`, with both missing and cleared provider state |
| Credential isolation and setup | Endpoint-binding/mode-600 tests; project `.env` CLI test; PTY hidden-entry/login/logout test |
| Hosted recovery remains compatible | `pnpm e2e` and `pnpm e2e:e2b`: VFS/native crashes, lease takeover, budget/cancel races, provider pause failures and environment loss |
| Static and automated checks | `pnpm check` across 12 packages; `pnpm lint`; `pnpm test`: 79 passed / 37 skipped; frozen offline install |
| Real terminal behavior | Haiku wrote/read HELLO, then changed/read WORLD in the same session; total model cost $0.008427; diff/model/status menus, 120-column and 64-column layouts, clean exit |

The 37 default skips consist of 36 optional provider conformance cases and one
native session integration case. The latter was separately run against both Docker
and E2B. Local verification artifacts are under ignored
`sandbox/local-runtime-terminal-verification/`. No commit or push was performed.
