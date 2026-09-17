import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  CombinedAutocompleteProvider,
  type Component,
  Key,
  matchesKey,
  ProcessTerminal,
  ScrollView,
  type Terminal,
  TuiAltScreen,
  truncateToWidth,
  VStack,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { safeText } from "../display.ts";
import { CommandRegistry } from "./commands.ts";
import { Composer } from "./composer.ts";
import { type Choice, type Controller, errorMessage, type TerminalView } from "./controller.ts";
import { configureEditorKeys, Keyboard, type KeyboardHost } from "./keyboard.ts";
import { attachmentsFromPrompt } from "./local-io.ts";
import { Pager, Picker } from "./panels.ts";
import { theme } from "./theme.ts";
import { renderConversation } from "./transcript.ts";

class Dynamic implements Component {
  constructor(readonly draw: (width: number) => string[]) {}
  render(width: number) {
    return this.draw(width);
  }
  invalidate() {}
}

export class View implements TerminalView {
  readonly tui: TuiAltScreen;
  readonly registry = new CommandRegistry();
  readonly editor: Composer;
  readonly keyboard: Keyboard;
  private readonly transcript: ScrollView;
  private resolveExit!: () => void;
  readonly done = new Promise<void>((resolve) => {
    this.resolveExit = resolve;
  });
  private suspended = false;
  private transcriptCache?: { key: string; lines: string[]; prompts: number[] };
  private hintText = "";
  private hintUntil = 0;
  private stashedDraft = "";
  private shownSession = "";
  private readonly heartbeat: ReturnType<typeof setInterval>;
  constructor(
    readonly controller: Controller,
    readonly terminal: Terminal = new ProcessTerminal(),
  ) {
    configureEditorKeys();
    this.tui = new TuiAltScreen(terminal, true, undefined, { mouse: true, copyOnSelect: false });
    const colors = theme(controller.preferences.theme);
    this.editor = new Composer(
      this.tui,
      {
        borderColor: colors.accent,
        selectList: {
          selectedPrefix: (text) =>
            theme(controller.preferences.theme).selectList.selectedPrefix(text),
          selectedText: (text) => theme(controller.preferences.theme).selectList.selectedText(text),
          description: (text) => theme(controller.preferences.theme).selectList.description(text),
          scrollInfo: (text) => theme(controller.preferences.theme).selectList.scrollInfo(text),
          noMatch: (text) => theme(controller.preferences.theme).selectList.noMatch(text),
        },
      },
      { paddingX: 2, autocompleteMaxVisible: 7 },
    );
    this.refreshResources();
    for (const session of controller.store.list().reverse())
      for (const turn of session.turns) this.editor.addToHistory(turn.prompt);
    this.editor.onSubmit = (text) => {
      if (!text.trim()) return;
      if (controller.active && !text.startsWith("/")) {
        this.editor.setText(text);
        this.hint("Still working. Draft kept; Esc stops, /background opens another conversation.");
        return;
      }
      this.editor.setText("");
      this.editor.addToHistory(text);
      void this.dispatch(text);
    };
    this.editor.onChange = () => this.tui.requestRender();
    this.keyboard = new Keyboard({
      editor: this.editor,
      profile: () => controller.preferences.keymap ?? "nimplex",
      active: () => !!controller.active,
      overlay: () => this.tui.hasOverlay(),
      command: (name) => {
        void this.dispatch(`/${name}`);
      },
      action: (action) => this.keyboardAction(action),
      hint: (text) => this.hint(text),
      stop: () => {
        void controller.stop().catch((e) => this.notice("Stop failed", errorMessage(e)));
      },
      stopAll: () => {
        void controller.stopAll().catch((e) => this.notice("Stop failed", errorMessage(e)));
      },
      close: () => controller.close(),
      jump: (direction) => this.jumpPrompt(direction),
    });
    this.transcript = new ScrollView(new Dynamic((width) => this.renderTranscript(width)), {
      follow: "end",
      primary: true,
      scrollbar: "auto",
    });
    const layout = new VStack([
      { component: new Dynamic((width) => this.header(width)), shrink: 0 },
      { component: this.transcript, grow: 1, minSize: 1 },
      { component: new Dynamic((width) => this.composerLabel(width)), shrink: 0 },
      { component: this.editor, shrink: 0, maxSize: 12 },
      { component: new Dynamic((width) => this.footer(width)), shrink: 0 },
    ]);
    this.tui.setLayoutRoot(layout);
    this.tui.setFocus(this.editor);
    this.tui.addInputListener((data) => {
      if (
        matchesKey(data, Key.ctrl("c")) &&
        this.tui.hasActiveSelection() &&
        !this.tui.hasOverlay()
      ) {
        void this.tui.copyActiveSelectionToClipboard();
        return { consume: true };
      }
      const result = this.keyboard.handle(data);
      if (result) this.refresh();
      return result;
    });
    this.heartbeat = setInterval(() => {
      if (controller.active || this.hintText) this.refresh();
    }, 750);
    this.heartbeat.unref();
  }
  refreshResources() {
    this.registry.refresh(this.controller);
    configureEditorKeys();
    this.editor.setAutocompleteProvider(
      new CombinedAutocompleteProvider(
        this.registry.commands.flatMap((c) =>
          [c.name, ...(c.aliases ?? [])].map((name) => ({ name, description: c.description })),
        ),
        this.controller.cwd,
      ),
    );
    this.transcriptCache = undefined;
    this.tui.requestRender(true);
  }
  start() {
    this.tui.start();
    this.refresh();
  }
  refresh() {
    if (this.suspended || this.controller.closed) return;
    const c = this.controller,
      t = theme(c.preferences.theme);
    this.editor.borderColor = c.active ? t.muted : t.accent;
    this.editor.muted = t.muted;
    this.editor.label = c.preferences.mode === "read_only" ? "Plan · read only" : "Build";
    this.editor.placeholder = c.active
      ? "Draft your next message while the agent works"
      : "Describe a task, / commands, @ files";
    if (this.shownSession !== c.session.id) {
      this.shownSession = c.session.id;
      this.transcript.scrollToEnd();
    }
    this.tui.requestRender();
  }
  private header(width: number) {
    const c = this.controller,
      t = theme(c.preferences.theme);
    const brand = t.accent("● ") + t.bold("nimplex");
    const location = safeText(basename(c.cwd), 100);
    const title =
      c.session.title === "New conversation" ? location : safeText(c.session.title, 100);
    return [
      truncateToWidth(` ${brand}  ${t.muted(title.replaceAll("\n", " "))}`, width),
      t.muted("─".repeat(width)),
    ];
  }
  private composerLabel(width: number) {
    const c = this.controller,
      t = theme(c.preferences.theme);
    if (this.hintText && Date.now() < this.hintUntil)
      return wrapTextWithAnsi(t.accent(` ${this.hintText}`), Math.max(1, width));
    this.hintText = "";
    if (!c.active) return [];
    const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    const tools = c.active.turn.events.filter((e) => e.type === "tool.call").length;
    return [
      truncateToWidth(
        ` ${t.accent(frames[Math.floor(Date.now() / 150) % frames.length] ?? "●")} Working${tools ? ` · ${tools} tools` : ""}  ${t.muted(width < 60 ? "Esc stop" : "Esc stop · /background")}`,
        width,
      ),
    ];
  }
  private footer(width: number) {
    const c = this.controller,
      t = theme(c.preferences.theme);
    const hints =
      width < 60
        ? " ? help · ⇧Tab mode · Alt+R tools"
        : " ? shortcuts   / commands   @ files   ⇧Tab mode   Alt+R tools   Ctrl+G editor";
    const lines = [truncateToWidth(t.muted(hints), width)];
    if (c.preferences.statusline) {
      const spent = c.session.turns.reduce((sum, turn) => sum + (turn.result?.spent_usd ?? 0), 0);
      const model = c.preferences.model
        .replace(/^claude-/, "")
        .replace(/-([0-9])([0-9])$/, " $1.$2");
      const subscription = c.preferences.model.startsWith("openai-codex/");
      const right = `${subscription ? "subscription" : `$${spent.toFixed(4)}`}${c.tasks.size ? ` · ${c.tasks.size} active` : ""}`;
      const native = c.session.turns.some((turn) =>
        turn.events.some((e) => e.type === "tier.escalated"),
      );
      const detail = `${model} · ${native ? "native workspace" : "just-bash"}`;
      const left = truncateToWidth(detail, Math.max(1, width - visibleWidth(right) - 4));
      lines.push(
        t.muted(
          ` ${left}${" ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right) - 2))}${right} `,
        ),
      );
    }
    return lines;
  }
  private renderTranscript(width: number) {
    const c = this.controller;
    const key = JSON.stringify([
      c.session.id,
      width,
      c.preferences.theme,
      c.preferences.expanded,
      c.session.turns.map((turn) => [
        turn.events.length,
        turn.result?.status,
        turn.result?.spent_usd,
        turn.result?.error,
      ]),
    ]);
    if (this.transcriptCache?.key !== key)
      this.transcriptCache = { key, ...renderConversation(c.session, c.preferences, width) };
    return this.transcriptCache.lines;
  }
  private jumpPrompt(direction: -1 | 1) {
    const prompts = this.transcriptCache?.prompts ?? [];
    const row =
      direction < 0
        ? prompts.findLast((p) => p < this.transcript.scrollTop)
        : prompts.find((p) => p > this.transcript.scrollTop);
    if (row !== undefined) this.transcript.scrollTo(row, { disableFollow: true });
    else if (direction > 0) this.transcript.scrollToEnd();
    else this.transcript.scrollToStart();
  }
  private hint(text: string) {
    this.hintText = text;
    this.hintUntil = Date.now() + 4000;
    this.refresh();
  }
  private keyboardAction(action: Parameters<KeyboardHost["action"]>[0]) {
    if (action === "redraw") this.tui.requestRender(true);
    else if (action === "details") {
      this.controller.preferences.expanded = !this.controller.preferences.expanded;
      this.controller.settingsChanged();
    } else if (action === "history") {
      const prompts = [...this.editor.promptHistory].reverse();
      void this.choose(
        "Prompt history",
        prompts.map((p, i) => ({ value: String(i), label: p.slice(0, 200) })),
      ).then((value) => {
        if (value !== undefined) this.draft(prompts[Number(value)] ?? "");
      });
    } else if (action === "editor") {
      void this.externalEditor(this.editor.getExpandedText())
        .then((text) => this.draft(text))
        .catch((e) => this.notice("Editor failed", errorMessage(e)));
    } else if (action === "stash") {
      const current = this.editor.getExpandedText();
      this.editor.setText(this.stashedDraft);
      this.stashedDraft = current;
      this.hint(
        current ? "Draft stashed. Ctrl+S restores it or swaps drafts." : "Stashed draft restored.",
      );
    } else if (action === "suspend") this.suspend();
  }
  private suspend() {
    if (process.platform === "win32") {
      this.hint("Process suspension is available on Unix terminals.");
      return;
    }
    this.suspended = true;
    this.tui.stop();
    process.once("SIGCONT", this.continueTerminal);
    process.kill(process.pid, "SIGTSTP");
  }
  private readonly continueTerminal = () => {
    this.suspended = false;
    if (!this.controller.closed) {
      this.tui.start();
      this.refresh();
    }
  };
  async dispatch(text: string) {
    try {
      if (text.startsWith("/")) await this.registry.execute(this.controller, text);
      else await this.controller.submit(text, attachmentsFromPrompt(text, this.controller.cwd));
    } catch (error) {
      this.notice("Unable to complete action", errorMessage(error));
    }
    this.refresh();
  }
  draft(text: string) {
    this.editor.setText(safeText(text, 262144));
    this.tui.setFocus(this.editor);
    this.refresh();
  }
  notice(title: string, text: string) {
    if (this.controller.closed) return;
    const component = new Pager(
      title,
      text,
      theme(this.controller.preferences.theme),
      () => this.terminal.rows,
      () => this.tui.hideOverlay(),
      () => this.refresh(),
    );
    this.tui.showOverlay(component, {
      width: Math.min(this.terminal.columns, 100),
      maxHeight: "90%",
      anchor: "center",
    });
  }
  choose(title: string, choices: Choice[]): Promise<string | undefined> {
    if (!choices.length) {
      this.notice(title, "No matching items yet.");
      return Promise.resolve(undefined);
    }
    return new Promise((resolve) => {
      const t = theme(this.controller.preferences.theme);
      const component = new Picker(
        title,
        choices,
        t,
        () => this.terminal.rows,
        (value) => {
          this.tui.hideOverlay();
          resolve(value);
        },
        () => this.refresh(),
      );
      this.tui.showOverlay(component, {
        width: Math.min(this.terminal.columns, 90),
        maxHeight: "90%",
        anchor: "center",
      });
    });
  }
  async authenticate(provider?: string) {
    this.suspended = true;
    this.tui.stop();
    try {
      const { login } = await import("../auth.ts");
      await login(provider);
      this.controller.close();
    } finally {
      this.suspended = false;
      if (!this.controller.closed) this.tui.start();
    }
  }
  async externalEditor(text: string) {
    const dir = mkdtempSync(join(tmpdir(), "nimplex-editor-"));
    const file = join(dir, "prompt.md");
    writeFileSync(file, text, { mode: 0o600 });
    this.suspended = true;
    this.tui.stop();
    try {
      const editor = process.env.VISUAL || process.env.EDITOR || "vi";
      await new Promise<void>((resolve, reject) => {
        const child = spawn("/bin/sh", ["-c", `${editor} "$1"`, "nimplex-editor", file], {
          stdio: "inherit",
        });
        child.on("error", reject);
        child.on("exit", (code) =>
          code === 0 ? resolve() : reject(new Error(`Editor exited with ${code}`)),
        );
      });
      return readFileSync(file, "utf8");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      this.suspended = false;
      this.tui.start();
      this.refresh();
    }
  }
  exit() {
    clearInterval(this.heartbeat);
    process.removeListener("SIGCONT", this.continueTerminal);
    this.tui.stop();
    process.stdin.pause();
    this.resolveExit();
  }
}
