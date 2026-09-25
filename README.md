<img src="apps/site/public/icon-1024.png" alt="nimplex icon" width="96" height="96">

# nimplex

**A durable coding-agent harness built on top of [Pi](https://github.com/earendil-works/pi).**

Pi drives the model and the tools. nimplex commits every model response, tool
result and file change to a SQLite log before the next step happens, so a session
survives a `kill -9`, a dead sandbox or a lost network, every model call is
accounted for exactly once, and any turn can be stopped mid-flight. It runs on
your laptop as the `nimplex` terminal: no server, no database service, no worker.

> Status: early and pre-release. Open-sourced on 2026-09-20. Contracts and CLI
> flags change without notice. Read [What is not done yet](#what-is-not-done-yet)
> before relying on anything.

## Inspired by Cloudflare Project Think

nimplex is inspired by [Cloudflare's Project Think](https://blog.cloudflare.com/project-think/):
an agent should have a durable identity, keep its state when the process running
it goes away, and resume where it left off. Think delivers that on Cloudflare's
platform, where each agent is a Durable Object with its own SQLite store and the
platform owns placement and lifetime. nimplex pursues the same promise for Pi
agents on your own machine: one SQLite log per state root, explicit commit
barriers around every model response and tool result, a durable workspace that
outlives the sandbox, and recovery from the log after `kill -9`. It does not use
the Think harness, `@cloudflare/think` or Durable Objects, and it keeps Pi's loop,
session and tool semantics. What was compared and what remains open:
[Think reference study](docs/product/2026-09-16-cloudflare-think-reference.md).

```text
nimplex CLI ──► session runtime (in process) ──► Pi ──► model provider
                       │
             SQLite: events, model calls, Pi records, workspace revisions
                       │
             read / write / edit / bash
                       │
      just-bash VFS  ──or──  Docker / E2B / ComputeSDK sandbox (native commands only)
```

## Built on Pi

[Pi](https://github.com/earendil-works/pi) describes itself as "a minimal
terminal coding harness": a model/tool loop, a provider catalog, sessions with
branching and compaction, and TypeScript extensions, skills and prompt templates.
nimplex uses Pi's published packages (`@earendil-works/pi-agent-core`, `pi-ai`,
`pi-coding-agent`, `pi-tui`, pinned to 0.85.1, MIT) through their public APIs.
There is no fork and no patched internals.

| Comes from Pi | Added by nimplex |
| --- | --- |
| The agent loop: model requests, tool calls, streaming, retries | Commit barriers around every step: a model response is durable before its tools run, a tool result and workspace revision are durable before the next model call |
| Provider catalog and authentication: every built-in Pi provider, API keys, OAuth logins, Codex subscription | Call identity and settlement: a committed call ID before dispatch, atomic usage settlement, lost responses recorded as explicit unknown outcomes |
| Thinking levels, model switching, session tree, branch summaries, compaction, steering and follow-up queues | Ownership: an OS lock per state root, so only one runtime commits to a session at a time, and recovery that resumes an interrupted turn from the log after process death |
| Extensions, skills, prompt templates, context files, the terminal editor | Tiered tool execution: pure shell in an in-process VFS, native commands in a disposable sandbox, files in a durable workspace that outlives both |
| Session persistence through the public `AgentHarness` and its async `Storage` port | A SQLite implementation of that port sharing one transaction with nimplex's own events, accounting and workspace commits |

New sessions run on `pi-harness`: Pi's public `AgentHarness` on nimplex's SQLite
transaction, with Pi-native sessions, compaction, branching, steering, thinking
levels, the full provider catalog and trust-gated extensions. The earlier
`pi-executor` (a host-owned Pi `Agent` that supports only Anthropic and Codex) stays
as a legacy engine: sessions created on it keep it, and `NIMPLEX_ENGINE=pi-executor`
still selects it for new sessions. Every session keeps the engine it was created with. The row-by-row state of
Pi compatibility is tracked in the
[Pi compatibility inventory](docs/product/2026-09-15-pi-compatibility.md); a
command name alone is never counted as compatibility.

## What the harness guarantees

| Guarantee | How |
| --- | --- |
| **A turn survives process death** | Every model response and tool result is committed before the next step. After `kill -9`, the runtime reopens the state root, classifies the interrupted turn and resumes it: committed responses are reused, only the missing tool calls execute, against the last committed workspace. |
| **A turn survives a dead sandbox** | Files live in a durable workspace (Tier 0), not in the sandbox. Native commands run under an in-sandbox supervisor whose journal is keyed by tool-call ID, so a restarted runtime collects the same result instead of running the command twice. Confirmed sandbox loss creates a new generation, restores the workspace, and reports any command with unknown side effects instead of replaying it. |
| **Model usage is durable** | Each request has a committed call ID before dispatch. Responses and usage settle atomically, duplicate settlements are ignored, and lost responses remain explicit unknown outcomes. There is no USD spending limit. |
| **Any turn can be cancelled** | Cancellation is a durable transition. The model call and tool in flight are aborted, a late response cannot overwrite the terminal state, and a cancelled tool never publishes a partial workspace. |
| **Accepted input is not duplicated** | Headless requests carry a session-scoped `--request-id`. Retrying the same ID replays the original turn's committed events; reusing it with different content fails. |

Measured with `pnpm bench` (fake upstream with zero model latency, so the numbers
isolate nimplex's own durability cost): a six-tool turn costs about 36 ms and 89
durable commits; recovery after `SIGKILL` takes about 13 ms with no repeated side
effects. Real provider latency dominates in practice. Details and caveats:
[harness benchmark](docs/product/2026-09-18-harness-benchmark.md).

## Harness properties

**The log is the runtime.** The transcript, the model's context, the workspace
and crash recovery are all projections of one append-only history. No in-memory
state survives between turns by design.

**Execution tiers.**

| Tier | What | Persistence |
| --- | --- | --- |
| Tier 0 | Durable workspace in SQLite: files, binary content, empty directories, workspace-local symlinks, mode bits | Every tool commit writes the byte delta and a workspace revision |
| Tier 1 | [just-bash](https://github.com/vercel-labs/just-bash) VFS inside the runtime process; 60+ commands, millisecond startup, no container | Private per tool call; becomes durable only on commit |
| Native | Docker, E2B, or ComputeSDK (Daytona, Vercel) sandbox | Disposable. E2B pauses between tools and resumes on demand; `node_modules` is a reconstructible cache |

Bash is parsed as a full shell AST before execution. Pure shell runs in the VFS;
native binaries and dynamic commands route the whole script to an isolated
sandbox. Nothing executes on the host that holds provider keys, and keys never
enter a sandbox.

**Context.** Long histories get versioned extractive context checkpoints with a
digest over the event projection; invalid checkpoints are ignored and rebuilt
from the log. Full tool output is archived and the model reads more through
`read_output` and `read_log`. On the harness engine, compaction and branch
summaries are Pi's own, committed durably.

**Sandboxes.** One `SandboxProvider` port, several implementations: `docker`,
`e2b`, `daytona`, `vercel` (through ComputeSDK) and `local` for development.
Every provider passes the same conformance kit
(`packages/sandbox/src/conformance.test.ts`). Serializable session state lets a
restarted runtime reconnect to, pause, resume or destroy a sandbox it did not
create. Sandbox journals are untrusted input, validated by type, path, count and
size.

**Accounting.** `spent_usd` records Pi's catalog-based model cost estimates,
rounded upward to micro-USD per call; call IDs deduplicate settlement and unknown
outcomes never imply a free request. Provider invoices remain authoritative. A
per-turn timeout caps wall-clock time. There is no monetary admission gate.

**Sessions.** `/fork`, `/rewind` and `/tree` navigate history; `contextMode` is
`continue`, `reset` or `compact` per turn; `/plan` removes `write`, `edit` and
`bash` for a read-only turn; `@path` attaches a local file into `/workspace`.
Steering and follow-up input are durable inbox items on the harness engine.

## Quickstart

Requirements: Node 22.13+ (for `node:sqlite`) and pnpm 10.

```bash
pnpm install
pnpm --dir apps/cli link --global         # puts `nimplex` on PATH (or: pnpm dev)

nimplex                                   # interactive
nimplex "Create /workspace/hello.js and run node hello.js to verify it"
printf 'Inspect the workspace' | nimplex
nimplex --resume SESSION_ID "Continue this task"
nimplex --resume SESSION_ID --request-id task-001 "Run this task once"
```

Set `ANTHROPIC_API_KEY`, run `nimplex login`, or keep the credential in the
project's `.env` (see `.env.example`). Defaults are Haiku 4.5 and E2B for native
commands (`E2B_API_KEY`) or `--sandbox docker`; just-bash-only tasks create no
sandbox at all. Local state lives in `~/.local/state/nimplex/<project-hash>`
(`NIMPLEX_STATE_DIR` overrides it); one runtime owns a state root at a time.

Any installed Pi provider works; sign in and pass `provider/model`:

```bash
nimplex login groq                         # delegates to Pi's OAuth or API-key flow
nimplex --model groq/llama-3.3-70b-versatile "Your task"
nimplex login codex                        # personal Codex subscription
nimplex --model openai-codex/gpt-5.6-sol "Your task"
```

Inside the TUI: `/new`, `/resume`, `/fork`, `/rewind`, `/tree`, `/plan`,
`/compact`, `/background`, `/thinking`, `/model`, `/trust`, `/extensions`,
`/reload`, `/help`. `/keymap claude` and `/keymap codex` select familiar bindings.
Guides: [local runtime](docs/product/2026-09-13-local-runtime.md),
[terminal controls](docs/product/2026-09-13-terminal-controls.md),
[resource reload](docs/product/2026-09-14-pi-resources.md),
[Codex subscription](docs/product/2026-09-15-codex-subscription.md).

## Verification

```bash
pnpm check && pnpm lint && pnpm test
pnpm bench        # durability overhead, recovery time, storage growth
NIMPLEX_TEST_NATIVE=docker pnpm exec vitest run packages/runtime/src/native.integration.test.ts
```

Accounting and recovery are tested against `@nimplex/testkit`, a fake Anthropic
Messages upstream, so the money path never needs a real key. Process-death tests
use a real `SIGKILL`. Native sandbox tests need Docker or an `E2B_API_KEY`.

## Repository

| Directory | Contents |
| --- | --- |
| `apps/cli` | `nimplex` terminal and headless mode |
| `apps/site` | Marketing site (nimplex.dev) |
| `packages/runtime` | Pi execution (both engines), tools, context checkpoints, native execution, SQLite persistence and the Pi `Storage` implementation |
| `packages/contracts` | Zod schemas for turn requests, accepted input, events, checkpoints and Pi storage records |
| `packages/core` | Pure functions, zero IO: pricing, state transitions, conversation projection, `SandboxProvider` port |
| `packages/sandbox` | `SandboxProvider` implementations: Docker, E2B, ComputeSDK (Daytona, Vercel), local; shared conformance tests |
| `packages/testkit` | Fake Anthropic upstream and sandbox conformance kit |
| `examples/quickstart` | `pnpm bench` |
| `docs/product` | Dated design records and the implemented runtime contracts |

Dependency direction: `cli → runtime → core/contracts/sandbox`; `core → contracts`.
See [file structure](docs/file-structure.md) and [tech stack](docs/tech-stack.md).

## What is not done yet

- **Legacy sessions stay on the legacy engine.** Sessions created on
  `pi-executor` before 2026-09-25 are not converted to `pi-harness`; they keep
  Anthropic/Codex only and have no thinking levels or extensions.
- **Sandbox cost is an estimate.** `spent_usd` is model cost. Sandbox running time
  is recorded per session in SQLite and priced at the provider's list rate (E2B by
  the sandbox's allocated vCPU and RAM; Docker counts as $0), shown as
  `sandbox ~$… (est.)`. Time nobody observed is flagged and capped at the E2B
  lifetime; storage and network are not metered; the provider's bill is authoritative.
- **Extensions are partially bridged.** Harness sessions load user extensions
  and, after `/trust`, project extensions: registered tools, system-prompt and
  provider-request hooks, tool call/result hooks and steer/follow-up messages
  work. Extension commands, UI, `setModel`, Pi packages and themes are not bridged.
- **Recovery restores files, not environments.** Native sandbox snapshots and
  browser session state are specified but not implemented.
- **No subagents, no journal pruning.** Storage grows about 195 KiB per six-tool
  turn until a pruning policy exists.
- **Workspace limits.** Tier 0 is capped at 2,000 entries and 32 MiB; each
  native command ships the workspace into the sandbox and reads it back. Fine for
  small projects, not monorepos.
- **Exactly-once holds for nimplex's own commits**, not for arbitrary external
  side effects. A command whose journal was lost is reported as unknown, never
  silently replayed. Arbitrary trusted extension IO is outside replay guarantees.
- **No cloud deployment.** A hosted API/worker on PostgreSQL existed until
  2026-09-20 and was removed to keep the repository focused on the harness; the
  candidate cloud topologies are recorded in
  [cloud agent candidates](docs/product/2026-09-15-cloud-agent-candidates.md).

The implementation plan, gates and acceptance criteria are in the
[durable Pi implementation plan](docs/product/2026-09-16-durable-pi-implementation-plan.md).
Dated documents under `docs/product/` describe decisions as they were made; the
implemented runtime contracts and current source win when they disagree.

## Design sources

- **Loop kernel**: [Pi](https://github.com/earendil-works/pi). Everything the
  model sees and every tool it calls goes through Pi; nimplex owns commit,
  ownership and recovery.
- **Durable agents**: [Cloudflare Project Think](https://developers.cloudflare.com/agents/harnesses/think/),
  see [Inspired by Cloudflare Project Think](#inspired-by-cloudflare-project-think);
  positioning: [positioning map](docs/product/2026-09-16-positioning-map.md).
- **Log is the runtime**: Apache Maka, [`log-is-the-runtime.md`](https://github.com/apache/maka/blob/main/docs/blogs/log-is-the-runtime.md).
  nimplex adds a durable workspace and sandbox generations on top of the event log.
- **Tier 1 shell**: [just-bash](https://github.com/vercel-labs/just-bash).
- **Sandbox port**: OpenAI Agents SDK `SandboxClient` / `SandboxSession`;
  serializable session state is what makes reconnecting after a restart possible.

## License

[MIT](LICENSE). Pi, just-bash and the other dependencies keep their own licenses.
