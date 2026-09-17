import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

export async function commandOutput(
  command: string,
  args: string[],
  cwd?: string,
  input?: string,
): Promise<string> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    const collect = (data: Buffer) => {
      output += data.toString();
      if (output.length > 1024 * 1024) child.kill("SIGKILL");
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", reject);
    child.stdin.on("error", () => {});
    child.stdin.end(input);
    const timeout = setTimeout(() => child.kill("SIGKILL"), 30000);
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0 || (command === "git" && code === 1)) resolveResult(output);
      else reject(new Error(output.slice(0, 2000) || `${command} exited with ${code}`));
    });
  });
}
export async function copyText(text: string) {
  if (!text) throw new Error("No completed response to copy.");
  if (process.platform === "darwin") await commandOutput("pbcopy", [], undefined, text);
  else if (process.platform === "win32") await commandOutput("clip", [], undefined, text);
  else if (process.env.WAYLAND_DISPLAY) await commandOutput("wl-copy", [], undefined, text);
  else await commandOutput("xclip", ["-selection", "clipboard"], undefined, text);
}
export function exportText(cwd: string, path: string | undefined, text: string) {
  const target = resolve(cwd, path || `nimplex-${Date.now()}.md`);
  writeFileSync(target, text, { flag: "wx", mode: 0o600 });
  return target;
}
export function attachmentsFromPrompt(prompt: string, cwd: string) {
  const attachments: { path: string; content: string }[] = [];
  const root = realpathSync(cwd);
  for (const match of prompt.matchAll(/(?:^|\s)@(?:"([^"]+)"|(\S+))/g)) {
    const requested = match[1] ?? match[2];
    if (!requested) continue;
    // Not every @token is a file mention (handles, scoped packages); only existing paths attach.
    const candidate = resolve(root, requested);
    if (!existsSync(candidate)) continue;
    const file = realpathSync(candidate);
    const rel = relative(root, file);
    if (rel.startsWith(`..${sep}`) || isAbsolute(rel) || rel === "..")
      throw new Error("File mentions must stay inside the current project.");
    if (!statSync(file).isFile() || statSync(file).size > 131072)
      throw new Error("Attach a text file no larger than 128 KiB.");
    const content = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(file));
    const path = `/workspace/${rel.split(sep).join("/")}`;
    if (!attachments.some((entry) => entry.path === path)) attachments.push({ path, content });
  }
  if (attachments.length > 16) throw new Error("Attach at most 16 files per prompt.");
  return attachments;
}
export function projectInstructions(cwd: string) {
  return ["AGENTS.md", "CLAUDE.md"]
    .filter((name) => existsSync(join(cwd, name)))
    .map((name) => `${name}\n${readFileSync(join(cwd, name), "utf8").slice(0, 32000)}`)
    .join("\n\n");
}
export function initializeInstructions(cwd: string) {
  const path = join(cwd, "AGENTS.md");
  writeFileSync(
    path,
    `# ${basename(cwd)}\n\n## Working agreements\n\n- Keep code maintainable through small modules and explicit boundaries.\n- Write documentation and comments in English.\n- Preserve existing work and test important behavior changes.\n- Record project-specific build and validation commands here.\n`,
    { flag: "wx" },
  );
  return path;
}
export async function fileDiff(before: string, after: string, path: string) {
  const dir = mkdtempSync(join(tmpdir(), "nimplex-diff-"));
  try {
    mkdirSync(join(dir, "before"));
    mkdirSync(join(dir, "after"));
    writeFileSync(join(dir, "before", "file"), before);
    writeFileSync(join(dir, "after", "file"), after);
    return (
      await commandOutput(
        "git",
        ["diff", "--no-index", "--no-color", "--", "before/file", "after/file"],
        dir,
      )
    )
      .replaceAll("before/file", `before/${path}`)
      .replaceAll("after/file", `after/${path}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
