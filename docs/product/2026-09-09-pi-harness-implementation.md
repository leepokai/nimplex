# 2026-09-09 · Pi + just-bash harness: implementation proposal

> Historical planning document. The [harness runtime](2026-09-10-harness-runtime.md) records the implementation and acceptance state as of 2026-09-10.

This proposal draws on the working tree, the 09-06 §7 decision, the 09-09 demo plan, and upstream documentation. The existing Pi spike verified fake-upstream calls and usage; the production harness had not yet been implemented at the point described here. Recommendations are not additional decisions approved by Kevin.

## Product boundary

Build nimplex as a recoverable runtime with Pi as its agent kernel and a durable workspace. Pi owns the model/tool conversation loop, just-bash supplies the virtual shell, and nimplex owns step durability, execution ownership, budgets, cancellation, and recovery. The first demonstrable result is another worker finishing a task from committed messages and files after the original worker dies.

```text
SDK → API → Postgres ← worker / nimplex harness → Pi → model provider
              ↑                 ↓
       events + workspace    tool adapter
                                ↓
                    Tier 1: just-bash / private VFS
                                ↓ later
                    Tier 2: SandboxProvider
```

Tier 0 is the durable workspace. The VFS is an execution copy; only committed Postgres state is recoverable. Tools must not inherit provider keys or the worker's complete `process.env`.

## Existing integration points and gaps

| Location | Behavior at this checkpoint | Required before Pi integration |
| --- | --- | --- |
| `packages/core/src/executor.ts` | `step()` returns one batch of events, cost, and next work; no signal or intermediate checkpoint | Awaitable persistence interface, AbortSignal, and explicit execution boundaries |
| `apps/worker/src/index.ts` | Fixed stub, 60-second lease, events written only after execution | Heartbeat, cancellation on lease loss, kill checks during execution, fencing on every commit |
| `processStep()` in the same file | Post-execution settlement; completion checked before budget excess | Reserve before execution; resolve terminal/kill races with transactions or CAS |
| `packages/db/src/events.ts` | Sequence allocation and insertion are separate queries; callers can pass a transaction | Require critical writes to share a transaction with workspace, usage, and checkpoints |
| `packages/db/src/schema.ts` | Runs, work_items, events, usage_records, reserved_usd | Workspace versions, tool execution IDs, and deduplicated reservation/settlement records |
| `apps/api/src/app.ts` | Initial stub payload `{ step: 1 }` | Versioned harness startup contract that replacement workers can restore |
| `packages/testkit/src/fake-anthropic.ts` | Existing fake upstream | Scripted tools, usage, delays, interruption, and retry scenarios |

Do not place an entire `agent.prompt()` inside the existing `step()` and write the DB only at the end. Pi can run many rounds while leases expire, cancellation cannot propagate, and file changes lack commit boundaries.

## Pi integration: complete a small feasibility spike first

`sandbox/pi-spike/spike.ts`, Pi 0.85.1, just-bash 3.4.2, and four VFS tool adapters already exist. Extend that spike with acceptance checks before adding production workspace dependencies. Prefer `Agent` from `@earendil-works/pi-agent-core` and `pi-ai`; use coding-agent tool factories as needed without importing the entire CLI session, extension loader, or local settings system.

The existing spike was run with a fake key and explicit localhost base URL. The upstream received one request, and Pi reported input=1000/output=500. No `hello.txt` was created because the fake upstream then emitted text only, without tool calls. This verifies headless operation, base URL overrides, and usage, not tools, recovery, or cancellation. Its printed cost uses manually entered spike prices and is neither real spending nor a production-ledger test.

