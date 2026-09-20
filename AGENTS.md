# nimplex — Codex project instructions

## Shared project context

Read `CLAUDE.md` for the shared project description and architectural rules. Its
`@path` references are Claude syntax: explicitly read `docs/file-structure.md` and
`docs/tech-stack.md` instead of assuming those files were imported automatically.
Keep shared architectural decisions in the existing documents.

Before runtime work, read:

- `docs/product/2026-09-13-local-runtime.md`, the implemented local runtime contract
- `docs/product/2026-09-10-harness-runtime.md`, the implemented recovery contract
- `docs/product/2026-09-01-architecture.md` (hosted sections are historical)
- `docs/product/2026-09-06-harness-on-just-bash.md`, especially the final decision in section 7

Dated documents include historical proposals. Distinguish the latest explicit
decision from a proposal and from behavior actually implemented in the code.
Current scope, confirmed on 2026-09-20: the local harness only. The hosted
API/worker/PostgreSQL deployment, HTTP SDK and VPS files were removed from the
tree on that date; documents describing them are historical. Cloud topology
candidates remain recorded in `docs/product/2026-09-15-cloud-agent-candidates.md`
and `docs/product/2026-09-16-cloudflare-think-reference.md` for a later decision;
nothing there is implemented.
`packages/runtime` owns sessions and executes Pi with just-bash/native tools.
Terminal and headless clients share this runtime; SQLite stores local state.
Model responses settle before tools; tool outcomes and workspace snapshots commit
together.

## Working conventions

- Use Traditional Chinese when discussing the project with Kevin.
- Write all documentation, instruction files, code comments, configuration comments,
  and commit messages in English. Keep documentation in Markdown. Discussion with
  Kevin may remain in Traditional Chinese.
- Preserve existing staged and unstaged work. Scope changes and commits to the task.
- Change public schemas in `packages/contracts` first. Keep `core` free of IO.
- Follow the credential boundaries in `CLAUDE.md`: provider keys never enter
  sandboxes. Existing implementation gaps are not precedents for new code.
- Put third-party experiments in the ignored root `sandbox/` directory. Never commit
  it, `docs/competitor-analyze/`, credentials, or local environment files.
- Project skills already live in `.agents/skills/`; `.claude/skills/` points to the
  same files. Do not duplicate or migrate them over themselves.

## Long-term maintainability

- Preserve Pi capability parity as a product requirement. Track actual support and
  gaps in `docs/product/2026-09-15-pi-compatibility.md`; importing Pi Agent alone
  does not establish full Pi CLI compatibility.
- Treat long-term code maintainability as a requirement, not a follow-up task.
- Keep UI rendering, command definitions, application state, and IO behind clear
  module boundaries. Reuse existing runtime and contract seams instead of duplicating
  business rules in clients.
- Prefer small, cohesive modules and explicit types. Extract shared behavior when
  it has real callers; avoid speculative abstractions and large command switches.
- Add behavior-focused tests for important state transitions and failure paths.
  Update the relevant architecture and usage documents when behavior changes.
- Remove superseded paths when replacing an implementation. Do not keep placeholder
  commands or claim a capability that the runtime does not actually enforce.

## Validation and review

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
  partial commits and unauthorized dispatch where applicable.
  Do not substitute implementation-mirroring assertions or line-coverage numbers
  for full requirement coverage.
- Never weaken assertions, silently skip required cases, or change expected behavior
  merely to make a suite pass. Fix the implementation and retain regression tests.
- Before claiming completion, audit the full requested scope against the tests
  actually run. Report uncovered, skipped, unavailable or failing cases explicitly;
  a green subset does not establish completion, and required gaps remain unfinished.

After code changes, run `pnpm check`, `pnpm lint`, and `pnpm test`, plus the relevant
integration or conformance checks (`pnpm bench`, native sandbox tests, sandbox
conformance). Use the fake upstream for accounting tests. Documentation-only changes need link/content and
diff checks; configuration changes also need format/configuration validation.

Review the changed code before committing. Review accounting, run transitions,
ownership, cancellation, and recovery with high scrutiny; use medium scrutiny for other code changes. Fix actionable findings and
rerun affected checks. Do not claim tests or reviews that were not performed.

`/code-review medium`, `/code-review high`, and `/model opus` in `CLAUDE.md` are
Claude Code commands, not Codex commands. Codex can review its changes, but that
does not satisfy the existing requirement for an Opus review before code commits.
Complete implementation and validation first; if a requested code commit still
requires that review and it is unavailable, report that specific remaining gate.
Do not add AI attribution trailers to commit messages.

## Codex configuration

`.codex/config.toml` contains project defaults. Model selection, credentials, and
permissions remain in the user's environment. There are no project Claude MCP
servers, hooks, custom agents, or slash commands to translate at this time.

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
