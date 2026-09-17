import { posix } from "node:path";
import type { WorkspaceMetadata } from "@nimplex/contracts";
import { checkWorkspaceLimits } from "@nimplex/core";
import type { Bash } from "just-bash";

const ROOT = "/workspace";
function validPath(path: string) {
  if (!path.startsWith(`${ROOT}/`) || posix.normalize(path) !== path)
    throw new Error(`invalid workspace path: ${path}`);
}
function validLink(path: string, target: string) {
  const resolved = posix.resolve(posix.dirname(path), target);
  if (resolved !== ROOT && !resolved.startsWith(`${ROOT}/`))
    throw new Error(`symlink escapes workspace: ${path}`);
}

export async function snapshotWorkspace(bash: Bash) {
  const files: Record<string, Uint8Array> = {};
  const metadata: WorkspaceMetadata = {};
  for (const path of bash.fs.getAllPaths()) {
    if (!path.startsWith(`${ROOT}/`)) continue;
    validPath(path);
    const stat = await bash.fs.lstat(path);
    if (stat.isSymbolicLink) {
      const target = await bash.fs.readlink(path);
      validLink(path, target);
      metadata[path] = { kind: "symlink", mode: stat.mode & 4095, target };
    } else if (stat.isDirectory) {
      metadata[path] = { kind: "directory", mode: stat.mode & 4095 };
    } else if (stat.isFile) {
      metadata[path] = { kind: "file", mode: stat.mode & 4095 };
      files[path] = await bash.fs.readFileBuffer(path);
    } else throw new Error(`unsupported workspace entry: ${path}`);
  }
  const exceeded = checkWorkspaceLimits(files, metadata);
  if (exceeded) throw new Error(exceeded);
  return { files, metadata };
}

export async function restoreWorkspace(
  bash: Bash,
  files: Record<string, Uint8Array>,
  metadata: WorkspaceMetadata,
) {
  const exceeded = checkWorkspaceLimits(files, metadata);
  if (exceeded) throw new Error(exceeded);
  await bash.fs.rm(ROOT, { recursive: true, force: true });
  await bash.fs.mkdir(ROOT, { recursive: true });
  for (const [path, entry] of Object.entries(metadata).sort(([a], [b]) => a.length - b.length)) {
    validPath(path);
    if (entry.kind === "directory") await bash.fs.mkdir(path, { recursive: true });
  }
  for (const [path, content] of Object.entries(files)) {
    validPath(path);
    await bash.fs.mkdir(posix.dirname(path), { recursive: true });
    await bash.fs.writeFile(path, content);
  }
  for (const [path, entry] of Object.entries(metadata)) {
    if (entry.kind === "symlink") {
      if (entry.target === undefined) throw new Error("symlink without target");
      validLink(path, entry.target);
      await bash.fs.mkdir(posix.dirname(path), { recursive: true });
      await bash.fs.symlink(entry.target, path);
    } else await bash.fs.chmod(path, entry.mode);
  }
}
