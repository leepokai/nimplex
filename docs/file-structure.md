# File structure

The current default entry point is a local coding-agent runtime. The existing hosted
API/worker deployment shares the same executor. See [runtime architecture](product/2026-09-13-local-runtime.md).
The long-term product direction and proposed alternatives are recorded in
[cloud agent candidates](product/2026-09-15-cloud-agent-candidates.md), with
[Grok Bot reference evidence](product/2026-09-15-grok-bot-reference.md) and the
[Project Think architecture and overlap study](product/2026-09-16-cloudflare-think-reference.md).

The [positioning map](product/2026-09-16-positioning-map.md) separates reference
products, candidate audiences, and the proposed Pi-based cloud workspace direction.

The [mandatory durable Pi integration requirement](product/2026-09-16-pi-durable-runtime-requirement.md)
defines the required relationship between Pi capabilities and durable execution.

See the [durable Pi implementation plan](product/2026-09-16-durable-pi-implementation-plan.md)
for integration gates, migration phases, and acceptance criteria.

[Native and browser recovery](product/2026-09-16-environment-browser-recovery.md)
extends the plan with Chrome state, journals, snapshots, and restore acceptance.

```text
apps/
  cli/
    bin/nimplex.mjs              Executable entry point; loads TypeScript through tsx
    src/index.ts                Environment loading and TUI/headless routing
    src/local-runtime.ts        Local runtime composition and project state-root selection
    src/auth.ts                 Local model credentials; masked input and mode-600 storage
    src/codex-auth.ts           Pi subscription OAuth, isolated credential storage and refresh
    src/plain.ts                Headless/piped operations over session runtime
    src/terminal/               Controller, commands, view, preferences and local file IO
      keyboard.ts               Shortcut contexts, profiles, chord timing and help
      composer.ts               Pi editor presentation and prompt history
      transcript.ts             Conversation/tool rendering and prompt positions
      panels.ts                 Searchable pickers and paged output viewers
      resources.ts              Declarative prompt/skill snapshots and argument expansion
      resource-commands.ts      Reload and resource command adapters
      pi-commands.ts            Pi-style session navigation and capability explanations
  api/src/                      Optional hosted HTTP API, auth, runs, SSE, continuation seeding
  worker/src/
    index.ts                    Hosted work queue, lease/fence, heartbeat, reaper, transitions
    checkpoints.ts              Postgres executor persistence adapter
    pi-storage.ts               Organization-scoped PostgreSQL implementation of Pi's Storage port
    native-bash.ts              Hosted ownership adapter to shared native execution
  site/                         Marketing site
packages/
  contracts/src/                Shared Zod schemas and public session/turn contracts
  core/src/                     Pure budget/pricing/state/conversation functions and ports
  runtime/src/
    runtime.ts                  Session execution authority, lifecycle, cancellation and events
    sessions.ts                 Session operations, turn seeding and read projections
    store.ts                    SQLite persistence and state-root OS ownership lock
    models.ts                   Local model selection and installed Codex subscription catalog
    checkpoints.ts              Local atomic model/tool/workspace commits
    pi-executor.ts              Shared Pi loop, tool composition and model projection
    pi-harness-engine.ts        Opt-in AgentHarness engine: atomic commits, context operations, inbox, recovery
    pi-harness-models.ts        Enforced reservation inside the Models port for assistant and summary requests
    pi-storage/                 SQLite Pi Storage with host transactions, journal, summary responses and conformance
    pi-summary-models.ts         Experimental public Models facade for summary-response validation
    pi-extensions/              Atomic Pi projection, durable extension actions, mutation barriers and tool adapter
    pi-harness-*.test.ts         Pinned candidate lifecycle, commit and process-recovery gates
    context.ts                  Checkpoints, digests, compaction and output archive
    workspace.ts                just-bash workspace snapshot/restore
    bash-routing.ts             Whole-script virtual/native routing
    native-bash.ts              Shared isolated supervisor journals and provider lifecycle
  db/src/                       Hosted Postgres schema, migrations, auth, workspace and events
  sandbox/src/                  Docker, E2B, ComputeSDK and local-development provider adapters
  sdk/src/                      Optional hosted API client; depends only on contracts
  testkit/src/                  Fake model endpoint and sandbox conformance helpers
examples/quickstart/src/         Hosted integration and recovery acceptance
```

## Dependency direction

```text
cli → runtime → core/contracts/sandbox
worker → runtime + db
api → db/core/contracts/sandbox
sdk → contracts
core → contracts
```

- UI state is a projection; it cannot overwrite canonical execution events.
- Runtime has IO; `core` remains free of IO.
- Default local execution does not import the Postgres package or start a server.
- Native tools receive an explicit workspace and isolated environment, not host secrets.
- Hosted queries remain tenant-scoped; API and worker coordinate through Postgres.
- Tests for shared execution live beside their runtime modules.
- Root `sandbox/` and `docs/competitor-analyze/` are ignored research artifacts.
