import type { ExecutorEvent } from "./executor.ts";

/** Build a new invocation from committed conversation facts, never pending tool calls. */
export function continuationMessages(
  config: unknown,
  events: ExecutorEvent[],
): Record<string, unknown>[] {
  const c = config as {
    instructions?: string;
    input?: string;
    prior_messages?: Record<string, unknown>[];
  };
  const messages = structuredClone(c.prior_messages ?? []);
  messages.push({ role: "user", content: c.input ?? c.instructions ?? "", timestamp: 0 });
  const outcomes = new Set(
    events.filter((e) => e.type === "tool.result").map((e) => (e.payload as { id: string }).id),
  );
  for (const event of events) {
    const p = event.payload as Record<string, unknown>;
    if (event.type === "model.call" && p?.message) {
      const message = structuredClone(p.message) as Record<string, unknown>;
      if (Array.isArray(message.content)) {
        const content = message.content.filter(
          (block) => block.type !== "toolCall" || outcomes.has(block.id),
        );
        if (content.length === 0) continue;
        message.content = content;
      }
      messages.push(message);
    } else if (event.type === "tool.result") {
      messages.push({
        role: "toolResult",
        toolCallId: p.id,
        toolName: p.name,
        content: p.content,
        isError: p.is_error,
        timestamp: 0,
      });
    } else if (event.type === "message.continue") {
      messages.push({ role: "user", content: p.text, timestamp: 0 });
    }
  }
  return messages;
}
