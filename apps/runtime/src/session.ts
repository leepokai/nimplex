import Anthropic from "@anthropic-ai/sdk";
import { getSandbox } from "@cloudflare/sandbox";
import { runTool, type SandboxLike, toolDefs } from "./tools";

export interface Env {
  AgentSession: DurableObjectNamespace;
  // biome-ignore lint/suspicious/noExplicitAny: Sandbox namespace 的泛型由 @cloudflare/sandbox 提供，這裡不綁死
  Sandbox: any;
  ANTHROPIC_API_KEY: string;
}

export interface SessionConfig {
  end_user: string;
  model: string;
  instructions: string;
  budget_usd: number;
}

// TODO(P0): 這些型別之後全部上移到 @nimplex/contracts。
type SessionStatus = "queued" | "running" | "awaiting_input" | "completed" | "failed" | "killed";

// USD per MTok。電表 v0：input/output/cache 全記。
const PRICING: Record<string, { input: number; output: number }> = {
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

const SYSTEM_PROMPT = `You are an agent with your own cloud computer (a persistent Ubuntu container).
Use the bash / write_file / read_file tools to inspect the environment, install what you need, write code, run it, and verify results.
Work step by step and report what you did. State persists across your tool calls within this session.`;

const MAX_LOOP_ITERATIONS = 24;

export class AgentSession {
  private listeners = new Set<ReadableStreamDefaultController<Uint8Array>>();

  constructor(
    private state: DurableObjectState,
    private env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    switch (url.pathname) {
      case "/init":
        return this.handleInit(request);
      case "/message":
        return this.handleMessage(request);
      case "/events":
        return this.handleEvents(url);
      case "/state":
        return this.handleState();
      default:
        return Response.json({ error: "not found" }, { status: 404 });
    }
  }

  private async handleInit(request: Request): Promise<Response> {
    const config = (await request.json()) as SessionConfig;
    await this.state.storage.put({
      config,
      status: "awaiting_input" satisfies SessionStatus,
      spent_usd: 0,
      seq: 0,
      messages: [] as Anthropic.MessageParam[],
    });
    await this.emit("session_created", { config });
    return Response.json({ ok: true });
  }

  private async handleMessage(request: Request): Promise<Response> {
    const { text } = (await request.json()) as { text: string };
    const status = await this.state.storage.get<SessionStatus>("status");
    if (status === "running") {
      return Response.json({ error: "a turn is already running" }, { status: 409 });
    }
    if (status === "killed" || status === "failed") {
      return Response.json({ error: `session is ${status}` }, { status: 409 });
    }
    await this.state.storage.put("status", "running" satisfies SessionStatus);
    this.state.waitUntil(this.runTurn(text));
    return Response.json({ ok: true }, { status: 202 });
  }

  private async handleState(): Promise<Response> {
    const [config, status, spent] = await Promise.all([
      this.state.storage.get<SessionConfig>("config"),
      this.state.storage.get<SessionStatus>("status"),
      this.state.storage.get<number>("spent_usd"),
    ]);
    return Response.json({ config, status, spent_usd: spent ?? 0 });
  }

  private handleEvents(url: URL): Response {
    const after = Number(url.searchParams.get("after") ?? 0);
    const encoder = new TextEncoder();
    const listeners = this.listeners;
    const storage = this.state.storage;
    let controllerRef: ReadableStreamDefaultController<Uint8Array>;

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controllerRef = controller;
        const stored = await storage.list<string>({ prefix: "ev:" });
        for (const [key, value] of stored) {
          const seq = Number(key.slice(3));
          if (seq > after) {
            controller.enqueue(encoder.encode(`id: ${seq}\ndata: ${value}\n\n`));
          }
        }
        listeners.add(controller);
      },
      cancel() {
        listeners.delete(controllerRef);
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  }

  private async emit(type: string, data: Record<string, unknown>): Promise<void> {
    const seq = ((await this.state.storage.get<number>("seq")) ?? 0) + 1;
    const event = JSON.stringify({ seq, ts: new Date().toISOString(), type, ...data });
    await this.state.storage.put({ seq, [`ev:${String(seq).padStart(8, "0")}`]: event });
    const chunk = new TextEncoder().encode(`id: ${seq}\ndata: ${event}\n\n`);
    for (const controller of this.listeners) {
      try {
        controller.enqueue(chunk);
      } catch {
        this.listeners.delete(controller);
      }
    }
  }

  // ---- 電表（v0）----

  private async addCost(model: string, usage: Anthropic.Usage): Promise<number> {
    const price = PRICING[model] ?? { input: 5, output: 25 };
    const cost =
      (usage.input_tokens * price.input +
        usage.output_tokens * price.output +
        (usage.cache_creation_input_tokens ?? 0) * price.input * 1.25 +
        (usage.cache_read_input_tokens ?? 0) * price.input * 0.1) /
      1_000_000;
    const spent = ((await this.state.storage.get<number>("spent_usd")) ?? 0) + cost;
    await this.state.storage.put("spent_usd", spent);
    return spent;
  }

  /** 超過預算 → 當場終止，這是整個 demo 的賣點。 */
  private async breakerTripped(config: SessionConfig): Promise<boolean> {
    const spent = (await this.state.storage.get<number>("spent_usd")) ?? 0;
    if (spent < config.budget_usd) return false;
    await this.state.storage.put("status", "killed" satisfies SessionStatus);
    await this.emit("budget_exceeded", {
      spent_usd: spent,
      budget_usd: config.budget_usd,
      message: "Budget hard cap reached — run terminated mid-flight.",
    });
    return true;
  }

  /** 延後開容器：沒呼叫工具的 session 不該付沙箱成本。 */
  private sandbox(): SandboxLike {
    return getSandbox(this.env.Sandbox, this.state.id.toString()) as unknown as SandboxLike;
  }

  // ---- Agent 迴圈 ----

  private async runTurn(userText: string): Promise<void> {
    let messages: Anthropic.MessageParam[] = [];
    try {
      const config = (await this.state.storage.get<SessionConfig>("config")) as SessionConfig;
      messages = (await this.state.storage.get<Anthropic.MessageParam[]>("messages")) ?? [];
      const client = new Anthropic({ apiKey: this.env.ANTHROPIC_API_KEY });

      messages.push({ role: "user", content: userText });
      await this.emit("user_message", { text: userText });

      for (let i = 0; i < MAX_LOOP_ITERATIONS; i++) {
        if (await this.breakerTripped(config)) return;

        const response = await client.messages.create({
          model: config.model,
          max_tokens: 16000,
          thinking: { type: "adaptive" },
          system: `${SYSTEM_PROMPT}\n\n${config.instructions}`,
          tools: toolDefs,
          messages,
        });

        const spent = await this.addCost(config.model, response.usage);
        await this.emit("usage", { spent_usd: spent, budget_usd: config.budget_usd });

        messages.push({ role: "assistant", content: response.content });
        for (const block of response.content) {
          if (block.type === "text" && block.text.trim()) {
            await this.emit("assistant_text", { text: block.text });
          }
        }

        if (response.stop_reason === "tool_use") {
          const results: Anthropic.ToolResultBlockParam[] = [];
          for (const block of response.content) {
            if (block.type !== "tool_use") continue;
            if (await this.breakerTripped(config)) return;
            await this.emit("tool_call", { tool: block.name, input: block.input });
            let content: string;
            let isError = false;
            try {
              content = await runTool(
                this.sandbox(),
                block.name,
                block.input as Record<string, unknown>,
              );
            } catch (error) {
              content = error instanceof Error ? error.message : String(error);
              isError = true;
            }
            await this.emit("tool_result", {
              tool: block.name,
              output: content,
              is_error: isError,
            });
            results.push({
              type: "tool_result",
              tool_use_id: block.id,
              content,
              ...(isError ? { is_error: true } : {}),
            });
          }
          // 同一則 user message 回齊所有 tool_result（平行工具規則）
          messages.push({ role: "user", content: results });
          await this.state.storage.put("messages", messages);
          continue;
        }

        if (response.stop_reason === "refusal") {
          await this.emit("refusal", { stop_details: response.stop_details ?? null });
        }
        await this.state.storage.put("messages", messages);
        await this.state.storage.put("status", "awaiting_input" satisfies SessionStatus);
        await this.emit("turn_completed", { stop_reason: response.stop_reason });
        return;
      }

      await this.state.storage.put("status", "awaiting_input" satisfies SessionStatus);
      await this.emit("turn_completed", { stop_reason: "max_iterations" });
    } catch (error) {
      await this.state.storage.put("messages", messages);
      await this.state.storage.put("status", "failed" satisfies SessionStatus);
      if (error instanceof Anthropic.RateLimitError) {
        await this.emit("error", { kind: "rate_limit", message: error.message });
      } else if (error instanceof Anthropic.APIError) {
        await this.emit("error", {
          kind: "api_error",
          status: error.status,
          message: error.message,
        });
      } else {
        await this.emit("error", {
          kind: "internal",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
