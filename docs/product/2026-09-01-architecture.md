# nimplex architecture

> 2026-09-01. Follows the 08-26 positioning and 08-27 MVP definition. Defines component boundaries, invariants, and gaps between implementation and target after reviewing all source in apps/api/worker and packages/contracts/core/db/gateway/sandbox/sdk.
> **Historical:** this describes the gateway/CLI-harness design before the 09-06 refocus. Current API/worker separation and tenant/credential discipline remain relevant, but the gateway, console, token scheme, and harness registry were removed. Use [the 09-10 runtime contract](2026-09-10-harness-runtime.md) for current execution and recovery.

---

## 0. Core principle

The control plane governs authority, the metering plane governs money/admission, and the execution plane governs sandbox lifetime. They coordinate through the Postgres run state machine rather than calling one another. The reviewed implementation already preserved this valuable property; the recommendations below protect it.

## 1. Four planes

At the time, three backend planes shared two processes. The main proposed change was separating metering deployment.

| Plane | Responsibility | Authentication | Traffic | Recorded implementation | Target |
|---|---|---|---|---|---|
| Experience | Console/site/SDK/MCP/CLI | Org key | Low | apps/console/site, packages/sdk | Add @nimplex/mcp |
| Control | /v1 run CRUD, registries, credentials, events | Org key, then unimplemented | Low QPS, latency-tolerant | apps/api | Keep |
| Metering | /gw LLM proxy, reserve/settle, soft kill | Run token | Every model token, streaming, latency-sensitive | Mounted in apps/api | Separate apps/gateway |
| Execution | Claim work, create sandboxes, install harnesses, stream events, kill/reap | No public interface | Long-running | apps/worker | Keep |

### 1.1 Why separate the gateway

```ts
app.route("/gw", createGateway(db)); // Metering mounted under the control plane
```

This shares a process, deployment, scaling unit, and failure domain. Ten concurrent streaming runs can slow CRUD; restarting for a harness route change interrupts model connections; control scales with users while metering scales with concurrent runs; trusted backend org-key traffic shares a process with untrusted sandbox run-token traffic. `createGateway(db)` is already separable, so the principal change is deployment boundaries.

## 2. Trust zones and credentials

```text
Zone A: trusted API / gateway / Postgres
  AES-256-GCM provider_keys
  Plaintext exists while accepting PUT key or forwarding a model request
          │ run token only
Zone B: worker, no customer provider keys
  Create sandbox, install harness, stream events, kill
          │ base URL and run token environment variables
Zone C: untrusted sandbox
  Arbitrary uploaded harness
  claude-code manifest uses --permission-mode bypassPermissions
  Sandbox isolation, not an internal permission switch, is the boundary
```

### 2.1 Invariants

