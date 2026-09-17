# nimplex MVP definition

> 2026-08-27. Follows `2026-08-26-positioning-and-naming.md` and the three-layer competitor review `docs/competitor-analyze/2026-08-26-runloop-computesdk-omnara.md`.
> Defines scope, exclusions, and acceptance. **Historical proposal:** the later worker-hosted Pi runtime supersedes the gateway/harness-registry design below.

---

## 0. Resolve three contradictions first

### 0.1 One overall key versus BYOK

One key paying every supplier implies resale, terms risk, COGS, and payment operations, while 08-26 explicitly selected no resale for v1. Separate two meanings:

| Meaning | In this version | Excluded |
|---|---|---|
| Control-plane identity | One nimplex key operates sandboxes, harnesses, models, accounting, and cancellation | — |
| Payment instrument | — | One key paying every supplier |

One key unifies operations; customers retain their own provider contracts. Sandboxed harnesses receive short-lived nimplex tickets rather than real Anthropic/E2B keys, reducing credential exposure.

### 0.2 Multiple harnesses are a slot, not a billing axis

The 08-26 conclusion remains: free Apache-2.0 packages do not support harness-based margin; Vercel HarnessAgent already supplied free interoperability, and computesdk/sandbox-agent stopped after nine days. Support multiple harnesses to prove metering is independent of them, not as the product's reason to exist.

### 0.3 Selectively copy Runloop

Runloop's research orientation and Omnara's internal-tool audience differ from target B, embedding agents in products for end users.

| Reuse | Do not copy |
|---|---|
| OpenAPI-first generated SDKs, Stainless style | Organization/team/user seat hierarchy |
| Organization-entered provider credentials, as in /org-setup/sandbox-provider | CPU-hour focus on the roughly 5% compute share |
| Provider × type × scope credentials, as in /me/model-provider-secrets | A 170-endpoint surface with no budget/spend/cost controls |
| Agent stop/interrupt/stream/snapshots operations | Research-oriented Blueprint/Devbox terminology |

---

## 1. Product statement

One key operates any harness on any sandbox using customer model credits, with a per-end-user USD cap that can stop execution mid-run. The proposed difference is the billing axis—end-user dollars rather than CPU-hours/seats. Provider neutrality alone is insufficient because Runloop's sandbox-options.ts was already provider-agnostic.

## 2. Architecture: the gateway is the critical component

### 2.1 Why

Metering and enforcement require the execution path to pass through us. A sandboxed Claude Code process calling Anthropic directly hides tokens and makes a USD promise unenforceable.

```text
             nimplex control plane
        runs / end_users / budgets / events / prices
              │ create/kill       │ accounting and admission
              ▼                   ▼
       Sandbox Port          nimplex Gateway → customer Anthropic/OpenAI/OpenRouter
       (ComputeSDK)          (BYOK vault)
              │                   ▲
              ▼                   │ injected model base URL
       Harness (builtin / claude-code)
       Only a short-lived nimplex ticket enters the sandbox
```

Base URL injection enables harness-independent metering, external credential custody, and two-stage cancellation: gateway admission denial followed by sandbox.destroy().

### 2.2 Metered versus unmetered

| Mode | Condition | Guarantee proposed |
|---|---|---|
| Metered, default | BYOK model traffic through gateway | USD cap, burn rate, mid-run kill, exact accounting |
| Unmetered | Subscription-seat traffic outside the gateway | Duration/call caps and sandbox kill only; no USD guarantee |

Omnara logs contained `provider_reported_cost_usd.accounting_limitation: "byok_state_missing"`, showing that BYOK did not necessarily provide known cost. Explicitly expose `metering: "exact" | "none"` in UI/SDK. Unmetered agents cannot set budget_usd; they use max_duration/max_calls.

### 2.3 ComputeSDK source review, 2026-08-27

Available:

- setConfig with providers, priority/round-robin strategies, and fallbackOnError.
- Unified runCommand with cwd/env/background/onStdout/onStderr; filesystem readFile/writeFile/readdir/mkdir/exists/remove; getInfo, getUrl, destroy.
- CreateSandboxOptions.snapshotId and provider-factory SnapshotMethods.
- Low-cost custom integration through defineProvider.

Missing:

- Cost/billing concepts; SandboxResourceOptions even contains provider-specific billing-plan fields such as Northflank's, so compute prices need our own registry.
- Sessions, end users, and budgets.
- Individual background-process handles; the proposal therefore uses whole-sandbox destroy as the hard-kill primitive.
- Gateway/control-plane transport, explicitly removed in its README, leaving that layer outside ComputeSDK.

Decision at the time: use ComputeSDK directly for the sandbox port and integrate two providers seriously on day one.

## 3. MVP object model

```text
organization
 └── project
      ├── agent: versioned harness/model/tools/skills/default budget
      ├── end_user: first-class identity absent from the reviewed alternatives
      │    ├── budget: daily/monthly cap and balance
      │    └── credential: end_user-scoped BYOK
      └── run: always belongs to an end_user
           ├── budget_usd / spent_usd / metering
           ├── immutable sequenced resumable events
           └── sandbox_ref / harness_ref
```

Keep the existing contracts shape with required end_user and broker-only credential references. Add sandbox provider/resources/snapshot, replace the builtin-only harness enum with a registry, and add metering exact/none.

Credential resolution:

```text
scope precedence: end_user > project > organization
type: apiKey | subscription | oauth_ref
provider: anthropic | openai | openrouter | … (first three for MVP)
```

## 4. Five MVP feature areas

### 4.1 Observability

| In | Out |
|---|---|
| Run list with status/end_user/spent/burn rate | Custom dashboards/query language |
| Immutable detail events and SSE after=seq | Trace trees/spans/OTel export |
| Per-call provider_reported_cost_usd, as demonstrated by Omnara | Sampling/retention policies |
| User spending rollups/rankings | Alert rules engine |
| Dedicated budget_exceeded/killed reasons/events | — |

Reuse AgentSession DO's existing events, SSE, and meter from apps/runtime.

### 4.2 BYOK

| In | Out |
|---|---|
| Anthropic/OpenAI/OpenRouter | Eleven providers, Bedrock, Vertex |
| Three-scope precedence and auditable key ownership | SCIM/IdP/directory synchronization |
| Keys only in gateway, never sandbox | Claude Max/Codex subscription seats until M6 |
| Validate before storing, following Runloop | — |

### 4.3 Spending limits: highest priority

| In | Out |
|---|---|
| Per-run hard cap | Team/department budget trees |
| Per-end-user rolling daily/monthly caps | Invoices, balances, postpaid overages |
| Deny next call → destroy sandbox → emit reason | Predictive throttling/model downgrades |
| Reserve before calls to prevent concurrent excess | — |
| Duration/call limits for unmetered execution | — |

Acceptance: set $0.05 and observe an active run killed with a reason in its event stream. The reviewed three competitors, over 200 endpoints, and Go monorepo had no equivalent path.

### 4.4 Calculator

Reuse the spending price registry:

| In | Out |
|---|---|
| Model token and provider compute prices | Live pricing-page scraping; start manually versioned |
| Estimated cost before running | Treating an estimate as the hard-cap guarantee |
| Time-to-cap projected from current burn | — |
| Cross-provider/model comparisons, e.g. E2B/Vercel and Sonnet/Opus | — |

The cited SMALL 1 CPU/2 GB devbox cost about $0.07 for 26 minutes, while model tokens cost one to two orders of magnitude more. Default displays must prioritize tokens, with compute secondary.

### 4.5 SDK

| In | Out |
|---|---|
| OpenAPI source → generated TS SDK | Manually maintained multilingual SDKs |
| Org-key Server SDK: runs, budgets, kill, accounting | — |
| Short-lived end-user-token Client SDK, own runs only | — |
| Async event iteration | — |
| Python SDK at M6 | — |

