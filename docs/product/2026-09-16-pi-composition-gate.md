# Pi composition qualification: 0.85.1

Status: **AgentSession observer composition failed; public AgentHarness qualified for
an opt-in production engine**. The existing durable Agent executor remains the
default engine; the harness engine is selected per session. This report is evidence for Phase 0 of the
[implementation plan](2026-09-16-durable-pi-implementation-plan.md), not a claim
that the full harness or Phase 0 acceptance suite has been completed.

## Reproduction

```sh
pnpm vitest run packages/runtime/src/pi-composition.test.ts packages/runtime/src/pi-composition-crash.test.ts
```

The initial run on 2026-09-16 passed 13 qualification assertions. Several assert
unsafe upstream behavior deliberately: green tests mean the blocker is reproduced,
not that a candidate bridge passes durability qualification. The tests use the
installed AgentSession, real extension registration, the real Anthropic adapter,
an in-process fake upstream, isolated temporary files, and synthetic credentials.
The process tests launch a separate Node process and terminate it with SIGKILL.
No default runtime, user session, provider credentials, or external account is used.

Pinned packages: `@earendil-works/pi-agent-core`, `pi-ai`, and `pi-coding-agent`
are all 0.85.1. `pnpm view @earendil-works/pi-coding-agent version` returned
0.85.1 on the audit date. No newer published release was available from that
registry query; no dependency upgrade has been selected.

## Observed boundaries

| Experiment | Observation | Qualification consequence |
| --- | --- | --- |
| Hold an AgentSession assistant `message_end` subscriber indefinitely | Tool executes and a second model request completes while persistence is pending | Subscriber is not a response commit barrier |
| Hold an AgentSession tool-result subscriber | Next model request completes before persistence | Subscriber is not a tool/workspace commit barrier |
| Reject extension `message_end` or `tool_result` | Error listener receives the error; dependent tool/model execution continues | These hooks cannot propagate required storage failures by throwing |
| Hold the lower-level Agent assistant listener | Zero tool effects until release | Usable model/tool-loop seam |
| Reject the lower-level Agent listener | Prompt rejects; no tool dispatch or second model request | Required loop failure can halt dependencies |
| Hold the lower-level Agent tool-result listener | No second model request until release | Usable loop result barrier |
| SIGKILL with pending AgentSession response observer | Probe file exists; committed-response record does not | Real process death preserves an effect with no committed decision |
| SIGKILL with pending Agent response listener | Neither probe file nor response record exists | Lower-level barrier prevents dispatch at that boundary |
| Queue steering and follow-up, reconstruct SessionManager | Neither queued input exists in entries | A durable inbox and delivery boundary are required |
| Execute user shell with a rejecting Agent listener | Shell operation executes and appends its result without an Agent event | Loop listener does not cover user-shell lifecycle |
| Append extension custom entry and perform subsequent extension code | Extension continues while entry subscriber is pending | Synchronous extension append is not an async commit acknowledgement |
| Compact, navigate with branch summary/label, reload, reconstruct | Entry IDs, parents, custom data, summaries and selected context survive explicit entry/leaf reconstruction | Public lossless entry restoration exists; this is not a database commit test |

The crash probes use a deliberately held persistence callback and filesystem
witness, not a PostgreSQL transaction. They establish ordering. Production
SQLite/PostgreSQL atomicity, accounting, takeover, and browser recovery still
require their own acceptance fixtures.

## Authoritative mutation inventory

This inventory audits shipped JavaScript and public declarations, rather than
assuming source on upstream main matches the installation. Relative source names
below are under Pi coding-agent's `dist/core/`. Lower-level Agent listeners are
awaited in agent-core's `dist/agent.js`; AgentSession `_emit` does not await them.
The latter runs before SessionManager appends regular message entries.

