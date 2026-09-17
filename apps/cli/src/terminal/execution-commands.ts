import type { Command } from "./commands.ts";

export const executionCommands: Command[] = [
  {
    name: "model",
    group: "Run",
    description: "Choose a supported model from the runtime",
    action: async (c, arg) => {
      const models = await c.client.models();
      const value =
        arg ||
        (await c.view.choose(
          "Model",
          models.map((m) => ({
            value: m.model,
            label: m.model,
            description:
              m.billing_mode === "subscription"
                ? "ChatGPT subscription · provider quota applies"
                : `$${m.input_per_mtok}/$${m.output_per_mtok} per MTok`,
          })),
        ));
      if (!value) return;
      if (!models.some((m) => m.model === value))
        throw new Error("This model is not in the runtime's priced catalog.");
      c.preferences.model = value;
      c.settingsChanged();
    },
  },
  {
    name: "plan",
    group: "Run",
    description: "Toggle read-only planning; optionally send a prompt",
    action: async (c, arg) => {
      c.preferences.mode = arg
        ? "read_only"
        : c.preferences.mode === "build"
          ? "read_only"
          : "build";
      c.settingsChanged();
      if (arg) await c.submit(arg);
    },
  },
  {
    name: "permissions",
    aliases: ["approvals"],
    group: "Run",
    description: "Choose read-only or isolated workspace editing",
    action: async (c, arg) => {
      const value =
        arg ||
        (await c.view.choose("Execution permissions", [
          {
            value: "read_only",
            label: "Read only / Plan",
            description: "Read and archive tools only; writes and shell are unavailable",
          },
          {
            value: "build",
            label: "Workspace edits",
            description: "Read, write, edit and isolated sandbox execution",
          },
        ]));
      if (!value) return;
      if (value !== "build" && value !== "read_only") throw new Error("Use build or read_only.");
      c.preferences.mode = value;
      c.settingsChanged();
    },
  },
  {
    name: "sandbox",
    group: "Run",
    description: "Choose Docker or E2B",
    action: async (c, arg) => {
      const providers = (await c.client.sandboxProviders()).filter(
        (p) => p.available && ["e2b", "docker"].includes(p.id),
      );
      const value =
        arg ||
        (await c.view.choose(
          "Sandbox",
          providers.map((p) => ({ value: p.id, label: p.id })),
        ));
      if (!value) return;
      if (!providers.some((p) => p.id === value) || (value !== "e2b" && value !== "docker"))
        throw new Error("Choose an available isolated sandbox.");
      c.preferences.sandbox = value;
      c.settingsChanged();
    },
  },
  {
    name: "budget",
    group: "Run",
    description: "Set the model budget for subsequent turns",
    action: (c, arg) => {
      if (!arg) {
        c.view.notice(
          "Model budget",
          c.preferences.model.startsWith("openai-codex/")
            ? "Codex uses subscription quota. USD model budgets do not cap subscription usage. /timeout still applies. Sandbox charges are separate."
            : `$${c.preferences.budget} per turn. Use /budget 0.50 to change it. Sandbox charges are separate.`,
        );
        return;
      }
      const value = Number(arg);
      if (!Number.isFinite(value) || value <= 0)
        throw new Error("Budget must be a positive USD amount.");
      c.preferences.budget = value;
      c.settingsChanged();
      if (c.preferences.model.startsWith("openai-codex/"))
        c.view.notice(
          "API budget saved",
          "This budget applies when using an API model. Codex subscription quota is provider-managed; /timeout still applies.",
        );
    },
  },
  {
    name: "stop",
    aliases: ["kill"],
    group: "Run",
    description: "Stop the active task in the runtime",
    action: async (c) => {
      await c.stop();
    },
  },
  {
    name: "tasks",
    aliases: ["ps"],
    group: "Run",
    description: "Inspect active and background tasks",
    action: async (c) => {
      const choice = await c.view.choose(
        "Active tasks",
        [...c.tasks.values()].map((t) => ({
          value: t.session.id,
          label: t.session.title,
          description: t.turn.runId ?? "Starting…",
        })),
      );
      const task = choice ? c.tasks.get(choice) : undefined;
      if (task) {
        c.session = task.session;
        c.changed();
      }
    },
  },
  {
    name: "runs",
    group: "Run",
    description: "List recent runs in this project",
    action: async (c) => {
      const runs = await c.client.listTurns(20);
      c.view.notice(
        "Recent runs",
        runs
          .map(
            (r) =>
              `${r.id}  ${r.status}  ${r.billing_mode === "subscription" ? "subscription" : `$${r.spent_usd.toFixed(6)}`}`,
          )
          .join("\n") || "No runs yet.",
      );
    },
  },
  {
    name: "status",
    group: "Run",
    description: "Inspect model, mode, workspace and current run",
    action: async (c) => {
      const run = c.head ? await c.client.getTurn(c.head) : undefined;
      c.view.notice(
        "Session status",
        `Conversation: ${c.session.title}\nModel: ${c.preferences.model}\nMode: ${c.preferences.mode}\nSandbox: ${c.preferences.sandbox}\nWorkspace: /workspace (isolated session)\nNext-turn billing: ${c.preferences.model.startsWith("openai-codex/") ? "subscription quota (USD cap does not apply)" : `$${c.preferences.budget} API budget`}\nRun: ${run?.id ?? "none"}\nStatus: ${run?.status ?? "ready"}`,
      );
    },
  },
  {
    name: "cost",
    aliases: ["usage"],
    group: "Run",
    description: "Show actual model usage for this conversation",
    action: (c) => {
      const turns = c.session.turns;
      const spent = turns.reduce((sum, t) => sum + (t.result?.spent_usd ?? 0), 0);
      const subscriptionTurns = turns.filter(
        (t) => t.result?.billing_mode === "subscription",
      ).length;
      c.view.notice(
        "Model usage",
        `${turns.length} turns · $${spent.toFixed(6)} recorded API model cost\n${turns.map((t, i) => `${i + 1}. ${t.result?.status ?? "pending"}  ${t.result?.billing_mode === "subscription" ? "subscription" : `$${(t.result?.spent_usd ?? 0).toFixed(6)}`}`).join("\n")}\n${subscriptionTurns} subscription turns: token usage is recorded in events; remaining plan quota is not available here.\nSandbox/storage/network charges are separate. In-flight or unknown reservations are not final charges.`,
      );
    },
  },
  {
    name: "context",
    group: "Run",
    description: "Inspect conversation size and compaction state",
    action: (c) => {
      const size = Buffer.byteLength(JSON.stringify(c.session.turns));
      c.view.notice(
        "Context",
        `${c.session.turns.length} turns\n${size.toLocaleString()} bytes in the local transcript (not a token count)\nNext turn: ${c.nextContextMode}\nThe runtime builds model context from canonical events and verified checkpoints.`,
      );
    },
  },
];
