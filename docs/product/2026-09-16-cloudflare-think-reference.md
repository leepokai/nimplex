# Cloudflare Project Think: architecture and product overlap

Recorded on 2026-09-16. This is a reference study and product assessment, not a
platform selection or migration decision.

## Verified reference

The current Think documentation describes `@cloudflare/think` as a stateful agent
base class with a model/tool loop, message persistence, streaming, resumption,
client tools, and extensions. Each agent instance is a Durable Object backed by
SQLite. Think supports top-level chat agents and subagents invoked over RPC,
and integrates with AI SDK models. This does not establish Pi compatibility.
See the [Think documentation](https://developers.cloudflare.com/agents/harnesses/think/).

Project Think is also the name of the broader Cloudflare initiative covering
long-running agents, durable execution, sessions, and tools across execution
environments. Distinguish the initiative's broader direction from the exact
behavior of an installed SDK version. See the
[Project Think announcement](https://blog.cloudflare.com/project-think/).

## Why SQLite can support this cloud architecture

```text
Client / event
      |
Cloudflare routing by object identity
      |
Durable Object running the agent
      |-- Per-object SQLite state
      |-- Model requests
      `-- Tools / external execution environments
```

Durable Objects combine addressable compute with durable storage. The platform
manages placement and object lifecycle; the application does not distribute one
ordinary local SQLite file across arbitrary workers. Many independent objects
partition state and execution. One logical object does not imply one dedicated
VM. See [Durable Objects concepts](https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/)
and the [SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).

For nimplex, choosing whether object identity represents an agent, session, or
another scope would still be an application design decision. Cross-session memory,
aggregate queries, tenant admission, and external tool lifetimes need explicit
contracts. Platform ownership does not make external actions exactly-once, nor
remove the need to handle cancellation, retries, and unknown outcomes.

SQLite is the storage engine; cloud routing, durability, and recovery are separate
capabilities supplied by this deployment system. Durable Object SQLite must not
be conflated with D1 or nimplex's local `node:sqlite` adapter.

## Implications for nimplex

The [architecture candidates](2026-09-15-cloud-agent-candidates.md) include this
pattern as candidate F. PostgreSQL remains the existing hosted implementation's
store and a provisional baseline for self-managed workers. It is not a universal
requirement for cloud agents or recovery across hosts.

For self-managed leased workers, nimplex must implement ownership transfer and
reject stale commits. Durable Objects can move much of that ownership machinery
into the platform. Their concurrency rules and external tool coordination still
need evaluation; custom worker leases should not be copied into an actor design
without a concrete need.

The phrase "log is the runtime" concerns authoritative records and recovery
semantics. SQLite or PostgreSQL alone says nothing about whether the system uses
an event log, checkpoints, mutable state, or a combination. Do not infer complete
replay guarantees from Think's persistence feature list.

Before adopting this candidate, verify full Pi behavior, Node/process/filesystem
requirements, extension loading, resource reload, native sandbox integration,
export/restore, cross-agent queries, and self-hosting requirements. No Pi-on-Think
prototype, deployment, or capacity benchmark has been completed here.

## Product overlap and hypotheses

Kevin raised a direct concern that Project Think overlaps with the intended
nimplex product. The assessment is that overlap is substantial at the general
cloud harness layer. Persistence, session management, resumable execution, and
tool orchestration should not be presented as unique merely because nimplex
implements them with a different database or scheduler.

Possible product directions remain hypotheses:

- Preserve Pi workflows and extensions while moving a local coding session into
  durable cloud execution. Full Pi parity and local/cloud continuity are still
  incomplete; they cannot be marketed as delivered advantages.
- Offer deployment and data ownership choices for customers who require their
  own infrastructure. Validate customer demand before paying the abstraction cost.
- Build a complete agent operating experience around a specific recurring job,
  including terminal/web interaction, intervention, recovery, and workspace access.
  Validate the job and user rather than targeting every agent use case.
- Use Cloudflare as infrastructure if that best serves the chosen product, subject
  to Pi compatibility and portability constraints. Think need not be integrated
  merely because Durable Objects are evaluated; replacing Pi is a separate choice.

Recommended next product exercise: choose one user and recurring task, implement
one complete flow, and compare its friction with building the same flow on Think.
Record a measurable benefit such as setup effort, intervention time, portability,
or recovery behavior. This recommendation does not authorize a runtime rewrite.

## Decision status

The long-term cloud-agent goal and Pi parity requirement remain. No switch to
Cloudflare, removal of PostgreSQL, or selection of a final differentiator has been
approved. Existing runtime behavior and stored sessions are unchanged.

The subsequent [positioning map](2026-09-16-positioning-map.md) records Kevin's
Pi-based synthesis direction and separates product positions from dependencies.