| Path | Installed write/effect route | Required bridge boundary and recovery material |
| --- | --- | --- |
| Prompt, image input, expanded prompt/skill/context | `agent-session.js`: prompt preflight, extension input, Agent prompt | Commit accepted original and expanded input with resource digest before acknowledgement/dispatch; restore inbox identity |
| Model stream and response | Agent stream, `_handleAgentEvent`, synchronous `appendMessage` | Reservation before every request; full finalized response, stable Pi entry and intents before tools; preserve unknown attempts |
| Registered built-in/custom tools | `_installAgentToolHooks`, extension interception, Agent tool loop | Commit intent before effect; finalized result/workspace/entry atomically before dependencies; propagate infrastructure failure |
| Message transforms | Extension `emitMessageEnd`, before SessionManager append | Persist the final transformed value at an awaited barrier; transformations cannot independently acknowledge durability |
| Steering/follow-ups, clearing queues | `_queueSteer`, `_queueFollowUp`, `clearQueue`, Agent queue drain | Durable request ID and kind; atomic logical consumption with user entry; restore undelivered items rather than only queue text |
| Custom messages | `sendCustomMessage`, `_appendCustomMessage`, pending custom/aside flush | Commit both context-only and turn-triggering messages; preserve display/details and queue identity |
| Extension custom entries | `bindCore.appendEntry` → `appendCustomEntry`; `entry_appended` observer | Staged identity plus explicit awaited flush/helper; recover custom data without claiming opaque extension IO is replay-safe |
| Names and labels | `setSessionName`, `bindCore.setLabel` → synchronous append methods | Commit metadata and leaf independently of model-loop events; do not acknowledge a staged name as committed |
| Model/cycling/thinking | `setModel`, scoped/available cycling, `setThinkingLevel` | Persist selection and accounting policy before next request; settings default is separate from session state |
| Active tools, queue modes, prompt overrides | setters and extension `setActiveTools`/provider registration | Pin effective configuration/resource version before use; reconstruct configuration at activation |
| Manual compaction | `compact` → extension/default summary → `appendCompaction` | Meter summary requests; commit summary/usage/kept entry/leaf before exposing new context; preserve raw history |
| Automatic threshold/overflow compaction | `_compactBeforeNextAssistantResponse`, `_runAutoCompaction` | Same barriers, including internal continuation and retry, without relying on a client command wrapper |
| Agent and summary retries | `_prepareRetry`, `_summarizationRetryCallbacks`, model stream | New identified reservation per attempt; failed commits latch execution failure; no accidental paid retry after storage failure |
| User shell and recorded shell results | `executeBash`, `recordBashResult`, pending bash flush | Route operations through the shared sandbox adapter; durable intent/journal/result/entry, including queued shell results |
| Tree navigation and branch summaries | `navigateTree` → branch/reset/branchWithSummary/label | Versioned leaf and optional summary, distinct from workspace rollback; meter summary model requests |
| New/switch/fork/import | `agent-session-runtime.js`: teardown, SessionManager mutation, new runtime | Frozen exported entries/workspace plus ownership transition; creation failure must retain old authority |
| Resource reload | shutdown/invalidate old runner → settings reload → loader reload → runtime build | Validate candidate first; commit resource digest at idle; failed candidate must keep previous runtime usable |
| Shutdown, abort, cancellation | Agent abort, retry/compaction/bash controllers, extension shutdown | Durable cancellation/epoch check at every effect and commit; no terminal resurrection |
| Direct public SessionManager mutation | newSession, setSessionFile, append variants, branch/reset/createBranchedSession | Storage adapter must cover all mutators, or runtime must expose only read access to callers; JSONL remains an export |
| Trusted extension arbitrary IO/timers | Arbitrary host code, `exec`, callbacks | Outside automatic guarantees; declare trust boundary and offer durable effect helpers; cannot grant sandbox or provider secrets implicitly |

Rows beyond the executable experiments have source-audit evidence only. In
particular, retry, failed reload, all session replacement paths, and every
extension mutation still need positive qualification against a proposed bridge.
This inventory intentionally does not turn an unaudited or untested path into a
supported capability.

## Decision and next implementation

Do not migrate the default to AgentSession 0.85.1 using event mirroring, extension
error handlers, or only a lower-level Agent listener. These seams cover different
subsets; no tested composition covers all authoritative paths.

The negative result is specific to AgentSession, not every public API in 0.85.1.
A subsequent export audit found `AgentHarness`, `StorageBackedSession`, and an
asynchronous `Storage` interface in the same installed agent-core package. This
is an existing public composition candidate, not a proposed upstream change.
`StorageBackedSession` is exported from the public session entry point, but its
declaration describes it as a package-internal typed boundary. Qualification is
explicitly pinned; this report does not promise stability across Pi upgrades.
It must be qualified before deciding whether the
[AgentSession async storage proposal](2026-09-16-pi-async-storage-proposal.md) is
needed. A maintained dependency fork remains a separate architecture decision;
no production private-method patch, fork, or dependency mutation was applied.

Independent additive contracts and pure entry/inbox projection can proceed while
that seam is resolved. Existing sessions must retain their current engine and
remain readable. The full user objective still includes all six phases, native
and browser recovery, full Pi compatibility, and hosted ownership qualification.

## Public AgentHarness candidate

The experimental `packages/runtime/src/pi-storage/` adapter implements the public
Storage port with tenant/session-scoped SQLite tables and transaction-local
ownership checks. Versioned, checksummed commit batches preserve mutations,
including deleted values and queue items; indexed tables are rebuildable
projections. Rebuild requires exclusive ownership with no live harness attached,
validates the engine format and sequence continuity, and rolls back on a damaged
or truncated journal. It does not change `RuntimeStore` or the default executor.

```sh
pnpm vitest run packages/runtime/src/pi-storage packages/runtime/src/pi-harness-qualification.test.ts packages/runtime/src/pi-harness-crash.test.ts packages/runtime/src/pi-harness-lifecycle.test.ts
```

Candidate qualification through 2026-09-17 passed all 21 upstream Storage
conformance cases, ten storage durability cases, eight commit/reopen probes,
six lifecycle probes, and eleven actual SIGKILL/restart tests (nine with the real
ExtensionRunner enabled, including structural-operation, metadata and interrupted
model-selection and summary-usage cases). Some probes deliberately
record missing host guarantees, rather than treating them as supported features:

- Holding the assistant response commit prevents tool execution.
- Model intent is committed before provider dispatch; rejecting that commit sends
  no request. A rejecting `before_request` hook, however, is swallowed and does
  not authorize or deny spending. Accounting must use an enforced boundary.
