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
  /** Control-plane base URL, defaulting to NIMPLEX_BASE_URL. */
  baseUrl?: string;
  /** Organization API key, defaulting to NIMPLEX_API_KEY. */
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
  headers?: Record<string, string>;
}

/**
 * Centralize HTTP protocol behavior.
 * Console and SDK use the same public endpoints, without /internal routes,
 * so this transport exposes the same capabilities available to customers.
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
    // Bind browser fetch to its receiver to avoid Illegal invocation errors.
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
   * Read SSE with fetch. Clean server closure ends the event stream.
   * Network interruptions reconnect automatically with Last-Event-ID.
   * Exceeding the consecutive-failure limit or receiving an HTTP error throws.
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
              failures = 0; // Data resets reconnect backoff.
              yield parsed;
            }
          }
        } finally {
          await reader.cancel().catch(() => {});
        }
      } catch (err) {
        // Explicit cancellation and HTTP errors are not retried.
        if (options.signal?.aborted || err instanceof NimplexError) throw err;
        failures += 1;
        if (failures > SSE_MAX_RETRIES) throw err;
        await sleep(SSE_RETRY_BASE_MS * failures, options.signal);
        continue; // Reconnect after lastId, preserving exclusive cursor semantics.
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
