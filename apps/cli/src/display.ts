import { stripVTControlCharacters } from "node:util";
import type {
  RunEvent,
  RunResponse,
  SandboxUsageRecord,
  SandboxUsageSummary,
} from "@nimplex/contracts";

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

/**
 * Warning for a sandbox that cannot run native commands. `alternative` is another provider
 * that is available now; it is only suggested when it would actually work.
 */
export function sandboxWarning(sandbox: string, reason: string, alternative?: string): string {
  const hint = alternative
    ? `pass --sandbox ${alternative} to use ${alternative} instead`
    : "configure it before running commands that need node, git or package installs";
  return `${sandbox} sandbox is not available: ${reason}. Native commands will fail; ${hint}.`;
}

/**
 * The one wording for estimated sandbox cost. `short` fits the status line; both keep the
 * estimate label and flag time that was unobserved, unpriced or is still running.
 */
export function sandboxEstimate(
  summary: SandboxUsageSummary | undefined,
  style: "full" | "short" = "full",
): string | undefined {
  // A zero-rate sandbox (local Docker) has nothing to estimate.
  if (!summary || summary.free) return undefined;
  const amount = summary.usd.toFixed(summary.usd < 0.01 ? 6 : 4);
  const unpriced = Math.ceil(summary.unpriced_seconds);
  const notes: [boolean, string, string][] = [
    [summary.uncertain, "includes unobserved time", "unobserved"],
    [unpriced > 0, `${unpriced}s unpriced`, "unpriced"],
    [Boolean(summary.running_since), `running since ${summary.running_since}`, "running"],
  ];
  const flagged = notes
    .filter(([shown]) => shown)
    .map(([, full, short]) => (style === "full" ? full : short));
  return `sandbox ~$${amount} (est.${flagged.length ? `; ${flagged.join("; ")}` : ""})`;
}

/** One settled sandbox interval for the usage breakdown. */
export function sandboxIntervalText(record: SandboxUsageRecord): string {
  const cost = record.cost_usd === null ? "unpriced" : `~$${record.cost_usd.toFixed(6)}`;
  return `  ${safeText(record.provider)} ${record.reason} ${record.seconds.toFixed(1)}s ${cost}${record.uncertain ? " (unobserved)" : ""}`;
}

export function runText(run: RunResponse): string {
  return `${safeText(run.status)} · ${run.billing_mode === "subscription" ? "Codex subscription" : `model $${run.spent_usd.toFixed(6)}`}${run.error ? ` · ${safeText(run.error)}` : ""}`;
}