- Holding the tool result and private-workspace commit prevents the next model request.
- Rejecting either required commit rejects the operation and stops dependencies.
- Restart after a committed assistant response reuses that response and its entry
  identities, then executes its pending tool.
- Restart after a committed tool outcome restores the fixture workspace, skips the
  completed tool and continues with exactly one new model request.
- All SIGKILL fixtures also rebuild database projections from the immutable
  journal before attaching a new harness, preserving committed entries and usage.
- Accepted operation IDs, steering/follow-up input IDs and queue cancellation
  survive restart. Delivered queued entries appear once in the transcript.
- Custom entries, compaction, branch summaries, labels, lane thinking/tool settings
  and names survive restart; metadata failures fault the activation permanently.
- Global resources and steering/follow-up modes are process configuration, not
  automatically persisted state. The host must pin and restore them.

The fixture uses public Pi exports and an isolated fake provider. Its workspace
snapshot covers the single flat test file, not the production binary manifest or
native/browser environments. Error-based reopen probes and process-death probes
are separate tests. No inference is made about opaque external effects.

Remaining composition gates include AgentSession extension/resource behavior,
all authoritative mutation paths in the inventory, host accounting integration,
durable cancellation, stale-owner dispatch prevention, PostgreSQL parity and
uncertain native/browser operations. The public harness currently represents
some interrupted non-replayable tools as error results and continues; that alone
does not implement nimplex's required visible reconciliation policy. Its durable
kernel is promising, but importing it is not proof of full Pi CLI compatibility.

AgentHarness and AgentSession also use different entry formats. For example,
AgentHarness compaction stores `retainedTail`, while AgentSession compaction uses
`firstKeptEntryId`. The structural projection described below preserves the native
records and provides a separately mapped Pi-facing graph. Automatic legacy-session
migration and round-trip JSONL compatibility have not been implemented.

Validation after this candidate slice: `pnpm check --force` passed all 12 packages;
`pnpm lint` passed; `pnpm test` passed 177 tests with 37 optional skips; `pnpm e2e`
passed the existing hosted fake-provider acceptance suite. The hosted result is a
regression check for the unchanged default engine, not PostgreSQL qualification
of the new adapter. Changed storage code was locally reviewed for scoped queries,
atomic journal/projection updates, ownership checks, admission/close races,
rebuild rollback and version rejection. Document links and `git diff --check`
passed. No Opus review, dependency patch or code commit was performed.

## Extension adapter qualification added after the Storage slice

`pi-extensions/session-view.ts` supplies a stable read facade to the real exported
`ExtensionRunner`. It replaces in-memory SessionManager projections through public
factories, blocks direct mutators and clones returned data. Captured readers see
the latest projection; invalid candidate snapshots preserve the prior view.
No private Pi method or stored field is patched.

`pi-extensions/mutations.ts` serializes staged legacy setters and retains the first
failure. Synchronous setters acknowledge staging only. A controlled boundary must
await `flush`; the enforced storage path must also call `assertHealthy`, because
ordinary Pi behavior hooks can swallow rejection. `pi-extensions/tools.ts` uses
Pi's public registered-tool wrapper, preserves extension context and cancellation,
checks host ownership at dispatch/result, and defaults arbitrary extension tools
to non-replayable unless the host explicitly classifies them otherwise.

```sh
pnpm vitest run packages/runtime/src/pi-extensions packages/runtime/src/pi-harness-extensions.test.ts packages/runtime/src/pi-harness-crash.test.ts
```

`pi-extensions/compatibility-store.ts` adds a versioned Pi-facing entry graph in
the same Storage transaction and immutable journal as the native harness writes.
Accepted custom entries become visible immediately, including at `session_start`
after interruption. Their reserved IDs, visible parents, timestamps and data stay
unchanged when the harness later places them in its transcript. The native graph
is preserved separately: its delayed inbox placement has different parent/order
semantics from AgentSession's synchronous extension append. The wrapper serializes
commits and snapshots; the host must use it for every write under exclusive session
ownership. Existing unprojected history requires an explicit migration.

The initial custom-state slice used twelve adapter tests, five real-runner probes
and four process-death cases to cover:

- Pi read-method equivalence for custom entries, compaction, labels, metadata and
  branch selection, plus isolation from mutations to returned objects.
- Ordered staged writes, sticky failure and draining already admitted writes on close.
- Paired AgentSession/candidate extension behavior for argument mutation, transformed
  tool results, finalized messages and completed-operation custom-state restoration.
- Delayed/rejected custom-state commits preventing dependent tool execution.
- Ownership loss after tool intent but before dispatch preventing the extension effect.
- Atomic rollback of both graphs on projection failure, conflicting custom-entry
  identity rejection, session identity and ownership enforcement, and explicit
  rejection of malformed records and unprojected existing history.
- Stable accepted custom state after response interruption, native inbox delivery,
  branch navigation and a subsequent assistant response.
- Real SIGKILL after assistant or tool-result commit, followed by journal rebuild
  and a fresh ExtensionRunner: startup observes accepted custom state, committed
  tools are not repeated, and visible entry identity survives recovery.

