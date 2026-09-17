# Pi-compatible resource reload and commands

nimplex uses Pi's agent core and tool factories within its own session runtime.
It does not launch Pi's complete CLI or its extension/session manager. The Pi
CLI's built-in commands therefore need explicit nimplex implementations.
This document describes implemented behavior, not full Pi or DSH parity.

## What reload means

`/reload` refreshes declarative resources and terminal preferences without
restarting the process or replacing the current session, draft, stash, running
tasks, or workspace. It rebuilds command completion and invalidates the terminal
render cache. Modified preference values affect subsequent turns; a running turn
retains the configuration it captured when it started.

The command validates a new snapshot before publishing it. Invalid preference JSON,
invalid values, an unpriced model, or a prompt parsing/read failure leaves the
previous preferences and resource snapshot active. Pi skill discovery warnings
are reported in the reload result; skills rejected by the Pi loader are omitted.
At startup, a resource-load failure leaves built-in commands available so the
user can fix the file and retry `/reload`.

| Change | Implemented behavior |
| --- | --- |
| Terminal preferences JSON | `/reload` rereads `~/.config/nimplex/terminal/preferences.json`, respecting `XDG_CONFIG_HOME` |
| Keymap and theme selection | Reloaded preferences immediately update the terminal; custom Pi keybinding/theme formats are not imported |
| Prompt Markdown | Add, edit, or remove a template, then `/reload`; autocomplete and dispatch use the new snapshot |
| Skill instructions | Rediscover skills and reread their `SKILL.md` bodies on `/reload` |
| AGENTS.md / CLAUDE.md | Reload validates/reads them; each subsequent submitted turn also reads the current files |
| JavaScript/TypeScript extensions, tools, UI source | Require a process restart; executable extension loading and hot replacement are not implemented |
| `.env` | Loaded at CLI startup, not by `/reload` |
| Database and running sandbox | Retained; reload does not migrate, recreate, or restart them |

The current implementation is manual resource hot reload. It is not a filesystem
watcher, general JavaScript HMR, or DSH-style plugin lifecycle management.

## Prompts

Create `.pi/prompts/check-code.md`:

```markdown
---
description: Review a selected module
---
Review $1 for correctness and missing validation.
Additional instructions: ${ARGUMENTS:-Focus on concrete findings.}
```

Run `/reload`, then `/check-code "src/example.ts"`. The template expands into the
composer; edit it and press Enter to submit. Expansion itself makes no model call.
`/prompts` lists loaded templates. Names are derived from Markdown filenames.
Built-in names and aliases always win collisions, with a diagnostic explaining
which resource was shadowed.

Arguments support quoted strings, `$1`, `$2`, `$@`, `$ARGUMENTS`, positional/all-args
defaults such as `${1:-default}`, and slices such as `${@:2:3}`. Substitution is
single-pass text replacement and never executes shell expressions.

Discovery precedence is project `.nimplex/prompts`, project `.pi/prompts`,
nimplex's global configuration `prompts` directory, then `~/.pi/agent/prompts`.
`PI_CODING_AGENT_DIR` can replace `~/.pi/agent`. Each prompt directory contributes
its direct `.md` children. Duplicate names keep the first resource.

## Skills

The Pi SDK parses skill metadata and discovers skill files. Search order is:

1. Project `.nimplex/skills`.
2. Project `.pi/skills`.
3. Project `.agents/skills` (the existing nimplex project catalog).
4. The nimplex global configuration `skills` directory.
5. `~/.pi/agent/skills`, or `PI_CODING_AGENT_DIR/skills`.

`/skills` lists loaded skills. `/skill:name TASK` expands the instruction body and
task into the composer. This is explicit instruction expansion, not automatic
model skill selection. Supporting scripts/assets are not copied into the isolated
workspace or run on the host. Attach required local text files using `@path`.
Requirements for tools that the harness does not expose are not fulfilled by
loading a skill. Resource files are limited to 128 KiB and the catalog to 512 entries.

## Pi command mapping

| Pi command | nimplex behavior |
| --- | --- |
| `/reload` | Reload the declarative resources and preferences described above |
| `/hotkeys` | Alias of the current keyboard guide |
| `/name` | Alias of `/rename` |
| `/session` | Current session ID, parent, head turn, project, counts, cost and resource timestamp |
| `/tree` | Navigate related sessions or create a branch after a completed turn; interrupted recovery remains governed by runtime rules |
| `/clone` | Alias of the existing current-head `/fork` |
| `/changelog` | Recent nimplex terminal changes |
| `/settings`, `/model`, `/new`, `/resume`, `/fork`, `/copy`, `/quit` | Existing nimplex operations remain available |
| `/login`, `/logout` | nimplex credential handling, not Pi OAuth/provider account management |
| `/compact` | Existing extractive checkpoint request for the next submitted turn, not Pi's summarization flow |
| `/export` | Local Markdown, not Pi HTML/JSONL |
| `/thinking`, `/scoped-models`, `/llama`, `/trust`, `/import`, `/share` | Explicit explanations of missing capabilities; not advertised as functioning commands |

There is no automatic gist publication, package installation, executable extension
evaluation, Pi settings import, or source-code replacement during resource reload.

## Validation

Tests cover discovery precedence, unchanged old snapshots, edits/removals, argument
substitution without shell evaluation, reserved command collisions, invalid
preferences, and retaining active runtime owners across reload. A real CLI PTY
test edited a prompt while the same process stayed open, invoked `/reload`, and
verified the new text, retained stashed draft and session ID, malformed JSON
rollback, removed-command behavior, skills expansion, `/hotkeys`, and `/tree`.
It made no model requests. Artifacts are ignored under
`sandbox/pi-reload-verification/`; the script is `sandbox/verify-pi-reload.py`.

References: [Pi extension reload lifecycle](https://pi.dev/docs/latest/extensions)
and the installed Pi 0.85.1 README command reference. Pi can support extension
reload; using its lower-level agent core alone does not inherit that lifecycle.