| ID | Invariant | Recorded status |
|---|---|---|
| I1 | Real provider keys stay in zone A | Passed: ledger.resolveProviderKey → adapter.authHeaders decrypts only during forwarding |
| I2 | Maximum loss from a zone-C credential is bounded by its run budget | Failed for one oversized call; §5.2 |
| I3 | A database leak alone cannot impersonate tokens | Passed: runs stores SHA-256 hashes |
| I4 | Any worker can destroy any sandbox | Passed: serializable sandbox_state and delete(state) without resume |
| I5 | Console and SDK have equal capabilities; no /internal/* | Passed and documented in sdk/client.ts |

I2 was the sole failing invariant and the headline promise. In the later Pi architecture, API and worker share the provider-key trust boundary; the sandbox exclusion remains.

### 2.2 Two separate tickets

| Ticket | Holder | Issued | Purpose |
|---|---|---|---|
| run_token | Integrator backend | Once at run creation | Self-hosted harness |
| sandbox_token | Sandbox | Separately during worker setup | In-sandbox harness |

A sandbox compromise should not expose the integrator's ticket. authorizeRun accepted both, but they could be invalidated independently.

## 3. Database coordination

All planes coordinate through runs:

```text
gateway exceeds budget → killRun(status=killed)
                                   ↓
runs: status, spent/reserved, sandbox_state, event_seq
                                   ↓
worker watchdog every 5s → terminal? → abort → session.stop → clear sandbox_state
```

| Action | Owner | Guarantee |
|---|---|---|
| Soft kill: durable status and refusal of future calls | Gateway/control | Immediate without locating sandbox |
| Hard kill: session.stop removes sandbox | Worker | Eventual, with five-second watchdog and ten-second reaper |

Keep them outside a shared long transaction. Gateway need not know sandbox location or reach its provider; worker reads durable status. Never speed up kill by making the gateway call a sandbox provider: provider outages would then break model proxying.

## 4. Uneven pluggability across three slots

| Slot | Port | Registry | Implementations | Changes to add one |
|---|---|---|---|---|
| Sandbox | SandboxProvider/SandboxSession in core/sandbox.ts | registerSandboxProvider | Local, disabled by default; Docker | Class plus registration |
| Harness | Zod/DB HarnessManifest | Organization overrides built-in slugs | Four built-ins plus uploads | Customer PUT, no release |
| LLM provider | None | Hard-coded PROVIDER_ADAPTERS | Anthropic/OpenAI/OpenRouter | Contracts enum, adapter, prices |

The least pluggable slot carries the money. Proposed shape:

```ts
export interface ModelProviderAdapter {
  readonly providerId: string;
  defaultBaseUrl: string;
  authHeaders(apiKey: string): Record<string, string>;
  rewriteBody(body: unknown): unknown; // Require upstream usage reporting
  extractUsage(chunk: unknown): TokenUsage | null;
  extractReportedCost(chunk: unknown): number | null;
  worstCaseTokens(body: unknown): { input: number; output: number }; // Required by §5.2
}
registerModelProvider(new AnthropicAdapter());
```

### 4.1 Conformance kit

Propose packages/conformance with mandatory adapter tests:

```ts
import { runSandboxConformance } from "@nimplex/conformance";
runSandboxConformance(new E2bSandboxProvider());
// Verify create/exec/readFile/stop, JSON state round-trip and resume,
// delete without resume, failed exec after stop, and real signal/timeout cancellation.
```

Provider neutrality should fail a build when broken. Differences such as lost environment variables after resume can otherwise emerge as intermittent unkillable runs. Conformance makes I4 mechanically testable; the later implementation placed this kit in packages/testkit.

## 5. Accounting path

### 5.1 Hot/cold separation

| | Hot path, every call | Cold path |
|---|---|---|
| Operations | Authenticate → gate → reserve → forward → settle | Rollups/reports/audits |
| Recorded implementation | Four Postgres round trips: authorize/gate/reserve/settle | Query usage_records |
| Proposed target | Seconds-long token-to-run cache and batched settlement | Keep |

Per-call usage rows support audit. Repeated DB authentication was the likely first bottleneck; proposed caching requires active invalidation on terminal transitions.

### 5.2 The hard cap was not hard

```ts
const reserved = Math.min(costUsd, available); // Reserves too little but still admits the call
```

With $0.01 left, a max_tokens=64000 request could reserve $0.01 and settle at $2, exceeding by $1.99. Small-call $0.05 demos did not expose this per-request gap.

Use the existing request-rewriting mechanism, which already added stream_options.include_usage, to shape requests around available budget:

```text
worstCase = input bound × input price + max_tokens × output price
  Fits available → reserve full bound and dispatch
  Output can be reduced to fit → rewrite max_tokens, reserve new bound, dispatch
  Minimum useful output cannot fit → reject with 402 budget_exceeded
```

This is the actual property a budget demo must test. It depends on conservative input bounds and correct pricing; the later implementation rejects unpriced models.

### 5.3 Move prices to the database

At this date core/pricing.ts hard-coded prices, requiring deployment for changes despite budgets depending on them. The proposal retained the expensive $15/$75 per-MTok FALLBACK_RATE and added versioned model_prices behind unchanged lookupRate(). The current runtime instead rejects unknown prices; do not restore the historical fallback by following this proposal.

## 6. Contracts and code generation

```text
packages/contracts, Zod
  ├─ OpenAPI generated from hono-zod-openapi routes
  │    ├─ SDK types
  │    ├─ MCP tool catalog
  │    └─ console client
  └─ Runtime validation at API input and before SDK submission
```

Contracts already provided a single source. Proposed parity CI fails whenever a console operation lacks an MCP tool, enforcing the three 08-27 §5 rules mechanically.

## 7. Data layer

### 7.1 Tenant isolation was application-only

Without RLS, forgetting org_id in one query creates a cross-tenant leak. Two options:

| | Postgres RLS | Recommended scoped repository |
|---|---|---|
| Mechanism | SET LOCAL app.org_id plus policies | Export scopedDb(orgId), making unscoped queries unavailable by type |
| Cost | Per-connection state and more complex Drizzle integration | Thin wrapper and lint rule blocking raw db imports |
| Enforcement | Database | Compile-time boundary |

Implement early; retrofitting after forty routes costs more.

### 7.2 Missing outcomes table

A technically completed run may be useless. The proposed outcome-data moat needs storage:

```text
outcomes
  run_id → runs.id
  verdict: accepted | rejected | partial
  signal: JSONB (PR merged, tests passed, rating, retry count)
  reported_by: integrator | end_user | automated
  created_at
```

Add run.report({verdict, signal}) to compute harness × model × task-type success rates. Outcome data accumulates over time, so delaying the table loses historical evidence.

### 7.3 Replace 400 ms stream polling

Each SSE viewer polled the DB every 400 ms; 100 viewers meant 250 queries/second. Existing run_id/seq indexing and atomic sequencing already enabled resume. Proposed LISTEN/NOTIFY supplies notification, with polling retained as a reconnect fallback.

## 8. Proposed removals

| Target | Reason |
|---|---|
| apps/runtime, Cloudflare Workers/DO | No longer the execution backbone; Cloudflare-specific sandbox coupling conflicts with provider choice. API already absorbed its SSE approach |
| Unimplemented core RunExecutor at that date | Real harness-executor used another path; a misleading abstraction. Later Pi work added a real consumer, so this deletion recommendation no longer applies |
| Production local sandbox | Explicitly has no isolation. Keep for development but block at deployment rather than relying on unset environment flags |

## 9. Deployment

| Component | Proposed host | Reason |
|---|---|---|
| Site/console | Vercel or Cloudflare Pages CDN | Static Vite output |
| API | Persistent Node, Fly.io/Railway | Long-lived Postgres connections |
| Gateway | Separately deployed persistent Node | Different hot-path scaling and failure domain |
| Worker | Persistent Node; Docker daemon if using Docker provider | Long-running execution |
| Postgres | Neon | Selected |

Docker provider creates containers on the worker host, meaning arbitrary user code shares that machine. Production should default to remote E2B/Vercel/Daytona so the worker needs only API access and can run on ordinary PaaS.

## 10. Implementation priorities

| Priority | Work | Reason |
|---|---|---|
| P0 | Org-key authentication and scoped repository | /v1 was then unauthenticated under one default organization |
| P0 | Budget-aware shaping | Fixes the headline promise in the gateway path |
| P1 | Separate gateway deployment | Existing createGateway is already separable; delay adds coupling |
| P1 | Outcomes and run.report | Begin time-series collection |
| P2 | Model registry and conformance | Mechanically test neutrality |
| P2 | DB prices, LISTEN/NOTIFY | Cheaper early than late |
| P3 | Remove runtime and then-unused RunExecutor | Cleanup, not a blocker |

## Plane boundaries to preserve

- Control: CRUD/authorization, not provider execution.
- Metering: run-token accounting, no sandbox-provider dependency in this historical design.
- Execution: durable DB state, no control coordination through gateway. The 09-02 Managed Agents exception sent run-token requests through the gateway to preserve I1, not to create a new coordination channel; state still flowed through DB.
- Shared core: contracts own public shapes; core remains pure and free of IO.