The qualification fixture binds only the exercised actions. Its other extension
actions remain explicit errors. It is not a production extension host. Completing
the bridge requires all remaining action/context bindings, structural extension
hooks, trust/resource versions and failure-safe reload. The compatibility wrapper
now projects all four native entry types and the model/thinking, label and name
value mutations described below. Plain-harness lifecycle tests alone do not
establish extension action compatibility. The accepted-state recovery
fix neither discards the durable inbox nor replays the committed model response.

After adding the atomic projection and extension process-death probes,
`pnpm check --force` passed all 12 packages, `pnpm lint` passed, and `pnpm test`
passed 196 tests with 37 optional skips. The changed code was locally reviewed for
atomic rollback, stable entry identity, raw-history preservation, ownership checks
and recovery without duplicate effects. Local document links and `git diff --check`
passed. `pnpm e2e` also passed the existing hosted fake-provider regression suite,
including budget enforcement, cancellation, SIGKILL recovery and SIGSTOP lease
takeover. That suite still exercises the unchanged default executor; it does not
qualify the experimental adapter for hosted/native deployment.

### Structural projection and failure coverage

`pi-extensions/structural-projection.ts` converts compaction's materialized
`retainedTail` to the legacy first-kept boundary. When the retained messages match
an existing ancestor suffix, their original entry IDs are reused. If an extension
replaces or reorders those messages, deterministic projection-only message nodes
represent that tail, with an explicit versioned mapping back to the native
compaction. The native entries, parent links, retained payload, details and usage
remain intact. An empty tail uses the compaction's own ID as the first-kept reader
boundary. These are read-projection semantics, not a claim of legacy JSONL import
compatibility or support for navigating directly to a projection-only node.

Branch summaries preserve their identity, source and details. A native null
source maps to Pi's documented-in-source `root` sentinel. Navigation can write
both the target and new summary tip within one transaction; the projection now
uses the final tip write. Compaction metadata, derived nodes and raw records commit
in one transaction with usage. Non-finite JSON values and invalid structural
metadata fail before acknowledgement.

```sh
pnpm vitest run packages/runtime/src/pi-extensions packages/runtime/src/pi-harness-structural.test.ts packages/runtime/src/pi-harness-structural-crash.test.ts
```

Coverage for this slice:

| Requirement | Executable evidence |
| --- | --- |
| Reuse original retained IDs and match the legacy reader | `structural-projection.test.ts`: paired public SessionManager context |
| Preserve empty, replacement, reordered and multimodal tails | Table cases in `structural-projection.test.ts`; deterministic derived IDs and unchanged original entries |
| Handle optional fields without spurious replacement and reject non-finite values | JSON normalization and rejection cases in `structural-projection.test.ts` |
| Roll back summary, usage, mapping and derived entries together | SQLite trigger failure and successful retry in `compatibility-store.test.ts` |
| Preserve root/empty branch summaries and the final tip of multi-write navigation | Parameterized branch cases in `compatibility-store.test.ts` |
| Preserve repeated compaction, branch context, files and extension startup after rebuild | `pi-harness-structural.test.ts`, using the actual harness and ExtensionRunner |
| Await required structural writes and prevent dependent requests after rejection | Held/rejected commit case in `pi-harness-structural.test.ts` |
| Recover committed compaction/navigation before acknowledgement with no repeated work | Two actual SIGKILL/rebuild cases in `pi-harness-structural-crash.test.ts` |

The structural summary hooks used here are public AgentHarness hooks. Translation
of legacy `session_before_compact`/tree hooks and the remaining extension action bindings is
still open; these tests do not establish full extension lifecycle parity. Hosted
storage parity, enforced accounting, native/browser continuity and the other
implementation-plan release gates also remain open.

Validation after the structural slice: `pnpm check --force` passed all 12 packages,
`pnpm lint` passed, and `pnpm test` passed 210 tests with 37 optional skips.
`pnpm e2e` passed the unchanged default hosted engine's fake-provider suite,
including budget, cancellation, tenant isolation, SIGKILL and lease takeover. The
changed projection and tests were locally reviewed for retained-entry identity,
JSON normalization, native-history preservation, multi-write navigation, atomic
usage/projection rollback and process-death recovery. Instruction content, local
document links and `git diff --check` passed. No Opus review or code commit was
performed.

### Metadata history and projection version 2

`pi-extensions/metadata-projection.ts` converts native `pi.lane.config`,
`pi.session.name` and `pi.entry.label` mutations into Pi-facing model/thinking,
session-info and label entries. Native value mutations have no entry ID, so the
adapter assigns projection identities in the same transaction and records each
source namespace, key, lane and write index. These records and native writes share
one journal; native entry identity and parent links remain unchanged.

Initial model/thinking settings and subsequent changes are recorded in order.
Tool-list-only changes do not invent model/thinking changes. Clear operations
append history instead of removing previous metadata entries. Pi-facing names
use the legacy append method's newline/whitespace normalization, while the native
name value remains lossless. Names and labels remain globally readable across
branches. Global-only mutations attach to the host's metadata lane (default
`main`); a transaction identifying one branch supplies that origin instead.

