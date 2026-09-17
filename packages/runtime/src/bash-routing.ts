import { parse } from "just-bash";

const virtualCommands = new Set(
  `: true false echo printf cat head tail wc sort uniq cut paste tr
  grep rg sed awk jq yq xan sqlite3 ls pwd cd mkdir rmdir rm cp mv touch chmod ln readlink realpath
  basename dirname find du stat test [ date seq sleep env printenv export unset set shopt read
  mapfile type which command help history clear base64 md5sum sha1sum sha256sum sha512sum
  diff cmp comm tee xargs yes od hexdump strings split expand unexpand rev nl tac join fold
  tar gzip gunzip zcat zip unzip expr let local declare typeset return break continue`.split(/\s+/),
);

/** Inspect the complete AST before running any command, including command substitutions. */
export function needsNativeSandbox(command: string): boolean {
  let native = false;
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const node = value as Record<string, unknown>;
    if (node.type === "SimpleCommand" && node.name) {
      const parts = (node.name as { parts: { type: string; value?: string }[] }).parts;
      const literal = parts.every((part) => part.type === "Literal" || part.type === "SingleQuoted")
        ? parts.map((part) => part.value ?? "").join("")
        : null;
      if (
        !literal ||
        !virtualCommands.has(literal) ||
        ["xargs", "command", "env"].includes(literal)
      )
        native = true;
    }
    if (node.type === "FunctionDef" || node.type === "ProcessSubstitution") native = true;
    Object.values(node).forEach(visit);
  };
  try {
    visit(parse(command));
  } catch {
    return true;
  }
  return (
    native ||
    /\/dev\/(tcp|udp)\//.test(command) ||
    /\bfind\b[^\n]*\s-(exec|execdir|ok)\b/.test(command)
  );
}
