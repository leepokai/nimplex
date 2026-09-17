import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { compositionFixture, deferred } from "./testing/pi-composition-fixture.ts";
import { attachQualificationExtension } from "./testing/pi-extension-fixture.ts";
import { context, getOrThrow, harnessFixture, hasMessage } from "./testing/pi-harness-fixture.ts";

import { probeExtension as representative, workspaceProbe } from "./testing/pi-probe-extension.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function setup(inject?: (f: Awaited<ReturnType<typeof harnessFixture>>) => void) {
  const f = await harnessFixture({ compatibility: true });
  cleanup.push(f.close);
  const opened = await f.open();
  const witness = { restored: 0, effects: 0 };
  const extension = workspaceProbe(opened.bash, witness);
  inject?.(f);
  const bridge = await attachQualificationExtension(f, opened, extension);
  cleanup.push(async () => {
    await bridge.close().catch(() => {});
  });
  return { f, opened, bridge, witness, extension };
}

it("matches baseline Pi extension transformations and persists its custom state", async () => {
  const baselineWitness = { restored: 0, effects: 0 };
  const baseline = await compositionFixture(representative(baselineWitness));
  cleanup.push(baseline.close);
  await baseline.session.prompt("Write once");
  const { f, opened, bridge, witness } = await setup();
  expect(getOrThrow(await opened.lane.prompt("Write once", undefined, context)).status).toBe(
    "completed",
  );
  expect(witness.effects).toBe(1);
  expect(await opened.bash.fs.readFile("/workspace/probe.txt")).toBe(
    readFileSync(join(baseline.directory, "probe.txt"), "utf8"),
  );
  const entries = await opened.session.findEntries({ order: "asc" }, context);
  const baselineEntries = baseline.session.sessionManager.getEntries();
  const states = (items: { type: string; customType?: string; data?: unknown }[]) =>
    items.filter((e) => e.type === "custom" && e.customType === "probe-state").map((e) => e.data);
  expect(states(entries)).toEqual(states(baselineEntries));
  expect(states(entries)).toEqual([{ counter: 1 }, { counter: 2 }]);
  const toolResult = entries.find((e) => e.type === "message" && e.message.role === "toolResult");
  expect(toolResult).toMatchObject({
    message: {
      content: [{ type: "text", text: "EXTENSION RESULT" }],
      details: { transformed: true },
    },
  });
  expect(entries.at(-1)).toMatchObject({ type: "custom", customType: "probe-state" });
  expect(
    entries.some(
      (e) =>
        e.type === "message" &&
        e.message.role === "assistant" &&
        e.message.content.some((part) => part.type === "text" && part.text === "EXTENSION FINAL"),
    ),
  ).toBe(true);
  await bridge.refresh();
  const capturedContext = bridge.runner.createContext();
  const visibleKinds = (items: typeof baselineEntries) =>
    items
      .filter((e) => e.type === "message" || e.type === "custom")
      .map((e) => (e.type === "message" ? e.message.role : e.type));
  expect(visibleKinds(capturedContext.sessionManager.getBranch())).toEqual(
    visibleKinds(baseline.session.sessionManager.getBranch()),
  );
  expect(
    capturedContext.sessionManager
      .getEntries()
      .filter((e) => e.type === "message" || e.type === "custom")
      .map((e) => e.id)
      .sort(),
  ).toEqual(entries.map((e) => e.id).sort());
  // Native value mutations now have their own mapped Pi-facing entry identities.
  expect(
    capturedContext.sessionManager
      .getEntries()
      .filter((e) => e.type === "model_change" || e.type === "thinking_level_change"),
  ).toEqual([
    expect.objectContaining({
      type: "model_change",
      provider: f.model.provider,
      modelId: f.model.id,
    }),
    expect.objectContaining({ type: "thinking_level_change", thinkingLevel: "off" }),
  ]);
  expect(bridge.errors).toEqual([]);
  await bridge.close();
  await opened.harness.close(context);
  await opened.session.close(context);
  const restored = await f.open();
  const restoredWitness = { restored: 0, effects: 0 };
  const restoredBridge = await attachQualificationExtension(
    f,
    restored,
    representative(restoredWitness),
  );
  cleanup.push(restoredBridge.close);
  expect(restoredWitness.restored).toBe(2);
  expect(await restored.session.findEntries({ order: "asc" }, context)).toEqual(entries);
  expect(() => capturedContext.sessionManager.getEntries()).toThrow();
});