Projection now processes entries, navigation tips and metadata in the original
transaction order. This prevents configuration written before a message from
appearing after it, and preserves both target and summary tip transitions.
The read facade also permits normal Promise assimilation while continuing to
reject mutators and invalidated reads.

The metadata slice introduced compatibility header version **2**; the compaction
hook slice below now requires version **3**. Old version-1 projections lack this
metadata history and are rejected before reads or writes; future/invalid versions
are also rejected. Explicit migration remains required. Native Storage format 1
and its immutable journal remain readable by the existing adapter. The default
runtime's schema and engine have not changed.

| Requirement | Executable evidence |
| --- | --- |
| Baseline model/thinking context and ordered changes | `metadata-projection.test.ts`: paired SessionManager reads, multiple config writes and interleaved message/metadata writes |
| Name/label updates and clears; independent lane settings | Global metadata and branch cases in `metadata-projection.test.ts` |
| Atomic native value/history/mapping/tip rollback | SQLite trigger failure, retry and unchanged journal assertions |
| Reject invalid values, missing label targets and incompatible projection versions | Rejection cases preserving the original journal and configuration |
| Await actual harness metadata writes; retain a sticky failure | `pi-harness-lifecycle.test.ts`, with and without compatibility enabled |
| Stable metadata after process death before acknowledgement | Metadata case in `pi-harness-structural-crash.test.ts`: SIGKILL, journal rebuild, fresh runner, no new provider call or tool effect |
| Read-only facade works through async code | Promise assimilation and mutation rejection in `session-view.test.ts` |

Historical branch context and the harness's current lane configuration are
distinct: native navigation does not itself restore historical model/thinking
settings. A complete host command bridge must qualify that policy and all legacy
extension actions. This slice also does not implement legacy history migration,
export/import, resource reload or the remaining release gates.

Validation after metadata integration: `pnpm check --force` passed all 12 packages,
`pnpm lint` passed, and `pnpm test` passed 224 tests with 37 optional skips. Local
review covered transaction order, metadata identity, branch scope, clear semantics,
rollback, version rejection and restart without repeated effects. `pnpm e2e`
passed the unchanged default hosted engine's fake-provider regression suite,
including budget, tenant isolation, cancellation, SIGKILL recovery and SIGSTOP
lease takeover. Document links and `git diff --check` passed. No Opus review or
code commit was performed.

### Durable extension settings actions

`pi-extensions/settings-actions.ts` binds name/label, active-tool and thinking
actions, tool inspection, and registered-model selection through the real
ExtensionRunner. Synchronous setters stage work; their API getters expose staged
values, while the session read facade remains a committed projection until flush.
Controlled effect boundaries must drain mutations and notifications. Session-view
read-after-write parity inside the same synchronous callback is therefore still
an explicit gap, not a full extension-parity claim.

Name normalization, unknown-tool filtering, thinking clamping and per-model
thinking preferences follow the inspected pinned Pi behavior. Notifications are
tracked outside the serialized commit line so a `model_select` handler can await
another `setModel` without deadlock. Required failures remain latched. Reattachment
preserves the stored active-tool selection for the available registered tools;
complete tool/resource version restoration remains a separate gate.
Closing seals new action/effect admission but drains accepted metadata writes and
their notifications before invalidating the runner/view. Notification readers can
observe the committed state during that drain; stale readers fail afterwards.

`pi-extensions/model-change.ts` records a credential-free, versioned accepted
model/thinking intent before invoking Pi's separate public setters. It marks that
same intent applied only after both settings commit. Activation recovers an
accepted intent before extension startup. Missing catalogs fail visibly. The
enforced Storage guard rejects model, tool, deferred-model and summary dispatch
while a model change is pending; this guard must not be installed as a swallowable
behavior hook. Notifications from an interrupted activation are not replayed as
opaque external effects; a fresh extension restores from committed state.

These bindings currently require the model to be registered in the host catalog.
Dynamic resource/provider registration, complete catalog version pinning, arbitrary
unregistered model objects, global settings persistence and the other extension
actions remain unqualified. A normal missing-auth selection returns false;
required acceptance or application failures halt dependent effects. None of this
replaces the still-required model budget/reservation boundary.

| Requirement | Executable evidence |
| --- | --- |
| Pi name/tool/thinking semantics and notification order | Paired AgentSession/ExtensionRunner case in `pi-harness-settings.test.ts`, including parameter schemas, labels/clears and restored inactive tools |
| Nested asynchronous model selection without deadlock | Real `model_select` callback and notification/mutation drain tests |
| Missing auth does not hide an earlier successful selection | Concurrent authenticated/unauthenticated selection regression |
| Per-model defaults and interrupted compound action recovery | Accepted-intent reopening case, retaining the same action ID |
| Delayed/rejected settings block effects | Held name commit, original cause assertion and zero-tool-effect checks |
| Model/tool/summary dispatch cannot bypass pending selection | Three actual harness dispatch cases |
| Acceptance failure, ownership loss and missing recovery catalog | No changed configuration, no new intent/effect or no startup, respectively |
| Real process death between model and thinking commits | `model_change` case in `pi-harness-structural-crash.test.ts`: SIGKILL, journal rebuild, same intent completion and no repeated request/tool |
| Close preserves admitted writes and notification reads | Queued/committing cases in `pi-harness-settings.test.ts`, with idempotent close and rejected late admissions |

