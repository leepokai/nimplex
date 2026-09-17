import type { Command } from "./commands.ts";

export const unsupportedPiCommands: Record<string, string> = {
  thinking:
    "Extended thinking is disabled in this runtime's accounting path. /model selects supported models; /thinking is not implemented.",
  "scoped-models":
    "Model cycling scopes are not implemented. Use /model to select from the priced catalog.",
  llama:
    "The runtime currently uses Anthropic-compatible Messages endpoints; llama.cpp router management is not implemented.",
  trust:
    "Executable Pi extensions are not loaded. Declarative prompts and skill instructions can be inspected with /prompts and /skills.",
  import:
    "Pi JSONL import is not implemented. /resume opens nimplex SQLite sessions; /export writes Markdown.",
  share: "Public/gist sharing is not implemented. /export saves a local Markdown transcript.",
};

export const piCommands: Command[] = [
  {
    name: "session",
    group: "Conversation",
    description: "Inspect session identity, branches, turns and cost",
    action: (c) =>
      c.view.notice(
        "Session information",
        [
          `Name: ${c.session.title}`,
          `Session: ${c.session.id}`,
          `Project: ${c.session.cwd}`,
          `Parent session: ${c.session.parentSessionId ?? "none"}`,
          `Head turn: ${c.head ?? "none"}`,
          `Turns: ${c.session.turns.length}`,
          `Events: ${c.session.turns.reduce((sum, turn) => sum + turn.events.length, 0)}`,
          `Recorded API cost: $${c.session.turns.reduce((sum, turn) => sum + (turn.result?.spent_usd ?? 0), 0).toFixed(6)} (subscription quota excluded)`,
          `State: ${c.active ? "working" : "idle"}`,
          "Storage: local SQLite",
          `Resource snapshot: ${c.resources.loadedAt ?? "not loaded"}`,
        ].join("\n"),
      ),
  },
  {
    name: "tree",
    group: "Conversation",
    description: "Navigate related sessions or branch from a completed turn",
    action: async (c) => {
      const sessions = c.store.list();
      const byId = new Map(sessions.map((session) => [session.id, session]));
      const rootOf = (id: string) => {
        const visited = new Set<string>();
        while (byId.get(id)?.parentSessionId && !visited.has(id)) {
          visited.add(id);
          id = byId.get(id)?.parentSessionId ?? id;
        }
        return id;
      };
      const owner = c.session;
      const root = rootOf(owner.id);
      const related = sessions.filter((session) => rootOf(session.id) === root);
      const choice = await c.view.choose("Conversation tree", [
        ...related.map((s) => ({
          value: `session:${s.id}`,
          label: `${s.id === owner.id ? "● " : "  "}${s.title}`,
          description: `${s.parentSessionId ? "Branch" : "Root"} · ${s.turns.length} turns · ${s.id.slice(0, 8)}`,
        })),
        ...owner.turns.flatMap((turn, index) =>
          turn.result &&
          ["completed", "failed", "killed", "canceled"].includes(turn.result.status) &&
          turn.result.error !== "runtime_interrupted"
            ? [
                {
                  value: `turn:${index}`,
                  label: `  ↳ ${index + 1}. ${turn.prompt.slice(0, 70)}`,
                  description: "Create a new branch after this turn",
                },
              ]
            : [],
        ),
      ]);
      if (choice?.startsWith("session:")) {
        const session = byId.get(choice.slice(8));
        if (session) await c.resume(session);
      } else if (choice?.startsWith("turn:")) {
        if (c.session.id !== owner.id)
          throw new Error("The visible session changed; open /tree again.");
        c.fork(Number(choice.slice(5)));
      }
    },
  },
  {
    name: "changelog",
    group: "Settings",
    description: "Show recent nimplex terminal changes",
    action: (c) =>
      c.view.notice(
        "nimplex terminal changes",
        [
          "2026-09-14",
          "• /reload: refresh declarative resources and terminal preferences in place.",
          "• /skills, /prompts, /skill:name and /template: expand reusable instructions into the draft.",
          "• Pi command equivalents: /hotkeys, /name, /session, /tree, /clone.",
          "",
          "2026-09-13",
          "• In-process Pi runtime, SQLite sessions and session-scoped workspaces.",
          "• Prompt blocks, tool previews, multiline composer, keyboard profiles and draft stash.",
          "",
          "Executable extensions and source-code hot replacement are not implemented.",
        ].join("\n"),
      ),
  },
];
