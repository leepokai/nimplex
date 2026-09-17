import { stripVTControlCharacters } from "node:util";
import { type Terminal, visibleWidth } from "@earendil-works/pi-tui";
import type { RunEvent, RunResponse } from "@nimplex/contracts";
import type { NimplexRuntime } from "@nimplex/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Controller } from "./controller.ts";
import type { Preferences, Session, SessionStore } from "./store.ts";
import { renderConversation } from "./transcript.ts";
import { View } from "./view.ts";

class TestTerminal implements Terminal {
  columns = 80;
  rows = 30;
  kittyProtocolActive = false;
  input: (data: string) => void = () => {};
  resize = () => {};
  start(input: (data: string) => void, resize: () => void) {
    this.input = input;
    this.resize = resize;
  }
  stop() {}
  async drainInput() {}
  write() {}
  moveBy() {}
  hideCursor() {}
  showCursor() {}
  clearLine() {}
  clearFromCursor() {}
  clearScreen() {}
  setTitle() {}
  setProgress() {}
}
const preferences: Preferences = {
  theme: "dark",
  model: "claude-haiku-45",
  sandbox: "e2b",
  budget: 0.2,
  timeout: 180,
  mode: "build",
  expanded: false,
  statusline: true,
};
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
function fixture() {
  const terminal = new TestTerminal();
  const session: Session = {
    version: 1,
    id: "session",
    title: "New conversation",
    cwd: "/tmp",
    updatedAt: new Date().toISOString(),
    turns: [],
  };
  const store = { create: () => session, list: () => [], savePreferences: vi.fn() };
  const controller = new Controller(
    {} as NimplexRuntime,
    store as unknown as SessionStore,
    { ...preferences },
    "/tmp",
  );
  const view = new View(controller, terminal);
  controller.view = view;
  cleanups.push(() => controller.close());
  view.start();
  return { view, controller, terminal, session };
}

describe("terminal composer integration", () => {
  it("preserves a draft when Enter is pressed during execution", () => {
    const f = fixture();
    f.controller.tasks.set(f.session.id, {
      session: f.session,
      turn: { prompt: "busy", events: [] },
      observer: new AbortController(),
      stopRequested: false,
    });
    f.view.editor.setText("Draft 中文\nsecond line");
    f.terminal.input("\r");
    expect(f.view.editor.getExpandedText()).toBe("Draft 中文\nsecond line");
    expect(f.session.turns).toHaveLength(0);
  });
  it("stashes expanded pastes and restores them without sending a prompt", () => {
    const f = fixture();
    const text = "中文 pasted text\n".repeat(20).trim();
    f.terminal.input(`\u001b[200~${text}\u001b[201~`);
    f.terminal.input("\u0013");
    expect(f.view.editor.getText()).toBe("");
    f.terminal.input("\u0013");
    expect(f.view.editor.getExpandedText()).toBe(text);
    expect(f.session.turns).toHaveLength(0);
  });
  it("keeps Home/End in the composer and supports newline, deletion, undo and history aliases", () => {
    const f = fixture();
    f.view.editor.addToHistory("older");
    f.terminal.input("\u0010");
    expect(f.view.editor.getText()).toBe("older");
    f.view.editor.setText("hello");
    f.terminal.input("\u001b[H");
    f.terminal.input("\u0004");
    expect(f.view.editor.getText()).toBe("ello");
    expect(f.controller.closed).toBe(false);
    f.terminal.input("\u001f");
    expect(f.view.editor.getText()).toBe("hello");
    f.terminal.input("\u001b[F");
    f.terminal.input("\u000a");
    f.terminal.input("next");
    expect(f.view.editor.getText()).toBe("hello\nnext");
    f.terminal.input("\u0001");
    f.terminal.input("\u000b");
    f.terminal.input("\u0019");
    expect(f.view.editor.getText()).toBe("hello\nnext");
  });
  it("restores discarded drafts through search and cancels menus without interrupting", async () => {
    const f = fixture();
    f.view.editor.setText("discarded 中文");
    f.terminal.input("\u001b");
    f.terminal.input("\u001b");
    f.terminal.input("\u0012");
    expect(f.view.tui.hasOverlay()).toBe(true);
    f.terminal.input("\t");
    await Promise.resolve();
    expect(f.view.editor.getText()).toBe("discarded 中文");
    const stop = vi.spyOn(f.controller, "stop");
    const choice = f.view.choose("Choose", [
      { value: "a", label: "Alpha" },
      { value: "b", label: "Beta" },
    ]);
    f.terminal.input("\u0003");
    expect(await choice).toBeUndefined();
    expect(stop).not.toHaveBeenCalled();
    expect(f.view.editor.getText()).toBe("discarded 中文");
  });
  it("changes the keymap immediately and preserves the current draft", async () => {
    const f = fixture();
    f.view.editor.setText("keep draft");
    await f.view.dispatch("/keymap codex");
    f.terminal.input("\u001b");
    f.terminal.input("\u0002");
    expect(f.view.editor.getCursor().col).toBe(9);
    f.terminal.input("\u0014");
    expect(f.view.tui.hasOverlay()).toBe(true);
    f.terminal.input("\u0014");
    expect(f.view.tui.hasOverlay()).toBe(false);
    expect(f.view.editor.getText()).toBe("keep draft");
  });
  it("bounds the real composer and screen at narrow sizes with CJK and multiline input", () => {
    const f = fixture();
    for (const width of [24, 40, 60, 100, 140]) {
      f.terminal.columns = width;
      for (const text of ["", "中文與 emoji 🛠️ ".repeat(20), "line\n".repeat(25)]) {
        f.view.editor.setText(text);
        const lines = f.view.editor.render(width);
        expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
        expect(stripVTControlCharacters(lines[0] ?? "")).toContain("╭");
      }
    }
  });
});

