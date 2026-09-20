// Production bridge between Pi's public extension runtime and the harness engine.
//
// Extensions are host code. They load from Pi's user agent directory and, only when the
// project is trusted, from `<cwd>/.pi/extensions`. Their tools and behavior hooks join
// the harness through Pi's public `ExtensionRunner`; every durable effect still commits
// through the engine's storage boundary. What the bridge does not carry is listed in
// `unsupported` below and fails closed instead of degrading silently.
import type { AgentHarness, AgentHarnessTool, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  CURRENT_SESSION_VERSION,
  DefaultResourceLoader,
  ExtensionRunner,
  type LoadExtensionsResult,
  ModelRegistry,
  ModelRuntime,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { PiExtensionMutations } from "./mutations.ts";
import { PiSessionView } from "./session-view.ts";
import { extensionTools } from "./tools.ts";

export interface PiExtensionSources {
  cwd: string;
  /** Pi agent directory whose `extensions/` always load, like Pi's own user extensions. */
  agentDir: string;
  /** Whether `<cwd>/.pi/extensions` may execute; the host decides from its trust store. */
  projectTrusted: boolean;
  /** Credential file the extension model registry may use; never Pi's own auth store. */
  authPath: string;
}

export interface LoadedPiExtensions extends PiExtensionSources {
  result: LoadExtensionsResult;
  models: ModelRuntime;
}

/** Load extension modules once; activations per turn share the loaded runtime like Pi does. */
export async function loadPiExtensions(sources: PiExtensionSources): Promise<LoadedPiExtensions> {
  const loader = new DefaultResourceLoader({
    cwd: sources.cwd,
    agentDir: sources.agentDir,
    // In-memory settings: Pi packages, themes and prompt templates are not part of this bridge.
    settingsManager: SettingsManager.inMemory(),
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload({ resolveProjectTrust: async () => sources.projectTrusted });
  const models = await ModelRuntime.create({
    authPath: sources.authPath,
    modelsPath: null,
    refreshOnCreate: false,
  });
  return { ...sources, result: loader.getExtensions(), models };
}

export interface PiExtensionSummary {
  projectTrusted: boolean;
  extensions: { path: string; tools: string[]; events: string[] }[];
  errors: { path: string; error: string }[];
}

export function describePiExtensions(loaded: LoadedPiExtensions): PiExtensionSummary {
  return {
    projectTrusted: loaded.projectTrusted,
    extensions: loaded.result.extensions.map((extension) => ({
      path: extension.path,
      tools: [...extension.tools.keys()],
      events: [...extension.handlers.keys()].sort(),
    })),
    errors: loaded.result.errors.map((error) => ({ path: error.path, error: error.error })),
  };
}

export interface PiExtensionActivationOptions {
  loaded: LoadedPiExtensions;
  sessionId: string;
  prompt: string;
  systemPrompt: string;
  model: Model<Api>;
  thinkingLevel: ThinkingLevel;
  /** Names of the engine's own tools, reported to extensions as active. */
  baseTools: string[];
  signal: AbortSignal;
  /** Deliver extension-sent messages through the lane's durable inbox. */
  queue(kind: "steer" | "followUp", text: string): Promise<unknown>;
  /** Request a durable abort of the running operation. */
  abort(): void;
}

export interface PiExtensionActivation {
  tools: AgentHarnessTool<undefined>[];
  /** Errors Pi isolated from extension handlers; the turn reports them after it settles. */
  errors: string[];
  /** Bridge behavior hooks onto the harness and announce the session to extensions. */
  attach(harness: AgentHarness<undefined>): Promise<void>;
  close(): Promise<void>;
}

const unsupported = (name: string) => () => {
  throw new Error(`Pi extension action ${name} is not supported by the nimplex harness bridge`);
};

function textOf(content: string | { type: string; text?: string }[]): string {
  return typeof content === "string"
    ? content
    : content
        .filter((part): part is { type: "text"; text: string } => part.type === "text")
        .map((part) => part.text)
        .join("\n");
}

/** One turn's extension activation: tools, hooks and the actions Pi exposes as `pi.*`. */
export async function activatePiExtensions(
  options: PiExtensionActivationOptions,
): Promise<PiExtensionActivation> {
  const { loaded, signal } = options;
  // Extensions see an empty read-only transcript: nimplex's durable events, not Pi's
  // JSONL, are the record. `ctx.sessionManager` reads therefore return no entries.
  const view = new PiSessionView({
    header: {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: options.sessionId,
      timestamp: new Date().toISOString(),
      cwd: loaded.cwd,
    },
    entries: [],
    leafId: null,
  });
  const mutations = new PiExtensionMutations();
  const runner = new ExtensionRunner(
    loaded.result.extensions,
    loaded.result.runtime,
    loaded.cwd,
    view.manager,
    new ModelRegistry(loaded.models),
  );
  const errors: string[] = [];
  runner.onError((error) => errors.push(`${error.extensionPath} (${error.event}): ${error.error}`));
  let systemPrompt = options.systemPrompt;
  const deliver = (kind: "steer" | "followUp" | undefined, text: string, action: string) => {
    if (kind !== "steer" && kind !== "followUp")
      return mutations.fail(
        new Error(`Pi extension ${action} without steer/followUp delivery is not supported`),
      );
    void mutations.stage(() => options.queue(kind, text));
  };
  runner.bindCore(
    {
      ...loaded.result.runtime,
      sendMessage: (message, delivery) =>
        deliver(
          delivery?.deliverAs === "nextTurn" ? undefined : delivery?.deliverAs,
          textOf(message.content),
          "sendMessage",
        ),
      sendUserMessage: (content, delivery) =>
        deliver(delivery?.deliverAs ?? "steer", textOf(content), "sendUserMessage"),
      appendEntry: unsupported("appendEntry"),
      setSessionName: unsupported("setSessionName"),
      getSessionName: () => undefined,
      setLabel: unsupported("setLabel"),
      getActiveTools: () => [
        ...options.baseTools,
        ...runner.getAllRegisteredTools().map((tool) => tool.definition.name),
      ],
      getAllTools: unsupported("getAllTools"),
      setActiveTools: unsupported("setActiveTools"),
      refreshTools: () => {},
      getCommands: () => [],
      setModel: () => Promise.reject(unsupported("setModel")),
      getThinkingLevel: () => options.thinkingLevel,
      setThinkingLevel: unsupported("setThinkingLevel"),
    },
    {
      getModel: () => options.model,
      getScopedModels: () => [],
      isIdle: () => false,
      isProjectTrusted: () => loaded.projectTrusted,
      getSignal: () => signal,
      abort: () => options.abort(),
      hasPendingMessages: () => false,
      shutdown: unsupported("shutdown"),
      getContextUsage: () => undefined,
      compact: unsupported("compact"),
      getSystemPrompt: () => systemPrompt,
    },
  );
  const disposers: (() => void)[] = [];
  const assertAuthority = () => signal.throwIfAborted();
  let started: Promise<void> | undefined;
  const start = () => {
    started ??= (async () => {
      const result = await runner.emitBeforeAgentStart(
        options.prompt,
        undefined,
        systemPrompt,
        {} as never,
      );
      if (result?.messages?.length)
        mutations.fail(
          new Error("Pi extension before_agent_start message injection is not supported"),
        );
      if (result?.systemPrompt) systemPrompt = result.systemPrompt;
      await mutations.flush();
    })();
    return started;
  };
  return {
    tools: extensionTools(runner, mutations, assertAuthority),
    errors,
    async attach(harness) {
      disposers.push(
        harness.hooks.on("transform_context", async (event) => {
          await start();
          const messages = await runner.emitContext(event.messages);
          await mutations.flush();
          return { messages, systemPrompt };
        }),
        harness.hooks.on("before_payload", async (event) => ({
          payload: await runner.emitBeforeProviderRequest(event.payload),
        })),
        harness.hooks.on("before_tool", async (event) => {
          const input = structuredClone(event.args);
          const result = await runner.emitToolCall({
            type: "tool_call",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            input,
          });
          await mutations.flush();
          return {
            args: input,
            ...(result?.block
              ? {
                  block: {
                    reason: result.reason ?? "Blocked by extension",
                    terminate: result.terminate,
                  },
                }
              : {}),
          };
        }),
        harness.hooks.on("after_tool", async (event) => {
          const result = await runner.emitToolResult({
            type: "tool_result",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            input: event.args,
            content: event.content,
            details: event.details,
            isError: event.isError,
          });
          await mutations.flush();
          return result
            ? {
                ...result,
                details:
                  result.details === undefined
                    ? undefined
                    : (JSON.parse(JSON.stringify(result.details)) as never),
              }
            : undefined;
        }),
      );
      await runner.emit({ type: "session_start", reason: "startup" });
      await mutations.flush();
    },
    async close() {
      for (const dispose of disposers.splice(0)) dispose();
      try {
        await mutations.close();
      } finally {
        view.invalidate();
      }
    },
  };
}
