# Harness as a Service: vision, critique, and MVP positioning (2026-08-18)

**Purpose:** precursor to the full nimplex HaaS specification, preserving the original vision, integrating prior criticism, filling competitor gaps, refining personas, and narrowing the MVP.
**Prerequisites:** `~/mycode/claude-daily-tasks/personal/product/harness-as-a-service.md`, `research/harness-as-a-service-report-2026-08-14.md`, `research/harness-as-a-service-critique-2026-08-17.md`, `research/haas-round2-competitors-persona-2026-08-17.md`, and `nimplex/docs/competitor-analyze/*`.
**New research**, archived under `docs/competitor-analyze/haas-api/`: research-firstparty-runtimes.md (AWS/Google/Azure/Cloudflare), research-startup-oss-layer.md (Omnara/LangGraph/Letta/Runloop/Blaxel), research-glue-layer.md (Arcade/Nango/metering/security), research-persona-subsegments.md (named evidence for five P3 segments).
**Status at the time:** analysis complete; user selection pending in §6, followed by the evening refinement in §8. This historical record preserves the research's dated claims and assumptions; it is not current market, pricing, or legal guidance. Later decisions supersede it.

---

## 1. Original vision, recorded from the user's 2026-08-18 description

> Build Harness as a Service: a cloud platform where users deploy their chosen harness—Claude Code, OpenCode, or a customized Deep Harness with many extensions. We host the backend so users integrate agents directly into their Web/App like Cloud Managed Agents. The analogy is Vercel, with support for different agents instead of one harness.

Planned capabilities:

1. Connections and OAuth 2.0 so agents can use different toolchains.
2. User-deployed custom harnesses, including modified Deep Harnesses and extensions.
3. Monitoring/management to compare harness benchmarks and results.
4. Sandboxes and computer use as the execution foundation.
5. An API other agent systems can invoke for complete computer-use capabilities, offering more directly usable cloud-agent infrastructure than Replicas or Capy.

Original persona: Web/App developers adding a capable agent with strong context management, plus people building cloud agents. Original business preference: open source.

---

## 2. Conclusions inherited from prior research

The 08-14 and two 08-17 memos and existing competitor documents treated the following as established premises, rather than reopening them here.

### 2.1 The original form had already failed validation

- **A similar company had closed:** Bloop AI / Vibe Kanban supported 11 harnesses, cloud and self-hosting, investor funding, and $30 seats, then closed in April 2026. Its founder attributed the failure to overwhelmingly free usage and an unattractive business model.
- **Price-band hypothesis:** Replicas survived at $120–300/seat while Vibe Kanban failed at $30. The research interpreted sub-$100 multi-harness orchestration as a weak market; environment controls, triggers, and enterprise compliance drove surviving businesses, not harness count.
- **At least eight occupants, four free/open-source:** Replicas, Warp Oz, Coder, GitLab Duo, Databricks' Omnigent, Omnara, agentrove, and Mozilla's Otari. All fourteen originally planned features already existed somewhere (round-two memo §4).

### 2.2 Assessment of six vision components

| # | Component | Assessment | Basis |
|---|---|---|---|
| 1 | “Like Vercel” | Rejected analogy | Vercel owns its framework/distribution through Next.js; we would host competitors' harnesses whose owners can launch clouds, as Managed Agents, Warp Oz, and OpenAI's acquisition of Ona illustrated. Harnesses change tools, permissions, prompts, and costs rather than substituting cleanly; breadth creates an N×M×K support burden |
| 2 | Build OAuth/connections | Do not build | Security is a specialist business: Arcade raised $60M with security investors, while the research recorded Composio's May 2026 key leak. Integrate Arcade/Nango and inject secrets at a firewall boundary outside sandboxes |
| 3 | User-supplied custom harnesses | Possible gap, unvalidated demand | Pi's 2,000+ extensions were among few supply examples, with a market estimated in the hundreds. Arbitrary customer code implies multitenant untrusted-code hosting priced by Modal/E2B/Daytona economics |
| 4 | Monitoring/benchmarks | Strong evidence, weak standalone product | Same-model results differed by 16 percentage points across harnesses, including an arXiv paper. But htek provided broader free rankings, Warp Oz built them in, and observability was commoditized, with 89% organizational adoption in the cited research. Use as trust and acquisition content |
| 5 | Sandbox + computer use for monitoring | Buy sandbox infrastructure; reject CUA as monitoring | OSWorld 2.0 long-horizon Opus 4.8 binary accuracy was cited as 20.6%, with long latency and unstable reruns. Logs/traces/cost/steering have deterministic ACP/OTel/serve interfaces. Computer use belongs in browser tasks or customer E2E verification |
| 6 | General Web/App developer persona P1 | Removed | Typical end users have no repository; embedding a coding harness pays for repository scanning and bash loops to deliver chat. Free eve/Mastra/Cloudflare frameworks suffice; no payment evidence was found |

