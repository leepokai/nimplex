import type { MarkdownTheme, SelectListTheme } from "@earendil-works/pi-tui";

export function theme(name: "dark" | "light" | "mono") {
  const ansi = (code: string) => (text: string) =>
    name === "mono" ? text : `\u001b[${code}m${text}\u001b[0m`;
  const accent = ansi(name === "light" ? "38;5;25" : "38;5;111");
  const muted = ansi(name === "light" ? "38;5;243" : "38;5;245");
  const success = ansi(name === "light" ? "38;5;28" : "38;5;114");
  const danger = ansi(name === "light" ? "38;5;124" : "38;5;210");
  const bold = ansi("1");
  const surface = ansi(name === "light" ? "48;5;254;38;5;234" : "48;5;236;38;5;253");
  const selectList: SelectListTheme = {
    selectedPrefix: accent,
    selectedText: bold,
    description: muted,
    scrollInfo: muted,
    noMatch: muted,
  };
  const markdown: MarkdownTheme = {
    heading: bold,
    link: accent,
    linkUrl: muted,
    code: accent,
    codeBlock: (x) => x,
    codeBlockBorder: muted,
    quote: muted,
    quoteBorder: accent,
    hr: muted,
    listBullet: accent,
    bold,
    italic: ansi("3"),
    strikethrough: ansi("9"),
    underline: ansi("4"),
  };
  return { accent, muted, success, danger, bold, surface, selectList, markdown };
}
