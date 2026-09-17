import {
  type Editor,
  isKeyRelease,
  Key,
  KeybindingsManager,
  type KeyId,
  matchesKey,
  setKeybindings,
  TUI_KEYBINDINGS,
} from "@earendil-works/pi-tui";

export type Keymap = "nimplex" | "claude" | "codex";
type Action = "details" | "history" | "editor" | "stash" | "redraw" | "suspend";
const bindings: { keys: KeyId[]; action: Action | `/${string}`; label: string }[] = [
  { keys: ["ctrl+l"], action: "redraw", label: "Redraw the screen" },
  { keys: ["ctrl+r"], action: "history", label: "Search previous prompts" },
  { keys: ["ctrl+g"], action: "editor", label: "Edit draft in $VISUAL / $EDITOR" },
  { keys: ["ctrl+s"], action: "stash", label: "Stash / restore the draft" },
  { keys: ["ctrl+z"], action: "suspend", label: "Suspend to shell; fg resumes (Unix)" },
  { keys: ["shift+tab", "alt+m"], action: "/plan", label: "Switch Build / Plan" },
  { keys: ["alt+p"], action: "/model", label: "Choose model" },
  { keys: ["alt+r"], action: "details", label: "Expand / collapse tool details" },
];

export function configureEditorKeys() {
  setKeybindings(
    new KeybindingsManager(TUI_KEYBINDINGS, {
      "tui.editor.cursorUp": ["up", "ctrl+p"],
      "tui.editor.cursorDown": ["down", "ctrl+n"],
      "tui.editor.cursorLineStart": ["home", "ctrl+a"],
      "tui.editor.cursorLineEnd": ["end", "ctrl+e"],
      "tui.editor.deleteCharBackward": ["backspace", "ctrl+h"],
      "tui.editor.deleteWordBackward": ["ctrl+w", "alt+backspace", "ctrl+backspace"],
      "tui.editor.deleteWordForward": ["alt+d", "alt+delete", "ctrl+delete"],
      "tui.editor.undo": ["ctrl+-", "ctrl+_", "ctrl+shift+-"],
      "tui.input.newLine": ["shift+enter", "alt+enter", "ctrl+j"],
      "tui.select.up": ["up", "ctrl+p"],
      "tui.select.down": ["down", "ctrl+n"],
      "tui.altScreen.top": "ctrl+home",
      "tui.altScreen.bottom": "ctrl+end",
      // Prompt navigation belongs to our conversation renderer, not Pi's prompt markers.
      "tui.altScreen.previousPrompt": [],
      "tui.altScreen.nextPrompt": [],
    }),
  );
}

export function keyboardHelp(profile: Keymap = "nimplex") {
  const app = bindings.map(({ keys, label }) => `${keys.join(" / ")}  — ${label}`);
  return [
    `Keyboard profile: ${profile}`,
    "",
    "PROMPT",
    "Enter — Send; while working, keep the draft until the turn finishes",
    "Shift+Enter / Alt+Enter / Ctrl+J / \\ then Enter — New line",
    "Tab — Complete command or @file mention",
    "Up / Down / Ctrl+P / Ctrl+N — Move within prompt, then recall history",
    "? on empty input / F1 — Open this help",
    "Esc — Close suggestions or stop the current task",
    "Esc twice — Save and clear draft; on empty input, open branch picker",
    "Ctrl+C — Stop task or clear draft; press again to exit",
    "Ctrl+D — Delete next character; on empty input, press twice to exit",
    ...app,
    "Ctrl+X Ctrl+E — External editor",
    "Ctrl+X Ctrl+K twice — Stop all running conversations (within 3 seconds)",
    profile === "codex"
      ? "Ctrl+O — Copy last answer; Ctrl+T — Transcript viewer"
      : "Ctrl+O — Tool details; Ctrl+T — Running conversations; Ctrl+B — Background conversation",
    "",
    "TEXT EDITING",
    "Left / Right / Ctrl+F — Character navigation (Ctrl+B also works in Codex profile)",
    "Home / End / Ctrl+A / Ctrl+E — Beginning / end of line",
    "Alt+B / Alt+F / Ctrl+Left / Ctrl+Right — Word navigation",
    "Backspace / Ctrl+H / Delete / Ctrl+D — Delete character",
    "Ctrl+W / Alt+Backspace / Ctrl+Backspace — Delete previous word",
    "Alt+D / Alt+Delete / Ctrl+Delete — Delete next word",
    "Ctrl+U / Ctrl+K — Cut line prefix / suffix",
    "Ctrl+Y / Alt+Y — Paste / cycle cut text",
    "Ctrl+_ / Ctrl+- / Ctrl+Shift+- — Undo input edit",
    "",
    "CONVERSATION",
    "PageUp / PageDown — Scroll conversation",
    "Ctrl+Home / Ctrl+End — First / latest output",
    "Ctrl+Up / Ctrl+Down — Previous / next prompt",
    "Ctrl+Shift+F — Search visible transcript text; Enter / Shift+Enter move matches",
    "Ctrl+Shift+C — Copy last answer; mouse selection then Ctrl+C copies selection",
    "",
    "MENUS AND VIEWERS",
    "Up / Down / Ctrl+P / Ctrl+N — Select or scroll",
    "PageUp / PageDown / Home / End — Page or jump",
    "Enter / Tab — Accept menu item; Ctrl+R / Ctrl+S — Older / newer history match",
    "Esc / Ctrl+C — Close; q closes read-only viewers",
    "",
    "Use /keymap nimplex, /keymap claude or /keymap codex to change profiles.",
    "Option as Meta is needed for Alt keys on macOS. Ctrl+J is the portable newline.",
    "Terminal Cmd+C / Cmd+V and bracketed text paste remain terminal controls.",
    "Profiles adapt available nimplex actions; they are not full product emulations.",
    "Image/voice input, Vim mode, fast/thinking toggles and queued-message shortcuts are not implemented.",
    "Ctrl+T in the default/Claude profile lists running conversations, not model-generated todos.",
    "Background work stays in this process. Exiting closes the local runtime.",
  ].join("\n");
}