### 2.3 Compliance and economic constraints inherited from the research

- The research rejected third-party Claude Code hosting through subscription OAuth, citing proprietary binaries, February 2026 restrictions, and March/April enforcement against OpenClaw/OpenCode. It favored Apache/MIT harnesses—Codex CLI, OpenCode, Cline, Goose, Pi—and customer-owned API keys brokered outside the sandbox. The actual permitted integration still required the sales/legal verification in §7.
- **BYOK implies zero token margin.** Revenue must come from compute markup and platform fees. The cited AI gross-margin benchmark was 50–60%, versus SaaS at 80–90%.
- **Idle cost matters:** coding sessions last 10–40 minutes, mostly waiting for models. Wall-clock billing is unattractive; active-CPU billing leaves idle costs with the platform. Do not build hosted delivery unless modeled gross margin reaches 40%.

### 2.4 Selected persona P3

**P3: product teams shipping agents that must act for each end user**, typically B2B/vertical SaaS with 10–200 employees, a working demo, and an upcoming paid launch.

Four barriers between demo and production:

1. **W1:** isolate each user's OAuth tokens and ensure the agent uses only that user's authority.
2. **W2:** prevent a user from spending $400; provide user-level caps, attribution, and rebilling.
3. **W3:** constrain malicious instructions in user data from leaking another user's token.
4. **W4:** resume sessions after process or machine failures.

Pricing comes from product COGS rather than internal-tool budgets, suggesting end-user/execution-minute pricing instead of a $120/seat contest. Multiple harnesses become third-priority insurance against provider lock-in, not the main pitch.

First qualification question: “Must your agent read/write each end user's own third-party accounts, repositories, or browser sessions on their behalf?” Reject “no” answers.

### 2.5 Direction selected during the 2026-08-18 session

- **Direction:** expose P3 as an agent execution API, centered on per-end-user isolation, metering, quotas, and auditing from one agent to 10,000. Harness pluggability becomes insurance.
- **Core scenario:** a general task runtime. Customers define work through arbitrary harnesses/loops and tools; the platform supplies sandbox execution, firewall credential injection, metering/quotas, and audit.

### 2.6 Capy: capy.ai, previously mistyped caby.ai

Capy followed Scrapybara Inc.'s pivot (YC F24, roughly $4.1M seed). It offered a proprietary Captain/Build/Review harness, one Ubuntu VM per task (claimed 32 vCPU/128 GB and sub-second startup), native computer/browser use with annotated video evidence, and $20–2,000 monthly credit tiers. It supported customer ChatGPT/Copilot subscriptions but excluded Claude subscriptions; BYOK was Enterprise-only in the reviewed offering.

Two relevant observations:

1. Scrapybara's predecessor API for virtual desktops for AI agents closed in October 2025—the research's only direct, negative evidence for standalone computer-use APIs.
2. Visible customers were solo founders/indies, supported by X/Instagram launches and a Solo Founders program rather than attributable enterprise testimonials; the apparent market was prosumer despite enterprise presentation.

### 2.7 Reusable technical components

- **In-sandbox control plane:** Apache-2.0 `rivet-dev/sandbox-agent` unified Claude Code/Codex/OpenCode/Cursor/Amp/Pi behind HTTP+SSE, close to our needs. Alternatives: coder/agentapi and SWE-ReX.
- **Sandboxes:** self-hostable Apache-2.0 E2B infra, Modal, active-CPU Vercel Sandbox, and Cloudflare Sandbox SDK. Morph's claimed sub-250 ms N-way copy-on-write branch was the snapshot reference.
- **Original OSS gap:** no reviewed project combined VM sandboxes with warm pools and snapshot versions, customer-selected agent CLIs, and an event/cron loop engine.

