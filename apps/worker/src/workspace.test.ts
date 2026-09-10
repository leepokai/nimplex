import { Bash } from "just-bash";
import { describe, expect, it } from "vitest";
import { restoreWorkspace, snapshotWorkspace } from "./workspace.ts";

describe("workspace snapshots", () => {
  it("round-trips binary files, empty directories, symlinks and executable bits", async () => {
    const first = new Bash({ cwd: "/workspace" });
    await first.fs.mkdir("/workspace/empty", { recursive: true });
    await first.fs.writeFile("/workspace/bin", new Uint8Array([0, 255, 1]));
    await first.fs.chmod("/workspace/bin", 0o755);
    await first.fs.symlink("bin", "/workspace/link");
    const saved = await snapshotWorkspace(first);
    const second = new Bash({ cwd: "/workspace", files: { "/workspace/stale": "delete me" } });
    await restoreWorkspace(second, saved.files, saved.metadata);
    expect(await second.fs.exists("/workspace/stale")).toBe(false);
    expect((await second.fs.stat("/workspace/empty")).isDirectory).toBe(true);
    expect(await second.fs.readlink("/workspace/link")).toBe("bin");
    expect([...(await second.fs.readFileBuffer("/workspace/link"))]).toEqual([0, 255, 1]);
    expect((await second.fs.stat("/workspace/bin")).mode & 0o777).toBe(0o755);
    expect(await snapshotWorkspace(second)).toEqual(saved);
  });
  it("rejects escaping symlinks and noncanonical snapshot paths", async () => {
    const bash = new Bash({ cwd: "/workspace" });
    await bash.fs.mkdir("/workspace", { recursive: true });
    await bash.fs.symlink("/etc/passwd", "/workspace/leak");
    await expect(snapshotWorkspace(bash)).rejects.toThrow("symlink escapes");
    await expect(
      restoreWorkspace(bash, { "/workspace/../outside": new Uint8Array() }, {}),
    ).rejects.toThrow("invalid workspace path");
  });
});
