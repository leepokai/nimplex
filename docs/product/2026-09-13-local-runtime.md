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
- Preserve durable model dispatch intents and uncertain outcome accounting.
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
- Dispatch intent is enforced inside the `Models` port Pi must call, not in an
  observer hook. `pi-harness-models.ts` awaits `model.started` before provider IO;
  commit failure prevents dispatch. The event records Pi's usage ID for recovery.
  Pi owns provider output limits and thinking settings; no USD limit is enforced.
- Pi's usage row, its assistant entry and nimplex's `model.call`/`spend.updated`
  events commit together. A zero-usage error response without a dispatch intent is a
  denied or pre-dispatch failure; any other unidentified usage rejects the commit.
- A tool outcome commits with the workspace snapshot, `tool.result`, `file.changed`
  and `workspace.committed` in the same transaction as Pi's pending result entry.
  Tool intents append `tool.started` in Pi's intent transaction.
- Turn identity is the Pi operation id. Cancellation and the duration cap request
  a durable Pi abort; runtime shutdown closes the harness without cancelling, so
  the operation stays resumable through `resumeTurn`.
- After a crash during a model request, recovery settles the attempt as
  `model.unknown` (retained) and Pi's durable retry issues one new identified
  attempt. Committed responses and tool outcomes are never re-requested or
  re-executed; native bash reattaches to its supervisor journal by tool call id.
- Summary requests (compaction, branch summaries, overflow recovery) pass through
  the same dispatch boundary via `completeSimple`; Pi settles their usage without
  storing the response, so the engine keeps the delivered response until that
  settlement and records `model.call` with `step: "summary"` plus
  `context.compacted`. Pi never settles an interrupted summary request, so recovery
  records that attempt as `model.unknown` before resuming. Truncated or
  tool-calling summaries are rejected as in legacy Pi through `pi-summary-models.ts`.
- Context modes map to Pi operations owned by the turn: `reset` navigates the lane
  to its root (`<turn>:reset`) so the earlier history stays in Pi's tree, and
  `compact` runs a manual compaction (`<turn>:compact`) that summarizes everything
  before the latest turn boundary. Both happen before the prompt is accepted and
  survive a crash between them and the prompt.
- All built-in Pi provider/model pairs are selectable on the harness engine through
  `provider/model`. Bare IDs remain Anthropic aliases. Dispatch delegates to Pi's
  provider implementation; nimplex does not duplicate the provider/API routing map.
  Dynamic/custom catalogs and extension-registered providers remain outside this slice.
- Additional providers resolve credentials through Pi ModelRuntime, including provider
  headers and ambient cloud configuration. `nimplex login PROVIDER` uses Pi's login
  flow. Existing Anthropic/OpenAI credential files and isolated Codex login remain
  compatible. Subscription usage has zero per-request API charges.
- `thinking` sets Pi's level for the current turn; the lane's model and level are
  synchronized before prompt acceptance. Provider thinking/output defaults remain
  intact. The legacy executor still supports Anthropic/Codex and rejects other
  providers and levels other than `off`; the default engine has not changed.
- Branching copies the Pi path that ended the selected turn into the branch's own
  Pi scope using Pi's fork policy (`SqlitePiStorage.importForkSync`), in the same
  transaction as the branch record. Entries keep their identity and timestamps;
  operations, pending inbox items and results are not copied.
- Pi extensions (`RuntimeOptions.extensions`, set by the CLI to Pi's agent directory
  and trust store) load once per project directory and trust state. User extensions
  always run; `<cwd>/.pi/extensions` runs only when `projectTrusted(cwd)` is true.
  Their tools join the harness with `replay: "never"`, their behavior hooks bridge to
  harness hooks, and extension-sent messages enter the lane inbox as steer or
  follow-up input. A module load error fails the turn before any provider request;
  handler errors Pi isolated fail the turn after Pi settles it. The legacy executor
  never loads extensions. See `pi-extensions/bridge.ts` for the unsupported list.
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
`pi-harness-models.test.ts`, `codex.test.ts`, `providers.test.ts` (OpenAI dispatch
and settlement, thinking parameters, per-turn model switch, legacy refusals), the
host-transaction and fork cases
in `pi-storage/sqlite-durability.test.ts` and the engine suite, the steering case
in `apps/cli/src/terminal/controller.test.ts`, and the `NIMPLEX_ENGINE` case in
`apps/cli/src/cli.test.ts`.

Not supported by this engine yet, rejected or absent rather than approximated:
executable extensions and Pi resources through the production bridge, and
native/browser snapshot recovery. (A hosted PostgreSQL Storage adapter existed
until 2026-09-20 and was removed with the rest of the hosted path.) Pi's own history is the context
authority for these sessions; the nimplex extractive checkpoint is not applied to
them. Automatic threshold compaction uses Pi's default settings and is exercised
only through Pi's own tests; the durable summary path is verified through manual
compaction.

