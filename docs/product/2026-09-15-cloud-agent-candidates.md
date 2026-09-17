# Cloud agent direction and architecture candidates

Recorded on 2026-09-15 after Kevin clarified the long-term product goal.

## Status and precedence

**Confirmed product direction:** nimplex should support many agents deployed for
long-term operation in the cloud, with large numbers of persisted sessions.
The terminal is one client and a development surface. Local CLI convenience must
not determine the platform's storage or execution architecture.

**Planning baseline:** retain PostgreSQL as the central durable store for the
existing self-managed cloud deployment path. Preserve shared Pi execution and
just-bash-first tools with isolated native sandboxes when needed. SQLite remains
the current local adapter. This baseline does not make PostgreSQL mandatory for
all cloud architectures: platform-managed SQLite is a separate candidate below.

**Not decided:** the final scheduling unit, session-host lifetime, deployment
platform, cloud session API, or whether a separate workflow/actor platform is
necessary. The candidates below are proposals, not completed capabilities.

This document supersedes the primary-product framing in the
[2026-09-13 local design](2026-09-13-local-runtime.md). It does not supersede that
document's description of implemented local behavior or change the executable.
The [Grok Bot study](2026-09-15-grok-bot-reference.md) is evidence informing the
options, not an instruction to clone its topology. The
[Project Think study](2026-09-16-cloudflare-think-reference.md) records the managed
SQLite alternative and substantial product overlap identified on 2026-09-16.

## Current implementation

| Surface | Actual behavior |
| --- | --- |
| Terminal and headless CLI | In-process `NimplexRuntime`, local SQLite, one process owning a state root |
| Hosted API and worker | PostgreSQL run/work-item storage, claims with leases and fencing, shared Pi executor |
| Tool execution | just-bash workspace plus native sandbox routing; persistence adapters checkpoint execution |
| Local-to-cloud session continuity | Not implemented; setting `DATABASE_URL` does not redirect local CLI sessions |
| Cloud deployment scale | No fleet-capacity benchmark was performed for this document |

Evidence: [CLI composition](../../apps/cli/src/local-runtime.ts),
[local store](../../packages/runtime/src/store.ts),
[worker](../../apps/worker/src/index.ts), and
[database schema](../../packages/db/src/schema.ts).

## Common vocabulary and requirements

- **Agent:** a durable identity and configuration, potentially including policies,
  memory, schedules, and several sessions. A first-class cloud agent record is
  proposed; the current runtime's session should not silently acquire all meanings.
- **Session:** a durable conversation and workspace lineage.
- **Turn/run:** a bounded execution request. Existing local turn and hosted run
  contracts need explicit mapping rather than assumed equivalence.
- **Activation:** the temporary period during which a host has a session loaded
  and may execute work for it.
- **Worker/host:** an OS process providing execution capacity; one process may
  serve multiple activations with bounded concurrency.
- **Sandbox:** the environment for tool execution. Its identity and lifetime are
  separate from the agent, session, and execution owner.

Long-lived agents must survive client disconnects and process replacement. They
do not require permanently running inference loops or one idle VM per session.
An accepted request needs durable identity and state before acknowledgment.
History must be paginated; large artifacts should be referenced from durable
object storage when volume warrants it. Object storage is a proposal, not a
description of the current workspace implementation.

## Candidate comparison

| Candidate | Execution owner | Durable authority | Useful when | Main cost or limitation |
| --- | --- | --- | --- | --- |
| A. One session host with PostgreSQL | One service hosts all active sessions | PostgreSQL | Initial cloud deployment and a simple behavioral baseline | Single-host capacity and outage boundary |
| B. Pool of workers claiming executor steps | A lease covers each work item | PostgreSQL | Burst workloads, fine-grained scheduling, frequent redistribution | Queue/restore overhead and more ownership transitions |
| C. Pool of hosts owning session activations | A lease covers an activation; host keeps a runner warm | PostgreSQL | Interactive sessions, steering, repeated turns, warm tool environments | Routing, eviction, draining, and ownership transfer |
| D. Isolated box per agent or tenant | A box host owns its agents and workspaces | PostgreSQL centrally; local state requires a defined replication contract | Strong environment affinity or dedicated customer compute | Idle cost, storage relocation, and box recovery |
| E. Durable workflow orchestration | Workflow history coordinates separately executed activities | Workflow engine for scheduling; PostgreSQL for product records | Long waits, schedules, approvals, and multi-stage business workflows | Two histories to reconcile, versioning, and operational dependencies |
| F. Platform-managed durable actors | Platform places and serializes actors | Actor storage and/or PostgreSQL with explicit authority boundaries | Managed placement and high counts of mostly idle identities | Platform limits, portability, and coordinating external tools |

These are architectural patterns, not product recommendations or claims that a
particular vendor implements every required guarantee. No new infrastructure
dependency is selected by this comparison.

### A. One session host with PostgreSQL

```text
Terminal / Web / API -> Session host -> Pi + tool adapters
                            |
                        PostgreSQL
```

Move session authority behind one host and retain a common runtime interface.
This can simplify a first deployment without making SQLite central. It still
needs durable recovery and a rule preventing overlapping old/new owners during
restarts or rolling deployment. A singleton label alone is not fencing.

Use A as an operational starting point or a prototype of C. It is not a final
answer to multi-host capacity. Direct CLI execution against PostgreSQL could be
a developer variant, but database credentials should not become the public
terminal client's cloud authentication mechanism.

