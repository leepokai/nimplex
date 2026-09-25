# Pi compatibility inventory

Kevin's requirement, recorded 2026-09-15: preserve the full set of Pi capabilities
while developing nimplex. Reusing Pi's Agent does not establish Pi CLI parity.
This inventory makes omissions explicit; it is not an acceptance claim or a
decision to remove listed capabilities from the target.

Baseline: installed `@earendil-works/pi-coding-agent` 0.85.1 README, public SDK
exports, and nimplex source. This is the initial inventory and should expand when
additional version-specific behavior is discovered.

## Current compatibility

| Capability | Current nimplex behavior | Remaining work |
| --- | --- | --- |
| Model/tool loop | Pi Agent, durable nimplex executor steps | Preserve when changing session composition |
| Codex subscription auth | Pi ModelRuntime OAuth, browser/device login, locked refresh | Additional provider login delegates to Pi OAuth/API-key flows; live account verification remains provider-dependent |
| Model catalogs | All installed Pi built-in providers/models on the harness engine (default since 2026-09-25); catalog, provider adapters and credential resolution come from Pi | Live credential verification for every provider, dynamic catalogs, custom models and provider extensions |
| Thinking and model cycling | `/thinking` and `--thinking` set Pi levels on the harness; model and level sync into the lane each turn. Pi retains its native thinking/output limits without a monetary cap. The legacy executor rejects non-off levels | Scoped-model cycling shortcuts |
| Text input and terminal editing | Pi TUI editor with nimplex presentation and keymap profiles | Audit exact Pi bindings and customization-file compatibility |
| Interactive and headless modes | nimplex TUI and one-shot/piped commands | Pi JSON/RPC protocol and SDK client compatibility |
| Session creation/resume/naming | nimplex durable session operations | Pi session format import/export and migration semantics |
| Branching/tree/clone | nimplex session branches and picker | Pi tree navigation and branch summary semantics |
| Compaction | Extractive digest-verified checkpoints | Pi model-generated summaries, automatic thresholds and compaction hooks |
| Prompt templates | Declarative expansion into editable draft | Full Pi template syntax, package resources and invocation semantics |
| Skills | Explicit body expansion and selected discovery roots | Automatic discovery/use parity, assets/scripts and all parent/global roots |
| Context files | Selected AGENTS.md/CLAUDE.md loading | AGENTS.override.md, global and parent precedence, no-context-files option |
| System prompt customization | nimplex instructions and sandbox prompt | SYSTEM.md and APPEND_SYSTEM.md semantics |
| `/reload` | Declarative resources, nimplex preferences, and Pi extension modules (reloaded on the next harness turn) | Themes and full Pi lifecycle reload |
| Extensions | Pi harness sessions load user extensions from the Pi agent directory and, after `/trust`, `<cwd>/.pi/extensions`, through Pi's public `DefaultResourceLoader` + `ExtensionRunner` (`packages/runtime/src/pi-extensions/bridge.ts`): registered tools (replay never), `before_agent_start` system prompt, `context`, `before_provider_request`, `tool_call` (block/rewrite args), `tool_result`, `session_start`, `sendMessage`/`sendUserMessage` as steer/follow-up through the durable inbox. Not bridged: commands, UI, `appendEntry`, `setModel`/`setThinkingLevel`/`setActiveTools`, `sessionManager` transcript reads (empty view), Pi packages/themes, `session_*` lifecycle events other than start, hosted execution | Command/UI bridge, transcript projection, hosted per-tenant extension host |
| Custom tools/providers/commands | No general Pi extension registration | Preserve registration and event contracts with explicit execution authority |
| Built-in file/shell tools | Pi read/write/edit via VFS; custom bash routing | grep/find/ls, PowerShell and user shell modes with supported backends |
| Steering and follow-up queues | Separate sessions may run in background | In-flight steering, ordered follow-ups and durable inbox semantics |
| Multimodal input | Selected text-file attachments | Image paste/files, rich model input and persistence limits |
| Settings, themes and keybindings | nimplex preferences and built-in themes | Pi configuration formats and custom theme/keybinding files |
| Packages | No Pi package install/update/remove integration | Package resource discovery, dependency and trust lifecycle |
| Trust and extension permissions | Host secrets stay outside sandbox; read-only tool mode; project extensions execute only when Pi's shared `trust.json` marks the directory trusted (`/trust`, `/extensions`); a load error fails the harness turn closed | Pi `project_trust` extension event and session-only trust |
| Export/copy/session diagnostics | nimplex variants | Pi import/share/export and diagnostic behavior parity |
| Upgrade/offline behavior | Source changes require restart; resource reload is separate | Pi update/offline settings and restart recovery contract |

## Composition choices still requiring a decision

1. Adapt Pi capabilities incrementally through public SDK boundaries while
   preserving nimplex as the durable execution authority.
2. Make Pi AgentSession the session orchestrator and attach nimplex's persistence,
   accounting, and sandbox integration at verified lifecycle boundaries.

