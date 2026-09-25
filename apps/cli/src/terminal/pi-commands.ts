import { join } from "node:path";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { sandboxEstimate } from "../display.ts";
import { piAgentDirectory } from "../local-runtime.ts";
import type { Command } from "./commands.ts";

export const unsupportedPiCommands: Record<string, string> = {
  "scoped-models":
    "Model cycling scopes are not implemented. Use /model to select from the priced catalog.",
  llama:
    "The runtime currently uses Anthropic-compatible Messages endpoints; llama.cpp router management is not implemented.",
  import:
    "Pi JSONL import is not implemented. /resume opens nimplex SQLite sessions; /export writes Markdown.",
  share: "Public/gist sharing is not implemented. /export saves a local Markdown transcript.",
};

export const piCommands: Command[] = [
  {
    name: "trust",
    group: "Settings",
    description: "Trust this project's .pi/extensions for Pi harness sessions (shared with Pi)",
    action: async (c, arg) => {
      const store = new ProjectTrustStore(piAgentDirectory());
      const value =
        arg ||
        (await c.view.choose("Trust project folder?", [
          {
            value: "yes",
            label: "Trust",
            description: `Execute ${c.session.cwd}/.pi/extensions in harness sessions`,
          },
          { value: "no", label: "Do not trust", description: "Only user extensions run" },
        ]));
      if (!value) return;
      if (!["yes", "no"].includes(value)) throw new Error("Choose yes or no.");
      store.set(c.session.cwd, value === "yes");
      c.client.reloadExtensions();
      c.view.notice(
        "Project trust",
        `${c.session.cwd}: ${value === "yes" ? "trusted" : "not trusted"}. Recorded in ${join(piAgentDirectory(), "trust.json")}; the next Pi harness turn reloads extensions.`,
      );
    },
  },
  {
    name: "extensions",
    group: "Settings",
    description: "List the Pi extensions a harness turn in this project would run",
    action: async (c) => {
      const summary = await c.client.extensions(c.session.cwd);
      if (!summary) {
        c.view.notice("Extensions", "This runtime does not load Pi extensions.");
        return;
      }
      c.view.notice(
        "Extensions",
        [
          `Project .pi/extensions: ${summary.projectTrusted ? "trusted" : "not trusted (/trust)"}`,
          `Engine: ${c.session.engine === "pi-harness" ? "Pi harness" : "legacy executor (extensions do not run; open a new session without NIMPLEX_ENGINE=pi-executor)"}`,
          ...summary.extensions.map(
            (extension) =>
              `• ${extension.path}${extension.tools.length ? ` · tools: ${extension.tools.join(", ")}` : ""}${extension.events.length ? ` · events: ${extension.events.join(", ")}` : ""}`,
          ),
          ...summary.errors.map((error) => `✗ ${error.path}: ${error.error}`),
          summary.extensions.length || summary.errors.length ? "" : "No extensions loaded.",
        ].join("\n"),
      );
    },
  },
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
          `Sandbox: ${sandboxEstimate(c.client.sandboxUsage(c.session.id)) ?? "none metered"}`,
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
          "Pi extensions run in Pi harness sessions: user extensions always, project .pi/extensions after /trust. Source-code hot replacement is not implemented.",
        ].join("\n"),
      ),
  },
];