---

## 3. Expanded competitor map, 2026-08-18

Full reports are under `docs/competitor-analyze/haas-api/`; this section records their decision-relevant findings.

### 3.1 First-party runtimes: validated category, incomplete combination

| | AWS AgentCore | Google Agent Runtime | Azure Foundry | Cloudflare |
|---|---|---|---|---|
| W1 per-user OAuth | ◕ Token vault/3LO GA; SDK path puts tokens in sandbox | ◑ Strong concept, Preview | ◑ Entra OBO; SaaS customers may be outside tenant | ○ |
| W2 caps/metering/resale | ◑ Per-JWT-sub RPS/TPM rather than USD; DIY resale | ○ | ◔ | ◑ AI Gateway per-user USD limits, beta and LLM-only |
| W3 blast radius | ● MicroVM and gateway Guardrails | ◑ | ◔ Mostly detection | ◑ Strong primitives, DIY composition |
| W4 durability | ◕ | ◕ | ● | ◕ |
| Harness choice | ● Official Claude Code/Codex/OpenCode/Cursor and managed Harness GA | ○ Antigravity only | ◑ | ◑ |
| BYO model keys | ● | ○ | ○ Unsupported | ● |

AgentCore had occupied Harness, Identity token vault, Policy, Payments, and Registry within twelve months, with a cited average of roughly two months from preview to GA. It delivered the original multi-harness/BYOK vision, but with AWS/IAM/Cognito dependence, no per-user USD caps or resellable accounting, and sandbox-free secrets only as an optional path.

Three shared gaps identified:

1. Per-end-user **USD hard caps plus resellable usage accounting**; Cloudflare was closest but beta and LLM-only.
2. Secrets injected exclusively at the firewall as the default architecture.
3. Cross-cloud neutrality combined with managed multiple coding harnesses; AWS supplied the latter without the former.

### 3.2 Startup/OSS: fragmented, not empty

- **Omnara:** YC S25, four people, Apache-2.0; close architecture with a control-plane loop, durable event log, BYO keys/machines. Identity stopped at org/project/member without end_user; secrets entered execution environments as variables.
- **Runloop Agent Gateway:** opaque sandbox tokens, external credential proxy, and egress allowlists matched W1/W3 mechanisms, but only at organization scope.
- **Specialists:** Agentic Fabriq (YC W26, “Okta for agents”) for W1, Nevermined/Paid.ai for W2, Temporal/Inngest for commoditized W4, and E2B/Daytona/Blaxel for W3 compute.
- **Finding:** no reviewed single API combined end-user identity, brokered secrets outside sandboxes, USD caps, and resumable sessions around pluggable harnesses. Omnara or Runloop could plausibly add end-user identity within one roadmap quarter.

### 3.3 Glue-layer maturity

| Barrier | Available components | Integration burden |
|---|---|---|
| W1 credential isolation | Mature Arcade/Nango/Auth0 Token Vault/Scalekit | Medium, days to weeks; hosted vaults concentrate risk, illustrated by cited Drift/Composio/Vercel Connect incidents |
| W2 metering/quotas/billing | Components only: OpenMeter entitlements, LiteLLM budgets, Stripe-Metronome; custom attribution | Highest burden; least agent-native drop-in support |
| W3 blast radius | Established open-source patterns: Infisical Agent Vault, Pipelock, eve firewall injection | Medium/high; per-user boundaries still need composition |
| W4 durability | Commoditized | Low; often bundled free with frameworks |

The strongest counterargument: frameworks make integration thinner. Vercel eve already bundled durable sessions, per-agent sandboxes, secret brokerage, and approvals. W2 alone might be a feature-sized gap rather than a platform.

Build-it-yourself evidence: Browser Use built per-session microVMs and a credential-free control plane, acknowledging three services and an extra hop per operation; Braintrust published a per-user cost-cap playbook; TrueFoundry described teams adding rate limits after one unexpected bill and budgets after the second. The IETF had draft-oauth-ai-agents-on-behalf-of-user.

### 3.4 Exact gap and threats