Validation after the settings action slice: `pnpm check --force` passed all 12
packages, `pnpm lint` passed, and `pnpm test` passed 240 tests with 37 optional
skips. Local review covered compound-action acknowledgement, pending-dispatch
guards, retained failure causes, nested notification ordering, persisted tool
selection, draining on close and recovery before extension startup. `pnpm e2e`
passed the unchanged default hosted engine's fake-provider suite, including budget,
cancellation, tenant isolation, SIGKILL and lease takeover. Document links and
`git diff --check` passed. No Opus review or code commit was performed.

### Legacy compaction hooks, added 2026-09-17

`pi-extensions/compaction.ts` binds the real ExtensionRunner's
`session_before_compact`, `session_compact` and `session_compact_failed` through
public harness hooks and committed outcome events. It uses Pi's public
`findCutPoint` to expose legacy preparation and entry identities. A paired
repeated-compaction fixture found that native and legacy preparation split turns
differently; the adapter retains the legacy split and message partitions instead
of exposing the native preparation unchanged. Summary generation still runs in
Pi through its durable request boundary.

Extension results preserve the exact `firstKeptEntryId`, even when it points to
metadata or retains no messages. A versioned native-details envelope stores that
ID and the original extension details. The compatibility projector validates the
materialized tail against the selected branch suffix, restores the original
details, and records the original ID without inventing replacement nodes. Invalid
IDs, invalid envelope versions, mismatched tails and non-finite details fail
closed. Header version **3** prevents earlier readers from silently interpreting
these records as ordinary native compactions; versions 1/2 require explicit
migration. Native Storage/journal format remains version 1.

Pre-hook writes drain before accepting the result or starting default summary
generation. Required adapter errors latch in the mutation guard because Pi isolates
behavior-hook failures. Summary, usage and compatibility writes share the Storage
transaction. The completion event is a notification of that commit, not its
authority. Notification callbacks run outside Pi's event-delivery tail because a
callback can await setters whose notifications use the same tail. The host command
wrapper and subsequent drive/request boundaries drain those callbacks and their
writes. A failed notification write blocks dependent dispatch.

| Requirement | Executable evidence |
| --- | --- |
| Legacy preparation, custom instructions, repeated compaction and retained context | Paired real AgentSession/ExtensionRunner test in `pi-harness-compaction.test.ts` |
| Exact metadata retention IDs, empty tails and original extension details | Two restart cases and envelope rejection cases in `structural-projection.test.ts` |
| Cancellation and late results | Paired cancellation events plus an actual AbortSignal/late-summary test |
| Default generation and provider failure | Real fake-provider success and disconnected-provider failure notification cases |
| Custom state commits before summary, notification after commit | Held summary transaction with no premature acknowledgement/notification |
| Usage and summary atomicity | Held/rejected commit assertions on both entry and usage tables |
| Required failures cannot trigger fallback or dependent requests | Invalid retention/details/tokens, pre-write, summary-write and notification-write cases |
| Automatic threshold notifications drain before dispatch | Successful and rejected notification-write cases at the actual provider intent boundary |
| Stale ownership cannot publish a late custom summary | Ownership loss while awaiting the extension hook; no entry or provider request |
| Process death before acknowledgement | Additional `extension_compaction` SIGKILL/rebuild case preserves custom state and summary; a fresh runner does not replay opaque completion callbacks |

This remains a qualification composition. Complete automatic/overflow retry
parity, short-history eligibility/error parity, tree hooks, all host command/context
bindings and production integration remain open. Fatal storage faults terminate
the activation and reject the command; a legacy failure callback is not guaranteed
after such a fault. Hosts must drain active operations before disposing the bridge
and flush notifications before acknowledging other command types. Notification
replay after death is intentionally not an automatic replay of arbitrary trusted
extension IO; extensions restore from committed entries at startup. Budget
reservation, resource pinning, hosted takeover and browser recovery gates remain
required; this slice does not authorize default-engine migration.

Validation: `pnpm check --force` passed all 12 packages; `pnpm lint` checked 198
files; `pnpm test` passed 262 tests with 37 existing optional skips. The 22 added
cases include a new real SIGKILL recovery boundary. `pnpm e2e` passed the unchanged
default hosted engine's fake-provider suite, including accounting, cancellation,
tenant isolation, SIGKILL and stale-owner takeover. Local review covered mutation
failure latching, notification ordering, ownership, retention identity, projection
version rejection and atomic usage/summary publication. Document links and
`git diff --check` passed. No Opus review or code commit was performed. Optional
provider skips and the remaining release gates are not evidence of full coverage
for the complete implementation plan.

### Incomplete summary rejection, added 2026-09-17

Two negative qualification cases demonstrate that the unguarded pinned harness
accepts truncated model output as a compaction or branch-summary entry. Legacy Pi
rejects those responses and also rejects summary responses containing tool calls.
`pi-summary-models.ts` now restores that validation through a public `Models`
facade. Inspection of the pinned dispatch paths confirms that AgentHarness uses
`completeSimple` for structural summaries and `streamSimple`/`streamDeferred` for
ordinary turns. The facade only validates the former; this distinction is a
required requalification point for a Pi upgrade.

