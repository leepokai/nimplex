# Claude Managed Agents and nimplex: comparison and integration roadmap

> 2026-09-02. Compared the official claude-api skill references for beta managed-agents-2026-04-01 with nimplex, following the 09-01 architecture and SDK §1.1.
> Decision at that date: Managed Agents was both competitor and integration slot, with the listed capabilities to be delivered in the order below.
> **Historical:** this integration, gateway, and related tables were removed on 2026-09-06. This record preserves the design and lessons, not current supported endpoints.

## 0. Managed Agents shape

```text
Agent: versioned model/system/tools/MCP/skills
 └─ Session: state, event input/output, budget, resources, vault_ids
     └─ Environment: cloud or self_hosted worker polling tools into customer containers
         └─ Container: tools only; loop runs in Anthropic's orchestration layer
```

Lifecycle: rescheduling → running ↔ idle → terminated. Idle carries a reason such as awaiting input, tool result/approval, or budget_reached.

## 1. Comparison

| Managed Agents capability | nimplex at the time | Gap/integration |
|---|---|---|
| Session max_list_cost: integer-string USD cents; checked before model calls; idle at cap, resumable after changes; documented one-call overshoot | budget_usd with gateway reserve/settle; killed at cap | Future paused(budget_exceeded); map budget to session, usage.list_cost to spent_usd |
| Self-hosted environment: Anthropic loop, customer tools; ANTHROPIC_ENVIRONMENT_KEY polling and per-session work.secret | Worker, Docker, reaper | EnvironmentWorker bridge into nimplex sandboxes; self-hosting lacks vault/file/repo resources |
| Vault environment_variable injection at Anthropic egress | BYOK gateway and run token, I1 | Same principle, no direct integration needed |
| Outcomes, user.define_outcome/rubric and independent grader; satisfied/needs_revision/max_iterations_reached/failed/interrupted | Planned outcomes table, architecture §7.2 | Ingest span.outcome_evaluation_end.result as automated signal; later grade any harness |
| always_ask → status_idle → user.tool_confirmation | Planned approval events/resolveApproval | Compatible semantics; consider per-tool manifest policy |
| domain.action events, idle stop_reason, usage snapshots | Same naming planned, not fully typed | Low translation cost; spend.updated maps usage |
| Signed webhooks for status/budget/deployment/vault | SSE only | Add run.status_changed webhook |
| Scheduled deployment cron, per-session copied budget, deployment_run | None | Moderate-priority scheduled runs |
| Session overrides without modifying agent version | Manifest version existed but run did not record it | Persist resolved harness version for traceability |
| Memory stores, multiagent threads, advisor | None | Harness internals rather than this platform layer |

## 2. P0 integration: built-in claude-managed-agent harness

The gateway proxied arbitrary /:provider/* paths. Worker calls to sessions used a run token, exchanged for BYOK upstream credentials; the real key stayed outside the worker, preserving historical I1.

```text
worker                              gateway                       Anthropic
POST /gw/anthropic/v1/sessions → decrypt BYOK / x-api-key → POST /v1/sessions
GET session events             ← stream tee              ← events
POST user.interrupt            → soft interruption
DELETE session                 → hard termination
```

| Component | Proposed change |
|---|---|
| Core | BUILTIN_MANAGED_AGENT_COMMAND sentinel and Anthropic manifest, no install/sandbox |
| Contracts | provider_reported metering and closed stop_reason |
| DB | managed_agent_refs mapping org/harness/instructions_hash to reusable agent_id/environment_id |
| Worker | Resolve/create agent/environment, create budgeted session with initial prompt, translate events, update spent from usage, watchdog interrupt/delete |
| Gateway | Skip Messages usage extraction on session paths to avoid false metering.gap |
| E2E | Real Anthropic key and beta access; real costs for cloud validation |

Event mapping:

| Managed Agents | nimplex |
|---|---|
| agent.message | message.delta |
| agent.tool_use/result | tool.call/result |
| agent.custom_tool_use | tool.approval_requested, awaiting user.custom_tool_result |
| session.usage | spend.updated and runs.spent_usd |
| session.status_idle | run.status: awaiting_input, future paused(budget_exceeded), or v1 killed |
| session.status_terminated | completed/failed based on session object |
| session.error | run.failed |

## 3. Delivery order

| Priority | Work | Rationale |
|---|---|---|
| P0, implemented 09-02 | Built-in harness | Aggregation should include a major cloud agent; fake-key E2E reached upstream 401, validating proxy/executor wiring; real execution required real BYOK |
| P0 | Event union and typed stop_reason | Translation already needed |
| P1 | Pause at budget and continue after increase | Better product semantics, transition reserved |
| P1 | Status webhooks | Common ecosystem need, low cost |
| P2 | Cron runs | Add on demand |
| P2 | Outcomes and grader signals | Outcome-data strategy |
| P3 | Self-hosted environment bridge | Larger effort with vault/resource restrictions |

### 3.1 Three fixed integration failures

| Failure | Symptom | Fix |
|---|---|---|
| Setup throws into main worker loop | Work item fails but run remains running; SDK polls forever | Catch executor setup into failed; main catch always failRun for all harnesses |
| Anthropic SDK 0.123 stream allowlist omits session.usage | Silently dropped usage, spent_usd stays zero | Authoritative sessions.retrieve().usage.list_cost every five seconds and at completion |
| Gateway budget gate precedes session passthrough | Soft kill blocks interrupt/delete too; upstream session remains billable | Passthrough before admission gate; terminal runs allow only GET/DELETE or POST events containing solely user.interrupt, otherwise 409 |

The third case generalizes I4: soft cancellation must not close the cleanup channel needed for hard termination.

## 4. Constraints recorded at the time

- Beta API can change and supports only Anthropic models.
- list_cost is public list price, not a customer's negotiated price; display provider_reported metering distinctly from gateway measurements.
- Budget exhaustion pauses Managed Agents but kills nimplex v1; preserve distinct reasons.
- Self-hosted environments lack vault and file/repo mounts; EnvironmentWorker was available only in Python/TS/Go SDKs.
