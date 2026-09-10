# nimplex — Codex project instructions

## Shared project context

Read `CLAUDE.md` for the shared project description and architectural rules. Its
`@path` references are Claude syntax: explicitly read `docs/file-structure.md` and
`docs/tech-stack.md` instead of assuming those files were imported automatically.
Keep shared architectural decisions in the existing documents.

Before runtime work, read:

- `docs/product/2026-09-01-local-dev-runbook.md`
- `docs/product/2026-09-01-architecture.md`
- `docs/product/2026-09-01-sdk-architecture.md`
- `docs/product/2026-09-06-harness-on-just-bash.md`, especially the final decision in section 7
- `docs/product/2026-09-09-mvp-demo-plan.md`

Dated documents include historical proposals. Distinguish the latest explicit
decision from a proposal and from behavior actually implemented in the code.
The worker runs Pi (`@earendil-works/pi-agent-core`) as the loop kernel with tools on a just-bash in-memory VFS (`apps/worker/src/pi-executor.ts`); one work item drives one turn. Model responses and reservations settle before tools run; each tool result and workspace snapshot commits atomically. Native commands use the configured isolated sandbox with durable dispatch journals. Read `docs/product/2026-09-10-harness-runtime.md` for the implemented recovery contract and acceptance commands.

## Working conventions

- Use Traditional Chinese when discussing the project with Kevin.
- Write code comments, configuration comments, and commit messages in plain English.
  Keep product documents in Chinese and Markdown.
- Preserve existing staged and unstaged work. Scope changes and commits to the task.
- Change public API shapes in `packages/contracts` first. Keep `core` free of IO and
  the SDK dependent only on contracts. API and worker coordinate through Postgres.
- Follow the tenant isolation and credential boundaries in `CLAUDE.md`. Existing
  implementation gaps are not precedents for new code.
- Put third-party experiments in the ignored root `sandbox/` directory. Never commit
  it, `docs/competitor-analyze/`, credentials, or local environment files.
- Project skills already live in `.agents/skills/`; `.claude/skills/` points to the
  same files. Do not duplicate or migrate them over themselves.

## Validation and review

After code changes, run `pnpm check`, `pnpm lint`, and `pnpm test`, plus the relevant
integration or conformance checks described in the runbook. Use the fake upstream
for budget and accounting tests. Documentation-only changes need link/content and
diff checks; configuration changes also need format/configuration validation.

Review the changed code before committing. Review budget, accounting, tenant
isolation, run transitions, leases, fencing, cancellation, and recovery with high
scrutiny; use medium scrutiny for other code changes. Fix actionable findings and
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
