# Codex subscription access

The local terminal and headless runtime support Pi's `openai-codex` provider.
The Pi agent loop, nimplex checkpoints, just-bash tools, and native sandbox routing
remain in use. This does not launch Codex CLI as a second agent or expose its
host-shell tools.

## Sign in and run

```bash
nimplex login codex
nimplex --model openai-codex/gpt-5.6-sol
nimplex --model openai-codex/gpt-5.6-sol "Inspect the attached file @README.md"
```

Login offers Pi's browser and device-code methods. Complete the ChatGPT sign-in
yourself in the browser. An API key is not required for this provider. In the
terminal, `/login codex` starts the same flow and closes the terminal after a
successful login; restart with the selected subscription model.

`/model` lists the Codex subscription models in the installed Pi 0.85.1 catalog
alongside the existing Anthropic models. Selecting a model through `/model`
persists the terminal preference. Headless commands select their model with
`--model`; login alone does not silently switch existing defaults.
Catalog presence does not prove entitlement or current backend availability.
The example model is in the installed catalog, not a claim about the latest model.

```bash
nimplex logout codex
```

`/logout` removes the selected model provider's nimplex login. `/logout codex` and
`/logout anthropic` select explicitly. The existing `nimplex login` and
`nimplex logout` commands still target Anthropic by default.

## Credentials and routing

Pi's public `ModelRuntime` manages OAuth through a credential file at
`$XDG_CONFIG_HOME/nimplex/codex-auth.json`, or
`~/.config/nimplex/codex-auth.json` by default. Its file store uses restricted
permissions and serializes token refresh under a cross-process lock.

This is a separate login from Codex CLI and the Pi CLI. nimplex does not read,
copy, or rotate their credential files. It resolves subscription credentials
before each executor step and honors cancellation during auth operations.
Provider tokens never become session events, attachments, or sandbox variables.

Subscription requests use Pi's Codex Responses adapter at
`https://chatgpt.com/backend-api`. There is no subscription endpoint override.
An Anthropic endpoint or `OPENAI_API_KEY` cannot redirect these requests or cause
silent API fallback. A missing/expired login returns a re-login instruction;
provider quota errors end the turn without automatic model/provider fallback.

## Billing and execution semantics

Subscription turns have `billing_mode: "subscription"`.
Their API `spent_usd` is zero. These values mean no API charge
is attributed by nimplex, not free or unlimited model usage. The subscription
price, plan quota, and any provider-side credits are not calculated here.

Model events still record input, output, and cache token usage, request identity,
stop reason, and uncertain outcomes. A zero-dollar reservation preserves the
existing checkpoint sequence. Pi's API-price estimate is not recorded as an
actual subscription charge. `/cost`, completed turns, and the footer distinguish
subscription access from API costs.

USD budgets, `--budget`, and `/budget` were removed on 2026-09-20.
Subscription quota remains provider-managed.
`--timeout`, cancellation, read-only mode, and workspace limits still apply.
Sandbox charges remain separate. The adapter uses SSE, disables transport retries,
and currently uses low reasoning effort. Interactive thinking-level selection is
not yet implemented; see the [Pi compatibility inventory](2026-09-15-pi-compatibility.md).
The reservation's output-token field reflects the catalog limit; it is not a
provider-enforced user quota cap for subscription requests.

The hosted API remains Anthropic-only and rejects Codex subscription runs. This
change is for personal local use; it does not distribute one subscription login
to the proposed multi-tenant cloud worker fleet.

## Sources and validation scope

[Official OpenAI authentication documentation](https://learn.chatgpt.com/docs/auth#openai-authentication)
distinguishes ChatGPT subscription sign-in from API-key billing. It documents
Codex surfaces; nimplex's adapter is implemented through Pi and is not presented
as an official OpenAI client integration.

Implementation references are the installed Pi 0.85.1 public `ModelRuntime`,
`openai-codex` provider, and `openai-codex-responses` adapter. No Pi fork or private
deep import is required.

Tests use synthetic OAuth tokens, mocked token refresh, and Codex SSE responses
with the real Pi adapter. They cover durable tools/history, cancellation,
read-only execution, quota errors, endpoint binding, refresh serialization, and
credential isolation. These tests consume no real subscription quota. A browser
login and successful live model request are separate user-account verification.

Validation on 2026-09-15: workspace type checks passed, including a forced check
of all 12 packages; lint passed; unit/integration tests reported 109 passed and
37 optional skips. The PostgreSQL fake-provider `pnpm e2e` suite passed, including
worker death, lease takeover, cancellation, and accounting scenarios. A real PTY
check verified the browser/device login chooser and cancellation before network
authentication. Frozen offline installation and documentation checks passed.
