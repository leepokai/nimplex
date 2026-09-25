# Local release qualification for the harness default (2026-09-25)

Evidence for the Phase 6 local items of the
[durable Pi implementation plan](2026-09-16-durable-pi-implementation-plan.md), run
before `pi-harness` became the default engine for new sessions. Kevin approved the
switch the same day.

## Setup

- A fresh clone of `github.com/leepokai/nimplex` at `333c9d5` plus the cutover
  change, installed with `pnpm install`, run with an empty `HOME` and no ambient
  provider variables.
- Real providers: Anthropic `claude-haiku-4-5` (API key) and `openai-codex/gpt-5.6-sol`
  (ChatGPT subscription). Native sandboxes: Docker and E2B.
- Every state root was checked for these invariants: one settlement
  (`model.call` or `model.unknown`) per `model.started`, no duplicate `model.call`
  or `tool.result` IDs, `spent_usd` equal to the sum of settled costs, and no
  unsettled intent on a completed turn. Workspace contents were checked for
  duplicated side effects: each step appended one line to a file.
- The scripts were scratch files and were not committed.

## Results

| Area | Scenario | Result |
| --- | --- | --- |
| Real-model smoke | Two headless turns with a follow-up that depends on the first | Pass |
| Crash recovery | SIGKILL during the first model request; during the next request after a tool result; twice (original run and its resume) | Pass: no repeated step; interrupted requests settle as `model.unknown` |
| Native recovery | SIGKILL inside a running Docker command and inside a running E2B command | Pass: resume reattached to the journaled command; each line written once |
| Subscription model | Codex run, and Codex SIGKILL plus resume | Pass |
| Acceptance | Repeated `--request-id` with the same content and with different content | Pass: no second turn; the conflict is rejected |
| Ownership | A second process on a state root that is in use | Pass: rejected with "already owns" |
| Duration cap | `--timeout` during a native command, then a follow-up | Pass: `killed · duration_exceeded`, then the session continues |
| Upgrade | Roots written by schema v3 (`21ea9a8`) and by `333c9d5`, each with completed and SIGKILL-interrupted sessions on both engines, opened by the new code | Pass: interrupted turns resume, follow-ups keep history, and new sessions are `pi-harness` |
| Version mismatch | A v3 runtime opening a v4 root; `333c9d5` opening a root that has default-harness sessions | Pass: v3 refuses with "Unsupported runtime database version: 4"; `333c9d5` opens it and records its own new sessions as legacy |
| Backup and restore | Cold copy of an idle root; SQLite online `.backup` taken mid-turn and restored elsewhere | Pass: both continue; the hot copy resumes the interrupted turn |
| Interrupted migration | SIGKILL at 0.05 to 0.7 s while new code opens a v3 root, then reopen | Pass 9/9. A tenth kill at 1.0 s landed after the turn had started, and the follow-up was correctly told to resume first |
| Engine selection | Default and `NIMPLEX_ENGINE=pi-executor` set in both directions over the same root | Pass: each session kept its recorded engine |
| Terminal | Real TUI through a PTY: `/compact` then a question answered from the summary, `/thinking low`, `/rewind` twice (a branch of a branch), `/tree`, `/model openai/...` without a key | Pass after the fix below. The OpenAI model now fails for its missing credential, not for its engine |

## Defect found and fixed

`/rewind` or `/fork` on a branch failed for a turn the branch had inherited ("no
settled Pi operation to branch from"). A branch copies its source's turn list, but each
turn's Pi result stays in the scope of the session that ran it. Branching now resolves
the turn through the parent chain. Regression test: "branches a branch from a turn it
inherited from its source" in `pi-harness-engine.test.ts`.

## Open items

- The legacy executor leaves a request that was in flight at SIGKILL as a
  `model.started` without a settlement; the harness records `model.unknown`. This
  affects legacy sessions only.
- Hot backups were exercised with in-process VFS work only. A restored copy of a root
  whose session holds a native sandbox would share that sandbox with the original.
- Automatic threshold compaction is still covered only by Pi's own tests; manual
  compaction was verified above.
- The terminal shows "Check /runs before submitting again" for refusals that happen
  before dispatch, where no run exists.
- Launch blockers outside the engine remain: the README global-link command, a
  missing `E2B_API_KEY` producing a completed turn whose native commands never ran,
  untranslated sandbox error strings, and the `node:sqlite` experimental warning.
