import type {
  ApiKeyResponse,
  CreateApiKeyResponse,
  HarnessManifest,
  McpServerRequestInput,
  McpServerResponse,
  MemberResponse,
  ModelProvider,
  OrgResponse,
  OrgRole,
  ProviderKeyResponse,
  PutProviderKeyRequest,
  RunEvent,
  RunResponse,
  SkillManifestInput,
  SkillResponse,
  UsageGroupBy,
  UsageResponse,
} from "@nimplex/contracts";
import { harnessManifest, mcpServerRequest, skillManifest } from "@nimplex/contracts";
import { type AgentSettings, CloudAgent, streamRunEvents, waitForTerminal } from "./agent.ts";
import { Transport, type TransportOptions } from "./http.ts";

export interface HarnessSummary extends HarnessManifest {
  id: string;
  builtin: boolean;
  created_at: string;
}

export interface SandboxProviderSummary {
  id: string;
  available: boolean;
  unavailable_reason: string | null;
}

export interface UsageSummaryOptions {
  /** 窗口起點；預設 to 往前 30 天 */
  from?: Date | string;
  /** 窗口終點；預設現在 */
  to?: Date | string;
  /** 分桶維度；預設 day */
  groupBy?: UsageGroupBy;
  /** IANA 時區，只影響 day 分桶的切點；預設 UTC */
  tz?: string;
}

export interface PricedModel {
  provider: ModelProvider;
  model: string;
  input_per_mtok: number;
  output_per_mtok: number;
}

/**
 * 控制面客戶端。三個插槽各有一組操作：
 *   client.harness        插槽 2 —— 列出／上傳／刪除 harness
 *   client.providerKeys   插槽 1 —— 自己的 LLM token（BYOK）
 *   client.sandbox        插槽 3 —— 有哪些 sandbox provider 可用
 * 加上 client.runs、client.usage（帳務 rollup）、client.skills / client.mcpServers（工具 registry）
 * 與 client.agent()。
 */
export class Nimplex {
  readonly transport: Transport;

  constructor(options: TransportOptions = {}) {
    this.transport = new Transport(options);
  }

  /** 建一個綁定設定的 agent；一次呼叫＝在雲端跑一次 harness。 */
  agent(settings: AgentSettings): CloudAgent {
    return new CloudAgent(this.transport, settings);
  }

  readonly orgs = {
    list: (): Promise<OrgResponse[]> =>
      this.transport.request<{ orgs: OrgResponse[] }>("GET", "/v1/orgs").then((r) => r.orgs),

    create: (name: string): Promise<OrgResponse> =>
      this.transport.request<OrgResponse>("POST", "/v1/orgs", { body: { name } }),
  };

  readonly apiKeys = {
    list: (): Promise<ApiKeyResponse[]> =>
      this.transport
        .request<{ api_keys: ApiKeyResponse[] }>("GET", "/v1/api-keys")
        .then((r) => r.api_keys),

    /** 明文 key 只在回應出現一次（response.key）——存好再丟。 */
    create: (name: string): Promise<CreateApiKeyResponse> =>
      this.transport.request<CreateApiKeyResponse>("POST", "/v1/api-keys", { body: { name } }),

    /** 撤銷立即生效：這把 key 的下一個請求就是 401。 */
    revoke: (id: string): Promise<void> =>
      this.transport.request<void>("DELETE", `/v1/api-keys/${id}`),
  };

  readonly members = {
    list: (): Promise<MemberResponse[]> =>
      this.transport
        .request<{ members: MemberResponse[] }>("GET", "/v1/members")
        .then((r) => r.members),

    add: (email: string, role: OrgRole = "member"): Promise<MemberResponse> =>
      this.transport.request<MemberResponse>("POST", "/v1/members", { body: { email, role } }),

    setRole: (id: string, role: OrgRole): Promise<MemberResponse> =>
      this.transport.request<MemberResponse>("PATCH", `/v1/members/${id}`, { body: { role } }),

    remove: (id: string): Promise<void> =>
      this.transport.request<void>("DELETE", `/v1/members/${id}`),
  };

  readonly harness = {
    list: (): Promise<HarnessSummary[]> =>
      this.transport
        .request<{ harnesses: HarnessSummary[] }>("GET", "/v1/harnesses")
        .then((r) => r.harnesses),

    get: (slug: string): Promise<HarnessSummary> =>
      this.transport.request<HarnessSummary>("GET", `/v1/harnesses/${slug}`),

    /**
     * 上傳自己的 harness。送出前先在本地驗一次 manifest，
     * 讓打錯字在呼叫端就爆掉，而不是等網路來回（驗證錯誤一律是 rejection，不會同步 throw）。
     */
    upload: async (manifest: HarnessManifest): Promise<HarnessSummary> => {
      const parsed = harnessManifest.parse(manifest);
      return this.transport.request<HarnessSummary>("PUT", `/v1/harnesses/${parsed.slug}`, {
        body: parsed,
      });
    },

    delete: (slug: string): Promise<void> =>
      this.transport.request<void>("DELETE", `/v1/harnesses/${slug}`),
  };

