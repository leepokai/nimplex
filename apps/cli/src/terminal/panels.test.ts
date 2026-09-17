import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { Pager, Picker, panel } from "./panels.ts";
import { theme } from "./theme.ts";

describe("terminal menus", () => {
  it("supports history cycling, Tab selection and Ctrl+C cancellation without changing a draft", () => {
    const selected: (string | undefined)[] = [];
    const picker = new Picker(
      "History",
      [
        { value: "new", label: "Newest" },
        { value: "old", label: "Older" },
      ],
      theme("mono"),
      24,
      (value) => selected.push(value),
      () => {},
    );
    picker.handleInput("\u0012");
    picker.handleInput("\t");
    expect(selected).toEqual(["old"]);
    picker.handleInput("\u0013");
    picker.handleInput("\t");
    expect(selected.at(-1)).toBe("new");
    picker.handleInput("\u0003");
    expect(selected.at(-1)).toBeUndefined();
  });
  it("keeps the selected item visible when the terminal height shrinks", () => {
    let rows = 40;
    const picker = new Picker(
      "Items",
      Array.from({ length: 30 }, (_, i) => ({ value: String(i), label: `Item ${i}` })),
      theme("mono"),
      () => rows,
      () => {},
      () => {},
    );
    picker.handleInput("\u001b[F");
    rows = 16;
    const lines = picker.render(40);
    expect(lines.join("\n")).toContain("Item 29");
    expect(lines.length).toBeLessThanOrEqual(rows);
    picker.handleInput("\u001b[5~");
    expect(picker.render(40).join("\n")).toContain("→ Item 23");
  });
  it("pages through long output, reaches its end and closes without swallowing Ctrl+C", () => {
    let closed = 0;
    const pager = new Pager(
      "Output",
      Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n"),
      theme("mono"),
      () => 24,
      () => {
        closed++;
      },
      () => {},
    );
    expect(pager.render(40).join("\n")).toContain("line 0");
    pager.handleInput("\u001b[F");
    expect(pager.render(40).join("\n")).toContain("line 99");
    pager.handleInput("\u001b[H");
    expect(pager.render(40).join("\n")).toContain("line 0");
    pager.handleInput("\u0003");
    expect(closed).toBe(1);
  });
  it("keeps arrow selection and searches labels instead of opaque IDs", () => {
    const selected: (string | undefined)[] = [];
    const picker = new Picker(
      "Resume",
      [
        { value: "id-1", label: "First task" },
        { value: "id-2", label: "Fix 中文 input" },
        { value: "id-3", label: "Third task" },
      ],
      theme("dark"),
      24,
      (value) => selected.push(value),
      () => {},
    );
    picker.handleInput("\u001b[B");
    picker.handleInput("\r");
    expect(selected).toEqual(["id-2"]);
    picker.handleInput("中文");
    picker.handleInput("\r");
    expect(selected).toEqual(["id-2", "id-2"]);
    picker.handleInput("\u001b");
    expect(selected.at(-1)).toBeUndefined();
  });
  it("fills every panel row at narrow and wide widths with CJK and ANSI text", () => {
    for (const width of [20, 40, 80, 120]) {
      const lines = panel([theme("dark").accent("模型與設定"), "very long ".repeat(30)], width);
      expect(lines.every((line) => visibleWidth(line) === width)).toBe(true);
    }
  });
});
