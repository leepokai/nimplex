import type { Command } from "./commands.ts";

export const conversationCommands: Command[] = [
  {
    name: "transcript",
    group: "Conversation",
    description: "Open the conversation and tool output in a scrollable viewer",
    action: (c) => c.view.notice("Conversation transcript", c.transcript()),
  },
  {
    name: "new",
    aliases: ["clear", "reset"],
    group: "Conversation",
    description: "Start a new conversation; keep saved history",
    action: (c) => c.fresh(),
  },
  {
    name: "resume",
    aliases: ["continue"],
    group: "Conversation",
    description: "Search and resume a saved conversation",
    action: async (c, arg) => {
      const sessions = c.store.list();
      const id =
        arg ||
        (await c.view.choose(
          "Resume conversation",
          sessions.map((s) => ({
            value: s.id,
            label: s.title,
            description: `${s.turns.length} turns · ${s.updatedAt.slice(0, 16)}`,
          })),
        ));
      if (!id) return;
      const session = sessions.find((s) => s.id === id);
      if (!session) throw new Error("Conversation not found in this account.");
      await c.resume(session);
    },
  },
  {
    name: "fork",
    aliases: ["branch", "clone"],
    group: "Conversation",
    description: "Branch the current conversation and workspace",
    action: (c) => c.fork(),
  },
  {
    name: "rewind",
    group: "Conversation",
    description: "Branch from a previous completed turn",
    action: async (c) => {
      const turns = c.session.turns.flatMap((t, i) =>
        t.result && ["completed", "killed", "canceled", "failed"].includes(t.result.status)
          ? [
              {
                value: String(i),
                label: t.prompt.slice(0, 70),
                description: `${i + 1} · ${t.result.status}`,
              },
            ]
          : [],
      );
      const choice = await c.view.choose("Rewind into a new branch", turns);
      if (choice !== undefined) c.fork(Number(choice));
    },
  },
  {
    name: "rename",
    aliases: ["name"],
    group: "Conversation",
    description: "Rename this saved conversation",
    action: (c, title) => {
      if (!title) {
        c.view.draft("/rename ");
        return;
      }
      c.session.title = title.slice(0, 120);
      c.store.save(c.session);
      c.changed();
    },
  },
  {
    name: "compact",
    group: "Conversation",
    description: "Use extractive context compaction on the next turn",
    action: (c) => {
      c.nextContextMode = "compact";
      c.view.notice(
        "Context compaction",
        "The next turn will create a durable extractive checkpoint when context exceeds 4,000 UTF-8 bytes. Original events and workspace remain intact.",
      );
    },
  },
  {
    name: "followup",
    aliases: ["follow-up"],
    group: "Conversation",
    description: "Queue a follow-up for the running Pi harness turn",
    action: async (c, text) => {
      if (!text) {
        c.view.draft("/followup ");
        return;
      }
      await c.queue("followUp", text);
    },
  },
  {
    name: "background",
    group: "Conversation",
    description: "Keep this run working and open a new conversation",
    action: (c) => {
      if (!c.active) throw new Error("No active task to background.");
      c.fresh();
    },
  },
  {
    name: "exit",
    aliases: ["quit"],
    group: "Conversation",
    description: "Close the runtime; interrupted work can be resumed",
    action: (c) => c.close(),
  },
];
