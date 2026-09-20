# nimplex

A durable coding-agent harness built on top of Pi. The `nimplex` CLI starts a
session runtime in process; `packages/runtime` owns Pi execution, tools, context,
durable SQLite checkpoints, session workspace snapshots and session-scoped native
sandbox lifetime. No API server, database server or worker is required.

Current scope, confirmed on 2026-09-20: the local harness only. The earlier hosted
API/worker/PostgreSQL deployment, the HTTP SDK and the VPS deployment files were
removed from the tree on that date. Dated documents under `docs/product/` that
describe them are historical records. Cloud topology candidates remain recorded in
`docs/product/2026-09-15-cloud-agent-candidates.md` for a later decision; nothing
there is implemented, and PostgreSQL is not a requirement of any of them.

Read `docs/product/2026-09-13-local-runtime.md` for implemented local behavior.

@docs/file-structure.md
@docs/tech-stack.md

## Required reading

- Implemented local runtime contract: `docs/product/2026-09-13-local-runtime.md`
- Implemented recovery contract: `docs/product/2026-09-10-harness-runtime.md`
- Architecture invariants: `docs/product/2026-09-01-architecture.md` (hosted
  sections are historical)

Dated proposals describe historical decisions. Prefer the implemented runtime
contract and current source when older documents disagree.

## Rules

- `packages/contracts` defines the runtime's public schemas. Change contracts before
  the shapes that use them.
- Provider keys stay in the runtime and never enter sandboxes or tool environments.
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
  partial commits and unauthorized dispatch where applicable. Do not substitute
  implementation-mirroring assertions or line-coverage numbers for full
  requirement coverage.
- Never weaken assertions, silently skip required cases, or change expected behavior
  merely to make a suite pass. Fix the implementation and retain regression tests.
- Before claiming completion, audit the full requested scope against the tests
  actually run. Report uncovered, skipped, unavailable or failing cases explicitly;
  a green subset does not establish completion, and required gaps remain unfinished.

## Review after code changes

- Before committing code, run `/code-review medium`. Use `high` for accounting,
  run transitions, recovery, or broad changes.
- Reviews must use Opus. `/code-review` has no `--model` flag and uses the current
  session model. In Claude Code, switch with `/model opus` before reviewing.
- These slash commands are Claude Code commands, not Codex commands. Codex review
  does not satisfy the Opus review gate for a code commit.
- Fix actionable findings before committing and review substantial fixes again.
- Run `pnpm check`, `pnpm lint`, `pnpm test`, and the relevant integration checks
  (`pnpm bench`, `NIMPLEX_TEST_NATIVE=docker` native tests, sandbox conformance).

## Product positioning reference

Read `docs/product/2026-09-16-positioning-map.md` for Kevin's Pi-based direction
and the distinctions between Think-like capabilities, Cloudflare infrastructure,
and adopting the Think harness. Audience and packaging candidates remain open.

## Mandatory durable Pi integration

Kevin confirmed that preserving Pi capabilities while enforcing durable commit,
ownership, and recovery semantics is a necessary architecture step. Read
`docs/product/2026-09-16-pi-durable-runtime-requirement.md` before changing Pi
composition or persistence. Event mirroring alone does not meet this requirement;
full Pi parity and durability must both be preserved.

Implementation sequencing is proposed in
`docs/product/2026-09-16-durable-pi-implementation-plan.md`. The opt-in
`pi-harness` engine is the current bridge; do not switch the default engine
before its remaining gates pass.

Native/browser recovery must follow
`docs/product/2026-09-16-environment-browser-recovery.md`: preserve supported
Chrome session state and logs, define real snapshot capabilities, and distinguish
reattachment, snapshot restoration, reconstruction and unknown external effects.
