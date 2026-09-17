# nimplex TypeScript SDK architecture decision (2026-09-01)

> Follows the 08-27 MVP's gateway/M0–M6 plan and 08-18 protocol strategy. Defines SDK shape, layering, and browser integration using primary-source research conducted that day.
> **09-01 positioning revision:** end_user is no longer the differentiator. Customers manage their users, accumulated budgets, and tokens. nimplex focuses on one API, run resource, event format, and meter across harness × sandbox × customer model keys. Required end_user becomes optional external_user_id attribution; rolling user caps, user credential scopes, and user tokens leave the MVP. Browser access becomes optional run-scoped viewer tokens. This supersedes the 08-21 end-user focus while retaining SDK layering and the rule that org keys never enter browsers.
> **Historical scope:** later decisions removed the gateway/harness registry and added Pi-based continuation. Proposals here are not claims that every endpoint or package exists today.

## 0. Research method and sources

| Subject | Primary source | Status at initial drafting |
|---|---|---|
| ai@7.0.85 Agent and approval types | Local node_modules declarations | Complete |
| Vercel harness family | Complete 1,906-line unpkg declarations and ai-sdk.dev | Complete |
| Claude Agent SDK | code.claude.com | Complete |
| Managed Agents beta.sessions | platform.claude.com | Complete |
| Omnara SDK/React | Local clone source | Complete |
| Liveblocks/GetStream/Ably/ChatTransport tokens | unpkg declarations/distribution source and official docs | Complete |
| Runloop Stainless SDK and credential dimensions | Existing 08-26 research | Complete |
| Codex/Devin/Cursor | In progress, later filled in §8.1 | Completed below |
| LangGraph/Cloudflare Agents | In progress, later filled in §8.2 | Completed below |
| Cloudflare Computer/Think/Gateway | In progress, later filled in §8.3 | Completed below |

## 1. Lessons from other systems

### 1.1 Anthropic: stable primitives, replaceable convenience APIs

- Agent SDK removed the v2 createSession/session.send wrapper in 0.3.142 and returned to query plus async generators. Separate stable transport/resources from evolving convenience objects.
- canUseTool returning null means an out-of-band decision will arrive through another channel with the same requestId. This fits approval UI in customer frontends.
- Resume continues the same history; forkSession creates a new ID without changing the source.
- Client-estimated total_cost_usd was explicitly unsuitable for billing; Managed Agents' enforced list_cost was server-calculated. Keep our spent_usd server-authoritative.
- Managed Agents checked budgets between requests and documented one-request overshoot, such as stopping at 53 cents with a 50-cent cap. Budget exhaustion produced idle(budget_reached), accepted cleanup events, and allowed continuation after a budget increase.
- Use closed stop-reason enums and domain.action event names: user.message, agent.tool_use, session.status_idle.

### 1.2 Vercel harness: sessions and capabilities

- HarnessAgent implements ai Agent with version='agent-v1', generate, and stream, validating CloudAgent's shape.
- Agent is stateless; createSession with resumeFrom/continueFrom returns the state handle required by generate/stream.
- Lifecycle distinguishes detach (handoff, warm sandbox), stop (save resume state and shut down), and destroy (discard). suspendTurn slices active turns, explicitly describing lossless bridge adapters versus lossy host-resident adapters.
- Approvals use standard ai@7 tool-approval-request parts and submitToolApproval({approvalId, approved, reason}).
- onBootstrap/bootstrapHash separate template creation from sessions and invalidate snapshots by content hash, useful for custom-harness cold starts.
- Unsupported settings/tools are explicit warnings or HarnessCapabilityUnsupportedError. Harness/sandbox combinations need declared capabilities; metering exact/none is one example.
- ACP is an adapter, not the external API, matching the 08-18 decision.
- Do not copy Workflow's “use workflow” compiler machinery, only serializable continuation state; omit heavy multi-provider networking abstractions in v1. The experimental package is a reference implementation, not a standard.

### 1.3 Omnara: authentication and wrappers

- Inject AuthStrategy: bearerToken accepts a string or async getter for refresh; cookieCsrf serves browsers.
- Generated sdk/types/zod files coexist with thin createOmnaraClient/openAgentEventStream wrappers, supporting OpenAPI plus handwritten ergonomics.
- Its React package mixed org-management hooks without end-user isolation. Our revised browser/React surface should expose one run, not the management plane.