Proposed gap: one API binding end-user identity, brokered credentials kept outside sandboxes, USD caps, resumable sessions, and audit logs around a pluggable harness/loop, with cross-cloud neutrality, self-hostable OSS, and rebillable end-user usage.

Threats, ordered by urgency:

1. AgentCore's quarterly pace closes the window.
2. Omnara/Runloop add an end_user object.
3. Managed Agents at the cited $0.08/session-hour commoditizes W3/W4.
4. Frameworks reduce the value of integrated glue.
5. Concentrated credential hosting creates potentially fatal security exposure for a small company.

---

## 4. Refining “Web/App builders serving their customers”

### 4.1 Separate two personas

| | How the agent serves customers | Assessment |
|---|---|---|
| **P1** | Smart assistant reads the product's DB, answers questions, creates content using product-owned authority | Removed: free frameworks suffice; no payment evidence |
| **P3** | Acts for each customer using their own accounts, isolated code execution, and browser sessions | Four real barriers; paid from product COGS |

Qualification remains whether the agent must access each end user's **own** third-party accounts/repositories/browser sessions.

### 4.2 Five P3 subsegments

| Segment | Definition | Named examples | Main barriers | Observed purchasing | Beachhead assessment |
|---|---|---|---|---|---|
| **E: coding-agent-as-feature** | Sell coding agents to product users | CodeRabbit, Codegen, Sentry Seer, Factory, Tembo, Charlie Labs, cubic | All four; cited CodeRabbit RCE exposed writes to one million repositories, and Replit deleted SaaStr's production DB | Northflank for Sentry/Writer, Daytona for Trajectory's 4,000 monthly sandboxes, E2B | Best fit: sandboxed harness, user GitHub token, cap, resume; developer buyers fit OSS distribution |
| **C: vertical SaaS adding agents** | Connect each user's Gmail/Slack/CRM/QuickBooks | Motion, Athena Intelligence, Copy.ai, tl;dv, Credal, Plain, Vapi | W1/W2 | Nango from $500/month, Paragon ActionKit across 100+ SaaS products; largest segment | Expansion market, specifically the code/browser-execution subset; pure API calls do not need runtime |
| **A: agent-native B2B SaaS** | The agent is the product acting for customers | 11x, Artisan, Decagon, Sierra, Intercom Fin, Truewind | W1/W3/W2 | 11x's LangGraph/LangSmith stack, Nango | Possible design partners; leaders build internally and acquisition is expensive |
| **B: app builders** | Executable project per end user | Lovable, Bolt, v0, Replit, Manus, Gumloop | W3/W2 | Lovable/Modal reportedly ran one million sandboxes over a weekend with 20,000 concurrent | Evidence that the market pays at scale, not a first target already well served by E2B/Modal |
| **D: consumer computer-use assistants** | Operate websites for consumers | Manus, Genspark, Lindy, Benny | W1/W3 | Browserbase's reported 50M sessions/$300M valuation, Anchor, Kernel | Not recommended: few customers and browser vendors already cover credentials |

### 4.3 Beachhead

Start **E → C**, targeting teams the size of Tembo/Charlie/cubic. Use the CodeRabbit/Replit incidents to explain the problem. Expand when vertical SaaS agents begin executing code or browsers. Use B as market evidence, recruit one or two A design partners, and skip D.

### 4.4 Ten-company interview list

Gumloop, Athena Intelligence, Lindy, Aomni, Truewind, Parcha, Benny, one of Tembo/Charlie Labs/cubic, Sintra.ai, and Open-Inspect.

First ask whether agents act through each user's own accounts/repos. Then ask who currently implements token isolation, cost caps, and injection containment, and how many person-months that took.

### 4.5 Counterevidence to test directly

- Composition works: 11x successfully rebuilt on LangGraph; Lovable reported no pages during its Modal weekend. Unified value must come from the intersection—knowing which token and budget belong to a sandbox—not merely another abstraction.
- Winners build internally at scale: Vercel Hive, Replit, and Codegen built their sandbox layers.
- Many vertical SaaS agents only call APIs. The fraction requiring per-user sandboxed execution remains an interview question.

---

## 5. Five questions the MVP must answer

**1. Why not E2B + Nango + LiteLLM?** A defensible answer requires a shared control plane: USD enforcement must govern both model proxy and sandbox lifetime, injection boundaries must know user/token ownership, and audits must connect credentials, spending, and actions. If customers do not value that intersection, the thesis fails.

