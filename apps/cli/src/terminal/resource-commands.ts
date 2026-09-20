import type { Command } from "./commands.ts";
import { expandResource } from "./resources.ts";

export const resourceCommands: Command[] = [
  {
    name: "reload",
    group: "Settings",
    description: "Reload preferences, prompts, skills and context; retain this session",
    action: (c) => {
      c.reloadResources();
      c.client.reloadExtensions();
      c.view.notice(
        "Resources reloaded",
        [
          `${c.resources.commands.filter((r) => r.kind === "prompt").length} prompts · ${c.resources.commands.filter((r) => r.kind === "skill").length} skills`,
          "Preferences, keymap, appearance and command completion refreshed.",
          "AGENTS.md / CLAUDE.md validated; new instructions apply to subsequent turns.",
          "Conversation, draft, running tasks and workspace retained.",
          ...c.resources.diagnostics,
          "",
          "Pi extensions reload on the next harness turn. Built-in tool implementations, UI source and .env are not reloaded. Restart for those changes.",
        ].join("\n"),
      );
    },
  },
  ...(["skills", "prompts"] as const).map(
    (name): Command => ({
      name,
      group: "Settings",
      description: `Browse loaded ${name}; expand into the draft`,
      action: async (c) => {
        const resources = c.resources.commands.filter(
          (r) => r.kind === (name === "skills" ? "skill" : "prompt"),
        );
        const selected = await c.view.choose(
          `Loaded ${name}`,
          resources.map((r) => ({
            value: r.name,
            label: `/${r.name}`,
            description: r.description,
          })),
        );
        if (selected) c.view.draft(`/${selected} `);
      },
    }),
  ),
];

export function promptCommands(
  controller: import("./controller.ts").Controller,
  reserved: Set<string>,
): Command[] {
  return controller.resources.commands
    .filter((resource) => !reserved.has(resource.name))
    .map((resource) => ({
      name: resource.name,
      group: "Workspace",
      description: resource.description,
      action: (c, argument) => c.view.draft(expandResource(resource, argument)),
    }));
}
