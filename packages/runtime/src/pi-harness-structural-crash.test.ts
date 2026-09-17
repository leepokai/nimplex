import { fork } from "node:child_process";
import { once } from "node:events";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { PiCompatibilityStore } from "./pi-extensions/compatibility-store.ts";
import { modelChangeAddress } from "./pi-extensions/model-change.ts";
import { PiSessionView } from "./pi-extensions/session-view.ts";
import { SqlitePiStorage } from "./pi-storage/sqlite.ts";
import { attachQualificationExtension } from "./testing/pi-extension-fixture.ts";
import { context, getOrThrow, harnessFixture } from "./testing/pi-harness-fixture.ts";
import { workspaceProbe } from "./testing/pi-probe-extension.ts";

it.each([
  "compaction",
  "extension_compaction",
  "branch_summary",
  "metadata",
  "model_change",
  "compaction_usage",
  "navigation_usage",
] as const)(
  "restores %s after SIGKILL before acknowledgement, without rerunning completed work",
  async (kind) => {
    const child = fork(
      fileURLToPath(new URL("./testing/pi-structural-child.ts", import.meta.url)),
      [kind],
      {
        execArgv: ["--import", "tsx"],
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
    const exited = once(child, "exit");
    let directory: string | undefined;
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    let fixture: Awaited<ReturnType<typeof harnessFixture>> | undefined;
    let bridge: Awaited<ReturnType<typeof attachQualificationExtension>> | undefined;
    try {
      const boundary = await new Promise<{
        entryId: string;
        effects: number;
        requests: number;
        model: { provider: string; modelId: string };
      }>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Structural boundary timeout: ${stderr}`)),
          10_000,
        );
        child.once("exit", () => {
          clearTimeout(timer);
          reject(new Error(`Unexpected child exit: ${stderr}`));
        });
        child.on(
          "message",
          (message: {
            stage: string;
            directory?: string;
            entryId: string;
            effects: number;
            requests: number;
            model: { provider: string; modelId: string };
          }) => {
            if (message.stage === "ready") directory = message.directory;
            if (message.stage === "committed") {
              clearTimeout(timer);
              resolve(message);
            }
          },
        );
      });
      const failedSummary = kind === "compaction_usage" || kind === "navigation_usage";
      expect(boundary).toMatchObject(
        failedSummary ? { effects: 0, requests: 1 } : { effects: 1, requests: 2 },
      );
      child.kill("SIGKILL");
      expect(await exited).toEqual([null, "SIGKILL"]);
      if (!directory) throw new Error("Missing child storage directory");
      fixture = await harnessFixture({ directory, compatibility: true });
      const maintenance = new SqlitePiStorage(
        fixture.db,
        { tenantId: "test", sessionId: "session" },
        fixture.assertAuthority,
      );
      const projection = new PiCompatibilityStore(maintenance, {
        id: "session",
        cwd: "/workspace",
        createdAt: 0,
      });
      const before = await projection.snapshot("main", context);
      const nativeBefore = await maintenance.scanEntries({}, context);
      const statsBefore = await maintenance.getStats(context);
      try {
        expect((await maintenance.rebuildProjections()).stats).toEqual(statsBefore);
        expect(await projection.snapshot("main", context)).toEqual(before);
        expect(await maintenance.scanEntries({}, context)).toEqual(nativeBefore);
      } finally {
        await projection.storage.close(context);
      }
      const opened = await fixture.open();
      if (failedSummary) {
        const witness = { restored: 0, effects: 0 };
        bridge = await attachQualificationExtension(
          fixture,
          opened,
          workspaceProbe(opened.bash, witness),
        );
        const usageBefore = await opened.storage.scanUsage({}, context);
        expect(usageBefore).toHaveLength(1);
        expect(usageBefore[0]?.usage).toMatchObject({ input: 23, output: 5, totalTokens: 28 });
        const responses = await opened.summaryResponses?.read(context);
        expect(responses).toHaveLength(1);
        expect(responses?.[0]).toMatchObject({
          usageId: usageBefore[0]?.id,
          response: { stopReason: "length", usage: usageBefore[0]?.usage },
          delivered: { stopReason: "error" },
        });
        expect(opened.open).toHaveLength(1);
        expect(
          nativeBefore.some(
            (entry) => entry.type === "compaction" || entry.type === "branch_summary",
          ),
        ).toBe(false);
        expect(getOrThrow(await opened.lane.resume(context))).toMatchObject({
          status: "failed",
          error: { code: "structural_interrupted" },
        });
        await bridge.mutations.flush();
        expect(await opened.storage.scanUsage({}, context)).toEqual(usageBefore);
        expect(await opened.summaryResponses?.read(context)).toEqual(responses);
        expect(await opened.storage.getStats(context)).toEqual(statsBefore);
        expect(await opened.compatibility?.snapshot("main", context)).toEqual(before);
        expect(fixture.upstream.state.messagesCalls).toHaveLength(0);
        expect(witness).toEqual({ restored: 0, effects: 0 });
        return;
      }
      const interruptedChange = (await opened.session.getValue(modelChangeAddress("main"), context))
        ?.value;
      if (kind === "model_change") {
        expect(interruptedChange).toMatchObject({
          status: "accepted",
          model: boundary.model,
          thinkingLevel: "high",
        });
        expect(await opened.lane.getThinkingLevel(context)).toBe("off");
      }
      const witness = { restored: 0, effects: 0 };
      let replayedNotifications = 0;
      bridge = await attachQualificationExtension(fixture, opened, (pi) => {
        workspaceProbe(opened.bash, witness)(pi);
        pi.on("session_compact", () => {
          replayedNotifications++;
        });
      });
      expect(opened.open).toEqual([]);
      expect(witness).toEqual({ restored: 2, effects: 0 });
      expect(fixture.upstream.state.messagesCalls).toHaveLength(0);
      expect(await opened.lane.getTipId(context)).toBe(boundary.entryId);
      if (kind === "model_change") {
        expect((await opened.session.getValue(modelChangeAddress("main"), context))?.value).toEqual(
          { ...interruptedChange, status: "applied" },
        );
        expect(bridge.view.manager.buildSessionContext()).toMatchObject({
          model: boundary.model,
          thinkingLevel: "high",
        });
        expect(await opened.lane.getThinkingLevel(context)).toBe("high");
        for (const entry of before.entries)
          expect(bridge.view.manager.getEntry(entry.id)).toEqual(entry);
      } else if (kind === "metadata") {
        expect(bridge.view.manager.getLeafEntry()).toMatchObject({
          type: "label",
          targetId: boundary.entryId,
          label: "checkpoint",
        });
        expect(bridge.view.manager.getSessionName()).toBe("Restored metadata");
        expect(bridge.view.manager.getLabel(boundary.entryId)).toBe("checkpoint");
        expect(bridge.view.manager.buildSessionContext()).toMatchObject({
          model: boundary.model,
          thinkingLevel: "high",
        });
        expect(await opened.lane.getThinkingLevel(context)).toBe("high");
        expect(bridge.runner.createContext().model).toMatchObject({
          provider: boundary.model.provider,
          id: boundary.model.modelId,
        });
      } else {
        expect(bridge.view.manager.getLeafId()).toBe(boundary.entryId);
        expect(bridge.view.manager.getLeafEntry()).toMatchObject({
          type: kind === "extension_compaction" ? "compaction" : kind,
          summary: "Committed structural summary",
        });
      }
      if (kind !== "model_change")
        expect(bridge.view.manager.buildContextEntries()).toEqual(
          new PiSessionView(before).manager.buildContextEntries(),
        );
      expect(await opened.bash.fs.readFile("/workspace/probe.txt")).toBe("EXTENSION FILE");
      if (kind === "compaction")
        expect(bridge.view.manager.buildSessionContext().messages.slice(1)).toEqual([
          { role: "user", content: "Retained replacement", timestamp: 10 },
        ]);
      if (kind === "extension_compaction") {
        expect(replayedNotifications).toBe(0);
        expect(
          bridge.view.manager
            .getEntries()
            .filter(
              (entry) => entry.type === "custom" && entry.customType === "compaction-hook-state",
            ),
        ).toMatchObject([{ data: { checkpoint: 1 } }]);
        expect(bridge.view.manager.getLeafEntry()).toMatchObject({
          fromHook: true,
          details: { fixture: true },
        });
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
      await bridge?.close();
      if (fixture) await fixture.close();
      else if (directory) rmSync(directory, { recursive: true, force: true });
    }
  },
  15_000,
);
