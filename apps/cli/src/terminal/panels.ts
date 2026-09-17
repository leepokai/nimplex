import {
  type Component,
  CURSOR_MARKER,
  decodeKittyPrintable,
  Key,
  matchesKey,
  SelectList,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { safeText } from "../display.ts";
import type { Choice } from "./controller.ts";
import type { theme } from "./theme.ts";

export function panel(lines: string[], width: number) {
  const inner = Math.max(0, width - 4);
  return [
    `╭${"─".repeat(Math.max(0, width - 2))}╮`,
    ...lines.map((line) => {
      const text = truncateToWidth(line, inner);
      return `│ ${text}${" ".repeat(Math.max(0, inner - visibleWidth(text)))} │`;
    }),
    `╰${"─".repeat(Math.max(0, width - 2))}╯`,
  ].map((line) => truncateToWidth(line, width));
}

export class Picker implements Component {
  focused = true;
  private query = "";
  private list: SelectList;
  private listRows = 0;
  constructor(
    readonly title: string,
    readonly choices: Choice[],
    readonly colors: ReturnType<typeof theme>,
    readonly rows: number | (() => number),
    readonly finish: (value?: string) => void,
    readonly refresh: () => void,
  ) {
    this.list = this.filteredList();
  }
  private filteredList() {
    this.listRows = this.visibleRows();
    const list = new SelectList(this.matches(), this.visibleRows(), this.colors.selectList);
    list.onSelect = (item) => this.finish(item.value);
    list.onCancel = () => this.finish();
    return list;
  }
  private matches() {
    const query = this.query.toLocaleLowerCase();
    return this.choices.filter((item) =>
      `${item.label} ${item.description ?? ""} ${item.value}`.toLocaleLowerCase().includes(query),
    );
  }
  invalidate() {
    this.list.invalidate();
  }
  private visibleRows() {
    return Math.max(
      1,
      Math.min(12, (typeof this.rows === "function" ? this.rows() : this.rows) - 10),
    );
  }
  render(width: number) {
    if (this.listRows !== this.visibleRows()) {
      const selected = this.list.getSelectedItem()?.value;
      this.list = this.filteredList();
      const items = this.matches();
      this.list.setSelectedIndex(
        Math.max(
          0,
          items.findIndex((item) => item.value === selected),
        ),
      );
    }
    return panel(
      [
        this.colors.accent(safeText(this.title)),
        `Search: ${truncateToWidth(safeText(this.query), Math.max(1, width - 13))}${CURSOR_MARKER}`,
        "",
        ...this.list.render(Math.max(1, width - 4)),
        this.colors.muted(
          width < 45 ? "↑↓ select · Enter · Esc" : "↑↓ select · Tab / Enter confirm · Esc cancel",
        ),
      ],
      width,
    );
  }
  handleInput(data: string) {
    if (matchesKey(data, Key.ctrl("c"))) {
      this.finish();
      return;
    }
    if (matchesKey(data, Key.tab)) {
      const item = this.list.getSelectedItem();
      if (item) this.finish(item.value);
      return;
    }
    if (matchesKey(data, Key.ctrl("r")) || matchesKey(data, Key.ctrl("n"))) data = "\u001b[B";
    if (matchesKey(data, Key.ctrl("s")) || matchesKey(data, Key.ctrl("p"))) data = "\u001b[A";
    if (matchesKey(data, Key.home) || matchesKey(data, Key.end)) {
      this.list.setSelectedIndex(
        matchesKey(data, Key.home) ? 0 : Math.max(0, this.matches().length - 1),
      );
    } else if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown)) {
      const items = this.matches();
      const index = items.findIndex((item) => item.value === this.list.getSelectedItem()?.value);
      const next = index + (matchesKey(data, Key.pageUp) ? -1 : 1) * this.visibleRows();
      this.list.setSelectedIndex(Math.max(0, Math.min(items.length - 1, next)));
    } else if (
      [Key.escape, Key.enter, Key.up, Key.down, Key.pageUp, Key.pageDown].some((key) =>
        matchesKey(data, key),
      )
    ) {
      this.list.handleInput(data);
    } else {
      data = decodeKittyPrintable(data) ?? data;
      if (matchesKey(data, Key.backspace)) this.query = [...this.query].slice(0, -1).join("");
      else if (!data.includes("\u001b") && [...data].every((char) => char >= " "))
        this.query += data;
      else return;
      this.list = this.filteredList();
    }
    this.refresh();
  }
}

export class Pager implements Component {
  private offset = 0;
  private height = 1;
  private length = 0;
  constructor(
    readonly title: string,
    readonly text: string,
    readonly colors: ReturnType<typeof theme>,
    readonly rows: () => number,
    readonly finish: () => void,
    readonly refresh: () => void,
  ) {}
  invalidate() {}
  render(width: number) {
    const lines = wrapTextWithAnsi(safeText(this.text, 256000), Math.max(1, width - 4));
    this.height = Math.max(1, Math.min(30, Math.floor(this.rows() * 0.9) - 6));
    this.length = lines.length;
    this.offset = Math.max(0, Math.min(this.offset, this.length - this.height));
    const position = `${this.offset + 1}–${Math.min(this.length, this.offset + this.height)} / ${this.length}`;
    return panel(
      [
        this.colors.accent(safeText(this.title, 80)),
        "",
        ...lines.slice(this.offset, this.offset + this.height),
        "",
        this.colors.muted(`${position} · ↑↓ scroll · Esc close`),
      ],
      width,
    );
  }
  handleInput(data: string) {
    const is = (key: Parameters<typeof matchesKey>[1]) => matchesKey(data, key);
    if (
      [Key.escape, Key.enter, Key.ctrl("c")].some(is) ||
      data === "q" ||
      data === "?" ||
      (this.title === "Conversation transcript" && is(Key.ctrl("t")))
    )
      this.finish();
    else if (is(Key.down) || is(Key.ctrl("n")) || data === "j") this.offset++;
    else if (is(Key.up) || is(Key.ctrl("p")) || data === "k") this.offset--;
    else if (is(Key.pageDown) || data === " ") this.offset += this.height;
    else if (is(Key.pageUp) || is(Key.shift("space"))) this.offset -= this.height;
    else if (is(Key.ctrl("d"))) this.offset += Math.max(1, Math.floor(this.height / 2));
    else if (is(Key.ctrl("u"))) this.offset -= Math.max(1, Math.floor(this.height / 2));
    else if (is(Key.home) || data === "g") this.offset = 0;
    else if (is(Key.end) || data === "G") this.offset = this.length;
    this.offset = Math.max(0, Math.min(this.offset, Math.max(0, this.length - this.height)));
    this.refresh();
  }
}
