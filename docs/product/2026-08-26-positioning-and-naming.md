# nimplex positioning and naming

> Decision recorded on 2026-08-26, replacing the business-model section of `2026-08-21-enduser-sdk-direction.md`.
> The original technical illustration was `2026-08-24-nimplex-blueprint.html`, a presentation mockup rather than a maintained specification.
> **Historical:** market assessments and business assumptions below reflect that date. The 09-06 refocus later changed the product direction.

---

## 1. Positioning: OpenRouter for cloud agents

### 1.1 What OpenRouter sells

The original argument: **the bill is the product**.

OpenAI-compatible schemas were already a de facto standard before OpenRouter. Its value is one key, one bill, and one prepaid balance without forty vendor contracts, plus routing, failover, and a public leaderboard. It monetizes existing interoperability through a transaction margin.

For “OpenRouter for X” to work, X needs:

1. Multiple vendors with separate bills and cumbersome contracting.
2. Real substitutability so routing/fallback has value.
3. A cold-start benefit: access to something previously unavailable.

### 1.2 Three candidate positions

| | For sandboxes | For harnesses | **For cloud agents** |
|---|---|---|---|
| Separate vendor bills | Yes, thin margins | ❌ Free Apache-2.0 npm packages | ✅ **High prices** |
| Useful routing/substitution | Partly | ❌ Harness changes alter behavior, not merely price | ✅ **Common output: a PR** |
| Resellable API | ✅ | n/a | ⚠️ Mixed, with terms-of-service risk |
| Spending passes through us | Thin compute margin | ❌ | ✅ **Substantial** |
| Main competitive threat | No specific opponent | **Vercel providing it free** | **The vendors themselves** |

**Why the harness layer was rejected:** harness packages are free, unmetered, and behaviorally different, while Vercel's free `HarnessAgent` already supplied one API across nine adapters: claude-code, codex, cursor, cline, fx, grok-build, opencode, pi, and ACP. Taking a percentage of $0 is structurally impossible.

**Why cloud agents appeared viable:** Devin ACUs, Cursor seats, Copilot premium requests, and Codex through ChatGPT plans are separately and expensively billed. Their common contract is the result—repository plus issue in, PR out—rather than the API. That shared output supports routing and best-of-N comparisons.

### 1.3 The proposed structural gap with Vercel

The thesis was that Vercel sells its own compute. A neutral metering layer letting customers run E2B, route to Codex, and call Anthropic directly would conflict with that incentive. Free `HarnessAgent` makes adoption of Vercel Sandbox easier.

This was considered analogous to OpenRouter's position beside OpenAI and a stronger argument than a list of feature differences. It is a strategic hypothesis, not a guarantee about another company's future plans.

### 1.4 Vendors become the primary risk

Model vendors already sell APIs and want volume, enabling OpenRouter resale. Cloud-agent vendors often sell seats. Breaking seats into resold usage can undermine their pricing, giving a $500/user/month vendor a clear reason to prohibit it in its terms.

### 1.5 Therefore v1 uses BYOK

The initial version would not resell usage. Customers connect their own Devin / Cursor / Codex accounts to an orchestration and governance layer:

- Customers retain their own contracts. The original proposal described this as eliminating terms risk and COGS and avoiding a financial-services role; those were business assumptions, not a legal determination.
- We provide one API, best-of-N fan-out, per-user USD caps, kill switches, and unified auditing.
- We collect real outcome/win-rate data from each run.

This gives up the single-bill pitch and transaction margin in exchange for starting the data feedback cycle with less operational exposure.

> The proposed moat is outcome data, not adapters.

Public benchmarks do not answer which cloud agent works on a customer's actual repository. SWE-bench was considered saturated and unrepresentative of real repositories. An intermediary can collect real task outcomes across providers.

If that data becomes the reason customers stay, it creates bargaining power for future resale: vendors would want distribution through the platform. The intended sequence is orchestration first, distribution later; attempting resale first exposes the business to vendor restrictions immediately.

---

## 2. Target customers: B / C / D

Their common requirement is real aggregation.

### B. AI product companies embedding agents for end users

Examples: “build an app” products, Shopify app generators, and internal-tool generators.

| Area | Assessment |
|---|---|
| Pain | Uncapped end-user spending, provider outages becoming product outages, and cost differences directly determining gross margin |
| Need for aggregation | A single provider cannot solve all three problems |
| Priority | Strongest aggregation buyer and principal market |

### C. Engineering organizations with 50–500 people

| Area | Assessment |
|---|---|
| Pain | Four contracts and dashboards without a unified view, uncertain provider quality, and a fast-moving market discouraging lock-in |
| Need for aggregation | Consolidated billing, usage governance, interchangeable providers |
| Priority | Highest contract value but longest sales cycle; unsuitable as the first customer segment |

