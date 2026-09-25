# Tech stack

> Living document: update the rationale whenever a choice changes. Detailed decisions are in the corresponding documents under `docs/product/`.

Scope, 2026-09-20: the local Pi harness. The hosted API/worker, PostgreSQL schema,
HTTP SDK and VPS deployment were removed from the tree; the historical choices for
them are in this file's git history and the dated `docs/product/` records.

## Runtime and toolchain

| Area | Choice | Rationale |
|---|---|---|
| Runtime | Node ≥ 22.13 and tsx; TypeScript runs directly without a build step | Internal packages import source, so contract changes take effect throughout the monorepo immediately; `node:sqlite` needs 22.13+ |
| Package manager | pnpm 10; workspace: apps/*, packages/*, examples/* | Workspace protocol and space-efficient hard links |
| Task runner | Turbo 2; `pnpm check` runs workspace TypeScript checks | Incremental caching |
| Lint / format | Biome 2 replaces ESLint and Prettier; docs/ excluded | Fast and avoids conflicting configurations |
| Testing | Vitest 4 for unit and conformance tests; `pnpm bench` for durability measurements; the `@nimplex/testkit` fake Anthropic upstream | Accounting and recovery tests never use real keys: testkit follows the Anthropic Messages API shape and `base_url` redirects the unchanged runtime through the real execution path |

## Runtime

`@nimplex/runtime` is the execution package. The terminal and headless paths use
its in-process session authority and `node:sqlite`. SQLite transactions commit
events, model accounting, Pi storage records and workspace snapshots; a separate
SQLite ownership database holds an OS lock for the runtime lifetime. See
[the local design](product/2026-09-13-local-runtime.md).

`pi-harness` is the default engine for new sessions since 2026-09-25: Pi's public
`AgentHarness` over nimplex's SQLite transaction through an async `Storage` port,
with Pi-native sessions, compaction, branching, steering, thinking levels, the full
provider catalog and trust-gated extensions. `pi-executor`, a host-owned Pi `Agent`
with nimplex-owned persistence, remains as the legacy engine for sessions that
recorded it and for `NIMPLEX_ENGINE=pi-executor`. Sessions keep their recorded engine.

Harness sessions use the complete installed Pi built-in model catalog and provider
adapters. Pi ModelRuntime resolves provider authentication, headers and cloud
environment configuration; Anthropic/OpenAI API-key files and Codex OAuth remain
compatible. There are no USD budgets. Pi supplies usage/cost estimates; call IDs
and atomic commits preserve accounting and recovery. The legacy executor
supports Anthropic and Codex only.

| Area | Choice | Rationale |
|---|---|---|
| Harness loop | **Pi** `@earendil-works/{pi-agent-core,pi-ai,pi-coding-agent}` 0.85.1 (MIT), through public APIs only | The 09-09 spike verified headless use, custom operations and usage; the 09-16 composition gate showed that `AgentSession` event subscription is not a commit barrier while the public `AgentHarness` + async `Storage` port is. No fork. Pi's grep/find/ls tools are not registered because grep spawns ripgrep directly; models use bash `grep`/`rg` |
| Tier 1 VFS | **just-bash** 3.4.2: `Bash({ cwd, files })` and `InMemoryFs` | 60+ commands, millisecond startup, no sandbox charge; native git/npm/network/binary operations route to a native sandbox before execution. The VFS has no snapshot API, so Tier 0 (workspace files and metadata) commits every tool atomically |
| Sandbox | Docker (`node:22-bookworm-slim` by default); direct **E2B** SDK 2.46; **ComputeSDK** 4.1 with `@computesdk/{daytona,vercel}` 1.7 for additional providers; local only for development | Pluggable sandbox port. Each provider runs the same C0–C10 conformance kit. ComputeSDK lacks stdin and per-exec signals; the adapter uses a temporary file with `<` and `Promise.race`, with actual limitations measured by conformance tests |
| Contracts | Zod 4 in packages/contracts | One source for request validation and stored record shapes |

## Terminal

| Area | Choice | Rationale |
|---|---|---|
| Terminal | `@earendil-works/pi-tui` 0.85.1 plus `@nimplex/runtime`; plain readline mode for pipes and one-shot commands | Shared terminal primitives provide multiline editing, autocomplete, scrolling and Markdown; separate controller, store, command registry, view and IO modules keep the application maintainable |
| Site | Vite, React, and GSAP ScrollTrigger (`apps/site`) | Marketing animations |

`.env` in the current project is loaded by the CLI; sandbox tools never inherit
provider credentials.

## Known pitfalls

Read these before changing the related dependencies:

1. **Two real E2B issues found by conformance tests:** (a) Hobby sandboxes have a one-hour lifetime limit; longer values return HTTP 400, `Timeout cannot be greater than 1 hours`. The default is one hour, overridable by `NIMPLEX_E2B_LIFETIME_MS`. (b) The default account is non-root `user`; create `/workspace` as `root`, then chown it to `user`.
2. **A remote provider's `create()` must kill the new sandbox if any subsequent setup step fails.** Otherwise no caller receives its ID and the sandbox leaks. The first real E2B mkdir failure leaked 12 sandboxes; `e2b.ts` and `computesdk.ts` clean up. Apply the same rule to new providers.
3. **The installed Pi `AgentSession._emit` does not await listeners.** A `session.subscribe` handler is not a commit barrier. Persist through the public `AgentHarness` `Storage` port instead; see `docs/product/2026-09-16-pi-composition-gate.md`.
4. **The fake upstream chooses its script step by counting `tool_result` blocks in the conversation.** Multi-turn tests and benchmarks that expect the script to restart must open a new session.

## Runtime implemented on 2026-09-10

- Pi 0.85.1 and just-bash 3.4.2; each model response and each tool has a durable checkpoint.
- `model_calls` tracks dispatch intents, settlements, and unknown outcomes; `spent_usd` records settled estimates. No monetary reservation or budget fields remain.
- Native routing parses the complete shell AST. E2B uses durable supervisor journals, pause/resume, and reconstruction after confirmed environment loss.
- The workspace preserves binary data, empty directories, symlinks, and permissions; `node_modules` is a reconstructible native cache.
- Context uses digest-verified extractive checkpoints. Original logs remain available through paginated `read_output` / `read_log` tools.
- See `docs/product/2026-09-10-harness-runtime.md`.
