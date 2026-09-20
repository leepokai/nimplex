# 2026-09-12 · nimplex terminal experience

> Current keyboard and presentation behavior is documented in
> [Terminal presentation and keyboard controls](2026-09-13-terminal-controls.md).
> The acceptance record below describes the original implementation.

> The default terminal/headless architecture now follows [the 09-13 local runtime](2026-09-13-local-runtime.md). Hosted API/worker behavior and earlier acceptance records below retain their historical or hosted scope.

Goal: make `nimplex` usable as a daily terminal interface while preserving API/worker/SDK boundaries and explicitly requiring long-term maintainability in AGENTS.md and CLAUDE.md.

References: [Claude Code commands](https://code.claude.com/docs/en/commands), [interactive mode](https://code.claude.com/docs/en/interactive-mode), and [Codex commands](https://learn.chatgpt.com/docs/developer-commands). Shared names preserve user intent; they do not imply access to vendor accounts, services, or unsupported model capabilities.

## Implementation and acceptance checklist

- [x] Appearance: full-screen scrollable conversation, Markdown/code, compact tool cards, fixed composer, model/mode/cost/status footer, dark/light themes, narrow windows, CJK input.
- [x] Input: slash filtering/Tab completion, multiline input, paste, prompt history, Ctrl+R search, external editor, @ file attachments, shortcut help.
- [x] Conversations: /new, /clear, /resume, /continue, /fork, /rename, /compact, /rewind; continuation preserves workspace/history, branches leave their source unchanged.
- [x] Execution: /model, /plan, /permissions, /sandbox, /review; read-only is enforced by available tools, model lists come from the API.
- [x] Observation: /status, /cost and /usage, /context, /tasks and /ps, /stop and /kill, /background, /doctor; a disconnected observer does not imply a stopped server task.
- [x] Files/output: /files, /read, /diff, /mention, /copy, /export, /init, /memory; distinguish local IO from server workspace IO.
- [x] Settings: /help, /config, /theme, /keybindings and /keymap, /terminal-setup, /statusline, /login, /logout, /exit and /quit.
- [x] Keyboard: Enter submit, Shift+Enter/Ctrl+J newline, Tab completion, Esc stop, Ctrl+C clear/stop, Ctrl+D exit, Ctrl+L redraw, Ctrl+O tool details, Ctrl+R search, Ctrl+G editor, Shift+Tab mode, Alt+P model, Ctrl+B background, Ctrl+T tasks, double Esc branch from an earlier turn.
- [x] Maintainability: command registry, controller, session store, view, local IO; SDK/contracts first; no duplicated runtime state machine.
- [x] Validation: behavior tests, API tenant/source consistency, continuation/branch files, enforced read-only tools, PTY interaction, wide/narrow layouts, check/lint/test.

Models remain limited to the runtime's supported Anthropic catalog. Vendor billing, Codex Desktop, Claude Teams/cloud agents, and external plugin marketplaces cannot be implemented by adding command names; the menu does not pretend to provide those services.

## Behavior details

- Each follow-up is a new run seeded from a terminal parent. Rewind creates a branch at a completed turn, restoring that turn's server workspace through the next run's parent reference.
- `/compact` requests extractive context compaction on the next submission; it preserves raw server logs.
- `/plan` and `/permissions read_only` remove write/edit/bash tools in the worker. This is read-only inspection, not interactive approval of individual tool calls.
- `/keymap` and `/terminal-setup` show keyboard controls and terminal configuration guidance; shortcut remapping is not implemented.
- `/login` verifies and saves an organization API key, then exits for restart. `/logout` removes the saved key without revoking it or stopping server runs; environment-provided keys must be unset separately.
- Local AGENTS.md and CLAUDE.md are read for each task. Source code and entire local directories are not automatically synchronized or hot-reloaded.

## Acceptance record (2026-09-13)

- `pnpm check` and `pnpm lint` passed; `pnpm test` reported 69 passed and 36 skipped for unavailable providers.
- `pnpm e2e` passed continuation, independent branch files, cross-tenant rejection, enforced read-only tools, usage accounting, cancellation races, and checkpoint/lease recovery.
- A real Haiku terminal session wrote/read a file, then continued in a second run to edit/read the same workspace. The two run sequences cost $0.009531 total.
- PTY checks covered model navigation, plan/build switching, workspace read/diff, theme switching, 120-column and 60-column layouts, resume search, and clean exit.
- Separate PTY authentication checks verified hidden key entry, authenticated connection persistence with mode 600, and logout removing the saved credential.
- Language audit found no Chinese text in 20 Markdown files and five HTML files (including the site entry), or in 454 parsed JavaScript/TypeScript comments. CSS/configuration comments also passed. Intentional Unicode test data and existing localized runtime strings remain valid.
- Comment-only changes in 36 existing TypeScript files preserved their parsed program structure. Four historical HTML presentations preserved their element structure; their text and accessibility descriptions are now English.
- Local API and worker were restarted with the new runtime. No commit or push was performed for this change.
