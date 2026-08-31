import type {
  HarnessManifest,
  ModelProvider,
  ProviderKeyResponse,
  PutProviderKeyRequest,
  RunEvent,
  RunResponse,
} from "@nimplex/contracts";
import { harnessManifest } from "@nimplex/contracts";
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
 * 加上 client.runs 與 client.agent()。
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

  readonly harness = {
    list: (): Promise<HarnessSummary[]> =>
      this.transport
        .request<{ harnesses: HarnessSummary[] }>("GET", "/v1/harnesses")
        .then((r) => r.harnesses),

    get: (slug: string): Promise<HarnessSummary> =>
      this.transport.request<HarnessSummary>("GET", `/v1/harnesses/${slug}`),

    /**
     * 上傳自己的 harness。送出前先在本地驗一次 manifest，
     * 讓打錯字在呼叫端就爆掉，而不是等網路來回。
     */
    upload: (manifest: HarnessManifest): Promise<HarnessSummary> => {
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
}