### D. Best-of-N buyers with high-risk codebases

| Area | Assessment |
|---|---|
| Pain | Send the same task to three vendors and compare PRs |
| Priority | Low volume, high value, strongest demo; useful marketing material rather than the core business model |

Recommended order: **B → C**, with D supplying demonstrations throughout.

### Indie developers and small teams

The original personas—indie developers needing browsers and longer execution than Vercel/Supabase timeouts, and small teams needing permissions plus a Slack bot like Omnara—do not inherently need aggregation. One buys runtime, the other a control plane; either may accept a single-provider product.

That does not invalidate them as acquisition channels. OpenRouter users may arrive because one key is convenient and stay because of aggregation. These personas can attract initial users, but the architecture must support multiple providers from day one so their immediate needs do not permanently shape a single-provider product.

---

## 3. Naming: nimplex

### 3.1 Why abandon loopbox

`loop` + `box` suggests running a loop in a box. Under this positioning, the product routes work to loop operators rather than running the loop itself, making the name misleading. With only one commit, renaming was cheap; the cost would grow each week.

### 3.2 Naming criteria

The audience is B/C: platform teams and engineering leaders, not indie hackers. The name should sound like serious infrastructure and function as a name rather than a description.

`AgentRouter` was rejected as a literal description with no room for interpretation or recognition to develop. Reference names: Supabase, Vercel, Replicate, Turso, Groq—short, modern, coined, and suggestive of purpose.

### 3.3 Collision checks at the time

| Candidate | Result |
|---|---|
| Agentry | ❌ SAP Agentry, the enterprise mobile platform acquired with Syclo |
| Artery | ❌ Akka Artery, JVM remote transport |
| Agora | ❌ Agora.io, real-time audio/video SDK |
| Conductor / Maestro | ❌ Netflix uses both |
| Corso | ⚠️ Alcion Corso, a smaller open-source M365 backup product |
| Dispatch | ⚠️ Netflix Dispatch, incident management |
| Switchgear / Rotta | ✅ No identified collision, but industrial/retro tone |

Refined criterion: an abandoned npm package is not a meaningful collision; an active product is.

### 3.4 Construction

```text
nim + plex
```

- **plex:** from multiplex/plexus, suggesting multiple paths meeting and separating at a central point. Multiplex is familiar to engineers and conveys routing.
- **nim:** from **nimbus**, a meteorological cloud term, suggesting cloud infrastructure without stating it literally.

The naming discussion favored prefixes ending in a vowel or m/l/r because they flow into “pl,” citing com·plex, sim·plex, du·plex, and multi·plex. Candidates such as runplex and arcplex were rejected because they sounded like two joined words; grid/hub prefixes were judged similarly abrupt.

Other central-router roots considered: `xbar` from crossbar switching, and `spin` from the spine layer in spine-leaf networks. `nex` was considered overused by Nexus/Nexo/Nexa.

```text
@nimplex/sdk
$ nimplex run --cap=5.00
```

The command above was a naming illustration, not the current CLI syntax.

---

## 4. Validation before building, in priority order

| # | Question | Why it matters |
|---|---|---|
| 1 | Why did `bespokelabsai/sandbox`, describing itself as “OpenRouter for Sandbox” with eight backends and Apache-2.0 licensing, have only four stars? | If no spending passes through sandbox aggregation, this reframe avoids that problem. If customers do not want neutrality, run-level aggregation may also fail. The same observation supports opposite conclusions |
| 2 | Do cloud-agent terms permit multitenant proxies or resale? | Determines whether v1 must remain BYOK or can resell |
| 3 | Is someone already aggregating cloud agents? | Unverified; do not assume an empty market |

---

## Appendix: technical conclusions from the 2026-08-26 review

- **Do not rewrite loops and sessions in `apps/runtime`.** The proposal favored Vercel `HarnessAgent`, which supplied detach/stop/resume, cross-process `suspendTurn()`, bootstrap snapshots through `onBootstrap` + `bootstrapHash`, permissionMode, toolApproval, Workflow DevKit durability, and useChat streaming.
- **Sandbox integration is open**, not restricted to Vercel. Anyone can implement `HarnessV1SandboxProvider`; official providers include `@ai-sdk/sandbox-vercel` and sandbox-just-bash, with community Cloudflare, Coder, Azure Container Apps, and Apple Container bridges.
- **Three proposed differentiators absent from the reviewed Vercel offering:** per-end-user USD caps; mid-run kill switches (`detach()` is not kill); and per-end-user credential vaults. Vercel supplied the `credentialForwarding` channel rather than a vault. Composio covered SaaS OAuth and was masking raw tokens through `mask_secret_keys_in_connected_account`, while sandboxed `gh`, `psql`, and `terraform` require usable credentials.