A truncated or tool-calling summary becomes a failed response with its usage and
content preserved. It is not thrown away as a transport exception: Pi first
commits usage and then records the structural failure, without publishing a
summary or moving the branch tip. Existing provider errors and cancellation keep
their original outcomes. Deterministic rejection does not trigger another request
even with automatic retries enabled. Split-turn compaction commits the usage of
both nested requests if the second response fails, while retaining the original
conversation. No production package or default engine is patched or migrated.

| Requirement | Executable evidence |
| --- | --- |
| Reproduce the pinned upstream gap | Two unguarded cases in `pi-harness-summary-validation.test.ts` |
| Match Pi rejection for compaction and branch summaries | Four paired baseline/candidate length/tool-call cases; unchanged entries/tip and retained usage after reopening |
| Preserve usage from both parts of a failed split-turn summary | Real two-request fixture with a truncated turn-prefix response |
| Await settlement and halt after required settlement failure | Held/rejected usage transactions, no checkpoint and no later dispatch |
| Leave ordinary streaming and cancellation intact | Direct fake-provider streaming cases for length/tool responses and a live-request cancellation test |
| Survive death after usage commits but before terminal acknowledgement | `compaction_usage` and `navigation_usage` SIGKILL/rebuild cases in `pi-harness-structural-crash.test.ts`; unchanged transcript and usage with no redispatch under the fixture's disabled-retry policy |

The unwrapped pinned harness stores structural usage before the final summary,
but does not store each complete raw summary response at that boundary. After death there,
native recovery reports `structural_interrupted`; the disabled-retry fixture
terminates without redispatch. The next slice below adds raw-response journalling;
response reuse, explicit unknown-request accounting and the production retry
policy remain required.
These tests do not establish those broader guarantees or full automatic-compaction
parity. Arbitrary trusted extensions issuing their own model calls are outside
this purpose-bound Models surface until integrated through the host.

Validation after this slice: `pnpm check --force` passed all 12 packages;
`pnpm lint` checked 200 files; `pnpm test` passed 276 tests with 37 existing
optional skips. The 14 added cases include the two negative qualification probes
and two real SIGKILL boundaries. `pnpm e2e` passed the unchanged default hosted
engine's fake-provider suite. Local review checked response immutability, public
Models method binding, usage-before-failure ordering, cancellation, retry behavior
and the limits of recovery evidence. Document links and `git diff --check` passed.
No Opus review or code commit was performed; full-plan acceptance remains open.

### Atomic original summary responses, added 2026-09-17

`pi-storage/summary-responses.ts` composes the public Storage and Models ports to
retain the original provider response and its delivered validation verdict in the
same transaction as native usage settlement. The version-1 response envelope in
contracts identifies the operation, lane, structural task, attempt, nested request
index, usage ID and selected model. SQLite and its immutable journal retain the
complete Pi AssistantMessage, including content, provider response ID, stop reason
and usage. This is the provider adapter's response object, not an HTTP wire capture.

A before-request hook supplies a one-use host binding. The Models boundary checks
it against committed request intent, rechecks active request identities after
asynchronous reads, validates ownership/cancellation, and removes the internal
metadata before calling the provider. The hook alone is not the enforcement point:
missing or mismatched bindings fail at Models admission. Ordinary provider metadata
is preserved. Records remain scoped by the underlying tenant/session Storage.

At settlement, the Storage facade requires the matching captured response, exact
usage and expected native request-to-usage transition. It appends the immutable
response write to the native transaction; a rejected response write rolls back
usage too. Captures copy their data and cannot be reused after settlement. Closing
seals new admissions and drains already admitted commits. Hosts still must stop or
drain active operations before closing the storage stack.

| Requirement | Executable evidence |
| --- | --- |
| Original response, verdict and usage commit together | Success/truncation cases and held-commit acknowledgement in `pi-harness-summary-responses.test.ts` |
| Failures leave no partial settlement | Real SQLite response-write trigger failure; eight malformed/missing settlement cases in `pi-storage/summary-responses.test.ts` |
| Correct operation/request attribution | Concurrent real lanes; lane/model/attempt/kind mismatch and deterministic concurrent same-ID admission tests |
| No duplicate or mutable response records | Duplicate capture before/after commit, restored old request, overwrite/delete and non-finite usage rejection |
| Preserve ownership, cancellation and tenant boundaries | Stale admission, cancellation during the async identity read with no HTTP dispatch, subsequent lane reuse, tenant/session read and binding isolation |
| Recover original responses from committed records | Existing `compaction_usage` and `navigation_usage` SIGKILL tests now assert exact response/usage identities after journal rebuild and restart |
| Preserve provider metadata and graceful close | Metadata forwarding/internal-marker removal; frozen response values and close/drain tests |

This is experimental fixture integration; the production default is unchanged.
After death between summary usage settlement and structural completion, native
recovery still reports interruption under the fixture's disabled-retry policy.
The stored responses now survive that boundary, but automatic reconstruction of
the final summary from them is not implemented. Full model reservations, unknown
charges, production retry policy, hosted storage and complete Pi parity remain
required before migration. These tests do not qualify opaque model calls made
directly by trusted extensions.