function isCustomWrite(writes: import("@earendil-works/pi-agent-core/harness/session").Write[]) {
  return writes.some((w) =>
    w.kind === "entry"
      ? w.entry.type === "custom" && w.entry.customType === "probe-state"
      : w.kind === "value" &&
        w.op === "set" &&
        w.namespace === "pi.pending.entry" &&
        (w.value as { customType?: string }).customType === "probe-state",
  );
}

it("holds tool dispatch until extension-originated custom state is committed", async () => {
  const reached = deferred(),
    release = deferred();
  const { opened, witness } = await setup((f) => {
    f.beforeCommit = async (writes) => {
      if (isCustomWrite(writes)) {
        reached.resolve();
        await release.promise;
      }
    };
  });
  const run = opened.lane.prompt("Write once", undefined, context);
  try {
    await reached.promise;
    expect(witness.effects).toBe(0);
  } finally {
    release.resolve();
  }
  expect(getOrThrow(await run).status).toBe("completed");
  expect(witness.effects).toBe(1);
});

it("halts dependent effects when Pi swallows an extension custom-entry commit failure", async () => {
  const { f, opened, bridge, witness } = await setup((f) => {
    f.beforeCommit = async (writes) => {
      if (isCustomWrite(writes)) throw new Error("extension commit rejected");
    };
  });
  await expect(opened.lane.prompt("Write once", undefined, context)).rejects.toThrow();
  await expect(bridge.mutations.flush()).rejects.toThrow();
  expect(witness.effects).toBe(0);
  expect(f.upstream.state.messagesCalls).toHaveLength(1);
  expect(
    (await opened.session.findEntries(undefined, context)).some((e) => e.type === "custom"),
  ).toBe(false);
});

it("rechecks ownership at extension tool dispatch after the durable intent", async () => {
  const { f, opened, witness } = await setup();
  opened.harness.events.on("tool_start", () => f.loseOwnership());
  await expect(opened.lane.prompt("Write once", undefined, context)).rejects.toThrow();
  expect(witness.effects).toBe(0);
  expect(f.upstream.state.messagesCalls).toHaveLength(1);
  expect(await opened.bash.fs.exists("/workspace/probe.txt")).toBe(false);
});

it("restores accepted custom state before extension startup and preserves it through continuation", async () => {
  const { f, opened, bridge, witness } = await setup();
  f.afterCommit = async (writes) => {
    if (hasMessage(writes, "assistant")) throw new Error("lost after response commit");
  };
  await expect(opened.lane.prompt("Write once", undefined, context)).rejects.toThrow();
  expect(witness.effects).toBe(0);
  await bridge.close();
  await opened.harness.close(context);
  await opened.session.close(context);
  f.afterCommit = undefined;
  const restored = await f.open();
  const queues = (await restored.lane.watch(context)).snapshot.queues;
  expect(queues).toContainEqual(
    expect.objectContaining({
      kind: "write",
      type: "custom",
      customType: "probe-state",
      data: { counter: 1 },
    }),
  );
  const afterRestart = { restored: 0, effects: 0 };
  const restoredBridge = await attachQualificationExtension(
    f,
    restored,
    workspaceProbe(restored.bash, afterRestart),
  );
  cleanup.push(restoredBridge.close);
  expect(afterRestart.restored).toBe(1);
  const accepted = restoredBridge.view.manager.getEntries().find((e) => e.type === "custom");
  expect(accepted).toBeDefined();
  expect(getOrThrow(await restored.lane.resume(context)).status).toBe("completed");
  await restoredBridge.refresh();
  expect(afterRestart.effects).toBe(1);
  expect(f.upstream.state.messagesCalls).toHaveLength(2);
  expect(restoredBridge.view.manager.getEntry(accepted?.id ?? "missing")).toEqual(accepted);
  expect(
    restoredBridge.view.manager
      .getBranch()
      .filter((e) => e.type === "custom")
      .map((e) => e.data),
  ).toEqual([{ counter: 1 }, { counter: 2 }]);
});