Upstream `Agent` supports custom `streamFn`, messages, sequential tools, and awaited async subscribers. These can form persistence barriers. The lower-level `agentLoop()` iterator observes events without waiting for an async consumer before advancing, so it should not be used directly as a database barrier. See the [official Agent documentation](https://github.com/earendil-works/pi/blob/main/packages/agent/README.md).

Spike acceptance:

1. Connect to a fake Anthropic server through a custom base URL without a CLI or real key, and extract usage.
2. All four tools—read/write/edit/bash—operate on the same just-bash VFS, never the host workspace.
3. Tools start only after the full assistant message is durable; the next model request starts only after tool commits.
4. A new Agent can continue from saved complete messages with unchanged tool call/result IDs.
5. AbortSignal stops model streams and tools; timeouts work, and failures do not trigger automatic model calls.

The `createBashTool(cwd, { operations })` extension point exists, but surrounding behavior also matters: the upstream wrapper builds a shell environment and may offload large output to host temporary files. The adapter must create a minimal environment and make output references readable across workers. If necessary, wrap just-bash in a custom AgentTool. See [BashOperations source](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/tools/bash.ts).

## MVP persistence boundaries

Initially execute tools sequentially within each run. Let a claim drive one Pi turn, stopping with `shouldStopAfterTurn`, while committing checkpoints between the model and each tool. On reclaim, durable phase determines whether to finish pending tools or start a new model request; never unconditionally replay the turn. This changes work-item semantics, so update contracts/ports first.

1. **Before the model:** transactionally validate organization, run status, lease owner/fence; create a call ID and reserve funds.
2. **After the complete response:** save assistant message, tool calls, provider metadata, and usage; settle the reservation and commit pending tool identities. SSE text deltas cannot substitute for this record.
3. **Before each tool:** record stable call ID, input, and execution status.
4. **After each tool:** in a short transaction, validate fence, workspace version, and run status; atomically commit file deltas, tool result, checkpoint, and next work. Do not hold a transaction throughout tool execution.
5. **Continuation:** project messages from committed logs. Complete pending assistant/tool pairs before continuing Pi; the final event alone is insufficient for `continue()`.

The MVP can store full files in workspace_files, including organization/run/path, entry type, content bytes, required metadata, and workspace revision. Each tool uses a private VFS and commits its resulting diff as a batch. Scope reads and changes by organization. Define support for deletion, rename, empty directories, binary files, and symlinks explicitly; never store a SQLite binary database as UTF-8 text.

The MVP source of truth is the committed event log plus atomically committed workspace state. Without complete write deltas, it cannot claim arbitrary historical files are reconstructible from logs alone. Historical snapshots and replay can follow later.

Recovery rules:

- Tools with committed results: reuse results without execution.
- Uncommitted pure VFS execution: discard the private copy and rerun from the previous workspace revision.
- Accepted model request without a saved response: mark unknown and retain the reservation; do not assume a free failure.
- Future native/external writes with unknown outcomes: use idempotency keys or inspect external state, never blind replay.

The promise is continuation from committed execution boundaries, not from the exact token interrupted by a crash.

## Define the USD cap precisely

At this checkpoint, the code stops only after a step. A $0.01 balance can fund a $0.12 step and already be exceeded at settlement; a final step may even take the completion branch first. Stub acceptance does not prove a hard cap for real LLM calls.

Initially support only models and charge categories with conservative computable bounds:

- Compute `available = budget - settled - reserved` atomically.
- Reserve input bounds, output caps, and applicable extra charges before dispatch; restrict max output tokens to available funds.
- Do not promise strict bounds for a model whose input or other charges cannot be conservatively bounded.
- Deduplicate settlement by call ID. Every retry needs its own reservation; hidden SDK retries must not bypass budgets.
- Crashes and cancellation do not imply zero provider charges. Keep unknown reservations until reconciliation.
- Budget excess, user kill, and normal completion share one terminal coordination rule so they cannot overwrite each other.

The initial guarantee covers supported-model LLM cost. If sandbox lifetime, storage, or networking is excluded, say so in UI/docs. Use consistent USD precision, rounding, and safety margins.

## just-bash and escalation

just-bash provides replaceable filesystems, execution limits, and optional networking; arbitrary native binaries still require a real sandbox. Verify limit options and cancellation against the pinned version. Disable networking and optional executors for the MVP. See [official just-bash documentation](https://github.com/vercel-labs/just-bash/blob/main/packages/just-bash/README.md).

Revise the 09-06 “try Tier 1, then escalate on failure” idea to **route before execution**. For example:

```bash
echo one >> a.txt; npm test
```

Running the first half locally and then replaying the full script remotely appends `one` twice. Slice 2 should conservatively determine whole-script capabilities before execution. Unknown dynamic shell must use an authorized real sandbox or return an explicit unsupported result. A nonzero exit code alone must never trigger escalation. Capability routing does not replace sandbox isolation.

Start synchronization with a single writer and explicit checkpoints including dirty, untracked, deleted, and binary files. Git commit/checkout alone does not represent the full workspace. Keep sandbox generation (environment replacement) separate from workspace revision (file version).

## Delivery order and acceptance

| Order | Deliverable | Required acceptance |
| --- | --- | --- |
| 1 | Pinned Pi adapter spike | Fake upstream, four tools, usage, async barriers, message reconstruction, cancellation |
| 2 | Durable workspace and just-bash | Consistent write/delete/rename/binary restore; no partial state after pre-commit crashes |
| 3 | Worker, checkpoints, budgets | Heartbeat, stale-worker write rejection after takeover, reservation/settlement deduplication |
| 4 | Automated crash demo | Kill before/during/after tools without duplicate append; resumable SSE; no unaffordable calls |
| 5 | Slice 2 native sandbox | Pre-execution routing, file synchronization, generation, environment.reset |
| 6 | Slice 3 context management | Compaction checkpoints, raw message/tool archives, pagination |

For the 09-14 demo, focus on the first four. Automatically create/edit files, SIGKILL the worker, take over, and complete with no duplicate file changes, lost events, or accounting inconsistency. Separately inject failures for unknown model outcomes; killing only at safe moments does not demonstrate full recovery.

Start production code under `apps/worker/src/harness/`, ports and pure projections in core, persistence in db, and event schemas in contracts. Extract `packages/harness` only when a second real consumer exists.

## Codex project configuration

Root `AGENTS.md` and `.codex/config.toml` were created. AGENTS explicitly reads shared CLAUDE.md and its references; model, permissions, and credentials remain personal settings. `.agents/skills` is already Codex-native and needs no duplication. The Claude project has no MCP servers, hooks, custom agents, or commands to migrate. A Codex review does not satisfy the project's pre-commit Opus review requirement.