export interface KeyboardHost {
  editor: Editor;
  profile(): Keymap;
  active(): boolean;
  overlay(): boolean;
  command(name: string): void;
  action(action: Action): void;
  hint(text: string): void;
  stop(): void;
  stopAll(): void;
  close(): void;
  jump(direction: -1 | 1): void;
}

/** Context-sensitive app controls; Pi retains text editing and bracketed paste. */
export class Keyboard {
  private escapeAt = 0;
  private exitAt = 0;
  private exitKey = "";
  private chordAt = 0;
  private stopAllAt = 0;
  private paste = false;
  constructor(
    readonly host: KeyboardHost,
    readonly now = Date.now,
  ) {}
  handle(data: string): { consume: true } | undefined {
    const h = this.host,
      now = this.now(),
      consumed = { consume: true } as const;
    if (data.includes("\u001b[200~")) this.paste = true;
    if (this.paste) {
      if (data.includes("\u001b[201~")) this.paste = false;
      return;
    }
    if (isKeyRelease(data)) return consumed;
    if (h.overlay()) {
      this.escapeAt = this.exitAt = this.chordAt = 0;
      return;
    }
    const is = (key: KeyId) => matchesKey(data, key);
    const exit = (key: string) => {
      if (this.exitKey === key && this.exitAt && now - this.exitAt < 1000) h.close();
      else {
        this.exitAt = now;
        this.exitKey = key;
        h.hint(`Press ${key} again to exit; active work will be interrupted.`);
      }
    };
    if (!is("ctrl+c") && !is("ctrl+d")) this.exitAt = 0;
    if (is(Key.escape)) {
      this.chordAt = 0;
      if (h.editor.isShowingAutocomplete()) {
        this.escapeAt = 0;
        return;
      }
      if (h.active()) {
        this.escapeAt = 0;
        h.stop();
      } else if (this.escapeAt && now - this.escapeAt < 500) {
        this.escapeAt = 0;
        if (h.editor.getText()) {
          h.editor.addToHistory(h.editor.getExpandedText());
          h.editor.setText("");
          h.hint("Draft saved to history. Press Up to restore it.");
        } else h.command("rewind");
      } else this.escapeAt = now;
      return consumed;
    }
    this.escapeAt = 0;
    if (is("ctrl+c")) {
      if (h.active()) {
        this.exitAt = 0;
        h.stop();
      } else {
        h.editor.setText("");
        exit("Ctrl+C");
      }
      return consumed;
    }
    if (is("ctrl+d") && !h.editor.getText()) {
      exit("Ctrl+D");
      return consumed;
    }
    if (this.chordAt && now - this.chordAt < 1500) {
      this.chordAt = 0;
      if (is("ctrl+e")) {
        h.action("editor");
        return consumed;
      }
      if (is("ctrl+k")) {
        if (this.stopAllAt && now - this.stopAllAt < 3000) {
          this.stopAllAt = 0;
          h.stopAll();
        } else {
          this.stopAllAt = now;
          h.hint("Repeat Ctrl+X Ctrl+K within 3 seconds to stop all running conversations.");
        }
        return consumed;
      }
    }
    if (is("ctrl+x")) {
      this.chordAt = now;
      h.hint("Ctrl+X: Ctrl+E editor · Ctrl+K stop all");
      return consumed;
    }
    if (is("f1") || (is("?") && !h.editor.getText())) {
      h.command("keybindings");
      return consumed;
    }
    if (is("ctrl+up") || is("ctrl+shift+up")) {
      h.jump(-1);
      return consumed;
    }
    if (is("ctrl+down") || is("ctrl+shift+down")) {
      h.jump(1);
      return consumed;
    }
    if (is("ctrl+shift+c")) {
      h.command("copy");
      return consumed;
    }
    if (is("ctrl+o")) {
      if (h.profile() === "codex") h.command("copy");
      else h.action("details");
      return consumed;
    }
    if (is("ctrl+t")) {
      h.command(h.profile() === "codex" ? "transcript" : "tasks");
      return consumed;
    }
    if (is("ctrl+b") && h.profile() !== "codex") {
      if (h.active()) h.command("background");
      else h.hint("No running conversation to background.");
      return consumed;
    }
    const binding = bindings.find(({ keys }) => keys.some(is));
    if (binding) {
      if (binding.action.startsWith("/")) h.command(binding.action.slice(1));
      else h.action(binding.action as Action);
      return consumed;
    }
    return;
  }
}