## 5. Mechanically enforce AI-tool-native console operations

1. **Public APIs only.** Console and customer SDK share the same surface; no /internal/*.
2. **Generate MCP tools from OpenAPI.** One specification feeds SDK types, @nimplex/mcp, and the console client. CI fails if any console API operation lacks an MCP tool.
3. **Copy every state-changing call.** A Kill run control exposes the actual MCP call, SDK snippet, or curl request, keeping examples grounded in executed requests.

### 5.1 Requested skill installation card

The console home includes a card for operating nimplex through AI tools. The original illustrative commands were `claude plugin install nimplex` and `nimplex login --key nmx_live_…`, followed by examples:

- Set user_8f2's daily cap to $2.
- List today's runs spending over $1.
- Kill runs active for over 30 minutes.

Offer Copy commands and View skill. These were proposed integration commands, not current CLI syntax. Keep this card separate from apps/console/src/views/Skills.tsx, which manages skills used by agents. Target B platform teams already work in Claude Code/Codex; an agent-operable control plane can be a purchasing requirement.

## 6. Milestones and recordable acceptance demos

| Milestone | Work | Demo |
|---|---|---|
| M0 | Three ports, move contracts, remove runtime TODO(P0), OpenAPI skeleton | Type checks pass; generated SDK/MCP skeletons |
| M1 | Gateway, prices, accounting, reservations, soft/hard kill | $0.05 run stops mid-execution with matching event/accounting evidence |
| M2 | Two real ComputeSDK providers, destroy primitive | One config-line provider switch; kill actually removes sandbox |
| M3 | Builtin and claude-code manifests with base URL injection | Sandboxed Claude Code meters and stops at the cap, proving harness-independent accounting |
| M4 | BYOK vault, three scopes, validation | User key overrides org key; env reveals no real keys |
| M5 | Real console APIs, MCP, installation card, parity CI | Natural language in Claude Code performs every console action |
| M6 | Full estimates/comparisons and unmetered subscriptions | Compare E2B+Sonnet with Vercel+Opus on one page |

M1 precedes M2: prove the meter before provider breadth, otherwise the result is another neutral sandbox wrapper already supplied by ComputeSDK.

## 7. Explicit MVP exclusions

| Exclusion | Reason |
|---|---|
| Resale, unified bills, prepaid balance | Terms/payment operations; revisit after outcome data drives retention |
| Best-of-N | Persona D is demo material, not core business, and requires multiple vendor accounts |
| Marketplace | Deferred on 08-21 |
| MCP allow/ask/deny and durable approvals | P3; existing console mocks remain sample data |
| Egress controls | P3 |
| Scheduling/cron | Budget enforcement first |
| Custom sandbox abstraction | ComputeSDK already mature, with 96 forks and vendor adapters |
| Custom harness-neutral layer | Nine-day sandbox-agent shutdown and free Vercel HarnessAgent |

## 8. Unresolved pre-build validation

1. Is cloud-agent aggregation already being built? Still unverified since 08-26.
2. Do vendor terms prohibit multitenant proxying? Determines possible resale after M6.
3. Why did bespokelabsai/sandbox have four stars: no money through aggregation, or no demand for neutrality? These imply opposite decisions.
4. **New and most urgent:** does base URL injection reliably work for Claude Code/Codex? This supports M3 and accounting architecture; a half-day spike could invalidate the design.

## Existing assets

| Location | Recorded state | MVP use |
|---|---|---|
| contracts | Run state machine, required end_user, reference-only credentials | Extend existing shape |
| core/status.ts | Transitions including killed | Reuse |
| apps/runtime, Workers/DO | Event log, SSE, in-loop meter | M1 seed; README already identified the DO meter as the proposition |
| apps/console | Fifteen mock views, org/project navigation | Replace mocks at M5 and add end-user budget UI |
| apps/api and apps/worker | Early loopbox skeleton | Resolve overlap with runtime at M0 |
