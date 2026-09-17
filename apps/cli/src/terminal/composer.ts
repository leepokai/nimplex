import { stripVTControlCharacters } from "node:util";
import { CURSOR_MARKER, Editor, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Keep Pi's cursor, paste and autocomplete layout; only replace its border treatment. */
export class Composer extends Editor {
  readonly promptHistory: string[] = [];
  override addToHistory(text: string) {
    super.addToHistory(text);
    const previous = this.promptHistory.indexOf(text);
    if (previous !== -1) this.promptHistory.splice(previous, 1);
    if (text.trim()) this.promptHistory.push(text);
    if (this.promptHistory.length > 1000) this.promptHistory.shift();
  }
  label = "Build";
  placeholder = "Describe a task, / for commands, @ to attach a file";
  muted: (text: string) => string = (text) => text;
  protected override renderTopBorder(width: number, hiddenLineCount: number) {
    const start = truncateToWidth(
      `╭─ ${this.label} ${hiddenLineCount ? `· ↑ ${hiddenLineCount} ` : ""}`,
      Math.max(0, width - 1),
    );
    return this.borderColor(`${start + "─".repeat(Math.max(0, width - visibleWidth(start) - 1))}╮`);
  }
  protected override renderBottomBorder(width: number, hiddenLineCount: number) {
    const start = truncateToWidth(
      `╰${hiddenLineCount ? `─ ↓ ${hiddenLineCount} ` : ""}`,
      Math.max(0, width - 1),
    );
    return this.borderColor(`${start + "─".repeat(Math.max(0, width - visibleWidth(start) - 1))}╯`);
  }
  override render(width: number) {
    const rows = super.render(width);
    const bottom = rows.findIndex(
      (line, index) => index > 0 && stripVTControlCharacters(line).startsWith("╰"),
    );
    for (let i = 1; i < bottom; i++) {
      // Pi reserves horizontal padding for the cursor; retain its exact position.
      const row = rows[i] ?? "";
      rows[i] = row.replace(/^ /, this.borderColor("│")).replace(/ $/, this.borderColor("│"));
    }
    if (!this.getText() && !this.isShowingAutocomplete() && width >= 12) {
      const content = truncateToWidth(this.placeholder, width - 4);
      rows[1] =
        this.borderColor("│") +
        " " +
        (this.focused ? CURSOR_MARKER : "") +
        this.muted(content) +
        " ".repeat(Math.max(0, width - 3 - visibleWidth(content))) +
        this.borderColor("│");
    }
    return rows;
  }
}
