# Terminal presentation and keyboard controls

This is the current interaction contract, supplementing the
[local runtime design](2026-09-13-local-runtime.md) and superseding the keyboard
and presentation details in the [initial terminal plan](2026-09-12-terminal-experience.md).

## Presentation

- Previous prompts are literal text in a shaded block with a turn number.
  Assistant messages use Markdown and a separate speaker label.
- Tools show their name, state, two wrapped command lines, and an output preview.
  Errors show four output lines immediately. `Alt+R` expands inputs and output
  (up to 80 output rows per tool). Hidden rows are counted.
- `/transcript` opens a paged conversation view, capped at 256,000 characters.
  `/export` writes the conversation and tool output to Markdown for larger results.
  Display limits do not change stored events.
- Completion shows status, tool count and cost. Run IDs remain in `/runs` and
  `/status`. The bordered composer shows Build or read-only Plan mode.
- The footer prioritizes model and session cost at narrow widths. Its workspace
  label indicates virtual-only history or native usage in this session, not live
  VM health. Local project files must still be attached explicitly with `@path`.

## Profiles

`/keymap claude`, `/keymap codex`, and `/keymap nimplex` persist a profile and
take effect immediately. The default is `nimplex`. `/keybindings`,
`/terminal-setup`, `F1`, or `?` on an empty prompt opens the complete in-app reference.
Application bindings and that reference share `keyboard.ts`.

| Key | nimplex / Claude profile | Codex profile |
| --- | --- | --- |
| Ctrl+O | Expand/collapse tool details | Copy last answer |
| Ctrl+T | List running conversations | Open/close conversation viewer |
| Ctrl+B | Background the conversation | Move cursor left |
| Alt+R | Expand/collapse tool details | Expand/collapse tool details |
| Ctrl+Shift+C | Copy last answer | Copy last answer |

Profiles adapt supported nimplex actions; they are not complete product emulations.
The Claude-profile task control lists running conversations, not model-generated
todos. Backgrounding opens another conversation in the same process; it does not
detach a daemon. In the Codex profile, use `/background` for that action.

## Shared controls

| Area | Controls |
| --- | --- |
| Submission | Enter sends; during a running turn, the draft is retained |
| Multiline | Shift+Enter, Alt+Enter, Ctrl+J, or backslash followed by Enter |
| Completion | Tab completes `/commands` and `@files`; it does not queue a message |
| Interruption | Esc stops the current task; menus and completion popups handle Esc first |
| Exit | Ctrl+C stops active work, otherwise clears input; a second idle press within one second exits. Ctrl+D deletes forward in text, or requires two presses within one second on empty input |
| Rewind | Double Esc saves and clears a draft; with empty input it opens the completed-turn branch picker |
| Drafts | Ctrl+S stashes/restores expanded draft text, or swaps two drafts. Stashes are in-memory; cursor positions are not restored |
| History | Up/Down or Ctrl+P/Ctrl+N moves within input, then recalls history at the edges; Ctrl+R opens searchable history |
| External editor | Ctrl+G or Ctrl+X then Ctrl+E opens `$VISUAL` / `$EDITOR` |
| All tasks | Repeat Ctrl+X then Ctrl+K within three seconds to stop every running conversation, including work still being created |
| Mode/model | Shift+Tab or Alt+M switches Build/Plan; Alt+P chooses a model |
| Screen | Ctrl+L redraws; Ctrl+Z suspends to the Unix shell; `fg` resumes |
| Conversation | PageUp/PageDown scrolls; Ctrl+Home/Ctrl+End jumps to first/latest output; Ctrl+Up/Ctrl+Down jumps between prompts |
| Search | Ctrl+Shift+F searches displayed transcript text; Enter/Shift+Enter moves between matches; Esc closes |
| Editing | Home/End or Ctrl+A/Ctrl+E moves to line boundaries; Alt+B/Alt+F or Ctrl+Left/Ctrl+Right moves by word |
| Deletion | Backspace/Ctrl+H and Delete/Ctrl+D delete characters; Ctrl+W/Alt+Backspace/Ctrl+Backspace and Alt+D/Alt+Delete/Ctrl+Delete delete words |
| Cut/undo | Ctrl+U/Ctrl+K cuts prefix/suffix; Ctrl+Y pastes cut text; Alt+Y cycles cut history; Ctrl+_, Ctrl+-, or Ctrl+Shift+- undoes edits |
| Menus | Up/Down or Ctrl+P/Ctrl+N selects; PageUp/PageDown pages; Home/End jumps; Tab/Enter accepts; Esc/Ctrl+C cancels |
| History picker | Ctrl+R/Ctrl+S selects older/newer matches; accepting restores text without sending it |
| Viewers | Arrows or j/k scroll; PageUp/PageDown or Space pages; Ctrl+U/Ctrl+D moves half a page; Home/End or g/G jumps; Esc/Ctrl+C/q closes |

Mouse selection followed by Ctrl+C copies the selection, taking precedence over
clearing input or interrupting work. Pasted text and Kitty key-release events do
not trigger application shortcuts. Option shortcuts require Option as Meta on
macOS. Some terminals consume modified keys; Ctrl+J is the portable newline.
Terminal-native Cmd+C/Cmd+V and bracketed text paste remain available.

Vim editing, image/voice input, reasoning/fast toggles, and queued-message controls
require capabilities that are not implemented and are not advertised as working.

## Implementation and validation

`composer.ts` customizes Pi's presentation while retaining its editing mechanics.
`transcript.ts` renders runtime projections, sanitizes terminal control sequences,
wraps by display width, and records prompt positions. `keyboard.ts` owns shortcut
contexts, profiles and chord timing; `panels.ts` owns selection and paging.
`view.ts` connects these components to the controller. Cancellation still goes
through runtime task owners; presentation does not duplicate execution rules.

Behavior tests cover interruption/exit boundaries, chord confirmation, paste,
profile changes, draft retention, history, menu cancellation/resizing, CJK/emoji
widths, error output, and stopping multiple running conversations. Repository
checks passed: `pnpm check`, `pnpm lint`, `pnpm test` (95 passed, 37 skipped for
optional provider/integration coverage).

A real CLI process was exercised through a PTY at 100×42, 52×42 and 40×20, using
isolated SQLite fixture data and no external model requests. Checks covered tool
expansion, multiline input, stash/restore, help paging, profile switching,
transcript viewing, a resized model picker, and clean double-key exit. Ignored
screenshots live in `sandbox/terminal-ui-verification/`; the script is
`sandbox/verify-terminal-ui.py`. Fixture costs and tool results are display data,
not evidence of package installation or paid model calls during these checks.

Shortcut references:
[Claude Code interactive mode](https://code.claude.com/docs/en/interactive-mode)
and the official [Codex keymap](https://github.com/openai/codex/blob/main/codex-rs/tui/src/keymap.rs).
