# Console information architecture (2026-09-01)

> Follows the OpenRouter-for-cloud-agents positioning in `2026-09-01-sdk-architecture.md`.
> Defines each tab, its implementation status, and missing API support.
> The 08-27 §5 rule remains: the console uses only public APIs, with “Copy this call” beside every state-changing action.
> **Historical:** the console, gateway, and tool registries described here were removed on 2026-09-06.

## Tab inventory

| Group | Tab | Status at the recorded date | Data source | Missing backend |
|---|---|---|---|---|
| Execution | **Runs** | ✅ Real | `runs.list/kill/cancel/events`, live SSE; since 2026-09-03, no runs shows an empty state instead of sample runs | — |
| Execution | **Usage** | ✅ Real since 2026-09-03 | `usage.summary()` → `GET /v1/usage`, bucketed by day/harness/external_user_id/model | — |
| Execution | **Estimate before running** | 🟢 Partially real | Real `models.list()` prices and manually maintained compute constants | Versioned DB price registry |
| Three slots | Harness | ✅ Real | Since 2026-09-03, full manifest upload (env/output/workdir/timeout), editing, and built-in overrides | — |
| Three slots | LLM provider | ✅ Real | Existing organization-scoped implementation | — |
| Three slots | Sandbox | ✅ Real | Existing implementation | — |
| Tools | **Skills** | ✅ Real registry | `skills.list/get/upload/delete` → `/v1/skills` | Sandbox injection for run `skills: [slug]` |
| Tools | **MCP servers** | ✅ Real registry | `mcpServers.list/get/put/delete` → `/v1/mcp-servers` | Run injection for `mcp_servers: [slug]` and broker credential resolution |
| Organization | **API keys** | ✅ Real | `apiKeys.list/create/revoke` | — |
| Organization | **Members** | ✅ Real | `members.list/add/setRole/remove` | Invitations; currently adds emails directly |
| Top bar | **Organization switcher** | ✅ Real | `orgs.list/create` and `x-nimplex-org` | After authentication, derive organization from key/session |

## Tab definitions

### Runs: observability core

List status, harness, model × sandbox, spent/budget, and duration. Poll active runs every two seconds and terminal runs every fifteen. Details show live SSE with `Last-Event-ID` resume using the same SDK path, the `external_user_id` label, and metering mode. Keep **Cancel** (graceful completion) and **Kill** (destroy sandbox) separate, matching the two API primitives.

### Usage

Spending rollups: today/month cards and grouping by harness and `external_user_id`. The original design noted that `usage_events` already carried run/provider/labels but lacked a rollup endpoint; the 09-03 inventory above records its later implementation. This page makes harness-independent metering visible.

### Estimate before running: OpenRouter-style comparison

Enter estimated tokens and duration, then sort all model × sandbox combinations by cost. Model prices share the accounting table exposed by `GET /v1/models`; compute prices remain approximate constants until the price registry is versioned. **Tokens dominate the default view; compute is secondary**, following 08-27 §4.4.

### Skills used by agents

A skill is a directory plus `SKILL.md`. Upload it to the organization registry and pass `skills: ["slug"]` when creating a run. The supervisor installs it into the selected harness's skills directory so one skill works across harnesses. Keep this separate from skills users install to manage nimplex through the AgentConnect card.

### MCP servers used by agents

An allowlist of MCP endpoints reachable by the sandboxed agent, eventually part of egress policy. This is the native product tool bridge: a customer's MCP server lets the agent operate its host product. Authentication accepts only broker references; plaintext is neither stored nor placed in the sandbox. Runs specify `mcp_servers: ["slug"]`.

A separate footer card, “Manage nimplex with your AI tools,” advertises `@nimplex/mcp`. These two MCP roles occupy distinct areas of the same page.

### API keys

Organization programmatic identity: display plaintext once at creation, store a hash, list only last4, and support revocation. **Per-key limits are the future spending-control extension point**, following OpenRouter's pattern of issuing individual keys for per-user control.

### Members

Console users are owners, admins, or members. Owners manage billing/membership; admins manage the three slots and keys; members read and create runs. Human identities exist at this layer; customers manage their own end users.

### Organization switcher

`GET/POST /v1/orgs` with `x-nimplex-org`, validated by middleware. Store selection in localStorage and reload on switching; fall back to the default organization if the stored selection becomes invalid. Once authentication is enabled, key/session organization binding supersedes the header-only mechanism.

## Replacing mock data

1. ✅ `api_keys` and Bearer middleware, 2026-09-01.
2. ✅ `GET /v1/usage` rollup, 2026-09-03; bucketed `usage_records` with caller-supplied timezone.
3. ✅ `/v1/skills` and `/v1/mcp-servers`, 2026-09-03; tables, CRUD, and idempotent PUT.
4. ✅ Members with Better Auth integration, 2026-09-01.

At that checkpoint, the console no longer used mock data. The remaining work was consuming registry entries: accept `skills` / `mcp_servers` in `createRunRequest`, install skill files during sandbox creation, and write MCP endpoints into harness-specific configuration, starting with claude-code.