### 1.4 Browser token patterns

- Follow Liveblocks authEndpoint as URL/callback, but return {token, expiresAt}; clients never parse token internals, allowing future format changes.
- Lazy cache plus refresh at expiresAt minus 30 seconds avoids GetStream-style recovery only after 401 and Ably's separate server AUTH control frame.
- The initial research proposed signed claims {endUserId, runId?, scopes, exp} and a 15-minute TTL instead of the earlier opaque-token preference. The final §2.5 revision binds only runId. Opaque client contracts allow later introspection without client changes.
- Use native SSE Last-Event-ID. AI SDK resume=true obtains another transport stream, often requiring Redis-backed resumable-stream; our existing event sequence already provides a lighter standard mechanism.

## 2. Architecture decision

### 2.1 Layers

```text
Evolving convenience layer
  CloudAgent: generate/stream, agent-v1
  @nimplex/ai-sdk: NimplexChatTransport → useChat
  Future @nimplex/react: useRun/useApprovals
Stable primitives
  Transport: HTTP, SSE, Last-Event-ID
  Resources: runs/harness/providerKeys/sandbox/models
  Contract-defined event union
Contracts
  @nimplex/contracts: Zod, future generated OpenAPI
```

Convenience APIs compose only public primitives. Keep breaking evolution above the transport/resource layer. Console and SDK retain the same public API.

### 2.2 Packages

| Package/entry | Location | Credentials | Contents |
|---|---|---|---|
| @nimplex/sdk | Customer backend | Org key | Nimplex/CloudAgent; optional issueViewerToken |
| @nimplex/sdk/browser, optional | Customer frontend | Run viewer token | NimplexBrowser with authEndpoint; no apiKey property in its type |
| @nimplex/ai-sdk, later | Frontend | Viewer token | Event union → UIMessageChunk ChatTransport |
| @nimplex/react, later | Frontend | Viewer token | Run-scoped hooks, no management hooks |
| @nimplex/contracts | Shared | None | Schemas, events, scopes |

One SDK with subpath exports avoids separate version synchronization; ai-sdk/react integrations remain separate so peer dependencies do not enter the core SDK.

### 2.3 Events as first-class contracts

The existing loose payload and extractText duck-typing across three shapes should become a discriminated union:

- run.status with closed stop_reason; message.delta; tool.call/result; tool.approval_requested/resolved; spend.updated; file.changed; log.stdout; harness.raw as a lossless escape hatch.
- Approval shape follows ai@7: {approvalId, toolCall, reason}; resolution {approvalId, approved, reason?}. This accommodates ACP permission translation and useChat.
- Translate once in the supervisor: ACP session/update or Claude stream-json into the union, plain stdout into log.stdout. Clients consume only nimplex types. A future manifest output='acp' is an adapter extension.
- spend.updated drives browser burn-rate displays without polling runs.
- Every SSE connection starts with run.snapshot containing current status, spent_usd, and pending approval, then increments; clients need not replay all history to know current state.
- Persist pending_approval on the run so GET exposes waiting decisions independently of stream completeness.
- Resume is exclusive: events strictly after Last-Event-ID. Document and type one reconnection protocol.

### 2.4 Lifecycle and budgets

- Keep cancel and kill separate primitives, reflecting graceful interruption versus destruction.
- Closed terminal reasons: completed, budget_exceeded, max_duration, user_killed, user_canceled, error.
- The historical gateway proposal documented at most one in-flight-call overshoot, reduced through reservations. **The 09-10 runtime supersedes this with conservative pre-dispatch reservations; consult its contract.**
- v1 reaches killed(budget_exceeded); reserve a future paused state and budget-increase continuation.
- resolveApproval and sendInput use distinct endpoints. Answering an interrupt must not accidentally start another billable turn.
- Multi-turn sessions/resume/fork were deferred in this version. Keep CloudAgent stateless and run creation idempotent through client_nonce so sessions can be added later.
- Open question: per-create double-texting policy reject/interrupt/enqueue. Rollback is excluded until treatment of already-spent funds is explicit.

### 2.5 Optional run viewer tokens

Customers can embed progress, burn rate, and approvals or proxy everything through their backend. They retain end-user identity and cumulative accounting.

```ts
const { token, expiresAt } = await nimplex.runs.issueViewerToken("run_...", {
  ttlSeconds: 900, // Platform clamps the maximum
  scopes: ["run:read", "run:input", "run:approve"],
});
```

