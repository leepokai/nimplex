# Required: integrate Pi capabilities with durable execution

Confirmed by Kevin on 2026-09-16 as a necessary architecture step.

## Decision

Nimplex must preserve full Pi capabilities while making execution obey nimplex's
explicit persistence, ownership, and recovery contracts. This is a mandatory
requirement, not an optional logging feature. Pi supplies agent behavior;
nimplex must ensure that accepted work and committed execution state survive
failure and that recovery proceeds from authoritative durable records.

The working product direction is durable cloud execution for Pi agents, informally
"a Pi version of Project Think." Maka and Grok Bot remain design references.
This direction does not select Cloudflare infrastructure or the Think harness.

## Required execution semantics

- Persist accepted input before acknowledging durable acceptance.
- Commit a model response and its tool-call intents before dispatching those tools.
- Give each tool call a stable identity and record execution intent before effects.
- Commit tool outcomes with the corresponding durable workspace revision or
  artifact references before allowing execution to depend on those outcomes.
- A failed required commit must stop dependent execution; asynchronous event
  mirroring that permits the loop to continue is insufficient.
- Restore context and execution state from authoritative records and valid
  checkpoints. Treat client views and in-memory state as projections.
- Distinguish work not started, known completed work, and unknown external
  outcomes. Never invent success or blindly repeat an uncertain external action.
- Define one execution ownership policy per mutable session, including cancellation
  and stale-owner rejection where multiple hosts may take over.

These requirements do not promise atomic transactions with external services or
exactly-once external side effects. Workspace contents must be durably available
before a committed reference claims they are recoverable.

## Pi integration boundary

Tool replacement and just-bash/native sandbox routing may be exposed through a
Pi extension. Durable execution requires verified control over ordering, commit
failures, and restoration across the complete session lifecycle. Merely subscribing
to events and copying them into a database does not satisfy this requirement.

Preserve Pi session and extension behavior, not only its low-level model/tool
loop. Cover branching, compaction, steering, follow-ups, resource reload, and
extension-originated operations through explicit supported boundaries. Trusted
extensions that execute arbitrary host code require a declared trust contract;
tool routing alone cannot make every extension side effect durable or isolated.

Audit hooks and storage facilities against the installed, pinned Pi version.
Current upstream features are not proof that the installed version supports the
same contracts. Prefer existing public facilities where their semantics suffice.
The final choice between Pi AgentSession orchestration and incremental adapters
remains open; neither Pi parity nor durability may silently be dropped to make
the composition easier.

## Existing foundation and remaining work

The current [executor](../../packages/runtime/src/pi-executor.ts) and
[local checkpoint adapter](../../packages/runtime/src/checkpoints.ts) already
implement parts of the model/tool commit boundary. The existing hosted adapter
uses PostgreSQL and lease fencing. Preserve these guarantees and existing data
while evaluating a more complete Pi integration.

This decision does not claim that full Pi parity, all extension recovery, or
cloud session continuity is implemented. Track capability gaps in the
[Pi compatibility inventory](2026-09-15-pi-compatibility.md).

## Acceptance evidence required before claiming completion

1. Record the supported Pi version, lifecycle hooks, canonical records, and the
   component that controls each commit and recovery boundary.
2. Inject storage failures and prove that dependent model/tool actions do not run.
3. Kill execution before tool dispatch, during an external action, and around
   result/workspace commits; verify correct recovery and unknown-outcome handling.
4. Verify representative Pi extensions and session operations without bypassing
   durable state, cancellation, or ownership rules.
5. Verify restart and reconnect behavior, plus stale-owner rejection for hosted
   takeover, with existing accounting, workspace, and tenant checks preserved.
   USD budget enforcement was removed by Kevin on 2026-09-20.

Implementation topology, database selection, and migration planning remain
separate decisions. This record changes documentation only.

The [implementation plan](2026-09-16-durable-pi-implementation-plan.md) translates
this requirement into phased delivery and acceptance gates. Its integration
strategy remains conditional on the pinned Pi composition experiment.

## Native and browser scope clarification

Kevin additionally requires native sandbox snapshots, Chrome/browser session
restoration and durable execution diagnostics. Follow the
[environment recovery requirements](2026-09-16-environment-browser-recovery.md);
conversation/workspace recovery alone does not complete the intended harness.
