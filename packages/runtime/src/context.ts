import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type ContextCheckpoint, contextCheckpoint } from "@nimplex/contracts";
import type { ExecutorEvent } from "@nimplex/core";

export const OUTPUT_PREVIEW_CHARS = 12000;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export function eventDigest(events: ExecutorEvent[]): string {
  return createHash("sha256").update(canonical(events)).digest("hex");
}

export function latestCheckpoint(events: ExecutorEvent[]): ContextCheckpoint | null {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.type !== "context.checkpoint") continue;
    const parsed = contextCheckpoint.safeParse(events[i]?.payload);
    if (!parsed.success || parsed.data.high_water >= i) continue;
    if (eventDigest(events.slice(0, parsed.data.high_water + 1)) === parsed.data.digest)
      return parsed.data;
  }
  return null;
}

/** Compact only complete old turns, preserving the original prompt and recent tool-call pairs. */
export function compactContext(
  messages: AgentMessage[],
  events: ExecutorEvent[],
  threshold = 64000,
): ContextCheckpoint | null {
  if (Buffer.byteLength(JSON.stringify(messages)) <= threshold) return null;
  const assistantIndices = messages.flatMap((m, i) => (m.role === "assistant" ? [i] : []));
  if (assistantIndices.length < 3) return null;
  const keepFrom = assistantIndices[assistantIndices.length - 2];
  if (keepFrom === undefined || !messages[0] || events.length === 0) return null;
  const summary = messages
    .slice(1, keepFrom)
    .map((message) => {
      if (!("content" in message)) return message.role;
      const body =
        typeof message.content === "string" ? message.content : JSON.stringify(message.content);
      return `${message.role}: ${body?.slice(0, 384) ?? ""}`;
    })
    .join("\n")
    .slice(-8192);
  const compacted: AgentMessage[] = [
    messages[0],
    {
      role: "user",
      timestamp: 0,
      content: `Earlier completed turns (extractive, may omit details):\n${summary}\nFull originals remain in the durable log. Use read_log with path event:<sequence> or read_output with the tool call ID to retrieve details.`,
    },
    ...messages.slice(keepFrom),
  ];
  return {
    version: 1,
    high_water: events.length - 1,
    digest: eventDigest(events),
    strategy: "extractive",
    messages: compacted as unknown as ContextCheckpoint["messages"],
  };
}

export function toolOutputText(payload: unknown): string {
  const content = (payload as { content?: { type?: string; text?: string }[] } | null)?.content;
  return Array.isArray(content)
    ? content
        .map((part) => (part.type === "text" ? (part.text ?? "") : JSON.stringify(part)))
        .join("\n")
    : "";
}

export function readArchive(events: ExecutorEvent[], path: string, offset = 0, limit = 8000) {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 12000
  )
    throw new Error("offset must be nonnegative; limit must be 1..12000 characters");
  let text: string;
  if (path.startsWith("event:")) {
    const seq = Number(path.slice(6));
    if (!Number.isSafeInteger(seq) || seq < 0 || !events[seq]) throw new Error("event not found");
    text = JSON.stringify(events[seq]);
  } else {
    const event = events.find(
      (e) => e.type === "tool.result" && (e.payload as { id?: string } | null)?.id === path,
    );
    if (!event) throw new Error("tool output not found");
    text = toolOutputText(event.payload);
  }
  return {
    text: text.slice(offset, offset + limit),
    offset,
    next_offset: offset + limit < text.length ? offset + limit : null,
    total_characters: text.length,
  };
}