The second option may reduce feature duplication, but must prove that model and
tool checkpoints settle before subsequent external actions. Running the full Pi
CLI as a subprocess is another integration technique; it does not automatically
provide those guarantees or preserve nimplex's current tool boundaries.

Some Pi extensions intentionally execute host code. Full extension compatibility
therefore needs an explicit trusted-extension boundary; silently routing all code
into just-bash would not be equivalent. Conversely, silently granting arbitrary
extensions host credentials would change nimplex's authority model.

No composition choice is finalized here. During the Codex-auth task, Kevin was
asked which boundary should take precedence. Independent auth work can finish
while that architectural choice remains open. Do not count this inventory as
implementation of its missing features.

## Confirmed integration requirement

On 2026-09-16 Kevin confirmed that Pi capability preservation and durable execution
must be integrated as a necessary architecture step. See the
[mandatory requirement](2026-09-16-pi-durable-runtime-requirement.md). Composition
is still open; neither requirement may be silently traded away.

## Acceptance rule

For each capability, record its Pi baseline, intended behavior, adapter location,
and executable verification. Command names alone do not establish compatibility.
Run the existing recovery, accounting, cancellation, workspace and tenant tests after
changing execution composition. Preserve existing local and hosted histories.

## Experimental adapter evidence, 2026-09-16

The default capability table above is unchanged. The pinned public AgentHarness
candidate now has SQLite storage/recovery qualification and a bounded real
ExtensionRunner fixture. Argument/result/message transformations and custom state
after completed operations match the AgentSession baseline in that fixture.
An atomic compatibility projection now exposes accepted custom entries from the
durable inbox at extension startup, preserving their visible identity and parent
through native transcript placement. Real SIGKILL/rebuild/restart tests cover both
response and tool-result boundaries. The projection also converts compaction and
branch-summary records, including replacement retained tails and navigation's
multiple tip writes. Structural SIGKILL/rebuild tests preserve committed summaries
and extension context without repeating completed work. Projection version 3 also
records model/thinking, session-name and label mutations atomically, including
clears and ordered mixed transactions. A metadata SIGKILL/rebuild case checks the
fresh runner's model and restored state. Version-1/2 projections require explicit
migration; historical branch settings and the current lane configuration remain
distinct until the host navigation policy is implemented. Experimental settings
actions now use staged durable writes; registered-model selection has a recoverable
model/thinking intent and an enforced pending-dispatch guard. Paired behavior and
mid-selection SIGKILL tests cover these bindings. Same-callback session-view reads,
dynamic catalogs, resource versioning and global preference persistence remain
gaps. The compaction adapter now invokes legacy preparation/completion/failure
handlers, preserves exact retention IDs and extension details, drains staged writes
before summary generation, and blocks dependent dispatch on required failures.
Paired manual/repeated-compaction, cancellation, automatic-threshold notification,
ownership-loss and SIGKILL cases qualify this bounded integration. Overflow retry,
recovery reuse of raw summary responses,
complete automatic-compaction parity, host command integration and tree hooks
remain open. Remaining extension action
bindings, resource/trust lifecycle and legacy export/
import still require qualification. Full extension parity is not yet established. See the
[composition report](2026-09-16-pi-composition-gate.md#extension-adapter-qualification-added-after-the-storage-slice)
for test coverage, enforced boundaries and remaining gaps.

The experimental public Models facade rejects truncated or tool-calling summaries
while allowing Pi to settle their usage and persist structural failure. Paired
compaction/branch-summary tests cover this legacy behavior; ordinary streaming and
cancellation remain unchanged. Additional SIGKILL cases preserve committed summary
usage without publishing partial checkpoints or redispatching under the fixture's
disabled-retry policy. A Storage/Models boundary now commits original structural
responses and validation verdicts atomically with native usage, checks request
identity before dispatch, and preserves the records through SIGKILL/journal rebuild.
Concurrent admission, cancellation before HTTP dispatch, rejected settlement,
immutability and tenant/session isolation have executable tests. This is not full
model accounting or automatic recovery reuse of those responses.

## Opt-in production engine, 2026-09-17

`NIMPLEX_ENGINE=pi-harness` runs new sessions on the public AgentHarness with
nimplex's transaction, dispatch intent and workspace commits. The capability table
above still describes the default engine. On the harness engine the model/tool
loop, session history, cancellation, crash recovery, model-generated compaction
and branch summaries, root reset, Pi-policy branching, steering/follow-up queues,
per-turn thinking levels, Anthropic/OpenAI API and Codex subscription dispatch are
Pi-native and durable. Since 2026-09-18 the hosted worker runs harness sessions as
one leased `harness` work item with fenced PostgreSQL commits and takeover (see the
[hosted harness section](2026-09-10-harness-runtime.md#pi-harness-on-the-hosted-worker-2026-09-18)),
and local harness sessions execute trust-gated Pi extensions. Pi packages, themes,
extension commands/UI and hosted extension execution are not bridged. See the
[runtime contract](2026-09-13-local-runtime.md#pi-harness-engine-opt-in-added-2026-09-17).