**2. Why exist beside AgentCore?** Ten-minute onboarding without IAM/Cognito setup, cross-cloud neutrality, per-user USD caps and rebillable accounting, sandbox-free secrets by default, and self-hostable OSS. These may matter to 10–200-person non-AWS-centric teams, but the window narrows quarterly.

**3. Will people buy runtime as frameworks improve?** The proposed defense is framework-independent enforcement: customers keep eve/LangGraph loops and gain the four barriers through our runtime. The reviewed eve spending governance depended on Vercel and lacked per-user resale accounting/multiple harnesses. Interviews must establish willingness to pay for enforcement separately.

**4. What if Omnara/Runloop add end_user next quarter?** Avoid a feature race. Potential defenses are a data model built around users from day one, early OSS distribution in E, and deep, sticky billing exports. Without those, this becomes a speed contest.

**5. Do economics and permitted use work?**

- BYOK yields zero token margin; charge compute markup plus per-run or per-active-user platform fees.
- Obtain active-CPU supplier quotes before building; model a 40-minute session with eight active CPU minutes. Hosted requires at least 40% gross margin.
- Prefer Apache/MIT harnesses. The proposal constrained Claude to customer API keys with external injection and avoided a “Claude Code hosting” claim, pending confirmation.
- Do not build an OAuth token vault. Broker W1 to Nango/Arcade or the customer's vault; inject rather than custody those tokens, reducing concentrated exposure illustrated by Composio/Drift.

---

## 6. MVP options pending selection

### A, recommended: Per-End-User Agent Run API

One API packages the intersection for segment E:

```text
POST /v1/runs
{
  "end_user": "usr_123",                         // First-class identity
  "harness": "codex-cli | opencode | custom-container",
  "task": {"repo": "...", "prompt": "..."},
  "credentials": ["nango:conn_abc"],              // Broker references; secrets stay outside sandbox
  "budget_usd": 2.50,                            // Proposed combined LLM + compute cap
  "model_key_ref": "byok:anthropic"
}
→ SSE events, audit log, rebillable per-user usage export
```

- **In v1:** complete W2, default W3 sandbox/egress/firewall injection, one or two Codex/OpenCode harnesses through rivet sandbox-agent, BYOK, audit.
- **Excluded:** custom OAuth (integrate Nango), sophisticated W4 resume (coarse snapshots first), computer use, custom uploads, benchmark monitoring, marketplace.
- **Delivery:** Apache-2.0 self-hostable control plane plus hosted active-CPU compute and platform fees.
- **Rationale:** enforcement needs the execution path; a gateway alone is insufficient. E matches the design and preserves nimplex's sandbox/loop expertise.
- **Risk:** still two to three months to a solo-founder demo; do not accelerate before interview and margin gates pass.

### B: Agent Spend Gateway only

Aggregate an LLM proxy and sandbox billing for per-user USD limits, attribution, and resale exports without running execution.

- Advantage: four to eight weeks to launch, targeting the least mature barrier.
- Disadvantages: cannot kill another platform's sandbox, may be only feature-sized, competes directly with Cloudflare limits/Stripe-Metronome, and abandons sandbox engineering assets.

### C: OSS four-barrier runtime first, no hosted service

Ship A's control plane through Docker Compose, grow segment E and GitHub distribution, and consider hosting after over a thousand self-hosters.

- Advantages: lowest founder operating cost, distribution first, avoids initial hosting economics/compliance burden.
- Disadvantages: enterprises may self-host without paying, cited cloud conversion is only 2–5%, and Omnara already occupies open-source agent-API positioning.

Recommendation: **A's architecture, C's rollout order**. Open-source the smallest intersection—one harness, USD cap, secret proxy, audit—then use interviews and adoption to decide hosting. Treat B as A's first paid module, not a separate product.

---

## 7. Validation gates before building

