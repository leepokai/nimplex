# Tech stack

> Living document: update the rationale whenever a choice changes. Detailed decisions are in the corresponding documents under `docs/product/`.

Product direction, 2026-09-15: the target is a cloud agent platform with many
durable sessions. The tables below describe the current implementation, including
its local SQLite entry point. See [cloud architecture candidates](product/2026-09-15-cloud-agent-candidates.md)
for the PostgreSQL planning baseline and unresolved execution topology.

## Runtime and toolchain

| Area | Choice | Rationale |
|---|---|---|
| Runtime | Node ≥ 22 and tsx in development and production; TypeScript runs directly without a build step | Internal packages import source, so contract changes take effect throughout the monorepo immediately |
| Package manager | pnpm 10; workspace: apps/*, packages/*, examples/* | Workspace protocol and space-efficient hard links |
| Task runner | Turbo 2; `pnpm check` runs workspace TypeScript checks | Incremental caching |
| Lint / format | Biome 2 replaces ESLint and Prettier; docs/ and migrations/ excluded | Fast and avoids conflicting configurations |
| Testing | Vitest 4 for pure functions, `examples/quickstart/src/e2e.ts` for smoke tests, and the `@nimplex/testkit` fake upstream | Core business logic is pure and inexpensive to test; scripts cover integration. **Accounting tests do not use real keys:** testkit follows the official Anthropic Messages API shape, and BYOK `base_url` redirects the unchanged worker through the real execution path |

## Local runtime

`@nimplex/runtime` is the shared execution package. The default terminal and
headless paths use its in-process session authority and Node 22.13+ `node:sqlite`.
SQLite transactions commit events, model accounting, and workspace snapshots;
a separate SQLite ownership database holds an OS lock for the runtime lifetime.
Pi, context projection, just-bash tools, and native journals are shared with the
optional hosted worker. See [the local design](product/2026-09-13-local-runtime.md).
An opt-in per-session engine (`NIMPLEX_ENGINE=pi-harness`) runs Pi's public
AgentHarness over the same SQLite transaction; the hosted schema carries the
matching organization-scoped Pi Storage tables (`pi_*`, migration 0010).

Local model access includes Anthropic API credentials and Pi's Codex subscription
OAuth provider. Subscription requests retain the shared executor but record quota
usage separately from API charges. See [subscription access](product/2026-09-15-codex-subscription.md)
and [Pi compatibility](product/2026-09-15-pi-compatibility.md). Hosted model dispatch
remains Anthropic-only.

## Optional hosted backend

| Area | Choice | Rationale |
|---|---|---|
| HTTP framework | Hono 4 and @hono/node-server | `/v1` control plane and Better Auth share an app; SSE uses `hono/streaming` |
| Database | Postgres 17; local Docker on :5433; Neon selected for production | `DATABASE_URL` allows cloud changes without code changes; application-level tenant isolation does not require Supabase RLS |
| ORM | Drizzle 0.45, drizzle-kit migrations, postgres.js driver | Schema-derived types and version-controlled migrations |
| Contracts | Zod 4 in packages/contracts | One source for API validation, SDK types, and DB JSONB types |
| Human authentication | Better Auth 1.7: GitHub / Google social login; email/password enabled only for development and E2E | Data stays in our DB without vendor lock-in (compared with Clerk); see the decision memory and `.env.example` setup instructions |
| Programmatic authentication | Organization API keys (`nmx_live_…`), SHA-256 stored, revocable | A small purpose-built interface; per-key limits provide a future spending-control extension point |
| Secret storage | AES-256-GCM envelope encryption for the BYOK vault; plaintext exists in memory only while accepting or using a credential | Architectural invariants I1/I3, as updated for the worker-hosted loop |
| Harness loop | **Pi** `@earendil-works/{pi-agent-core,pi-ai,pi-coding-agent}` 0.85.1 (MIT); host-owned `Agent`, one turn via `shouldStopAfterTurn`; VFS operations for read/write/edit and custom bash execution | The 09-09 spike verified headless use, custom operations, BYOK base URL, and usage (`sandbox/pi-spike/`). No fork or custom loop. Pi's grep/find/ls tools are not registered because grep spawns ripgrep directly; models use bash `grep`/`rg` |
| Tier 1 VFS | **just-bash** 3.4.2: `Bash({ cwd, files })` and `InMemoryFs` | 60+ commands, millisecond startup, no sandbox charge; native git/npm/network/binary operations route to Tier 2 before execution. VFS has no snapshot API; Tier 0 (`workspace_files` and metadata) commits every tool atomically |
| Sandbox | Docker (`node:22-bookworm-slim` by default); direct **E2B** SDK 2.46; **ComputeSDK** 4.1 with `@computesdk/{daytona,vercel}` 1.7 for additional providers; local only for development | Pluggable sandbox port; production defaults to a remote provider (architecture §9). Each provider runs the same C0–C10 conformance kit. ComputeSDK lacks stdin and per-exec signals; the adapter uses a temporary file with `<` and `Promise.race`, with actual limitations measured by conformance tests |

## Frontend and terminal

| Area | Choice | Rationale |
|---|---|---|
| Site | Vite, React, and GSAP ScrollTrigger | Marketing animations |
| Terminal | `@earendil-works/pi-tui` 0.85.1, plus `@nimplex/runtime`; plain readline mode for pipes and one-shot commands | Shared terminal primitives provide multiline editing, autocomplete, scrolling, and Markdown; separate controller, store, command registry, view, and IO modules keep the application maintainable |
| Browser SDK | Planned `@nimplex/sdk/browser`, with run-scoped viewer tokens and no apiKey field in its type | SDK architecture §2.5 |

## SDK

The terminal lives in `apps/cli` and loads TypeScript through tsx. It uses the
local session runtime directly. The HTTP SDK remains available for optional hosted
API deployments and depends only on contracts. `.env` in the current project is
loaded by the CLI; sandbox tools never inherit provider credentials.

| Area | Choice | Rationale |
|---|---|---|
| Interface | Vercel AI SDK v7 `Agent` shape: version/generate/stream | SDK architecture §1.2 |
| Event stream | SSE with native `Last-Event-ID` resume; sequence number is the cursor | The original competitor comparison identified clean resumable streams as a differentiator (§8.1) |
| Dependencies | Only `@nimplex/contracts` | Minimal installation overhead for SDK customers |

## Known pitfalls

Read these before changing the related dependencies:

1. **Better Auth 1.7 requires `issuer` in the account table.** Many online examples target older versions. See `packages/db/src/auth-schema.ts`.
2. **Better Auth brings Kysely, which can create a second Drizzle peer instance under pnpm and break type checking.** Keep `kysely` in db/api/worker devDependencies to unify the peer context when upgrading Drizzle or Better Auth.
3. Managed Agents was removed on 2026-09-06. Its SDK event-allowlist issue remains documented in this file's history at `0f32657`.
4. **Two real E2B issues found by conformance tests:** (a) Hobby sandboxes have a one-hour lifetime limit; longer values return HTTP 400, `Timeout cannot be greater than 1 hours`. The default is now one hour, overridable by `NIMPLEX_E2B_LIFETIME_MS`. (b) The default account is non-root `user`; create `/workspace` as `root`, then chown it to `user`.
5. **The worker originally did not load the root `.env`, while the API did**, so sandbox credentials were unavailable. Both now use `process.loadEnvFile`.
6. **A remote provider's `create()` must kill the new sandbox if any subsequent setup step fails.** Otherwise no caller receives its ID and the sandbox leaks. The first real E2B mkdir failure leaked 12 sandboxes; `e2b.ts` and `computesdk.ts` now clean up. Apply the same rule to new providers.
7. **Drizzle 0.45 wraps query errors in `DrizzleQueryError`; Postgres SQLSTATE is in `err.cause.code`.** Reading only `err.code` caused uniqueness errors to return 500 instead of 409. Always use `pgErrorCode()` in `apps/api/src/pg-errors.ts`.

## Runtime implemented on 2026-09-10

- Pi 0.85.1 and just-bash 3.4.2; each model response and each tool has a durable checkpoint.
- `model_calls` tracks reservations, settlements, and unknown outcomes; settled and reserved amounts are returned separately.
- Native routing parses the complete shell AST. E2B uses durable supervisor journals, pause/resume, and reconstruction after confirmed environment loss.
- The workspace preserves binary data, empty directories, symlinks, and permissions; `node_modules` is a reconstructible native cache.
- Context uses digest-verified extractive checkpoints. Original logs remain available through paginated `read_output` / `read_log` tools.
- Acceptance: `pnpm e2e`, `pnpm e2e:e2b`, and `pnpm e2e:real`. See `docs/product/2026-09-10-harness-runtime.md`.
