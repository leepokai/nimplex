# Positioning map: Pi, Think, Maka, Grok Bot, and nimplex

Recorded on 2026-09-16. Kevin identifies nimplex's intended value as building on
Pi while combining capabilities associated with Project Think, Maka, and Grok
Bot. This confirms a direction to explore, not adoption of all four codebases,
a final target customer, or delivery of every referenced capability.

## Reference products and boundaries

The audience and value descriptions below are our interpretation of the cited
sources, rather than claims about market share or exclusive capabilities.

| Reference | Primary layer | Audience and value | Relevant inspiration | Evidence boundary |
| --- | --- | --- | --- | --- |
| Pi | Agent toolkit and coding CLI | Developers using or extending a model/tool loop and terminal agent | Model integrations, session workflows, skills, extensions, TUI | Toolkit and CLI are both in scope; importing Agent alone is not full compatibility |
| Project Think | Cloud agent harness and managed runtime ecosystem | Developers building persistent agents on Cloudflare | Durable identity, persistence, resumable interaction, lifecycle and tool integration | The Think harness and underlying Durable Objects are distinct adoption choices |
| Maka | Agent workspace and shared execution authority | Users running tasks with inspectable records across clients | Event authority, thin clients, task evaluation, local ownership | Current README goes beyond a desktop-only description; no fleet-scale conclusion follows |
| Grok Bot reference | Client, agent host, session runner, and execution environment | Reference for a hosted agent experience with background work | Warm runners, scheduling lanes, reconnects, environment continuity | Unofficial reconstructed code; official fleet and market positioning are not verified |
| nimplex today | Pi-based local harness plus hosted API/worker adapter | Current terminal users and platform development | Shared executor, checkpoints, just-bash/native routing | Full Pi parity and seamless local/cloud continuity remain incomplete |

Sources checked on this date:

- [Pi repository](https://github.com/earendil-works/pi): model API, agent loop,
  TUI, and coding CLI packages.
- [Think documentation](https://developers.cloudflare.com/agents/harnesses/think/):
  persisted agent loop, streams, tools, subagents, and Durable Object SQLite.
- [Maka repository](https://github.com/apache/maka): the former Maka-Agent URL
  redirects here. Its README describes a local agent workspace, append-only
  runtime events, shared Runtime Host, and published evaluations. These are
  project statements, not independently reproduced benchmark results.
- [Grok Bot reference study](2026-09-15-grok-bot-reference.md): pinned source
  observations and explicit limits on what the reconstruction establishes.

## Candidate nimplex positions

These positions describe different buyers and acceptance criteria. A product may
span several, but its first release needs a primary promise.

| Position | User or buyer | Product promise | Minimum convincing proof | Main overlap or cost |
| --- | --- | --- | --- | --- |
| A. Pi cloud runtime | Pi developers and agent builders | Deploy familiar Pi behavior as durable cloud execution | Extension compatibility, restart recovery, remote attach, supported environment contract | Think overlap; keeping pace with Pi is ongoing work |
| B. Agent workspace across local and cloud | Developers and technical operators | Start a task locally, let it continue remotely, return to the same work | Session/workspace handoff, reconnect, intervention, inspectable results | Maka/Grok-style experience; state transfer and UX are substantial |
| C. Managed agent fleet platform | Teams operating many agents | Deploy, schedule, observe, and govern many persistent agents | Tenant isolation, admission control, durable wakes, quotas, fleet operations | Broad infrastructure scope; requires real scale evidence |
| D. Self-hosted agent platform | Teams requiring infrastructure and data control | Operate agents in their own environment with portable records | Reproducible deployment, export/restore, upgrades, operational documentation | Hosting options create support and maintenance costs |
| E. Embeddable durable Pi harness | Developers building their own agent products | Add durable Pi execution through a stable SDK | Small integration example, stable contracts, deterministic failure tests | Less end-user UX; durability hooks must preserve Pi semantics |
| F. Agent for a specific recurring job | A selected user group with a concrete workflow | Complete that job with less setup and supervision | Measured end-to-end task outcomes and intervention effort | Requires choosing a workflow; generalized platform features are secondary |

Proposed emphasis based on Kevin's stated goals: A supplies the technical core,
B supplies the user-facing promise, and C is the long-term operating capability.
D is conditional on a confirmed self-hosting need; E is a packaging option; F
can provide a focused first workflow. This emphasis remains a recommendation.

## What combining the references means

```text
Terminal / Web / SDK
        |
Nimplex session and agent experience       <- workspace/host inspiration
        |
Durable execution and lifecycle boundary  <- Think-like capabilities
        |
Pi execution and extension integration   <- explicit foundation
        |
just-bash workspace / native sandbox
```

This is a responsibility sketch, not an implemented call graph. Persisted model
and tool boundaries must be integrated with execution, not merely wrapped around
an unobservable loop. The placement of Pi AgentSession and ownership of the
canonical session record remain open composition decisions.

Three integration strategies must not be conflated:

1. Build Think-like capabilities around Pi using nimplex's current hosted path.
   This preserves deployment choices but leaves ownership and recovery work with
   nimplex.
2. Use Cloudflare primitives to host or coordinate Pi execution. Evaluate where
   Pi runs, how actor state relates to executor state, and whether extensions need
   a Node host or external environment. This does not require using Think's loop.
3. Adopt the Think harness itself. First establish which component owns the loop,
   tool dispatch, session state, retries, and cancellation. Two independently
   authoritative loops cannot be assumed to compose into full Pi compatibility.

Maka and the Grok Bot reconstruction are design references here, not selected
runtime dependencies. No claim is made that any competitor lacks a candidate
feature; the comparison identifies emphasis and integration choices.

## Proposed positioning statement

> A persistent agent workspace built on Pi, with familiar local workflows and
> cloud execution that can continue across disconnections and restarts.

This is a target statement, not a current feature claim. A developer-facing
variant is "Durable cloud execution for Pi agents." The product-level advantage
must be demonstrated by workflow outcomes; database and scheduler choices alone
do not establish it.

## Acceptance and next decisions

- Identify the first user and recurring task before broadening the platform.
- Define Pi compatibility against the [inventory](2026-09-15-pi-compatibility.md),
  including extensions and resource reload rather than only command names.
- Prove a complete local-to-cloud task, disconnect/reconnect, restart recovery,
  intervention, and workspace retrieval with explicit failure semantics.
- Choose Cloudflare integration only after a bounded compatibility prototype;
  PostgreSQL and worker leases remain the current hosted implementation.
- Measure task completion, intervention effort, recovery, and operating cost.
  Do not imply production scale or exactly-once external effects without evidence.

Related records: [cloud candidates](2026-09-15-cloud-agent-candidates.md) and
[Think architecture and overlap](2026-09-16-cloudflare-think-reference.md).

## Subsequent clarification

Kevin subsequently described the core direction as a Pi version of Project Think:
durable cloud execution for Pi agents. This supersedes the earlier recommendation
to lead with workspace positioning; workspace and fleet experiences support the
core direction. The [durable Pi integration requirement](2026-09-16-pi-durable-runtime-requirement.md)
is confirmed as mandatory. Cloudflare adoption and execution topology remain open.
