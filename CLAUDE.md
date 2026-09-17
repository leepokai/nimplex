# nimplex

A coding-agent harness whose long-term product is a cloud agent platform with
many durable sessions. Read `docs/product/2026-09-15-cloud-agent-candidates.md`
for the confirmed direction and candidate designs; the execution topology is
not finally selected. Reference evidence is recorded in
`docs/product/2026-09-15-grok-bot-reference.md` and
`docs/product/2026-09-16-cloudflare-think-reference.md`. The latter records managed
SQLite and product overlap; PostgreSQL is not required by every cloud topology.

The current `nimplex` CLI starts a session runtime in process;
no API server, Postgres, or leased worker is required for terminal/headless use.
`packages/runtime` owns Pi execution, tools, context, durable SQLite checkpoints,
session workspace snapshots, and session-scoped native sandbox lifetime.
The existing hosted API/worker deployment reuses the same executor with Postgres
persistence and lease fencing. Read `docs/product/2026-09-13-local-runtime.md`
for implemented local behavior; its primary-product framing is superseded by
the 2026-09-15 direction.

@docs/file-structure.md
@docs/tech-stack.md

## Required reading

- Local operation and acceptance: `docs/product/2026-09-01-local-dev-runbook.md`
- Architecture and invariants: `docs/product/2026-09-01-architecture.md`
- SDK boundaries: `docs/product/2026-09-01-sdk-architecture.md`
- Implemented recovery contract: `docs/product/2026-09-10-harness-runtime.md`

Dated proposals describe historical decisions. Prefer the implemented runtime
contract and current source when older documents disagree.

## Rules

- `packages/contracts` defines public API schemas. Change contracts before API shapes.
- No `/internal` API: clients use `@nimplex/sdk` and the same public endpoints as customers.
- For hosted deployment, API and worker do not call each other. They coordinate through PostgreSQL.
- Scope every hosted database query to the organization, using a scoped join where needed.
- Provider keys stay in the owning runtime (or hosted API/worker) and never enter sandboxes.
- Write **all documentation, instruction files, code comments, configuration comments,
  and commit messages in English**. Use Markdown for documentation. Conversation
  with Kevin may remain in Traditional Chinese.
- `docs/competitor-analyze/` and `sandbox/` are ignored; never commit them.
  Keep third-party experiments under `sandbox/`.
- Never commit credentials or local environment files.
- Do not add AI attribution trailers to commits; the commit hook rejects them.

## Long-term maintainability

- Preserve Pi capability parity as a product requirement. See
  `docs/product/2026-09-15-pi-compatibility.md` for the current inventory and open
  composition choices; do not claim missing capabilities are implemented.
- Treat long-term code maintainability as a requirement for every change.
- Separate UI rendering, command definitions, application state, and IO. Reuse
  runtime and contract boundaries instead of duplicating business rules in clients.
- Prefer small, cohesive modules and explicit types. Extract abstractions for
  actual shared needs; avoid speculative frameworks and giant command switches.
- Cover important transitions and failure paths with behavior-focused tests.
  Update architecture and usage documentation when behavior changes.
- Remove superseded code when replacing an implementation. Do not ship placeholder
  commands or claim capabilities that the runtime does not actually enforce.

## Full behavioral test coverage

Full behavioral test coverage is required throughout implementation, not deferred
until the end. Do not take shortcuts by narrowing the requested behavior to the
cases that are easiest to implement or test.

- Map every requirement and acceptance criterion to executable evidence. Cover
  normal behavior, boundaries, invalid input, important branches, failure paths,
  and relevant concurrency, cancellation, ownership and recovery transitions.
- Add or update tests with each behavior change. Use unit tests for pure logic,
  integration/conformance tests for real boundaries, and end-to-end tests for
  complete user workflows. Include actual process-death/restart tests where
  durability is claimed; mocks alone cannot prove those guarantees.
- Test observable outcomes and invariants, including absence of duplicate effects,
  partial commits, cross-tenant access and unauthorized dispatch where applicable.
  Do not substitute implementation-mirroring assertions or line-coverage numbers
  for full requirement coverage.
- Never weaken assertions, silently skip required cases, or change expected behavior
  merely to make a suite pass. Fix the implementation and retain regression tests.
- Before claiming completion, audit the full requested scope against the tests
  actually run. Report uncovered, skipped, unavailable or failing cases explicitly;
  a green subset does not establish completion, and required gaps remain unfinished.

## Review after code changes

- Before committing code, run `/code-review medium`. Use `high` for accounting,
  budgets, run transitions, or broad changes.
- Reviews must use Opus. `/code-review` has no `--model` flag and uses the current
  session model. In Claude Code, switch with `/model opus` before reviewing.
- These slash commands are Claude Code commands, not Codex commands. Codex review
  does not satisfy the Opus review gate for a code commit.
- Fix actionable findings before committing and review substantial fixes again.
- Run `pnpm check`, `pnpm lint`, `pnpm test`, and the relevant integration checks.

## Product positioning reference

Read `docs/product/2026-09-16-positioning-map.md` for Kevin's Pi-based direction
and the distinctions between Think-like capabilities, Cloudflare infrastructure,
and adopting the Think harness. Audience and packaging candidates remain open.

## Mandatory durable Pi integration

Kevin confirmed that preserving Pi capabilities while enforcing durable commit,
ownership, and recovery semantics is a necessary architecture step. Read
`docs/product/2026-09-16-pi-durable-runtime-requirement.md` before changing Pi
composition or persistence. Event mirroring alone does not meet this requirement;
full Pi parity and durability must both be preserved. Implementation remains open.

Implementation sequencing is proposed in
`docs/product/2026-09-16-durable-pi-implementation-plan.md`. Begin with the pinned
Pi composition gate; the installed AgentSession event subscription is not an
awaited database commit boundary. Do not migrate the default before that gate.

Native/browser recovery must follow
`docs/product/2026-09-16-environment-browser-recovery.md`: preserve supported
Chrome session state and logs, define real snapshot capabilities, and distinguish
reattachment, snapshot restoration, reconstruction and unknown external effects.