### B. Workers claiming executor steps

```text
Clients -> API -> PostgreSQL work items <- worker pool -> shared Pi executor
```

This is closest to the existing hosted adapter. Each owner reconstructs the
needed committed context, performs its allocated work, checkpoints, and releases
or advances the item. Fine-grained work permits redistribution between steps.
Actual database and context-reconstruction cost must be measured before treating
this as inefficient or sufficient at the target scale.

Keep B if the workload is mostly independent jobs and the existing recovery
contract is valuable. It still needs cloud session semantics, durable wake inputs,
tenant fairness, concurrency limits, and reconnectable client projections.

### C. Session hosts with activation leases

```text
Clients -> API -> PostgreSQL inbox and session records
                              ^
                              |
                      pool of session hosts
                              |
                  cached Pi runners -> tool adapters
```

An available host claims a session activation, loads its committed state, and
processes accepted inputs in order. It keeps the runner warm across useful work,
then drains and releases ownership when idle or during deployment. The API can
write a durable inbox instead of depending on a live host connection. A routing
cache or notification accelerates delivery but is not the durable authority.

This combines the runner-registry pattern observed in Grok Bot with nimplex's
PostgreSQL and fencing requirements. It is the leading hypothesis for interactive,
persistent cloud agents, not a final selection. Idle eviction must commit state;
every mutable session needs one authoritative ownership rule. If agents have
multiple sessions, shared agent memory needs a separate concurrency policy.

### D. Dedicated boxes and local persistence

A host and an agent's native environment can remain assigned to a dedicated box.
The assignment might be per agent, tenant, or group; these have very different
isolation and cost profiles. A durable volume or verified replication can make
SQLite usable inside such a cloud deployment. Ephemeral container files alone
cannot satisfy the persistence requirement.

Two subvariants remain candidates: PostgreSQL holds canonical session events
with local caches, or local stores hold authority and replicate to central
storage. The second requires explicit acknowledgment, conflict, replication-lag,
backup, and restore semantics. Avoid casually introducing dual writable truths.
The reconstruction does not prove the official product uses either variant.

### E. Workflow orchestration

Use a durable workflow to schedule wakes, approvals, timeouts, and dependent
jobs; invoke the Pi harness as explicit activities. Do not blindly replay model
calls or tools as deterministic workflow code. Activity identifiers and external
idempotency remain necessary. Decide whether workflow history or PostgreSQL owns
each transition and how updates cross that boundary reliably.

This may later complement B or C when long waits dominate. It is unnecessary to
replace the whole agent loop merely to add a scheduler.

### F. Managed actors

Map an agent or session to a platform-managed actor and use its placement and
serialization facilities. Verify actual concurrency, hibernation, event ordering,
execution duration, storage, and migration behavior before selecting a platform.
Native shell execution remains in an external sandbox service. If PostgreSQL
also stores canonical events, actor memory must not become a second authority.

The advantage to test is reduced ownership infrastructure, not an assumption
that distributed coordination disappears. Cloudflare Project Think is now a
concrete reference for F; see the [reference study](2026-09-16-cloudflare-think-reference.md).
Pi compatibility, self-hosting, and data portability still need evaluation. No
actor vendor is chosen here.

## Ownership and recovery across candidates

For self-managed leased workers, lease expiry permits takeover; it does not stop
an old machine from running.
Use a monotonically increasing ownership epoch and reject stale state commits.
Session ownership and existing work-item fencing must have a defined relationship
if C is adopted; two independent locks are not automatically safer. Candidate F
should use verified platform ownership guarantees rather than automatically
reimplementing the same worker lease mechanism.

Database fencing cannot retract an already-dispatched external action. Retain
tool-call IDs, supervisor journals, provider handles, and explicit unknown-outcome
states. Do not promise exactly-once external effects. Cancellation must remain
durable and prevent late commits from reviving terminated work.

Schedules, messages, subagent completions, and manual input should become durable
wake records with deduplication keys. Maintain bounded concurrency and fair
admission per tenant. Keep unknown model charges reserved and preserve the existing
budget/accounting boundaries when adding autonomous retries or scheduled work.

Resources loaded by `/reload` are a separate concern. Resource updates can take
effect on later turns; executable upgrades need versioned checkpoints, draining,
and tested takeover. Neither a lease nor choosing PostgreSQL provides hot reload.

## Provisional direction and next decision

Retain the existing B implementation while evaluating C against it. A can be the
smallest deployment shape of the same host boundary. Preserve D for workloads
requiring dedicated environments; consider E for durable orchestration and F only
after a concrete platform evaluation. Do not build all candidates at once.

Before selecting B or C, run the same fake-model and sandbox scenarios against
both prototypes and record:

- Time from durable input acceptance to execution and first streamed output.
- Database operations and bytes loaded per turn, including long histories.
- Memory per active/idle session, reconnect behavior, and tenant fairness.
- Recovery after owner death, delayed heartbeats, and stale-owner tool completion.
- Rolling deployment, sandbox loss, duplicate wake delivery, and unknown effects.
- Budget correctness and cost per active session under the actual workload mix.

Set workload sizes and acceptance thresholds before benchmarking; no capacity
numbers are claimed yet. Preserve existing local and cloud data. A future
migration must explicitly address session/turn/run IDs, ownership, workspace
references, event ordering, and recovery. This documentation change performs no
storage migration and changes no runtime behavior.
