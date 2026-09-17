import { describe, expect, it, vi } from "vitest";
import { Keyboard, type KeyboardHost, type Keymap } from "./keyboard.ts";

function fixture() {
  let text = "",
    active = false,
    overlay = false,
    autocomplete = false,
    profile: Keymap = "nimplex",
    now = 10000;
  const editor = {
    getText: () => text,
    getExpandedText: () => text,
    setText: (value: string) => {
      text = value;
    },
    addToHistory: vi.fn(),
    isShowingAutocomplete: () => autocomplete,
  };
  const host = {
    editor,
    active: () => active,
    overlay: () => overlay,
    profile: () => profile,
    command: vi.fn(),
    action: vi.fn(),
    hint: vi.fn(),
    stop: vi.fn(),
    stopAll: vi.fn(),
    close: vi.fn(),
    jump: vi.fn(),
  };
  const keyboard = new Keyboard(host as unknown as KeyboardHost, () => now);
  return {
    host,
    keyboard,
    editor,
    text: (value: string) => {
      text = value;
    },
    active: (value: boolean) => {
      active = value;
    },
    overlay: (value: boolean) => {
      overlay = value;
    },
    autocomplete: (value: boolean) => {
      autocomplete = value;
    },
    profile: (value: Keymap) => {
      profile = value;
    },
    tick: (ms: number) => {
      now += ms;
    },
  };
}

describe("context-sensitive keyboard controls", () => {
  it("stops active work without exiting, and requires a second idle exit key", () => {
    const f = fixture();
    f.active(true);
    f.keyboard.handle("\u0003");
    f.keyboard.handle("\u0003");
    expect(f.host.stop).toHaveBeenCalledTimes(2);
    expect(f.host.close).not.toHaveBeenCalled();
    f.active(false);
    f.text("draft");
    f.keyboard.handle("\u0003");
    expect(f.editor.getText()).toBe("");
    f.keyboard.handle("x");
    f.keyboard.handle("\u0003");
    expect(f.host.close).not.toHaveBeenCalled();
    f.keyboard.handle("\u0003");
    expect(f.host.close).toHaveBeenCalledOnce();
  });
  it("does not exit on Ctrl+D in text, and expires an idle exit confirmation", () => {
    const f = fixture();
    f.text("text");
    expect(f.keyboard.handle("\u0004")).toBeUndefined();
    f.text("");
    f.keyboard.handle("\u0004");
    f.tick(1500);
    f.keyboard.handle("\u0004");
    expect(f.host.close).not.toHaveBeenCalled();
    f.keyboard.handle("\u0004");
    expect(f.host.close).toHaveBeenCalledOnce();
  });
  it("keeps escape scoped to autocomplete/overlays and only rewinds an empty draft", () => {
    const f = fixture();
    f.autocomplete(true);
    expect(f.keyboard.handle("\u001b")).toBeUndefined();
    f.autocomplete(false);
    f.overlay(true);
    expect(f.keyboard.handle("\u001b")).toBeUndefined();
    f.overlay(false);
    f.text("unsent");
    f.keyboard.handle("\u001b");
    f.keyboard.handle("\u001b");
    expect(f.editor.addToHistory).toHaveBeenCalledWith("unsent");
    expect(f.host.command).not.toHaveBeenCalled();
    f.keyboard.handle("\u001b");
    f.keyboard.handle("\u001b");
    expect(f.host.command).toHaveBeenCalledWith("rewind");
  });
  it("keeps pasted shortcuts literal, ignores key releases, and resolves profile conflicts", () => {
    const f = fixture();
    f.keyboard.handle("\u001b[200~");
    f.keyboard.handle("\u0003");
    f.keyboard.handle("?");
    f.keyboard.handle("\u001b[201~");
    expect(f.host.hint).not.toHaveBeenCalled();
    expect(f.host.command).not.toHaveBeenCalled();
    f.keyboard.handle("\u001b[111;5:3u");
    expect(f.host.action).not.toHaveBeenCalled();
    f.keyboard.handle("\u000f");
    expect(f.host.action).toHaveBeenCalledWith("details");
    f.keyboard.handle("\u0014");
    expect(f.host.command).toHaveBeenCalledWith("tasks");
    f.profile("codex");
    f.keyboard.handle("\u000f");
    expect(f.host.command).toHaveBeenCalledWith("copy");
    f.keyboard.handle("\u0014");
    expect(f.host.command).toHaveBeenCalledWith("transcript");
    expect(f.keyboard.handle("\u0002")).toBeUndefined();
  });
  it("requires a repeated stop-all chord and supports the editor chord without deleting text", () => {
    const f = fixture();
    f.text("keep");
    f.keyboard.handle("\u0018");
    f.keyboard.handle("\u0005");
    expect(f.host.action).toHaveBeenCalledWith("editor");
    f.keyboard.handle("\u0018");
    f.keyboard.handle("\u000b");
    expect(f.host.stopAll).not.toHaveBeenCalled();
    f.keyboard.handle("\u0018");
    f.keyboard.handle("\u000b");
    expect(f.host.stopAll).toHaveBeenCalledOnce();
    expect(f.editor.getText()).toBe("keep");
    f.keyboard.handle("\u0018");
    f.keyboard.handle("\u001b");
    f.keyboard.handle("\u0005");
    expect(f.host.action).toHaveBeenCalledTimes(1);
  });
});