Validation: `pnpm check --force` passed all 12 packages; `pnpm lint` checked 203
files. The initial unrestricted `pnpm test`, run alongside the other checks,
timed out in two existing CLI process tests (301 passed, 2 failed, 37 skipped).
All eight CLI cases then passed in isolation. The complete
`pnpm test --maxWorkers=4` run passed 303 tests with the same 37 optional skips,
without changing assertions, timeouts or test selection. This slice adds 27 cases
and extends two existing real SIGKILL cases. `pnpm e2e` passed the default hosted
engine's fake-provider acceptance suite, including budget, cancellation, tenant
isolation and ownership takeover. Local review found and fixed concurrent
same-identity admission and post-commit recapture; both have failing-before-fix
regression evidence. Review also checked usage atomicity, capture copying,
close/drain, scope boundaries and the stated recovery limitations. Document links
and `git diff --check` passed. No Opus review or code commit was performed.

## Production engine slice, added 2026-09-17

The AgentHarness route now runs real turns behind a per-session engine version
(`pi-harness-engine.ts`, see the
[local runtime contract](2026-09-13-local-runtime.md#pi-harness-engine-opt-in-added-2026-09-17)).
This is the first Phase 2 cutover step: new sessions opt in through
`NIMPLEX_ENGINE=pi-harness`; existing sessions keep the default executor; SQLite
schema version 3 prevents older runtimes from mixing engines on one root.

Boundaries enforced in production code rather than fixtures:

| Boundary | Enforcement | Evidence |
| --- | --- | --- |
| Reservation before dispatch | `Models.streamSimple` facade; hooks are not trusted | Denied dispatch, zero HTTP calls, `killed/budget_exceeded` |
| Response, usage and spend in one transaction | `SqlitePiStorage.commitSync` inside `RuntimeStore.transaction` | Injected `pi_store_usage` trigger rolls back Pi entry, spend and tool call together; reservation stays allocated |
| Tool outcome with workspace revision | Same transaction as Pi's pending result | `tool.result` always followed by `workspace.committed` |
| Cancellation and duration cap | Durable Pi abort, then nimplex terminal state | `aborted` operation result, `canceled`/`killed` turn, no later effect |
| Process death | Explicit `resumeTurn` drives the open Pi operation | Three real SIGKILL boundaries recover without repeated model calls or tool effects |
| Graceful shutdown | Harness closed without cancellation | `runtime_interrupted`, acceptance retry rejected, resume completes |

Recommended composition decision: adopt AgentHarness plus the async Storage
port as the durable bridge and retire the low-level Agent executor once the
remaining parity rows are implemented on this engine. This recommendation is not
yet Kevin's decision; the default is unchanged until it is.

Later the same day the engine gained budgeted summary requests (compaction,
branch summaries and overflow recovery through `completeSimple`), `reset` and
`compact` context modes as turn-owned Pi operations, Codex subscription dispatch,
Pi-policy branching into a separate Pi scope, and durable steering/follow-up input
with restart evidence. Each row has in-process and, where a boundary is involved,
real SIGKILL evidence (`pi-harness-engine-crash.test.ts`, five boundaries).

The hosted side now has `apps/worker/src/pi-storage.ts`, a PostgreSQL implementation
of Pi's Storage port scoped by organization and session with the same immutable
journal, rebuild and host-transaction seams as SQLite. It passes the same 21 upstream
conformance cases plus rollback, tenancy, rebuild, ownership and host-transaction
tests against a real PostgreSQL (`apps/worker/src/pi-storage.test.ts`, migration
`0010`). The worker itself still runs the default executor; running harness sessions
under lease fencing is the next hosted step.

Open before default migration: extension and resource loading through the
production bridge, hosted execution and takeover of harness sessions on PostgreSQL,
native/browser snapshots, and migration tooling for existing executor sessions.

## Regression record for the initial implementation slice

- `pnpm check --force`: all 12 workspace packages checked without cached results.
- `pnpm lint`: passed.
- `pnpm test`: 131 passed, 37 skipped. Optional E2B/ComputeSDK conformance and the
  opt-in native runtime test account for the skips; this is not remote-provider
  qualification.
- `pnpm e2e`: passed the existing fake-model hosted suite, including accounting,
  workspace recovery, SIGKILL, SIGSTOP takeover, cancellation and tenant isolation.
- `NIMPLEX_TEST_NATIVE=docker pnpm vitest run packages/runtime/src/native.integration.test.ts`:
  passed dependency reuse, branch isolation and native environment cleanup.
- New local input fixtures exercise duplicate/conflicting submissions, reopening,
  explicit interrupted-turn recovery, acceptance transaction rollback, old history
  reads, and failed schema migration. Headless fixtures cover cross-process retries.
- Changed execution/acceptance code was reviewed locally for atomicity, duplicate
  dispatch, interruption, branch scope and preservation of existing history. No
  Opus review or code commit was performed. No real-model or remote-provider test
  was needed to establish the negative composition result; those release gates
  remain outstanding.
