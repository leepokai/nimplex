import { Markdown, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { safeText } from "../display.ts";
import type { Preferences, Session } from "./store.ts";
import { theme } from "./theme.ts";

function textOutput(payload: Record<string, unknown>) {
  return Array.isArray(payload.content)
    ? payload.content
        .filter((b) => b?.type === "text" && typeof b.text === "string")
        .map((b) => b.text as string)
        .join("\n")
        .trim()
    : "";
}

/** Render canonical events without allowing model output to inject terminal controls. */
export function renderConversation(session: Session, preferences: Preferences, width: number) {
  const t = theme(preferences.theme);
  const inset = width >= 80 ? 2 : 1;
  const bodyWidth = Math.max(1, width - inset * 2);
  const left = " ".repeat(inset);
  const lines: string[] = [];
  const prompts: number[] = [];
  const wrap = (value: unknown, limit = 32000) =>
    wrapTextWithAnsi(safeText(value, limit), bodyWidth);
  const md = (text: string) => {
    const rendered = new Markdown(safeText(text, 32000), 0, 0, t.markdown).render(bodyWidth);
    while (rendered.length && !rendered[0]?.trim()) rendered.shift();
    while (rendered.length && !rendered.at(-1)?.trim()) rendered.pop();
    return rendered.map((line) => left + line);
  };
  if (!session.turns.length) {
    lines.push(
      "",
      left + t.accent("nimplex"),
      left + t.bold("What would you like to build?"),
      "",
      ...wrap("A conversation, a persistent workspace, and tools when you need them.").map(
        (s) => left + t.muted(s),
      ),
      "",
      `${left + t.accent("/model")}    Choose a model`,
      `${left + t.accent("/resume")}   Continue a conversation`,
      `${left + t.accent("@path")}     Attach a local text file`,
      "",
      ...wrap(
        "Tools work in /workspace. Attach project files with @path; your local folder is not automatically copied.",
      ).map((s) => left + t.muted(s)),
    );
  }
  for (const [index, turn] of session.turns.entries()) {
    lines.push("");
    prompts.push(lines.length);
    const cardWidth = Math.max(1, bodyWidth - 3);
    const card = (text: string) => {
      const row = truncateToWidth(text, cardWidth);
      return (
        left +
        t.accent("▎") +
        t.surface(` ${row}${" ".repeat(Math.max(0, cardWidth - visibleWidth(row)))} `)
      );
    };
    lines.push(card(`YOU  ${String(index + 1).padStart(2, "0")}`));
    lines.push(...wrapTextWithAnsi(safeText(turn.prompt, 32000), cardWidth).map(card), "");
    const results = new Map(
      turn.events
        .filter((e) => e.type === "tool.result")
        .map((e) => [
          String((e.payload as { id: string }).id),
          e.payload as Record<string, unknown>,
        ]),
    );
    let assistantLabel = false;
    let toolCount = 0;
    for (const event of turn.events) {
      const p = event.payload as Record<string, unknown>;
      if (event.type === "message.delta" && typeof p.text === "string" && p.text.trim()) {
        if (!assistantLabel) {
          lines.push(left + t.accent("● ") + t.bold("nimplex"), "");
          assistantLabel = true;
        }
        lines.push(...md(p.text), "");
      } else if (event.type === "tool.call") {
        toolCount++;
        const result = results.get(String(p.id));
        const failed = result?.is_error === true;
        const color = failed ? t.danger : result ? t.success : t.accent;
        const state = failed ? "failed" : result ? "done" : turn.result ? "no result" : "running";
        const name = safeText(p.name, 80);
        const input = (p.input && typeof p.input === "object" ? p.input : {}) as Record<
          string,
          unknown
        >;
        const subject = input.command ?? input.path ?? p.input ?? "";
        lines.push(
          left +
            color(result ? (failed ? "× " : "✓ ") : "○ ") +
            t.bold(name) +
            t.muted(`  ${state}`),
        );
        const toolWidth = Math.max(1, bodyWidth - 4);
        const command = wrapTextWithAnsi(safeText(subject, 12000), toolWidth);
        const shown = preferences.expanded ? command : command.slice(0, 2);
        lines.push(...shown.map((line) => left + t.muted("  │ ") + line));
        if (command.length > shown.length)
          lines.push(
            left + t.muted(`  │ +${command.length - shown.length} command lines · Alt+R expand`),
          );
        if (result) {
          const output = textOutput(result);
          if (output) {
            const rows = wrapTextWithAnsi(safeText(output, 12000), toolWidth);
            const preview = rows.slice(0, preferences.expanded ? 80 : failed ? 4 : 1);
            lines.push(
              ...preview.map(
                (line) => left + t.muted("  │ ") + (failed ? t.danger(line) : t.muted(line)),
              ),
            );
            if (rows.length > preview.length)
              lines.push(
                left +
                  t.muted(
                    `  └ +${rows.length - preview.length} output lines · ${preferences.expanded ? "/transcript" : "Alt+R expand"}`,
                  ),
              );
          }
        }
        lines.push("");
      } else if (event.type === "environment.reset") {
        lines.push(left + t.muted("↳ Native workspace recreated"), "");
      }
    }
    if (turn.result) {
      const ok = turn.result.status === "completed";
      const label = ok
        ? "Done"
        : turn.result.status === "killed" || turn.result.status === "canceled"
          ? "Stopped"
          : "Failed";
      lines.push(
        left +
          (ok ? t.muted : t.danger)(
            `${label}${toolCount ? ` · ${toolCount} tool${toolCount === 1 ? "" : "s"}` : ""} · ${turn.result.billing_mode === "subscription" ? "subscription" : `$${turn.result.spent_usd.toFixed(4)}`}`,
          ),
      );
      if (turn.result.error)
        lines.push(...wrap(turn.result.error, 2000).map((s) => left + t.danger(s)));
    }
  }
  lines.push("");
  return { lines: lines.map((line) => truncateToWidth(line, width)), prompts };
}
