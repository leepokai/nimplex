import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { loadSkills, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { safeText } from "../display.ts";
import { projectInstructions } from "./local-io.ts";
import { configDirectory } from "./store.ts";

export interface PromptResource {
  name: string;
  description: string;
  content: string;
  path: string;
  kind: "skill" | "prompt";
}
export interface Resources {
  commands: PromptResource[];
  diagnostics: string[];
  context: string;
  loadedAt?: string;
}
export const emptyResources = (): Resources => ({ commands: [], diagnostics: [], context: "" });

/** Load declarative resources only. Importing a skill must never execute a host extension. */
export function loadResources(
  cwd: string,
  root = configDirectory(),
  piRoot = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
): Resources {
  const snapshot = emptyResources();
  snapshot.context = projectInstructions(cwd);
  const roots = [join(cwd, ".nimplex"), join(cwd, ".pi"), root, piRoot];
  const names = new Set<string>();
  const add = (resource: PromptResource) => {
    if (!/^(skill:)?[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(resource.name))
      throw new Error(`Invalid resource command name: ${resource.name}`);
    resource.description = safeText(resource.description, 200).replaceAll("\n", " ");
    if (names.has(resource.name)) {
      snapshot.diagnostics.push(`Ignored duplicate /${resource.name}: ${resource.path}`);
      return;
    }
    names.add(resource.name);
    snapshot.commands.push(resource);
    if (snapshot.commands.length > 512)
      throw new Error("More than 512 resources; narrow the resource directories.");
  };
  const read = (path: string) => {
    if (statSync(path).size > 131072) throw new Error(`Resource exceeds 128 KiB: ${path}`);
    return new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path));
  };
  for (const root of roots) {
    const dir = join(root, "prompts");
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).sort()) {
      if (!file.endsWith(".md")) continue;
      const path = join(dir, file);
      if (!statSync(path).isFile()) continue;
      const name = basename(file, ".md");
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name))
        throw new Error(`Invalid prompt command name: ${name}`);
      const { frontmatter, body } = parseFrontmatter<{ description?: string }>(read(path));
      add({
        name,
        path,
        kind: "prompt",
        content: body,
        description: String(
          frontmatter.description || body.split("\n").find((s) => s.trim()) || name,
        ).slice(0, 200),
      });
    }
  }
  const skills = loadSkills({
    cwd,
    agentDir: root,
    includeDefaults: false,
    skillPaths: [
      ...roots.slice(0, 2).map((dir) => join(dir, "skills")),
      join(cwd, ".agents", "skills"),
      ...roots.slice(2).map((dir) => join(dir, "skills")),
    ].filter(existsSync),
  });
  for (const diagnostic of skills.diagnostics) {
    if (diagnostic.type === "error") throw new Error(diagnostic.message);
    snapshot.diagnostics.push(
      `${diagnostic.message}${diagnostic.path ? ` (${diagnostic.path})` : ""}`,
    );
  }
  for (const skill of skills.skills) {
    const { body } = parseFrontmatter(read(skill.filePath));
    add({
      name: `skill:${skill.name}`,
      path: skill.filePath,
      kind: "skill",
      description: skill.description,
      content: body,
    });
  }
  snapshot.loadedAt = new Date().toISOString();
  return snapshot;
}

/** Positional arguments follow Pi prompt conventions; replacements never evaluate shell code. */
export function expandResource(resource: PromptResource, argument: string) {
  if (resource.kind === "skill")
    return `Use the following skill instructions for this task.\nSource: ${resource.path}\nSupporting files are local and are not automatically attached to /workspace. Ask for required files if they are unavailable.\n\n${resource.content}\n\nTask: ${argument || "Describe the task to perform with this skill."}`;
  const args: string[] = [];
  let value = "",
    quote = "",
    started = false;
  for (const char of argument.trim()) {
    if (quote) {
      if (char === quote) quote = "";
      else value += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) {
        args.push(value);
        value = "";
        started = false;
      }
    } else {
      value += char;
      started = true;
    }
  }
  if (quote) throw new Error("Unclosed quote in prompt arguments.");
  if (started) args.push(value);
  return resource.content.replace(
    /\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g,
    (_match, fallbackKey: string, fallback: string, start: string, length: string, key: string) => {
      const get = (name: string) =>
        name === "@" || name === "ARGUMENTS" ? args.join(" ") : (args[Number(name) - 1] ?? "");
      if (fallbackKey) return get(fallbackKey) || fallback;
      if (start) {
        const index = Math.max(0, Number(start) - 1);
        return args.slice(index, length ? index + Number(length) : undefined).join(" ");
      }
      return get(key);
    },
  );
}
