import type { Command } from "./commands.ts";

import { type Keymap, keyboardHelp } from "./keyboard.ts";

export const settingsCommands: Command[] = [
  {
    name: "login",
    group: "Settings",
    description: "Save a local model credential and exit for restart",
    action: async (c, arg) => {
      const provider =
        arg ||
        (await c.view.choose("Sign in", [
          {
            value: "codex",
            label: "Codex subscription",
            description: "Sign in with ChatGPT through Pi OAuth",
          },
          { value: "anthropic", label: "Anthropic API key" },
        ]));
      if (provider) await c.view.authenticate(provider);
    },
  },
  {
    name: "logout",
    group: "Settings",
    description: "Remove the saved model credential and close this terminal",
    action: async (c, arg) => {
      const { logout } = await import("../auth.ts");
      const provider =
        arg || (c.preferences.model.startsWith("openai-codex/") ? "codex" : "anthropic");
      if (!["anthropic", "codex", "openai-codex"].includes(provider))
        throw new Error("Choose anthropic or codex.");
      c.close();
      await logout(provider);
    },
  },
  {
    name: "theme",
    group: "Settings",
    description: "Choose a persistent terminal theme",
    action: async (c, arg) => {
      const value =
        arg ||
        (await c.view.choose("Appearance", [
          {
            value: "dark",
            label: "Midnight",
            description: "Cool blue accent, calm dark-terminal contrast",
          },
          { value: "light", label: "Paper", description: "Ink blue accents for light terminals" },
          {
            value: "mono",
            label: "Monochrome",
            description: "Use terminal colors with minimal styling",
          },
        ]));
      if (!value) return;
      if (!["dark", "light", "mono"].includes(value))
        throw new Error("Choose dark, light or mono.");
      c.preferences.theme = value as "dark" | "light" | "mono";
      c.settingsChanged();
    },
  },
  {
    name: "config",
    aliases: ["settings"],
    group: "Settings",
    description: "Choose a setting to change",
    action: async (c) => {
      const command = await c.view.choose(
        "Settings",
        ["model", "theme", "permissions", "sandbox", "budget", "timeout", "statusline"].map(
          (value) => ({ value, label: value }),
        ),
      );
      if (command) c.view.draft(`/${command} `);
    },
  },
  {
    name: "debug-config",
    group: "Settings",
    description: "Inspect settings without credentials",
    action: (c) => c.view.notice("Configuration", JSON.stringify(c.preferences, null, 2)),
  },
  {
    name: "timeout",
    group: "Settings",
    description: "Set the time limit for subsequent turns",
    action: (c, argument) => {
      const value = Number(argument);
      if (!Number.isInteger(value) || value < 1 || value > 86400)
        throw new Error("Use /timeout SECONDS (1–86400).");
      c.preferences.timeout = value;
      c.settingsChanged();
    },
  },
  {
    name: "keybindings",
    aliases: ["keymap", "terminal-setup", "hotkeys"],
    group: "Settings",
    description: "Show keyboard controls and terminal setup guidance",
    action: (c, argument) => {
      if (argument) {
        if (!["nimplex", "claude", "codex"].includes(argument))
          throw new Error("Use /keymap nimplex, /keymap claude or /keymap codex.");
        c.preferences.keymap = argument as Keymap;
        c.settingsChanged();
      }
      c.view.notice("Keyboard controls", keyboardHelp(c.preferences.keymap));
    },
  },
  {
    name: "statusline",
    group: "Settings",
    description: "Toggle the detailed footer",
    action: (c) => {
      c.preferences.statusline = !c.preferences.statusline;
      c.settingsChanged();
    },
  },
  {
    name: "doctor",
    group: "Settings",
    description: "Check local credentials, models and sandbox availability",
    action: async (c) => {
      const { readCredential } = await import("../auth.ts");
      let credential = "Configured";
      try {
        if (c.preferences.model.startsWith("openai-codex/")) {
          const { codexAccounts } = await import("../codex-auth.ts");
          if (!(await (await codexAccounts()).checkAuth("openai-codex")))
            throw new Error("Missing login");
          credential = "Codex subscription login present (availability not tested)";
        } else readCredential();
      } catch {
        credential = "Missing: use /login and choose the selected model's provider";
      }
      const providers = await c.client.sandboxProviders();
      c.view.notice(
        "Runtime diagnostics",
        [
          "Execution: local runtime (no API or worker)",
          `Credential: ${credential}`,
          `Models: ${c.client.models().length}`,
          ...providers.map((p) => `${p.id}: ${p.available ? "available" : "not configured"}`),
        ].join("\n"),
      );
    },
  },
];
