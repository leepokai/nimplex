/** Single-quote a value for POSIX sh so it is passed verbatim (no expansion, no injection). */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
