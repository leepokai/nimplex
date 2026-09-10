import type {
  ApiKeyResponse,
  CreateApiKeyResponse,
  MemberResponse,
  ModelProvider,
  OrgResponse,
  OrgRole,
  ProviderKeyResponse,
  PutProviderKeyRequest,
  RunEvent,
  RunFileEntry,
  RunFileListResponse,
  RunResponse,
} from "@nimplex/contracts";
import { type AgentSettings, CloudAgent, streamRunEvents, waitForTerminal } from "./agent.ts";
import { Transport, type TransportOptions } from "./http.ts";

export interface SandboxProviderSummary {
  id: string;
  available: boolean;
  unavailable_reason: string | null;
}

export interface PricedModel {
  provider: ModelProvider;
  model: string;
  input_per_mtok: number;
  output_per_mtok: number;
}

/**
 * Control-plane client: orgs / API keys / members, BYOK provider keys, sandbox providers,
 * the price table, runs (create via agent(), list, kill, resumable event stream).
 */
export class Nimplex {
  readonly transport: Transport;

  constructor(options: TransportOptions = {}) {
    this.transport = new Transport(options);
  }

  /** Build an agent bound to fixed settings; one call = one cloud run. */
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

    /** The plaintext key appears once, in response.key. */
    create: (name: string): Promise<CreateApiKeyResponse> =>
      this.transport.request<CreateApiKeyResponse>("POST", "/v1/api-keys", { body: { name } }),

    /** Revocation is immediate: the next request with this key is a 401. */
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

  readonly providerKeys = {
    list: (): Promise<ProviderKeyResponse[]> =>
      this.transport
        .request<{ provider_keys: ProviderKeyResponse[] }>("GET", "/v1/provider-keys")
        .then((r) => r.provider_keys),

    /** Plaintext only travels in this request; afterwards only last4 is readable. */
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
    /** Price table shared by metering and pre-run estimates. */
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

    /** Mid-run kill: the soft kill lands immediately, the worker destroys the sandbox. */
    kill: (runId: string, reason?: string): Promise<RunResponse> =>
      this.transport.request<RunResponse>("POST", `/v1/runs/${runId}/kill`, { query: { reason } }),

    cancel: (runId: string): Promise<RunResponse> =>
      this.transport.request<RunResponse>("POST", `/v1/runs/${runId}/cancel`),

    /** Tier 0: the run's durable file tree, readable during and after the run. */
    files: (runId: string): Promise<RunFileEntry[]> =>
      this.transport
        .request<RunFileListResponse>("GET", `/v1/runs/${runId}/files`)
        .then((r) => r.files),

    readFile: (runId: string, path: string): Promise<Uint8Array> =>
      this.transport.requestBytes(`/v1/runs/${runId}/file`, { query: { path } }),

    /** Resumable event stream: reconnect from `after`. */
    events: (
      runId: string,
      options: { after?: number; signal?: AbortSignal } = {},
    ): AsyncGenerator<RunEvent> =>
      streamRunEvents(this.transport, runId, options.signal, options.after),

    wait: (runId: string, signal?: AbortSignal): Promise<RunResponse> =>
      waitForTerminal(this.transport, runId, signal),
  };
}