Models settle before tools; tool outcomes, file changes, metadata, and workspace
revisions commit atomically. Interrupted processes leave their committed state
recoverable. Opening the runtime does not make model calls: `/resume` explicitly
confirms continuation, and headless `--resume SESSION_ID` explicitly requests it.
Unknown model attempts remain recorded. An interrupted turn cannot be forked
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
| Uncapped accounting, cancellation, read-only execution | Real Pi plus fake-model tests; spending above the former cap, durable unknown outcomes, rejected write tool |
| Native lifetime and dependency reuse | Docker and E2B integration: first turn cache counter 1, second turn 2 with one environment; independent branch counter 1; close deletes both |
| No native replay after journal loss | `packages/runtime/src/native-bash.test.ts`, with both missing and cleared provider state |
| Credential isolation and setup | Endpoint-binding/mode-600 tests; project `.env` CLI test; PTY hidden-entry/login/logout test |
| Hosted recovery remained compatible (historical) | `pnpm e2e` and `pnpm e2e:e2b` covered VFS/native crashes, lease takeover, accounting/cancel races, provider pause failures and environment loss; the hosted path and these scripts were removed on 2026-09-20 |
| Static and automated checks | `pnpm check` across 12 packages; `pnpm lint`; `pnpm test`: 79 passed / 37 skipped; frozen offline install |
| Real terminal behavior | Haiku wrote/read HELLO, then changed/read WORLD in the same session; total model cost $0.008427; diff/model/status menus, 120-column and 64-column layouts, clean exit |

The 37 default skips consist of 36 optional provider conformance cases and one
native session integration case. The latter was separately run against both Docker
and E2B. Local verification artifacts are under ignored
`sandbox/local-runtime-terminal-verification/`. No commit or push was performed.

## Budget removal and Pi providers (2026-09-20)

The USD budget feature is removed from local requests, hosted requests/responses,
SDK settings, CLI flags, and terminal preferences. Earlier dated budget guarantees
are superseded. Usage/cost records, duration limits, ownership and tool commit
barriers remain. SQLite schema version 4 prevents older readers from restoring
budget enforcement; current readers strip obsolete budget JSON without rewriting
historical events. Legacy `model.reserved` records remain recoverable as dispatch
intents. Accepted request deduplication normalizes old budget fields on read.

Hosted migration 0012 converts pending `model_calls.status` from `reserved` to
`started` and drops budget/reservation amount and token-bound columns. New intent
events are `model.started`; `model.unknown` continues to identify lost responses.
Run migrations before starting the updated hosted API and workers.

Hosted cancellation remains immediately visible as a terminal run. Its fenced
worker then commits Pi cancellation and usage settlement without admitting new
model/tool dispatch or publishing a canceled tool's partial workspace. If the
worker dies, its successor completes that cleanup before releasing the work item.
Continuation requests return `409 parent_run_cleanup_pending` while the parent's
harness work item is still pending or leased; retry after cleanup completes.

The legacy Anthropic executor also validates model IDs against Pi's catalog before
dispatch. Unknown IDs fail explicitly instead of recording an unpriced request as
zero-cost usage.

### Usage accounting scope

Kevin confirmed that usage accounting must include both model API-key credit
consumption and sandbox resource usage. Removing monetary budgets does not remove
this requirement. Model token counts and catalog-based cost estimates are
implemented; provider invoices remain authoritative, and subscription quota is
separate from API-key charges.

Sandbox usage metering and cost accounting are not implemented yet. The existing
`spent_usd` field is model cost only, not a combined total. The follow-up must
record sandbox usage with units and provider identity, distinguish measured usage
from estimated charges and unavailable prices, and preserve durable deduplication
across retries, cancellation and recovery. Missing sandbox prices must not appear
as zero-cost usage. Model and sandbox subtotals must remain distinguishable when
reporting combined usage.

## Harness engine becomes the default (2026-09-25)

Kevin made `pi-harness` the default engine for new sessions. The runtime default
(`RuntimeOptions.engine`) and the CLI default are both `pi-harness`;
`NIMPLEX_ENGINE=pi-executor` still creates legacy-executor sessions. New sessions
always record their engine. A session record without an `engine` field was written
by the legacy executor (schema version 2, or before this change) and keeps running on
it; the recorded engine still wins over the environment on resume. No session is
converted between engines, so the change is reversible: restoring the old default
leaves harness-owned sessions on the harness. Legacy-executor sessions keep their
Anthropic/Codex-only model set, and their refusals now tell the user to open a new
session instead of setting an environment variable.

Covered by the engine-isolation case in `pi-harness-engine.test.ts` (an unmarked
legacy record runs on the executor beside default harness sessions), the default and
legacy-override cases in `apps/cli/src/cli.test.ts`, and the legacy refusals in
`providers.test.ts` and `controller.test.ts`. Tests that inject a `RunExecutor`
select `pi-executor` explicitly, because the injected executor replaces only the
legacy loop.

The same day's end-to-end run found that `/rewind` or `/fork` on a branch failed
for turns the branch inherited ("no settled Pi operation"): a branch copies its
source's turn list, but each turn's Pi result stays in the scope of the session
that ran it. Branching now resolves the selected turn through the parent chain and
forks from the owning scope; fork-copied entries keep their identity, so the path is
the same. Covered by "branches a branch from a turn it inherited from its source" in
`pi-harness-engine.test.ts`.
