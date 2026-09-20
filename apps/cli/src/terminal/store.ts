import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type { SessionSnapshot as Session, SessionTurn as Turn } from "@nimplex/contracts";

import {
  type SessionSnapshot as Session,
  type ThinkingLevelId,
  thinkingLevel,
} from "@nimplex/contracts";
import type { NimplexRuntime } from "@nimplex/runtime";

export interface Preferences {
  keymap?: "nimplex" | "claude" | "codex";
  theme: "dark" | "light" | "mono";
  model: string;
  sandbox: "e2b" | "docker";
  timeout: number;
  mode: "build" | "read_only";
  /** Pi thinking level for harness sessions; absent means off. */
  thinking?: ThinkingLevelId;
  expanded: boolean;
  statusline: boolean;
}
export const configDirectory = () =>
  join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "nimplex");

export class SessionStore {
  readonly directory: string;
  constructor(
    readonly runtime: NimplexRuntime,
    readonly cwd: string,
    root = configDirectory(),
  ) {
    this.directory = join(root, "terminal");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
  }
  create(title = "New conversation"): Session {
    return this.runtime.createSession(this.cwd, title);
  }
  save(session: Session) {
    // Only presentation metadata is editable here. Events and execution state belong to runtime.
    if (this.runtime.getSession(session.id).title !== session.title)
      this.runtime.renameSession(session.id, session.title);
  }
  list(): Session[] {
    return this.runtime.listSessions();
  }
  preferences(defaults: Preferences, strict = false): Preferences {
    const path = join(this.directory, "preferences.json");
    if (!existsSync(path)) return defaults;
    try {
      const p = JSON.parse(readFileSync(path, "utf8"));
      if (strict) {
        if (!p || typeof p !== "object" || Array.isArray(p))
          throw new Error("Preferences must be a JSON object.");
        const valid: Record<string, (value: unknown) => boolean> = {
          keymap: (v) =>
            typeof v === "string" && ["nimplex", "claude", "codex"].includes(v as string),
          theme: (v) => typeof v === "string" && ["dark", "light", "mono"].includes(v as string),
          model: (v) => typeof v === "string" && v.length > 0,
          sandbox: (v) => typeof v === "string" && ["e2b", "docker"].includes(v as string),
          timeout: (v) => typeof v === "number" && Number.isInteger(v) && v > 0 && v <= 86400,
          mode: (v) => typeof v === "string" && ["build", "read_only"].includes(v as string),
          thinking: (v) => thinkingLevel.safeParse(v).success,
          expanded: (v) => typeof v === "boolean",
          statusline: (v) => typeof v === "boolean",
        };
        for (const [name, check] of Object.entries(valid))
          if (name in p && !check(p[name])) throw new Error(`Invalid preference: ${name}`);
      }
      return {
        ...defaults,
        keymap: ["nimplex", "claude", "codex"].includes(p.keymap)
          ? p.keymap
          : (defaults.keymap ?? "nimplex"),
        theme: ["dark", "light", "mono"].includes(p.theme) ? p.theme : defaults.theme,
        model: typeof p.model === "string" ? p.model : defaults.model,
        sandbox: ["e2b", "docker"].includes(p.sandbox) ? p.sandbox : defaults.sandbox,
        timeout:
          Number.isInteger(p.timeout) && p.timeout > 0 && p.timeout <= 86400
            ? p.timeout
            : defaults.timeout,
        mode: ["build", "read_only"].includes(p.mode) ? p.mode : defaults.mode,
        ...(thinkingLevel.safeParse(p.thinking).success ? { thinking: p.thinking } : {}),
        expanded: typeof p.expanded === "boolean" ? p.expanded : defaults.expanded,
        statusline: typeof p.statusline === "boolean" ? p.statusline : defaults.statusline,
      };
    } catch (error) {
      if (strict) throw error;
      return defaults;
    }
  }
  savePreferences(preferences: Preferences) {
    this.write("preferences.json", preferences);
  }
  private write(name: string, value: unknown) {
    const temp = join(this.directory, `.${randomUUID()}.tmp`);
    writeFileSync(temp, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temp, join(this.directory, name));
  }
}