describe("conversation rendering", () => {
  it("separates literal prompts, wrapped tools, failures and answers without exposing control sequences or run IDs", () => {
    const event = (type: RunEvent["type"], payload: RunEvent["payload"], seq: number) =>
      ({ seq, type, payload, created_at: "2026-09-13" }) satisfies RunEvent;
    const session: Session = {
      version: 1,
      id: "s",
      title: "Test",
      cwd: "/tmp",
      updatedAt: "now",
      turns: [
        {
          prompt: "## 請安裝 package 🛠️",
          runId: "opaque-run-id",
          events: [
            event("message.delta", { text: "I will inspect the workspace." }, 1),
            event(
              "tool.call",
              {
                id: "tool",
                name: "bash",
                input: { command: "cd /workspace && npm install some-package-with-a-long-name" },
              },
              2,
            ),
            event(
              "tool.result",
              {
                id: "tool",
                name: "bash",
                is_error: true,
                content: [
                  {
                    type: "text",
                    text:
                      "ERROR install failed\n" +
                      "debug output\n".repeat(12) +
                      "\u001b]52;c;EVIL\u0007",
                  },
                ],
              },
              3,
            ),
            event(
              "message.delta",
              { text: "The installation failed; the workspace was preserved." },
              4,
            ),
          ],
          result: { status: "failed", spent_usd: 0.023794, error: "test failure" } as RunResponse,
        },
      ],
    };
    for (const width of [24, 40, 64, 120]) {
      const result = renderConversation(session, preferences, width);
      expect(result.lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      const text = stripVTControlCharacters(result.lines.join("\n"));
      expect(text).toContain("YOU  01");
      expect(text).toContain("## 請安裝");
      expect(text).toContain("ERROR install");
      expect(text).not.toContain("opaque-run-id");
      expect(result.lines.join("\n")).not.toContain("\u001b]52");
      expect(result.prompts).toHaveLength(1);
    }
    const collapsed = renderConversation(session, preferences, 80).lines.join("\n");
    const expanded = renderConversation(session, { ...preferences, expanded: true }, 80).lines.join(
      "\n",
    );
    expect(expanded.length).toBeGreaterThan(collapsed.length);
    expect(collapsed).toContain("Alt+R expand");
  });
});
