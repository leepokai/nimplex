import { stripVTControlCharacters } from "node:util";
import type { RunEvent, RunResponse } from "@nimplex/contracts";

export function safeText(value: unknown, limit = 12000): string {
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
  const clean = Array.from(stripVTControlCharacters(text))
    .filter(
      (char) =>
        char === "\n" || char === "\t" || (char >= " " && char < "\u007f") || char >= "\u00a0",
    )
    .join("");
  return clean.length > limit ? `${clean.slice(0, limit)}\n… (output truncated)` : clean;
}

export function eventText(event: RunEvent, outputLimit = 2000): string | undefined {
  const payload = event.payload as Record<string, unknown>;
  switch (event.type) {
    case "message.delta":
      return `\n${safeText(payload.text)}\n`;
    case "tool.call":
      return `\n→ ${safeText(payload.name)} ${safeText(payload.input, outputLimit)}`;
    case "tool.result": {
      const content = Array.isArray(payload.content)
        ? payload.content
            .filter((block) => block?.type === "text" && typeof block.text === "string")
            .map((block) => block.text)
            .join("\n")
        : "";
      return `${payload.is_error ? "✗" : "✓"} ${safeText(payload.name)}${content ? `\n${safeText(content, outputLimit)}` : ""}`;
    }
    case "run.started":
      return "Running…";
    case "run.resumed":
      return "Execution resumed.";
    case "environment.reset":
      return "Sandbox was rebuilt.";
    case "context.compacted":
      return "Context compacted.";
    case "input.queued":
      return payload.kind === "steer" ? "Steering input queued." : "Follow-up queued.";
    default:
      return undefined;
  }
}

export function runText(run: RunResponse): string {
  return `${safeText(run.status)} · ${run.billing_mode === "subscription" ? "Codex subscription" : `model $${run.spent_usd.toFixed(6)}`}${run.error ? ` · ${safeText(run.error)}` : ""}`;
}
