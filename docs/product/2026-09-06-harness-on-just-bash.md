# 2026-09-06 · Building a harness on just-bash: research and decision prerequisites

> Follows the 09-06 memory revision toward an open-source, self-hostable coding-agent cloud runtime. Kevin proposed building a custom harness on just-bash, with more complete sandbox resume management than Vercel's offering and inspiration from Apache Maka's “Log Is the Runtime.”
> This document answers six questions and records that day's code removal. Initially pending decisions appear near the end; §7 records Kevin's final direction.
> Research descriptions reflect the date of this document. The [09-10 runtime contract](2026-09-10-harness-runtime.md) describes the later implementation.

---

## 1. Is just-bash the optimal environment already discovered?

It is the cheapest tier of a layered design, not a universal optimum. The reviewed evidence came from primary sources:

- **Vercel's positioning:** `@ai-sdk/sandbox-just-bash` was experimental and explicitly lacked exposed ports and full network-sandbox features. The just-bash security documentation directed arbitrary binary execution to Vercel Sandbox. Its compatible Sandbox API encouraged starting with just-bash and switching to a real VM when needed; harness-pi treated both backends as interchangeable.
- **Supported:** 60+ commands including grep/rg/sed/awk/jq/sqlite3/yq/xan/tar/gzip/curl; pipes, redirects, functions, and loops; InMemoryFs/OverlayFs/ReadWriteFs/MountableFs; optional CPython-WASM python3 and QuickJS js-exec; defineCommand extensions, AbortSignal, and executionLimits. Version 3.4.2 remained beta, with roughly 4.2k stars, daily commits, and primary maintenance by Vercel CTO cramforce.
- **Unsupported:** arbitrary native binaries, npm/pip installation, listening ports, and real processes. Git was absent (issue #83); a maintainer noted a possible implementation's slowness and invited a contribution, while the community built a just-git shim. Browser Python was unavailable (#121).
- **Missing durability:** the README did not describe VFS snapshot/serialization/persistence. InMemoryFs dies with its process; cross-worker resume requires our own durable file tree.
- **Community:** the HN “Just-bash: Bash for Agents” discussion had 124 points and 69 comments. simonw favored bash's extensive training data and small-model compatibility; resonious noted token waste from quoting/escaping; production user cjbell88's Elixir port gained instant startup and avoided synchronization but would need a real sandbox for native Python, with interfaces already separated for that change. No substantive Reddit discussion was found.

For coding agents, exploration, reading/editing, and jq/sqlite processing fit the VFS; build/test/install require native execution. The proposed complete design is just-bash plus a real sandbox sharing one workspace, initially envisioned through Git synchronization. Vercel did not present just-bash alone as a complete native coding environment.

## 2. Related systems

| Project | Product and architecture | State / resume at the research date |
|---|---|---|
| **Cloudflare Project Think** | Announced during April 2026 Agents Week; roadmap cloudflare/agents #1439. Execution ladder: Tier 0 durable VFS (SQLite + R2), Tier 1 Dynamic Worker running generated JS in V8 isolates, Tier 2 npm, Tier 3 browser, Tier 4 full Sandbox synchronized with Tier 0 | Durable workspace from Tier 0; no bash emulator; Cloudflare-specific |
| **Vercel** | just-bash, bash-tool, harness-pi, sandbox-just-bash/vercel, and eve. Pi runs on the host; sandbox supplies remote FS/shell through nine PiRemoteOps methods: paths/readBuffer/writeFile/editFile/listDirectory/findFiles/grepFiles/access/exec | pi-resume-state.ts copies session JSONL into a private sandbox directory and retrieves it when replacing sandboxes; HarnessV1Session supports suspend-turn, detach, stop, destroy |
| **Apache Maka**, incubating | Local-first workspace; Electron, TUI, and CLI are thin Runtime Host clients. Initiated by jackwener, an Arrow/DataFusion/Doris PMC member, rather than a corporate donation. Local tools constrained by Seatbelt/bubblewrap/AppContainer | runtime_events in SQLite with event_seq/highWater/digest, compaction checkpoints, ContextOffloadStore. Workspace snapshots (Phase 4) were unimplemented; `.maka-workspace.json` proves workspace identity through UUID, not file content |
| **Anthropic Managed Agents** | Hosted loop; durable session event log, stateless harness, untrusted credential-free sandbox | Session survives harness/container death |
| **OpenAI Codex cloud** | Hosted closed system; a microVM per task, loop on OpenAI's side | Not assessed |
| **MicroVM vendors** | E2B, Fly Sprites, Blaxel, Runloop, Morph, Daytona; compete on snapshot/pause/resume | Reported claims: E2B approximately one-second resume; Sprites idle sleep with near-zero idle cost; Blaxel under 25 ms wake |
| **Others** | Omnara's open-source Managed Agents alternative; Pi/oh-my-pi/OpenClaw; WASM systems including wasmer/WASIX, v86, Runno, Conch | Not assessed in detail |

The proposed gap: Cloudflare had durable VFS plus synchronized native execution but platform dependence; Vercel had tiers without durable VFS and stored sessions inside sandboxes; Maka had durable logs without workspace snapshots. The research did not identify an open-source self-hostable implementation combining logs outside sandboxes, VFS snapshots, and tiered execution.

## 3. Maka's “Log Is the Runtime”

Recorded in memory and here:

1. `State(n) = Apply(Snapshot(k), Log[k+1..n])`. Agent state is a projection of append-only RuntimeEvents. UI, model context, terminal decisions, and crash recovery are separate projections of the same log.
2. Compaction changes how models read logs, not the logs themselves. A highWater/digest checkpoint can be recomputed if lost.
3. Archive large tool results before substituting a reference; models paginate details when needed, while logs retain the original output.

nimplex already had the skeleton in Postgres `run_events`, sequence cursors, and SSE resume. Missing pieces were context/continuation projections and the world state Maka explicitly had not implemented, addressed next.

## 4. What nimplex adds to Vercel's just-bash design

| Capability | Reviewed Vercel harness-pi + sandbox-just-bash | Proposed nimplex |
|---|---|---|
| Log location | JSONL copied into sandbox, vulnerable to sandbox loss | Postgres run_events outside disposable sandboxes |
| VFS persistence | InMemoryFs dies with the process | Generation-k snapshots and log replay; sandbox_generation in events |
| Tiers | Choose just-bash or Vercel Sandbox | VFS first, native build/test on demand, shared workspace initially envisioned via Git |
| Environment loss | No reviewed fallback | provider.resume → snapshot/pause → environment.reset in model context |
| Spending | No reviewed USD enforcement | Existing per-run USD caps and mid-run kill |
| Event resume | No reviewed resumable stream | Existing SSE Last-Event-ID |
| Large output | No reviewed durable offload | Maka-style archive references and pagination |

## 5. Build on Pi?

**Recommendation: use Pi as the loop kernel without forking or rewriting it.**

- Pi had moved to `@earendil-works/*`, version 0.85.1 released 2026-09-05, MIT licensed, roughly 100k stars, and daily updates. Its in-process Agent exposes streamFn/convertToLlm/beforeToolCall/afterToolCall and full events; agentLoop/agentLoopContinue are lower-level generators.
- Official extension points fit this use: createBashTool/createReadTool and typed Bash/Read/Edit/Grep/Find/Ls operations. The Gondolin containerization example runs Pi on the host and tools in a microVM. Adapt the same PiRemoteOps shape to nimplex's tiers.
- Existing compaction hooks, `session_before_compact`, session JSONL trees, and `SessionManager.inMemory(cwd?)` reduce reinvention.

Risks and responses:

- Pi sessions/events are not nimplex's canonical log. Translate Pi events into run_events, analogous to the former managed-agent.ts, and project them back into in-memory Pi entries after restart.
- Try Pi hooks first for digest-verified compaction and tool-result pruning. Add custom projection machinery only when those hooks prove insufficient; do not begin by rewriting the loop.

## 6. Removed and retained that day

**Removed** (git rm, staged but not yet committed at the time; historical implementation at `0f32657`): apps/runtime Cloudflare prototype, apps/console, packages/gateway with BYOK proxy and accounting ledger, CLI-in-a-box files (harness-executor.ts, core/harness.ts, builtin-harnesses.ts, gateway-urls.ts, api/harnesses.ts, db/harness-registry.ts, bootstrap.ts, seed.ts), Managed Agents executor/core, tool registry api/registries.ts with skills/mcp_servers, api/usage.ts rollups, and examples/quickstart/src/claude-code-e2b.ts. Migration 0006 dropped harnesses, managed_agent_refs, skills, mcp_servers, credential_refs, and runs.harness/metering/run_token_hash/sandbox_token_hash. Contracts removed harness manifests, metering, usage, skills, and MCP; budget_usd became required.

**Retained:** API auth/org/API keys/members/BYOK/runs/SSE; worker leases/fences/budgets/kill/reaper/stub; contracts; core budget/pricing/status/duration/sandbox port/RunExecutor/shellQuote; db; Docker/E2B/ComputeSDK/local providers and conformance; SDK; fake Messages/conformance testkit; deployment/Dockerfile/workflow. **apps/site stayed** because nimplex.dev deployed from it and deletion would break Vercel builds; its long-term location remained Kevin's decision.

**Validation at that checkpoint:** pnpm check 10/10, 31 tests passed, lint clean, and smoke flow passed: signup → key → BYOK → $0.60 completion → $0.36 budget kill → required budget → tenant isolation → revoked-key 401. Code shrank from 13.3k to 5.6k lines.

## Decisions pending Kevin's approval

1. Pi kernel or custom loop? **Resolved 2026-09-09: Pi kernel.** Kevin requested the just-bash harness on Pi; four spike gates passed in 30 minutes and Slice 1 landed that day. See `2026-09-09-mvp-demo-plan.md`.
2. Keep apps/site in this repo or move it?
3. Replace the remaining end_users table and runs.end_user_id, downgraded to attribution on 09-01, with `runs.external_user_id text`?
4. Keep the original delivery order: box mode/logs/kill → generation/reset/pause/resume → just-bash tiers?

---

## 7. Final decision: execution ladder (Kevin, 2026-09-06)

Kevin selected the Project Think-style ladder, ordered by each step's capability requirements, with every tier self-hostable:

| Tier | Backend | Responsibility | Cost |
|---|---|---|---|
| **Tier 0: durable workspace** | Postgres file snapshots plus write/edit events; `Files(n) = Apply(Snapshot(k), Writes[k+1..n])` | Authoritative durable files | No incremental sandbox charge |
| **Tier 1: just-bash** | Worker process with FS backed by Tier 0 | read/grep/edit/jq/sqlite/awk, optional QuickJS and CPython-WASM | No sandbox charge, millisecond startup |
| **Tier 2: native sandbox** | Existing SandboxProvider; self-hosted Docker+gVisor or cloud E2B/Sprites/Blaxel | git, npm/pip, builds, tests, networking; lazy creation, pause when idle, synchronization with Tier 0, generation increment on replacement | Pay when used |

Cloudflare's separate npm/browser tiers are excluded from v1.

Invariants:

1. **Tier 0 is authoritative; sandboxes are caches.** Sandbox loss discards reconstructible state such as node_modules supplied by prebuild images; files restore from Tier 0.
2. **The runtime decides escalation.** The original decision proposed trying Tier 1 first, escalating unsupported commands, git/npm/node/make/non-allowlisted curl, or network requirements, and recording tier.escalated. The 09-09 proposal later corrected this to whole-script routing before execution to avoid duplicate side effects.

Revised delivery order:

- **Slice 1:** Tier 0 snapshot table, just-bash backing, Pi remote operations, Pi-to-run_events translation, and cross-worker SIGKILL recovery without a sandbox provider.
- **Slice 2:** Tier 2 through existing Docker/E2B, workspace synchronization initially proposed through Git, generation, and environment.reset.
- **Slice 3:** Maka-style context projection, digest checkpoints, and large tool-result offload.