Proposed POST /v1/runs/:id/viewer-tokens accepts org keys only. Signed tokens contain {runId, scopes, exp} but remain opaque to clients. Middleware accepts full org keys or tokens restricted to one run; other resources return 403. Browser types cannot accept an org apiKey.

```ts
import { NimplexBrowser } from "@nimplex/sdk/browser";
const client = new NimplexBrowser({
  // POST URL or callback returning {token, expiresAt}; refresh 30 seconds before expiry
  authEndpoint: "/api/nimplex-token",
});
const run = client.run(runId);
for await (const event of run.events({ after: lastSeq })) {
  if (event.type === "tool.approval_requested") {
    await run.resolveApproval({ approvalId: event.approvalId, approved: true });
  }
  // Render message.delta and spend.updated using the same event union.
}
await run.sendInput("Continue");
```

These are proposed APIs, not implemented browser exports.

### 2.6 Capability declarations

Create responses/events carry warnings with kind unsupported-setting/unsupported-tool and detail. Reject impossible combinations such as unmetered plus budget_usd at the contract boundary. Treat metering mode as part of the same capability model.

### 2.7 People and keys after the revision

```text
organization
 ├─ org_members: Better Auth console users, owner/admin/member
 ├─ api_keys: programmatic org identity, name/last4/revocation; future per-key limits
 └─ runs: work units, optional external_user_id attribution rather than identity
```

Members are customer staff, not the customer's end users. Existing org_members/end_users had no inheritance, which remains appropriate. At initial drafting org/member tables existed but api_keys and Bearer middleware did not; Transport sent Authorization that the bootstrap single-org server did not verify. Future per-key caps let customers issue keys per user without introducing end-user identity into nimplex.

### 2.8 Exclusions

No external ACP-over-HTTP before its RFD settles; no custom resume protocol beyond SSE; no multi-provider networking abstraction for the api+worker backbone; no handwritten multilingual SDKs—generate Python later from OpenAPI at M5/M6.

## 3. Delivery order after the revision

1. Contracts: optional external_user_id, event union, closed reasons.
2. Uniformity demo: change only harness slug or sandbox provider, preserving run calls, event shapes, and accounting.
3. Gateway metering, per-run cap, two-stage kill.
4. Prices, estimates, comparisons.
5. Org API keys/Bearer verification with hashes, last4, revocation; prerequisite for launch and viewer tokens.
6. Optional viewer tokens, browser entry, examples/web-chat.
7. Later NimplexChatTransport.

## 8. Research follow-ups

### 8.1 Codex, Devin, Cursor, OpenHands; completed 2026-09-01

Sources: Codex GitHub raw code, docs.devin.ai v3, cursor.com/docs cloud-agent API, docs.openhands.dev.

| System | Lifecycle | Streaming | Cost controls | Mid-run stop |
|---|---|---|---|---|
| Codex SDK | startThread/resumeThread, run/runStreamed; locally spawns CLI, no hosted session | AsyncGenerator with item started/updated/completed; typed command_execution/file_change/mcp_tool_call | None reviewed | Client AbortSignal |
| Devin v3 | POST sessions, poll, append messages, DELETE | Polling only | Server max_acu_limit and usage_limit_exceeded; ACUs per session rather than USD per user | DELETE, not resumable |
| Cursor v1 | POST agents, runs, cancel/archive; idempotent agentId | Webhooks, with transitional contradictory docs | Team Admin USD controls, none per run | runs/:id/cancel |
| OpenHands V1 | Poll start-task, then conversation | Socket.IO | UI budget absent from API schema; accumulated_cost read-only | No public stop found |

Implications:

1. Shared lifecycle: create → opaque ID → observe → append to ID → terminate.
2. Devin status/status_detail supports separating status from reason; expose reason in both terminal events and GET.
3. None supplied the reviewed clean hosted resumable SSE shape, making Last-Event-ID a potential differentiator.
4. Stop alone is not unique; Devin/Cursor have it and Devin enforces session caps. Refine the pitch to one API across agents, native USD per-run caps, and resumable events, rather than per-user accumulation. OpenHands illustrates UI capabilities missing from APIs.
5. Cursor sub-tokens exchange service accounts for one-hour user worker tokens, supporting the token-exchange pattern.
6. Consider output_schema JSON Schema, present in Devin/Codex; typed Codex items support our tool/file events.
7. All four had transitional versions and inconsistent docs. Stabilize resources, mark deprecated versions clearly, and publish real OpenAPI-generated SDKs.

