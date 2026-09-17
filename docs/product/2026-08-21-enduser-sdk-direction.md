# Product direction: end-user SDK first, harness marketplace later (2026-08-21)

**Purpose:** refine the 2026-08-18 option A specification and 2026-08-20 MVP decision. Record the user's positioning clarification, two-phase roadmap, and new requirements for permissions and network controls.
**Prerequisites:** `2026-08-18-haas-vision-critique-mvp.md`, `2026-08-18-protocol-strategy.md`.
**Code at that date:** the MVP skeleton was on private `github.com/leepokai/nimplex`; runs, events, work queue, budget kill switch, and per-end-user metering had been verified.
**Historical scope:** later positioning and architecture decisions supersede this proposal where they conflict.

---

## 1. Positioning: different customers from Omnara

Assessment after reading Omnara source and documentation, accepted by the user on 2026-08-21:

| | Omnara | nimplex |
|---|---|---|
| Customer | **Internal teams** building cloud agents more conveniently | **A product owner's end users**, through agents shipped inside another company's web/app product |
| User identity | Organization member: engineer or operator | Each end user in the customer's product |
| SDK role | `frontend/packages/{sdk,react,cli}` operate the platform at organization scope; no end_user object, so these SDKs cannot safely be handed directly to customer end users | The SDK is the product: customers serve their end users through their own web/app |
| Harness | Fixed proprietary loop | Pluggability is a selling point |
| Maturity | Simpler than Replicas/Capy; lacks a standard SDK for building applications | Enter through that gap |

**Revised view of Capy:** it demonstrates **monetizing a harness**: its three-role harness is the billable product. This provides a business prototype for Phase 2, where third-party harnesses can be listed, invoked, and billed.

## 2. Agreed two-phase roadmap

### Phase 1: end-user agent infrastructure and SDK

First complete the **infrastructure layer**. A product owner should use the SDK to give every web/app end user an agent, with billing, credentials, permissions, and auditing handled by nimplex.

Priorities:

1. **Per-end-user billing for the product owner:** USD metering, hard caps, and resellable billing exports. The skeleton exists; export format and API remain.
2. **OAuth / MCP:** connect each end user's third-party accounts through Nango/Arcade so the agent acts as that user (W1).
3. **Native product tool bridge:** customers register their own product's MCP server or CLI as agent tools. This completes the integration: agents operate the host product as well as external services.
4. **Complete SDK**, described in §3.
5. Permission controls (§4) and network controls (§5).

### Phase 2: harness marketplace

- Third parties list harnesses for invocation as cloud agents, with a Managed Agents-like experience but a choice of marketplace harnesses.
- nimplex supplies cloud infrastructure; authors receive revenue share, turning Capy's model into a platform.
- Explicitly defer the marketplace until infrastructure is mature.
- Existing extension points: `runs.harness` and `RunExecutor`.

### Next action

**Build a mock frontend first** to clarify the product story, console information architecture, and SDK developer experience before adding more infrastructure code.

## 3. SDK shape: Phase 1's core deliverable

Three deliverables for three integration locations:

| SDK | Location | Credentials | Capabilities |
|---|---|---|---|
| **Server SDK**, TS first, Python second | Customer backend | Organization API key | Create runs, manage end users/budgets, stream events, resolve approvals, export bills |
| **Client SDK** | Customer web/app frontend | **Short-lived end-user-scoped token** exchanged by the customer backend | Connect to run events, submit input, render approvals |
| **Native tool bridge** | Customer product | Tool registration | Register the product's MCP server / CLI as agent tools |

**Day-one rule:** organization API keys never enter browsers or apps. The Client SDK accepts only short-lived tokens bound to one end_user and explicit scopes. This expresses W1 at the SDK boundary; the reviewed Omnara SDK lacks an end_user object to bind.

The existing `packages/contracts` (Zod → OpenAPI) and `packages/api-client` are the Server SDK seed.

## 4. Permission controls: new requirement on 2026-08-21

The user explicitly requested four layers, all keyed first by `end_user`:

1. **Tool policy:** each agent config declares `always_allow / always_ask / always_deny` per tool, enforced by the platform. `always_ask` moves a run to `awaiting_input`, already supported by the state machine, and resolves through API/SDK. Reuse the protocol strategy's ACP `session/request_permission` mapping when harnesses move inside sandboxes.
2. **Credential scope:** a run for usr_123 can reference only usr_123's `credential_refs`. Enforce end_user_id-scoped database queries with lint rules rather than relying on developer discipline alone.
3. **Token hierarchy:** backend organization key → short-lived frontend end-user session token → future opaque in-sandbox token exchanged by the firewall. Each level has strictly fewer capabilities.
4. **Console roles:** owner/admin/member organization roles already have a table; add project-level grants later.

## 5. Network controls: new requirement on 2026-08-21

Also explicitly requested. Implement in two phases because the current loop runs in the worker and the proposed future loop runs in a sandbox.

**Current worker-hosted loop: tool-call enforcement**

- **Egress allowlist:** each agent config declares domains. The worker checks before ToolWork, rejects unlisted destinations, and audits the denial.
- **MCP endpoint allowlist:** agents connect only to customer-registered MCP servers.
- **Per-end-user rate limits:** tool QPS and per-run call caps prevent runaway loops and complement the budget kill switch.
- **Traffic audit:** each external request records destination, verb, end_user, and run in `audit_events`, completing the credentials × spending × actions model.

**Future in-sandbox harness: network enforcement**

- All sandbox egress passes through a firewall proxy; allowed destinations derive from that user's credential scope.
- Secrets are injected at the proxy (fork two: plaintext never enters the sandbox).
- Budget or policy violations disconnect the proxy and kill the sandbox; enforcement owns the execution path.

**Design rule:** both phases share the same declarative allowlist/policy schema. Moving enforcement from worker to firewall must not require customers to rewrite configuration.

## 6. Open questions

1. Short-lived end-user tokens: self-contained JWT or opaque tokens with introspection? Opaque tokens are preferred for revocation.
2. Native tool transport: should nimplex connect to a reachable customer MCP endpoint, or should the customer backend connect inward persistently for CLI/private-network tools? Support both?
3. Billing exports: align with Stripe metered-billing usage records so customers can forward them to their billing system?
4. Frontend mock scope: console information architecture only, or also landing-page narrative?
