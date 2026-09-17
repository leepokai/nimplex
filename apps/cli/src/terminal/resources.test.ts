import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandRegistry } from "./commands.ts";
import type { Controller } from "./controller.ts";
import { expandResource, loadResources, type PromptResource } from "./resources.ts";
import { type Preferences, SessionStore } from "./store.ts";

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "nimplex-resources-"));
  cleanup.push(dir);
  const cwd = join(dir, "project"),
    global = join(dir, "config"),
    pi = join(dir, "pi");
  mkdirSync(cwd);
  vi.stubEnv("PI_CODING_AGENT_DIR", pi);
  const write = (file: string, text: string) => {
    const path = join(cwd, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  };
  return { dir, cwd, global, pi, write, load: () => loadResources(cwd, global, pi) };
}

describe("Pi-compatible declarative resources", () => {
  it("loads project prompts and existing .agents skills with deterministic precedence, without executing extensions", () => {
    const f = fixture();
    f.write(".pi/prompts/review.md", "---\ndescription: Review code\n---\nReview $1.");
    f.write(".nimplex/prompts/review.md", "Review preferred $ARGUMENTS.");
    f.write(
      ".agents/skills/testing/SKILL.md",
      "---\nname: testing\ndescription: Test a module\n---\nCover failure cases.",
    );
    f.write("AGENTS.md", "Use English comments.");
    f.write(".pi/extensions/unsafe.ts", 'throw new Error("Executable extension must not load");');
    const snapshot = f.load();
    expect(snapshot.commands.map((r) => r.name)).toEqual(["review", "skill:testing"]);
    expect(snapshot.commands[0]?.content).toContain("preferred");
    expect(snapshot.context).toContain("Use English comments.");
    expect(snapshot.diagnostics.join("\n")).toContain("duplicate /review");
  });
  it("rebuilds additions, edits and deletions without changing the old resource snapshot", () => {
    const f = fixture();
    f.write(".pi/prompts/review.md", "Old prompt");
    const old = f.load();
    f.write(".pi/prompts/review.md", "New prompt");
    f.write(".pi/prompts/explain.md", "Explain $1");
    const next = f.load();
    expect(old.commands[0]?.content).toBe("Old prompt");
    expect(next.commands.find((r) => r.name === "review")?.content).toBe("New prompt");
    rmSync(join(f.cwd, ".pi/prompts/review.md"));
    expect(f.load().commands.map((r) => r.name)).toEqual(["explain"]);
    f.write(".pi/prompts/broken.md", "---\ndescription: [invalid\n---\nPrompt");
    expect(f.load).toThrow();
  });
  it("expands quoted positional/default/slice arguments once and never executes shell expressions", () => {
    const f = fixture();
    const resource: PromptResource = {
      name: "test",
      path: "test.md",
      kind: "prompt",
      description: "Test",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Test literal Pi prompt placeholders.
      content: "$1|$2|${3:-fallback}|${@:2}|${@:1:1}|$ARGUMENTS",
    };
    const result = expandResource(resource, `'two  words' '$(touch ${join(f.dir, "unsafe")})'`);
    expect(result).toContain("two  words|$(touch");
    expect(result).toContain("|fallback|");
    expect(existsSync(join(f.dir, "unsafe"))).toBe(false);
    expect(expandResource({ ...resource, content: "$1" }, "'$2'")).toBe("$2");
    expect(() => expandResource(resource, "'unfinished")).toThrow("Unclosed quote");
  });
  it("keeps builtins authoritative and expands a dynamic command into the draft without submitting", async () => {
    const f = fixture();
    f.write(".pi/prompts/reload.md", "Do not override reload");
    f.write(".pi/prompts/check-code.md", "Review $1 and $2");
    const draft = vi.fn(),
      submit = vi.fn();
    const c = { resources: f.load(), view: { draft }, submit } as unknown as Controller;
    const registry = new CommandRegistry();
    registry.refresh(c);
    expect(registry.commands.filter((command) => command.name === "reload")).toHaveLength(1);
    expect(c.resources.diagnostics.join("\n")).toContain("Built-in /reload");
    await registry.execute(c, '/check-code "two  words" next');
    expect(draft).toHaveBeenCalledWith("Review two  words and next");
    expect(submit).not.toHaveBeenCalled();
    expect(registry.commands.find((command) => command.name === "keybindings")?.aliases).toContain(
      "hotkeys",
    );
  });
  it("rejects invalid preference files on reload while startup can retain defaults", () => {
    const f = fixture();
    const store = new SessionStore({} as never, f.cwd, f.global);
    const defaults: Preferences = {
      theme: "dark",
      model: "claude-haiku-4-5",
      sandbox: "e2b",
      mode: "read_only",
      expanded: false,
      statusline: true,
      budget: 0.2,
      timeout: 180,
    };
    writeFileSync(join(store.directory, "preferences.json"), '{"budget":-1}');
    expect(() => store.preferences(defaults, true)).toThrow("budget");
    expect(store.preferences(defaults).budget).toBe(0.2);
    writeFileSync(join(store.directory, "preferences.json"), '{"theme":["dark"]}');
    expect(() => store.preferences(defaults, true)).toThrow("theme");
    writeFileSync(join(store.directory, "preferences.json"), '{"theme":"light"}');
    expect(store.preferences(defaults, true)).toMatchObject({ theme: "light", mode: "read_only" });
    writeFileSync(join(store.directory, "preferences.json"), "{");
    expect(() => store.preferences(defaults, true)).toThrow();
  });
});
