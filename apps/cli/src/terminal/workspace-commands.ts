import { posix } from "node:path";
import type { Command } from "./commands.ts";
import {
  copyText,
  exportText,
  fileDiff,
  initializeInstructions,
  projectInstructions,
} from "./local-io.ts";

export const workspaceCommands: Command[] = [
  {
    name: "files",
    group: "Workspace",
    description: "Browse files in the session workspace",
    action: async (c) => {
      const files = await c.client.files(c.requireHead());
      const path = await c.view.choose(
        "Workspace files",
        files.map((f) => ({
          value: f.path,
          label: f.path,
          description: `${f.bytes} bytes · ${f.kind ?? "file"}`,
        })),
      );
      if (path)
        c.view.notice(
          path,
          new TextDecoder().decode(await c.client.readFile(c.requireHead(), path)),
        );
    },
  },
  {
    name: "read",
    group: "Workspace",
    description: "Read a session workspace file",
    action: async (c, arg) => {
      if (!arg) {
        c.view.draft("/read ");
        return;
      }
      const path = posix.resolve("/workspace", arg);
      c.view.notice(path, new TextDecoder().decode(await c.client.readFile(c.requireHead(), path)));
    },
  },
  {
    name: "mention",
    group: "Workspace",
    description: "Attach a local text file with @path",
    action: (c, arg) => {
      c.view.draft(arg ? `@"${arg}" ` : "@");
    },
  },
  {
    name: "diff",
    group: "Workspace",
    description: "Compare this turn's workspace with the previous turn",
    action: async (c) => {
      const head = c.requireHead();
      const index = c.session.turns.findIndex((t) => t.runId === head);
      const previous = c.session.turns[index - 1]?.runId;
      const current = await c.client.files(head);
      const before = previous ? await c.client.files(previous) : [];
      const paths = [
        ...new Set(
          [...current, ...before].filter((f) => !f.kind || f.kind === "file").map((f) => f.path),
        ),
      ];
      const chunks: string[] = [];
      for (const path of paths) {
        const oldEntry = before.find((f) => f.path === path);
        const newEntry = current.find((f) => f.path === path);
        if ((oldEntry?.bytes ?? 0) > 131072 || (newEntry?.bytes ?? 0) > 131072) {
          chunks.push(`${path}: file exceeds the 128 KiB diff preview limit`);
          continue;
        }
        const oldBytes =
          oldEntry && previous ? await c.client.readFile(previous, path) : new Uint8Array();
        const newBytes = newEntry ? await c.client.readFile(head, path) : new Uint8Array();
        if (Buffer.from(oldBytes).equals(Buffer.from(newBytes))) continue;
        const decoder = new TextDecoder("utf-8", { fatal: true });
        try {
          chunks.push(await fileDiff(decoder.decode(oldBytes), decoder.decode(newBytes), path));
        } catch {
          chunks.push(`${path}: binary or unavailable text diff`);
        }
      }
      c.view.notice("Workspace diff", chunks.join("\n") || "No file changes.");
    },
  },
  {
    name: "review",
    aliases: ["code-review"],
    group: "Workspace",
    description: "Review the current workspace with read-only tools",
    action: async (c, arg) => {
      const files = await c.client.files(c.requireHead());
      c.preferences.mode = "read_only";
      c.settingsChanged();
      await c.submit(
        `Review the current workspace for correctness, maintainability and missing validation. Read the relevant files; report concrete findings with paths. Do not edit anything.\nFiles:\n${files.map((f) => f.path).join("\n")}\n${arg}`,
      );
    },
  },
  {
    name: "copy",
    group: "Workspace",
    description: "Copy the latest response to the clipboard",
    action: async (c) => {
      await copyText(c.lastAnswer());
      c.view.notice("Copied", "Response copied to the system clipboard.");
    },
  },
  {
    name: "export",
    group: "Workspace",
    description: "Export the conversation to a new Markdown file",
    action: (c, arg) => {
      c.view.notice("Exported", exportText(c.cwd, arg, c.transcript()));
    },
  },
  {
    name: "init",
    group: "Workspace",
    description: "Create a local AGENTS.md without overwriting existing work",
    action: (c) => {
      c.view.notice("Project instructions", initializeInstructions(c.cwd));
    },
  },
  {
    name: "memory",
    aliases: ["memories"],
    group: "Workspace",
    description: "Inspect local AGENTS.md and CLAUDE.md",
    action: (c) => {
      c.view.notice(
        "Project instructions",
        projectInstructions(c.cwd) ||
          "No AGENTS.md or CLAUDE.md found. Use /init to create AGENTS.md.",
      );
    },
  },
];
