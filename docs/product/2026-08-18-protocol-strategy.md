# nimplex protocol strategy (2026-08-18)

**Basis:** `docs/competitor-analyze/haas-api/research-acp-protocol.md` and `research-anthropic-protocol-playbook.md`, both verified against primary sources with ego-browser that day. This document answers two questions: should the harness adapter depend on ACP, and how should nimplex define its API/manifest using Anthropic's approach?
**Companion:** `2026-08-18-haas-vision-critique-mvp.md`, MVP specification, option A: Per-End-User Agent Run API.
**Historical scope:** this proposal predates the 09-06 move to a worker-hosted Pi harness. It is a record of the original protocol decision, not the current implementation.

---

## 1. Harness adapters: ACP inside, our API outside

### Decision

**Use stdio ACP as the primary in-sandbox harness adapter and our own HTTP+SSE API between the control plane and sandbox. Do not commit to ACP-over-HTTP yet.**

### Rationale

1. **ACP stdio v1 is stable and has the broadest ecosystem.** Gemini CLI, OpenCode, and Goose implement it natively; Claude uses `claude-agent-acp`, Codex uses `codex-acp`, and Copilot CLI has entered public preview. One stdio ACP client can drive almost every mainstream harness, exceeding rivet sandbox-agent's four or coder/agentapi's six, with implementations maintained by harness vendors.
2. **ACP-over-HTTP is an Active RFD.** Replay, heartbeats, and reconnection semantics are deferred to v2; Goose is the sole reference implementation, SDK support is incomplete, and the architecture changed substantially at least three times between April and July 2026. Binding control-plane transport to it would force refactors around an unsettled specification.
3. **ACP assumes a different trust model.** It treats a trusted editor client as the security boundary. nimplex instead puts an untrusted harness in a sandbox under remote control-plane authorization. Permission requests can map to our control plane as the client, but authentication, tenancy, metering, and quotas belong to our product layer and are absent from ACP by design.
4. **Manage the v1/v2 transition explicitly.** The 2026-07-20 v2 draft introduces breaking changes. Pin v1, use capability negotiation, and migrate when v2 stabilizes.

### Implementation shape

```text
control plane ──(nimplex HTTP+SSE: runs/events/budget/audit)──▶ in-sandbox supervisor
                                                               │ stdio ACP v1
                                                               ├─▶ opencode
                                                               ├─▶ codex-acp → Codex CLI
                                                               └─▶ claude-agent-acp → Claude Agent SDK
                                                                    (customer-supplied API key only)
```

- **Supervisor:** build it or evaluate adopting/forking `rivet-dev/sandbox-agent`, which already wraps multiple harnesses behind in-sandbox HTTP+SSE. Our additions are budget kill switches and secret-proxy hooks. Spend two days checking whether its enforcement hooks suffice; adopt it if they do to reduce adapter maintenance.
- **Permissions:** map ACP `session/request_permission` directly to our policy engine: harness request → supervisor → control plane → automatic allow/deny or HITL escalation according to customer policy. Reuse the standard semantics.
- **Future compatibility:** leave room for an ACP-over-HTTP bridge once the RFD reaches Preview/Completed, potentially allowing Zed/JetBrains clients to connect directly to a nimplex sandbox. This is an optional future capability, not a present dependency.
- **Tracking:** review the ACP Transports WG HTTP/WS RFD quarterly; the group is led by Zed, JetBrains, and Block.

## 2. Our specification: Anthropic's discipline, in the right order

### Applicable principles

| # | Anthropic principle | nimplex application |
|---|---|---|
| 1 | A core small enough to implement in a day; optional capabilities | v1 exposes only `POST /v1/runs`, `GET /v1/runs/{id}/events` SSE, an end_user object, and `budget_usd`. Credential brokerage, multiple harnesses, and resume are declared optional capabilities |
| 2 | Ship specification, SDK, reference implementation, and flagship use case together | Open-source launch includes OpenAPI, TS/Python SDKs, a Docker Compose self-hostable control plane, and a product using our API, such as a PR autofix loop that also reuses nimplex's original loop-engineering direction |
| 3 | **Validate before opening the standard**, following Skills rather than MCP | This solo project has not passed interview or gross-margin gates. Present a useful open-source product API first, not an open standard on day one. Extract the manifest specification after real users validate segment E. This follows the 08-17 warning that standards require distribution we do not yet have |
| 4 | Date-based versioning | API and manifest versions use `2026-XX-XX`, with a version header on each request, following MCP's 2026-07-28 stateless direction |
| 5 | Extension mechanisms from day one | `_meta` and `x_` custom fields allow third-party extension without forks |
| 6 | Start with lightweight governance | GitHub PRs and an honest CHANGELOG explaining earlier shortcomings; add SEPs and formal conformance once cross-vendor disputes justify them, as MCP did after a year |
| 7 | Institutionalize breaking-change policy | Promise a deprecation window once paying users exist; start with three months for a solo project rather than MCP's twelve |

### Technical decisions to reuse

- **Authentication:** learn from MCP 2025-06-18. The control plane is an OAuth **Resource Server**, not a client. Bind external credential-broker tokens (Nango/Arcade) to their audience, following RFC 8707 Resource Indicators, to prevent confused-deputy mistakes.
- **Events:** consider both MCP's stateless requests plus a notification stream and ACP's long-lived GET stream plus 202 Accepted. Use SSE and `Last-Event-ID` on `runs/{id}/events`; MCP removed resumability, but our W4 durable-session proposition requires it.
- **Future harness/loop manifest:** follow SKILL.md: a directory, a Markdown/YAML file, progressive disclosure, and minimal name/description/harness/credential declarations.

## 3. Strategy statement

Consume ACP stdio inside the sandbox rather than defining ACP. Apply MCP's technical discipline to our API—minimal core, date versions, capability negotiation, and resource-server authentication—while following Skills' rollout order: product validation before an open specification.

## 4. Actions for specification §7

1. Two-day spike: can `rivet-dev/sandbox-agent` host budget kill-switch and secret-proxy enforcement? Adopt it if yes; otherwise build a supervisor and stdio ACP client with the official TS/Rust SDK.
2. One-day spike: does `claude-agent-acp` work with customer-supplied API keys injected by a firewall, without subscription OAuth? Feed the result into the Anthropic sales inquiry in specification §7 item 4.
3. Quarterly review: ACP HTTP/WS RFD, v2 stabilization, and the next annual MCP version.