### 8.2 LangGraph and Cloudflare Agents; completed 2026-09-01

Sources: unpkg @langchain/langgraph-sdk@1.10.0 and agents@0.22.0 declarations, docs.langchain.com, developers.cloudflare.com.

LangGraph lessons:

1. Thread.interrupts is durable, readable in one GET; adopt pending_approval on runs.
2. Command({resume}) is distinct from input; separate approval resolution and new input, especially around billing.
3. Per-run multitaskStrategy reject/interrupt/rollback/enqueue addresses concurrent messages; rollback needs explicit accounting semantics.
4. Legacy Last-Event-ID and v2 body-since reconnection coexist with differing inclusive/exclusive semantics, changed in v0.6.0. Avoid this by maintaining one exclusive protocol.

Cloudflare lessons:

1. Separate state synchronization from append-only events. Send an initial full run.snapshot; small state does not need JSON patches.
2. Browser WebSocket auth uses short-lived signed query tokens and async useAgent query functions on every reconnect, supporting an authEndpoint callback.
3. Distinct codes/events for auth failure, exhausted budget, and revocation let clients distinguish normal completion from stops; mirror this in stop_reason.
4. Renaming unstable_callable, deprecating AgentNamespace, and moving AIChatAgent into @cloudflare/ai-chat show why prefix-based versioning creates churn. Prefer /v1 plus @experimental annotations, and separate transport from chat integrations from the start.

### 8.3 Cloudflare Computer, Sandbox, Think, AI Gateway; completed 2026-09-01

Sources: cloudflare/computer README/docs, official sandbox/ai-gateway/agents documentation, and all 32 official changelog entries from 08-21 through 08-31.

Computer and Sandbox are distinct products:

| | @cloudflare/computer, released 08-03 | @cloudflare/sandbox |
|---|---|---|
| Core | SQLite/DO durable Workspace FS and pluggable exec; not a machine-creation API | Full container sandbox API |
| Status then | Preview-only, not production; 0.2.1 on 08-17, no commits after 08-21 | 0.12.x stable and 1.0 @next preview |
| Environment | Image-level COMPUTER_VAR_* only, no per-call env | setEnvVars, session env, per-exec env |
| Egress | interceptOutboundHttp hook, user-written policy | Hot-swappable outbound/outboundByHost, enableInternet:false, allowedHosts globs, default HTTPS interception with trusted per-sandbox CA |
| Destruction | No Workspace destroy | destroy; exec timeout explicitly does not kill the underlying process |
| RPC auth | Open question; trusts reachable clients | Worker bindings; external bridge Worker plus Bearer |

**Provider candidate:** Sandbox, not Computer. Its env/egress/destroy operations fit base URL injection, gateway-only egress, and killability, but require a maintained bridge Worker unlike native external E2B/Daytona APIs. Official Claude Code-to-AI Gateway instructions supported the feasibility of base URL injection.

**AI Gateway spending comparison:** per-user attribution through Access cf.user_id or metadata and user-bucketed USD rules had reached GA on 06-05, closer than the earlier 08-23 understanding. Remaining distinctions in the reviewed material:

- Eventual consistency permits temporary concurrent excess.
- No rule CRUD API was found; OpenAPI exposed only a deprecated global cap, suggesting dashboard-only management rather than programmatic signup/session rules.
- Limits block models but do not destroy sandboxes, which continue running until separately stopped.
- Cloudflare ecosystem dependence and a twenty-rule-per-gateway cap limit a rule-per-user model.

The refined pitch combines budget enforcement and sandbox lifecycle through a provider-independent first-class SDK.

**Think:** metering follows getModel's provider; the harness itself does not manage USD, matching harness-independent accounting. Its beforeTurn/beforeToolCall hooks optimize custom-agent construction and need not all become nimplex abstractions.

**Release activity:** the review found no substantial family release in the ten days after 08-23: Computer stalled, Think changes were internal, and no AI Gateway/OS/Sandbox changelog entries appeared.

Adopt three-level environment injection (sandbox → session → exec), with null explicitly unsetting values, and document timeout versus process termination. A soft budget stop without destroy leaves execution alive; that distinction motivates the two-stage design.
