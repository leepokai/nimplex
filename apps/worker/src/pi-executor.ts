// Pi (@earendil-works) as the loop kernel, loop-outside: the agent runs in this worker process,
// its tools run against a just-bash VFS (Tier 1) seeded from Tier 0. Nothing here touches the
// database; the worker owns the transaction.
import { Agent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import {
  type AssistantMessage,
  type Model,
  type ToolResultMessage,
  validateToolArguments,
} from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-coding-agent";
import type { ModelReservation } from "@nimplex/contracts";
import {
  computeCost,
  type ExecutorEvent,
  type RunExecutor,
  WORKSPACE_MAX_BYTES,
} from "@nimplex/core";
import { Bash } from "just-bash";
import { z } from "zod";
import { needsNativeSandbox } from "./bash-routing.ts";
import {
  compactContext,
  latestCheckpoint,
  OUTPUT_PREVIEW_CHARS,
  readArchive,
  toolOutputText,
} from "./context.ts";
import { restoreWorkspace, snapshotWorkspace } from "./workspace.ts";

export const WORKSPACE = "/workspace";
const DEFAULT_ANTHROPIC_URL = "https://api.anthropic.com";
const DEFAULT_BASH_TIMEOUT_MS = 120_000;

const runConfig = z.object({
  instructions: z.string(),
  input: z.string().nullable().optional(),
});
type RunConfig = z.infer<typeof runConfig>;

const toolResultPayload = z.object({
  id: z.string(),
  name: z.string(),
  is_error: z.boolean(),
  content: z.array(z.record(z.string(), z.unknown())),
});

export const piExecutor: RunExecutor = async (run, signal) => {
  signal.throwIfAborted();
  if (run.modelProvider !== "anthropic") throw new Error("pi executor supports Anthropic only");
  const config = runConfig.parse(run.config);
  const bash = new Bash({
    cwd: WORKSPACE,
    files: run.files,
    executionLimits: { maxFileSystemBytes: WORKSPACE_MAX_BYTES, maxOutputSize: 1024 * 1024 },
  });
  await restoreWorkspace(bash, run.files, run.workspaceMetadata);
  let currentToolId = "";
  const tools = vfsTools(bash, async (command, toolSignal, timeoutMs) => {
    if (!run.nativeBash) throw new Error("native sandbox is unavailable");
    const before = await snapshotWorkspace(bash);
    const remote = await run.nativeBash(
      currentToolId,
      command,
      before.files,
      before.metadata,
      toolSignal,
      timeoutMs,
    );
    await restoreWorkspace(bash, remote.files, remote.metadata);
    return remote.result;
  });
  tools.push(
    archiveTool("read_output", run.persistence.readEvents),
    archiveTool("read_log", run.persistence.readEvents),
  );
  let history = projectMessages(config, run.events);
  const compacted = compactContext(
    history,
    run.events,
    Number(process.env.NIMPLEX_CONTEXT_CHARS ?? 64000),
  );
  if (compacted) {
    await run.persistence.checkpointContext(compacted);
    history = compacted.messages as unknown as AgentMessage[];
  }
  let assistant: AssistantMessage | undefined;
  let reservation: ModelReservation | undefined;
  let infrastructureError: unknown;

  const persistTool = async (message: ToolResultMessage) => {
    signal.throwIfAborted();
    const events: ExecutorEvent[] = [
      {
        type: "tool.result",
        payload: {
          id: message.toolCallId,
          name: message.toolName,
          is_error: message.isError,
          content: message.content,
        },
      },
    ];
    const snapshot = await snapshotWorkspace(bash);
    await run.persistence.commitTool(events, snapshot.files, snapshot.metadata);
  };

  // A crash can leave a durable assistant message with only some tool results. Execute just
  // the missing calls against the last committed workspace before asking the model again.
  const lastAssistant = history.findLastIndex((m) => m.role === "assistant");
  const previous = history[lastAssistant] as AssistantMessage | undefined;
  if (previous) {
    const completed = new Set(
      history
        .slice(lastAssistant + 1)
        .filter((m) => m.role === "toolResult")
        .map((m) => m.toolCallId),
    );
    if (previous.stopReason === "stop") {
      return { events: [], costUsd: 0, files: run.files, stopReason: "stop" };
    }
    if (previous.stopReason !== "toolUse" && previous.stopReason !== "length")
      throw new Error(`cannot resume model stop: ${previous.stopReason}`);
    for (const call of previous.content) {
      if (call.type !== "toolCall" || completed.has(call.id)) continue;
      signal.throwIfAborted();
      if (previous.stopReason === "length") {
        const message: ToolResultMessage = {
          role: "toolResult",
          toolCallId: call.id,
          toolName: call.name,
          content: [
            {
              type: "text",
              text: "The prior response was truncated. This tool was not executed. Retry using smaller steps.",
            },
          ],
          isError: true,
          timestamp: 0,
        };
        await persistTool(message);
        history.push(message);
        continue;
      }
      currentToolId = call.id;
      await run.persistence.startTool(call.id, call.name);
      let message: ToolResultMessage;
      try {
        const tool = tools.find((t) => t.name === call.name);
        if (!tool) throw new Error(`unknown tool: ${call.name}`);
        const args = validateToolArguments(tool, call);
        const result = await tool.execute(call.id, args, signal);
        message = {
          role: "toolResult",
          toolCallId: call.id,
          toolName: call.name,
          content: result.content,
          isError: false,
          timestamp: Date.now(),
        };
      } catch (error) {
        signal.throwIfAborted();
        message = {
          role: "toolResult",
          toolCallId: call.id,
          toolName: call.name,
          content: [{ type: "text", text: String(error) }],
          isError: true,
          timestamp: Date.now(),
        };
      }
      await persistTool(message);
      history.push(message);
    }
  }

  const agent = new Agent({
    streamFn: (model, context, options) =>
      streamSimple(model as Model<"anthropic-messages">, context, {
        ...options,
        cacheRetention: "none",
        maxRetries: 0,
        timeoutMs: 120_000,
        onPayload: async (payload) => {
          try {
            signal.throwIfAborted();
            // Text-only messages and local tool schemas: one token per serialized UTF-8 byte,
            // plus framing allowance. Cache writes, thinking and paid server tools are disabled.
            const inputTokenBound = Buffer.byteLength(JSON.stringify(payload), "utf8") + 4096;
            reservation = await run.persistence.reserveModel(inputTokenBound);
            return { ...(payload as object), max_tokens: reservation.max_output_tokens };
          } catch (error) {
            infrastructureError = error;
            throw error;
          }
        },
      }),
    getApiKey: () => run.credential.apiKey,
    shouldStopAfterTurn: () => true,
    toolExecution: "sequential",
    beforeToolCall: async ({ toolCall }) => {
      try {
        signal.throwIfAborted();
        currentToolId = toolCall.id;
        await run.persistence.startTool(toolCall.id, toolCall.name);
      } catch (error) {
        infrastructureError = error;
        agent.abort();
        throw error;
      }
    },
    initialState: {
      systemPrompt:
        systemPrompt(config.instructions) +
        (run.events.some((e) => e.type === "environment.reset")
          ? "\nThe native environment was recreated from the durable workspace. Installed dependencies and background processes may be gone."
          : ""),
      model: buildModel(run.model, run.credential.baseUrl ?? DEFAULT_ANTHROPIC_URL),
      messages: history,
      tools,
    },
  });
  const onAbort = () => agent.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  agent.subscribe(async (event) => {
    try {
      if (event.type !== "message_end") return;
      if (event.message.role === "assistant") {
        if (infrastructureError) throw infrastructureError;
        assistant = event.message;
        if (!reservation) {
          if (infrastructureError) throw infrastructureError;
          throw new Error("model response without reservation");
        }
        const cost = computeCost(run.modelProvider, run.model, {
          inputTokens: assistant.usage.input,
          outputTokens: assistant.usage.output,
          cacheWriteTokens: assistant.usage.cacheWrite,
          cacheReadTokens: assistant.usage.cacheRead,
        });
        const uncertain = assistant.stopReason === "error" || assistant.stopReason === "aborted";
        const events: ExecutorEvent[] = [
          {
            type: uncertain ? "model.unknown" : "model.call",
            payload: {
              call_id: reservation.call_id,
              model: assistant.model,
              stop_reason: assistant.stopReason,
              usage: {
                input_tokens: assistant.usage.input,
                output_tokens: assistant.usage.output,
                cache_read_tokens: assistant.usage.cacheRead,
                cache_write_tokens: assistant.usage.cacheWrite,
              },
              cost_usd: cost.costUsd,
              estimated: cost.estimated,
              uncertain,
              message: assistant,
            },
          },
        ];
        for (const block of uncertain ? [] : assistant.content) {
          if (block.type === "text" && block.text)
            events.push({ type: "message.delta", payload: { text: block.text } });
          if (block.type === "toolCall")
            events.push({
              type: "tool.call",
              payload: { id: block.id, name: block.name, input: block.arguments },
            });
        }
        if (
          assistant.stopReason === "length" &&
          !assistant.content.some((block) => block.type === "toolCall")
        ) {
          events.push({
            type: "message.continue",
            payload: {
              text: "Your previous response reached the output limit. Continue in smaller steps; do not repeat completed work.",
            },
          });
        }
        await run.persistence.commitModel(reservation, events, cost.costUsd, uncertain);
      } else if (event.message.role === "toolResult") {
        await persistTool(event.message);
      }
    } catch (error) {
      infrastructureError = error;
      agent.abort();
      throw error;
    }
  });
  try {
    await agent.continue();
    if (infrastructureError) throw infrastructureError;
    if (!assistant)
      throw new Error(
        `pi executor: no assistant message (${agent.state.errorMessage ?? "unknown"})`,
      );
    return {
      events: [],
      costUsd: 0,
      files: (await snapshotWorkspace(bash)).files,
      stopReason: assistant.stopReason,
      errorMessage: assistant.errorMessage,
    };
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
};

/**
 * Run config + log -> Pi transcript. The prompt lives in the run row (durable), the rest is
 * projected from model.call (verbatim assistant message) and tool.result events.
 */
export function projectMessages(config: RunConfig, events: ExecutorEvent[]): AgentMessage[] {
  const checkpoint = latestCheckpoint(events);
  const messages: AgentMessage[] = checkpoint
    ? (checkpoint.messages as unknown as AgentMessage[])
    : [{ role: "user", content: config.input ?? config.instructions, timestamp: 0 }];
  for (const e of events.slice(checkpoint ? checkpoint.high_water + 1 : 0)) {
    if (e.type === "model.call") {
      messages.push((e.payload as { message: AssistantMessage }).message);
    } else if (e.type === "tool.result") {
      const p = toolResultPayload.parse(e.payload);
      messages.push({
        role: "toolResult",
        toolCallId: p.id,
        toolName: p.name,
        content:
          toolOutputText(p).length > OUTPUT_PREVIEW_CHARS
            ? [
                {
                  type: "text",
                  text: `${toolOutputText(p).slice(0, OUTPUT_PREVIEW_CHARS)}\n[Full output archived. Use read_output with path=${p.id}, offset=${OUTPUT_PREVIEW_CHARS}, limit=8000.]`,
                },
              ]
            : (p.content as unknown as ToolResultMessage["content"]),
        isError: p.is_error,
        timestamp: 0,
      });
    } else if (e.type === "message.continue") {
      messages.push({ role: "user", content: (e.payload as { text: string }).text, timestamp: 0 });
    }
  }
  return messages;
}

function systemPrompt(instructions: string): string {
  return [
    `You are a coding agent working in a sandboxed workspace at ${WORKSPACE}.`,
    "The shell is an in-memory bash emulator: coreutils, grep/rg, sed, awk, jq, sqlite3 and similar work;",
    "Native commands (git, npm, node, build and test) use the configured isolated sandbox when available.",
    "Use the read/write/edit tools for files. Finish with a short summary of what you did.",
    "",
    instructions,
  ].join("\n");
}

function buildModel(id: string, baseUrl: string): Model<"anthropic-messages"> {
  const known = getBuiltinModels("anthropic").find((m) => m.id === id);
  if (known) return { ...known, baseUrl };
  // Preserve the requested ID; the reservation gate rejects models without a known rate.
  return {
    id,
    name: id,
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8192,
  };
}

/** Pi's file tools with their operations pointed at the just-bash VFS instead of the host disk. */
function vfsTools(
  bash: Bash,
  native: (
    command: string,
    signal: AbortSignal,
    timeoutMs: number,
  ) => Promise<{ stdout: string; stderr: string; exitCode: number | null }>,
): AgentTool[] {
  const fs = bash.fs;
  const inside = (path: string) => {
    if (!path.startsWith(`${WORKSPACE}/`) && path !== WORKSPACE)
      throw new Error("path must be inside /workspace");
    if (path.split("/").includes("..")) throw new Error("path traversal is not allowed");
  };
  const readFile = async (p: string) => {
    inside(p);
    return Buffer.from(await fs.readFileBuffer(p));
  };
  const writeFile = (p: string, c: string) => {
    inside(p);
    return fs.writeFile(p, c);
  };
  const access = async (p: string) => {
    inside(p);
    if (!(await fs.exists(p))) throw new Error(`ENOENT: no such file: ${p}`);
  };
  const baseBash = createBashTool(WORKSPACE, { exposeSessionEnvironment: false });
  return [
    {
      ...baseBash,
      parameters: {
        ...baseBash.parameters,
        properties: {
          command: { type: "string", description: "Shell script to execute in /workspace." },
          timeout: {
            type: "number",
            exclusiveMinimum: 0,
            maximum: 120,
            default: 120,
            description: "Timeout in seconds, greater than 0 and at most 120; defaults to 120.",
          },
        },
        required: ["command"],
      },
      description:
        "Run a shell command in /workspace. The runtime routes the entire script to just-bash or an isolated native sandbox before execution. Full output is archived; large output can be read with read_output.",
      execute: async (_id, args, signal) => {
        const { command, timeout } = z
          .object({ command: z.string(), timeout: z.number().positive().max(120).optional() })
          .parse(args);
        const signals = [AbortSignal.timeout(timeout ? timeout * 1000 : DEFAULT_BASH_TIMEOUT_MS)];
        if (signal) signals.push(signal);
        const toolSignal = AbortSignal.any(signals);
        const result = needsNativeSandbox(command)
          ? await native(
              command,
              signal ?? new AbortController().signal,
              timeout ? timeout * 1000 : DEFAULT_BASH_TIMEOUT_MS,
            )
          : await bash.exec(command, { cwd: WORKSPACE, signal: toolSignal });
        const text = result.stdout + (result.stderr ? `\n${result.stderr}` : "");
        if ("timedOut" in result && result.timedOut)
          throw new Error(`${text}\nCommand timed out; split long work into smaller commands.`);
        if (result.exitCode !== 0)
          throw new Error(`${text}\nCommand exited with code ${result.exitCode}`);
        return { content: [{ type: "text", text: text || "(no output)" }], details: {} };
      },
    },
    createReadTool(WORKSPACE, { operations: { readFile, access } }),
    createWriteTool(WORKSPACE, {
      operations: {
        writeFile,
        mkdir: (d) => {
          inside(d);
          return fs.mkdir(d, { recursive: true });
        },
      },
    }),
    createEditTool(WORKSPACE, { operations: { readFile, writeFile, access } }),
  ];
}

function archiveTool(
  name: "read_output" | "read_log",
  readEvents: () => Promise<ExecutorEvent[]>,
): AgentTool {
  const base = createReadTool(WORKSPACE);
  return {
    ...base,
    parameters: {
      ...base.parameters,
      properties: {
        path: {
          type: "string",
          description:
            name === "read_output" ? "Durable tool call ID." : "Event reference: event:<sequence>.",
        },
        offset: {
          type: "integer",
          minimum: 0,
          default: 0,
          description: "Zero-based character offset.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 12000,
          default: 8000,
          description: "Maximum number of characters to return (1..12000).",
        },
      },
      required: ["path"],
    },
    name,
    label: name,
    description:
      name === "read_output"
        ? "Read full durable tool output. path is the tool call ID, offset is a zero-based character index (default 0), limit is 1..12000 characters (default 8000)."
        : "Read an original durable event. path is event:<sequence>, offset is a zero-based character index, limit is 1..12000 characters. Original events remain available after compaction.",
    execute: async (_id, args) => {
      const p = z
        .object({
          path: z.string(),
          offset: z.number().int().nonnegative().default(0),
          limit: z.number().int().min(1).max(12000).default(8000),
        })
        .parse(args);
      const page = readArchive(await readEvents(), p.path, p.offset, p.limit);
      return { content: [{ type: "text", text: JSON.stringify(page) }], details: {} };
    },
  };
}