1. **Qualification interviews this week:** ask the ten prospects whether they act for users and can quantify implementation cost. At least four must qualify and describe that cost, otherwise revisit the thesis.
2. **Intersection test during interviews:** would they prefer buying caps, credential isolation, and auditing separately? Establish whether shared enforcement matters.
3. **Margin model:** obtain E2B/Cloudflare active-CPU quotes for 40-minute sessions/eight active minutes. Below 40% means OSS-only option C.
4. **One legal-boundary inquiry:** ask Anthropic sales about customer API keys, external injection, and hosted execution; use the answer to define supported harnesses.
5. **Defer the crown test:** multiple harnesses are insurance, so comparison determines whether v1 needs one or two, not whether the whole product survives.

---

## 8. Evening refinement: Agent Computer as a Service

### 8.1 User refinement

> Focus on one precise need: people want a complete, capable sandbox for their agents. It is like Vercel eve with a choice of harnesses.

### 8.2 Product definition replacing the run-centric expression

Make the **sandbox—an agent's computer—the first-class object**. A customer's agent, using any framework, obtains a ready computer through one MCP connection or API call. The four barriers become default properties of that computer.

```text
POST /v1/sandboxes                 // Or the nimplex_computer MCP tools
{
  "end_user": "usr_123",          // W1/W3 identity boundary
  "budget_usd": 2.50,             // W2 cap and sandbox kill
  "credentials": ["nango:conn_abc"], // W1 external secret injection
  "harness": "opencode | codex-cli | none", // none: customer supplies the agent loop
  "snapshot_from": "snap_xyz"     // W4 state as a resource
}
→ MCP: bash / files / git / browser(a11y tree) / harness.prompt / snapshot
→ SSE, audit log, per-user usage export
```

The user selected all four v1 capability groups:

1. **Code workspace:** bash/files/git/dependency installation and repository cloning.
2. **Browser with accessibility tree:** headless Chrome and structured state, following Replicas browser-state.
3. **Preinstalled ACP harnesses:** supervisor drives Codex CLI/OpenCode over stdio ACP; `harness: none` lets the customer's agent supply the loop.
4. **Desktop GUI/computer use:** explicitly requested despite the analysis's concern about Scrapybara's closure and OSWorld reliability. Recommended internal sequencing: code/browser/harness first, desktop later behind a beta flag, removable without affecting the other three.

The user selected **MCP first** for one-line framework adoption and ecosystem distribution, with REST and TS/Python SDK underneath. MCP remains an adapter over that API.

### 8.3 Assessing “eve with interchangeable harnesses”

The prior research still judged this weak: eight or more competitors, four free implementations, little evidence harness breadth drives payment, and eve monetizes the metered execution foundation. The defensible comparison changes axes:

- eve/LangGraph serve engineers writing their own loops.
- nimplex provides a computer with a ready Codex/OpenCode-class harness for teams that do not want to build the loop.
- Follow eve's economics: free OSS framework/control plane, paid metered hosted compute and platform fees. nimplex's foundation is sandbox infrastructure rather than harness resale.
- Say **“your agent's computer”**, not “eve alternative,” to avoid comparison with a free library alone.

### 8.4 Competitor distinction in the research

E2B/Daytona supplied VMs without the proposed combined harness/user/USD layers; Browserbase focused on browsers; AgentCore supplied more of the stack with AWS/IAM dependence and incomplete per-user USD/default secret isolation; eve required customer loops and Vercel integration. Scrapybara's closure argued against desktop-only APIs. The proposed position was an open-source, cross-cloud, harness-ready agent computer with the four barriers enabled by default and one-line MCP access.

### 8.5 Validation changes

- Replace the second interview question with: “What gives your agent its hands today? If you use E2B, which browser, harness, secret injection, and cost controls did you build, and how many person-months did that take?” Test willingness to pay for a prepared computer over a bare VM.
- Keep the active-CPU/40% margin gate; separately model desktop streaming, the most expensive source of idle cost among the four groups.

---

## Research archive

- `docs/competitor-analyze/haas-api/research-firstparty-runtimes.md`: AWS/Google/Azure/Cloudflare.
- `docs/competitor-analyze/haas-api/research-startup-oss-layer.md`: Omnara/LangGraph/Letta/Runloop/Blaxel/E2B/Daytona and 2026 entrants.
- `docs/competitor-analyze/haas-api/research-glue-layer.md`: Arcade/Nango/Composio/metering/security and customer evidence.
- `docs/competitor-analyze/haas-api/research-persona-subsegments.md`: five P3 segments and interview targets.