  readonly providerKeys = {
    list: (): Promise<ProviderKeyResponse[]> =>
      this.transport
        .request<{ provider_keys: ProviderKeyResponse[] }>("GET", "/v1/provider-keys")
        .then((r) => r.provider_keys),

    /** 明文只在這一次請求裡出現，之後只讀得到 last4。 */
    put: (request: PutProviderKeyRequest): Promise<ProviderKeyResponse> =>
      this.transport.request<ProviderKeyResponse>("PUT", "/v1/provider-keys", { body: request }),

    delete: (id: string): Promise<void> =>
      this.transport.request<void>("DELETE", `/v1/provider-keys/${id}`),
  };

  readonly sandbox = {
    listProviders: (): Promise<SandboxProviderSummary[]> =>
      this.transport
        .request<{ providers: SandboxProviderSummary[] }>("GET", "/v1/sandbox-providers")
        .then((r) => r.providers),
  };

  readonly models = {
    /** 價格表：計量與跑前試算共用同一份資料。 */
    list: (): Promise<PricedModel[]> =>
      this.transport.request<{ models: PricedModel[] }>("GET", "/v1/models").then((r) => r.models),
  };

  readonly runs = {
    list: (options: { externalUserId?: string; limit?: number } = {}): Promise<RunResponse[]> =>
      this.transport
        .request<{ runs: RunResponse[] }>("GET", "/v1/runs", {
          query: {
            external_user_id: options.externalUserId,
            limit: options.limit === undefined ? undefined : String(options.limit),
          },
        })
        .then((r) => r.runs),

    get: (runId: string): Promise<RunResponse> =>
      this.transport.request<RunResponse>("GET", `/v1/runs/${runId}`),

    /** 跑到一半也砍得掉：軟殺立即生效，沙箱由 worker 銷毀。 */
    kill: (runId: string, reason?: string): Promise<RunResponse> =>
      this.transport.request<RunResponse>("POST", `/v1/runs/${runId}/kill`, { query: { reason } }),

    cancel: (runId: string): Promise<RunResponse> =>
      this.transport.request<RunResponse>("POST", `/v1/runs/${runId}/cancel`),

    /** 可續傳的事件流：斷線後從 after 之後接回來。 */
    events: (
      runId: string,
      options: { after?: number; signal?: AbortSignal } = {},
    ): AsyncGenerator<RunEvent> =>
      streamRunEvents(this.transport, runId, options.signal, options.after),

    wait: (runId: string, signal?: AbortSignal): Promise<RunResponse> =>
      waitForTerminal(this.transport, runId, signal),
  };

  readonly usage = {
    /**
     * 帳務 rollup：窗口內的總花費與分桶（day / harness / external_user_id / model）。
     * 「今日」「本月」的邊界由呼叫端用自己的時區算好帶進 from；tz 只影響 day 分桶的切點。
     */
    summary: (options: UsageSummaryOptions = {}): Promise<UsageResponse> =>
      this.transport.request<UsageResponse>("GET", "/v1/usage", {
        query: {
          from: toIso(options.from),
          to: toIso(options.to),
          group_by: options.groupBy,
          tz: options.tz,
        },
      }),
  };

  readonly skills = {
    list: (): Promise<SkillResponse[]> =>
      this.transport
        .request<{ skills: SkillResponse[] }>("GET", "/v1/skills")
        .then((r) => r.skills),

    get: (slug: string): Promise<SkillResponse> =>
      this.transport.request<SkillResponse>("GET", `/v1/skills/${slug}`),

    /** 上傳／覆寫（同 slug 冪等）。送出前先本地驗一次，缺 SKILL.md 這種錯在呼叫端就爆。 */
    upload: async (manifest: SkillManifestInput): Promise<SkillResponse> => {
      const parsed = skillManifest.parse(manifest);
      return this.transport.request<SkillResponse>("PUT", `/v1/skills/${parsed.slug}`, {
        body: parsed,
      });
    },

    delete: (slug: string): Promise<void> =>
      this.transport.request<void>("DELETE", `/v1/skills/${slug}`),
  };

  readonly mcpServers = {
    list: (): Promise<McpServerResponse[]> =>
      this.transport
        .request<{ mcp_servers: McpServerResponse[] }>("GET", "/v1/mcp-servers")
        .then((r) => r.mcp_servers),

    get: (slug: string): Promise<McpServerResponse> =>
      this.transport.request<McpServerResponse>("GET", `/v1/mcp-servers/${slug}`),

    /** 註冊／覆寫。auth 只收 broker 引用（nango:conn_abc 這種），明文 token 在本地就被擋下。 */
    put: async (request: McpServerRequestInput): Promise<McpServerResponse> => {
      const parsed = mcpServerRequest.parse(request);
      return this.transport.request<McpServerResponse>("PUT", `/v1/mcp-servers/${parsed.slug}`, {
        body: parsed,
      });
    },

    delete: (slug: string): Promise<void> =>
      this.transport.request<void>("DELETE", `/v1/mcp-servers/${slug}`),
  };
}

function toIso(value: Date | string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value instanceof Date ? value.toISOString() : value;
}
