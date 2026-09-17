import { fork } from "node:child_process";
import { once } from "node:events";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { SqlitePiStorage } from "./pi-storage/sqlite.ts";
import { attachQualificationExtension } from "./testing/pi-extension-fixture.ts";
import { context, getOrThrow, harnessFixture } from "./testing/pi-harness-fixture.ts";
import { workspaceProbe } from "./testing/pi-probe-extension.ts";

it.each([
  { role: "assistant", compatibility: false },
  { role: "toolResult", compatibility: false },
  { role: "assistant", compatibility: true },
  { role: "toolResult", compatibility: true },
] as const)(
  "recovers from SIGKILL after $role (extensions: $compatibility) using SQLite alone",
  async ({ role, compatibility }) => {
    const child = fork(
      fileURLToPath(new URL("./testing/pi-harness-child.ts", import.meta.url)),
      [role, compatibility ? "extension" : "core"],
      { execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"] },
    );
    const exited = once(child, "exit");
    let directory: string | undefined;
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    let restored: Awaited<ReturnType<typeof harnessFixture>> | undefined;
    let bridge: Awaited<ReturnType<typeof attachQualificationExtension>> | undefined;
    try {
      const witness = await new Promise<{ effects: number; requests: number }>(
        (resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`Commit boundary timeout: ${stderr}`)),
            10_000,
          );
          child.once("exit", () => {
            clearTimeout(timer);
            reject(new Error(`Unexpected child exit: ${stderr}`));
          });
          child.on(
            "message",
            (message: { stage: string; directory?: string; effects: number; requests: number }) => {
              if (message.stage === "ready") directory = message.directory;
              if (message.stage === "committed") {
                clearTimeout(timer);
                resolve(message);
              }
            },
          );
        },
      );
      expect(witness).toMatchObject({ effects: role === "assistant" ? 0 : 1, requests: 1 });
      child.kill("SIGKILL");
      expect(await exited).toEqual([null, "SIGKILL"]);
      if (!directory) throw new Error("Child did not supply a database directory");
      const db = new DatabaseSync(join(directory, "pi.sqlite"));
      let committed: Record<string, unknown>[];
      try {
        committed = db
          .prepare("SELECT id,parent_id,seq,data FROM pi_store_entries ORDER BY seq")
          .all();
      } finally {
        db.close();
      }
      restored = await harnessFixture({ directory, compatibility });
      const maintenance = new SqlitePiStorage(
        restored.db,
        { tenantId: "test", sessionId: "session" },
        () => {},
      );
      try {
        const stats = await maintenance.getStats(context);
        expect((await maintenance.rebuildProjections()).stats).toEqual(stats);
      } finally {
        await maintenance.close(context);
      }
      const recovered = await restored.open();
      const extensionWitness = { restored: 0, effects: 0 };
      if (compatibility) {
        bridge = await attachQualificationExtension(
          restored,
          recovered,
          workspaceProbe(recovered.bash, extensionWitness),
        );
        expect(extensionWitness.restored).toBe(1);
      }
      const customBefore = bridge?.view.manager.getEntries().find((e) => e.type === "custom");
      expect(recovered.open).toHaveLength(1);
      expect(getOrThrow(await recovered.lane.resume(context)).status).toBe("completed");
      expect(compatibility ? extensionWitness.effects : restored.effects).toBe(
        role === "assistant" ? 1 : 0,
      );
      expect(restored.upstream.state.messagesCalls).toHaveLength(1);
      expect(await recovered.bash.fs.readFile("/workspace/probe.txt")).toBe(
        compatibility ? "EXTENSION FILE" : "ONCE",
      );
      if (bridge) {
        await bridge.refresh();
        expect(bridge.view.manager.getEntry(customBefore?.id ?? "missing")).toEqual(customBefore);
        expect(
          bridge.view.manager
            .getBranch()
            .filter((e) => e.type === "custom")
            .map((e) => e.data),
        ).toEqual([{ counter: 1 }, { counter: 2 }]);
      }
      const after = restored.db
        .prepare("SELECT id,parent_id,seq,data FROM pi_store_entries ORDER BY seq")
        .all();
      expect(after.slice(0, committed.length)).toEqual(committed);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
      await bridge?.close();
      if (restored) await restored.close();
      else if (directory) rmSync(directory, { recursive: true, force: true });
    }
  },
  15_000,
);
