# File structure

nimplex is a local coding-agent runtime built on Pi. The `nimplex` CLI starts the
runtime in process and stores everything in SQLite. See
[runtime architecture](product/2026-09-13-local-runtime.md).

The hosted API, worker, PostgreSQL schema, HTTP SDK and VPS deployment files were
removed on 2026-09-20. Dated documents that describe them are historical. Cloud
topology candidates remain recorded in
[cloud agent candidates](product/2026-09-15-cloud-agent-candidates.md), with
[Grok Bot reference evidence](product/2026-09-15-grok-bot-reference.md) and the
[Project Think architecture and overlap study](product/2026-09-16-cloudflare-think-reference.md);
none of them is implemented.

The [positioning map](product/2026-09-16-positioning-map.md) separates reference
products, candidate audiences, and the Pi-based direction.

The [mandatory durable Pi integration requirement](product/2026-09-16-pi-durable-runtime-requirement.md)
defines the required relationship between Pi capabilities and durable execution.
See the [durable Pi implementation plan](product/2026-09-16-durable-pi-implementation-plan.md)
for integration gates and acceptance criteria, and
[native and browser recovery](product/2026-09-16-environment-browser-recovery.md)
for Chrome state, journals, snapshots and restore acceptance.

```text
apps/
  cli/
    bin/nimplex.mjs              Executable entry point; loads TypeScript through tsx
    src/index.ts                Environment loading and TUI/headless routing
    src/local-runtime.ts        Runtime composition, engine selection and project state-root selection
    src/auth.ts                 Local model credentials; masked input and mode-600 storage
    src/codex-auth.ts           Pi subscription OAuth, isolated credential storage and refresh
    src/plain.ts                Headless/piped operations over the session runtime
    src/terminal/               Controller, commands, view, preferences and local file IO
      keyboard.ts               Shortcut contexts, profiles, chord timing and help
      composer.ts               Pi editor presentation and prompt history
      transcript.ts             Conversation/tool rendering and prompt positions
      panels.ts                 Searchable pickers and paged output viewers
      resources.ts              Declarative prompt/skill snapshots and argument expansion
      resource-commands.ts      Reload and resource command adapters
      pi-commands.ts            Pi-style session navigation, trust and extension commands
  site/                         Marketing site (nimplex.dev)
packages/
  contracts/src/                Zod schemas: turn requests, accepted input, events, checkpoints, Pi storage records
  core/src/                     Pure pricing/state/conversation functions and the SandboxProvider port
  runtime/src/
    runtime.ts                  Session execution authority, lifecycle, cancellation and events
    sessions.ts                 Session operations, turn seeding and read projections
    store.ts                    SQLite persistence and state-root OS ownership lock
    models.ts                   Local selection over the complete installed Pi provider/model catalog
    checkpoints.ts              Atomic model/tool/workspace commits
    pi-executor.ts              Legacy engine: host-owned Pi Agent loop; shared tool composition and system prompt
    pi-harness-engine.ts        Default AgentHarness engine: atomic commits, context operations, inbox, recovery
    pi-harness-local-host.ts    SQLite host port for the harness engine
    pi-harness-models.ts        Awaited dispatch intent inside Pi Models for assistant and summary requests
    pi-storage/                 SQLite Pi Storage with host transactions, journal, summary responses and conformance
    pi-summary-models.ts        Public Models facade for summary-response validation
    pi-extensions/              Trust-gated Pi extension bridge (bridge.ts: loading, hooks, tools)
    pi-harness-*.test.ts        Lifecycle, commit and process-recovery gates
    context.ts                  Checkpoints, digests, compaction and output archive
    workspace.ts                just-bash workspace snapshot/restore
    bash-routing.ts             Whole-script virtual/native routing
    native-bash.ts              Isolated supervisor journals and provider lifetime
  sandbox/src/                  Docker, E2B, ComputeSDK and local-development provider adapters
  testkit/src/                  Fake Anthropic upstream and sandbox conformance helpers
examples/quickstart/src/
  harness-bench.ts              Durability overhead, recovery time and storage growth measurements
```

## Dependency direction

```text
cli → runtime → core/contracts/sandbox
sandbox → core/contracts/testkit
core → contracts
```

- UI state is a projection; it cannot overwrite canonical execution events.
- Runtime has IO; `core` remains free of IO.
- Native tools receive an explicit workspace and isolated environment, not host secrets.
- Tests for runtime behavior live beside their runtime modules.
- Root `sandbox/` and `docs/competitor-analyze/` are ignored research artifacts.
