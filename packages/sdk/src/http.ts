export class NimplexError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "NimplexError";
  }
}

export interface TransportOptions {
  /** nimplex 控制面位址，預設讀 NIMPLEX_BASE_URL */
  baseUrl?: string;
  /** org 層 API key，預設讀 NIMPLEX_API_KEY */
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
  headers?: Record<string, string>;
}

/**
 * 只做一件事：把 HTTP 細節收在一個地方。
 * Console 與 SDK 走的是同一組公開 endpoint（沒有 /internal），
 * 所以這個 transport 能做的事，就是使用者能做的事的全集。
 */
export class Transport {
  readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly extraHeaders: Record<string, string>;

  constructor(options: TransportOptions = {}) {
    this.baseUrl = (
      options.baseUrl ??
      globalThis.process?.env?.NIMPLEX_BASE_URL ??
      "http://localhost:8787"
    ).replace(/\/+$/, "");
    this.apiKey = options.apiKey ?? globalThis.process?.env?.NIMPLEX_API_KEY;
    // 瀏覽器裡的 fetch 必須以 window 當 receiver，直接存成欄位再呼叫會 Illegal invocation
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.extraHeaders = options.headers ?? {};
  }

  headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      ...this.extraHeaders,
      ...extra,
    };
  }

  async request<T>(
    method: string,
    path: string,
    options: {
      body?: unknown;
      signal?: AbortSignal;
      query?: Record<string, string | undefined>;
    } = {},
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
    const response = await this.fetchImpl(url, {
      method,
      headers: this.headers(
        options.body === undefined ? {} : { "content-type": "application/json" },
      ),
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    const parsed: unknown = text ? safeJson(text) : null;
    if (!response.ok) throw toError(response.status, parsed, text);
    return parsed as T;
  }

  /** GET returning raw bytes (workspace files). Errors are parsed like `request`. */
  async requestBytes(
    path: string,
    options: { query?: Record<string, string | undefined>; signal?: AbortSignal } = {},
  ): Promise<Uint8Array> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
    const response = await this.fetchImpl(url, {
      method: "GET",
      headers: this.headers(),
      signal: options.signal,
    });
    if (!response.ok) {
      const text = await response.text();
      throw toError(response.status, text ? safeJson(text) : null, text);
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  /**
   * SSE：用 fetch 讀串流。伺服器乾淨關閉＝事件流結束；
   * 中途斷線（網路錯誤）會帶 Last-Event-ID 自動重連續傳，
   * 連續失敗超過上限或 HTTP 層錯誤（4xx/5xx）則直接拋出。
   */
  async *sse(
    path: string,
    options: { after?: number; signal?: AbortSignal } = {},
  ): AsyncGenerator<{ id: string | null; event: string; data: string }> {
    let lastId = options.after === undefined ? null : String(options.after);
    let failures = 0;
    for (;;) {
      let closedCleanly = false;
      try {
        const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          headers: this.headers({
            accept: "text/event-stream",
            ...(lastId === null ? {} : { "Last-Event-ID": lastId }),
          }),
          signal: options.signal,
        });
        if (!response.ok || !response.body) {
          const text = await response.text().catch(() => "");
          throw toError(response.status, safeJson(text), text);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) {
              closedCleanly = true;
              break;
            }
            buffer += decoder.decode(value, { stream: true });
            const frames = buffer.split("\n\n");
            buffer = frames.pop() ?? "";
            for (const frame of frames) {
              const parsed = parseFrame(frame);
              if (!parsed) continue;
              if (parsed.id !== null) lastId = parsed.id;
              failures = 0; // 有資料進來就重置退避
              yield parsed;
            }
          }
        } finally {
          await reader.cancel().catch(() => {});
        }
      } catch (err) {
        // 呼叫端主動取消、或 server 明確回錯（4xx/5xx）——不重試
        if (options.signal?.aborted || err instanceof NimplexError) throw err;
        failures += 1;
        if (failures > SSE_MAX_RETRIES) throw err;
        await sleep(SSE_RETRY_BASE_MS * failures, options.signal);
        continue; // 帶著 lastId 重連，事件不重不漏（exclusive 語意）
      }
      if (closedCleanly) return;
    }
  }
}

const SSE_MAX_RETRIES = 5;
const SSE_RETRY_BASE_MS = 200;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function parseFrame(frame: string): { id: string | null; event: string; data: string } | null {
  let id: string | null = null;
  let event = "message";
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("id:")) id = line.slice(3).trim();
    else if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return null;
  return { id, event, data: dataLines.join("\n") };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function toError(status: number, parsed: unknown, raw: string): NimplexError {
  if (parsed && typeof parsed === "object") {
    const body = parsed as Record<string, unknown>;
    const nested = body.error;
    if (nested && typeof nested === "object") {
      const inner = nested as Record<string, unknown>;
      return new NimplexError(
        status,
        String(inner.type ?? "error"),
        String(inner.message ?? raw),
        body.detail ?? body.issues,
      );
    }
    if (typeof nested === "string") {
      return new NimplexError(
        status,
        nested,
        String(body.detail ?? nested),
        body.detail ?? body.issues,
      );
    }
  }
  return new NimplexError(status, "http_error", raw || `HTTP ${status}`);
}
