import type { Controller } from "./controller.ts";
import { conversationCommands } from "./conversation-commands.ts";
import { executionCommands } from "./execution-commands.ts";
import { piCommands, unsupportedPiCommands } from "./pi-commands.ts";
import { promptCommands, resourceCommands } from "./resource-commands.ts";
import { settingsCommands } from "./settings-commands.ts";
import { workspaceCommands } from "./workspace-commands.ts";

export interface Command {
  name: string;
  aliases?: string[];
  description: string;
  group: "Conversation" | "Run" | "Workspace" | "Settings";
  action(controller: Controller, argument: string): Promise<void> | void;
}
export class CommandRegistry {
  readonly commands: Command[];
  private readonly builtins: Command[];
  constructor() {
    this.commands = [
      ...conversationCommands,
      ...executionCommands,
      ...workspaceCommands,
      ...settingsCommands,
      ...resourceCommands,
      ...piCommands,
    ];
    this.commands.unshift({
      name: "help",
      description: "Browse commands and keyboard shortcuts",
      group: "Settings",
      action: (c) => c.view.notice("Commands", this.help()),
    });
    const names = this.commands.flatMap((c) => [c.name, ...(c.aliases ?? [])]);
    if (new Set(names).size !== names.length) throw new Error("Duplicate command or alias.");
    this.builtins = [...this.commands];
  }
  refresh(controller: Controller) {
    const reserved = new Set(
      this.builtins.flatMap((command) => [command.name, ...(command.aliases ?? [])]),
    );
    const collisions = controller.resources.commands.filter((resource) =>
      reserved.has(resource.name),
    );
    for (const resource of collisions) {
      const message = `Built-in /${resource.name} takes precedence over ${resource.path}`;
      if (!controller.resources.diagnostics.includes(message))
        controller.resources.diagnostics.push(message);
    }
    this.commands.splice(
      0,
      this.commands.length,
      ...this.builtins,
      ...promptCommands(controller, reserved),
    );
  }
  help() {
    return this.commands
      .map(
        (c) =>
          `/${c.name.padEnd(14)} ${c.description}${c.aliases?.length ? ` (${c.aliases.map((a) => `/${a}`).join(", ")})` : ""}`,
      )
      .join("\n");
  }
  async execute(controller: Controller, input: string) {
    const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(input.trim());
    const name = match?.[1] ?? "";
    const argument = match?.[2] ?? "";
    const command = this.commands.find((c) => c.name === name || c.aliases?.includes(name ?? ""));
    if (!command)
      throw new Error(
        unsupportedPiCommands[name] ??
          `Unknown command /${name}. Type /help or use the command menu.`,
      );
    await command.action(controller, argument);
  }
}
