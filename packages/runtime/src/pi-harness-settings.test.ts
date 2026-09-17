import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import {
  type ExtensionAPI,
  type ExtensionFactory,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it } from "vitest";
import { modelChangeAddress } from "./pi-extensions/model-change.ts";
import { compositionFixture, deferred } from "./testing/pi-composition-fixture.ts";
import { attachQualificationExtension } from "./testing/pi-extension-fixture.ts";
import { context, getOrThrow, harnessFixture } from "./testing/pi-harness-fixture.ts";
import { workspaceProbe } from "./testing/pi-probe-extension.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture(extra?: ExtensionFactory, settings?: SettingsManager) {
  const f = await harnessFixture({ compatibility: true });
  cleanup.push(f.close);
  const opened = await f.open(),
    witness = { effects: 0, restored: 0 };
  let api: ExtensionAPI | undefined;
  const bridge = await attachQualificationExtension(
    f,
    opened,
    (pi) => {
      api = pi;
      workspaceProbe(opened.bash, witness)(pi);
      return extra?.(pi);
    },
    { settings },
  );
  cleanup.push(async () => {
    await bridge.close().catch(() => {});
  });
  if (!api) throw new Error("Missing extension API");
  return { f, opened, witness, api, bridge };
}
function modelPair() {
  const models = getBuiltinModels("anthropic");
  const first = models[0],
    second = models.find((m) => m.reasoning && m.id !== first?.id);
  if (!first || !second) throw new Error("Missing pinned model pair");
  return { first, second };
}

it("matches Pi's name/tool/thinking actions and durable notification ordering", async () => {
  let baselineAPI: ExtensionAPI | undefined;
  const baselineEvents: string[] = [],
    events: string[] = [];
  const hooks =
    (target: string[]): ExtensionFactory =>
    (pi) => {
      pi.on("session_info_changed", (event) => {
        target.push(`name:${event.name}`);
      });
      pi.on("thinking_level_select", (event) => {
        target.push(`thinking:${event.level}`);
      });
      pi.on("model_select", (event) => {
        target.push(`model:${event.model.id}`);
      });
    };
  const baseline = await compositionFixture((pi) => {
    baselineAPI = pi;
    hooks(baselineEvents)(pi);
  });
  cleanup.push(baseline.close);
  if (!baselineAPI) throw new Error("Missing baseline API");
  const { f, opened, api, bridge } = await fixture(hooks(events));
  for (const target of [baselineAPI, api]) {
    target.setSessionName("  durable\nname  ");
    target.setActiveTools(["probe", "missing", "probe"]);
    target.setThinkingLevel("max");
  }
  expect(api.getSessionName()).toBe(baselineAPI.getSessionName());
  expect(api.getActiveTools()).toEqual(baselineAPI.getActiveTools());
  expect(api.getThinkingLevel()).toBe(baselineAPI.getThinkingLevel());
  expect(api.getAllTools().find((tool) => tool.name === "probe")?.parameters).toEqual(
    baselineAPI.getAllTools().find((tool) => tool.name === "probe")?.parameters,
  );
  await bridge.mutations.flush();
  const { second } = modelPair();
  expect(await api.setModel(second)).toBe(await baselineAPI.setModel(second));
  await bridge.mutations.flush();
  expect(api.getThinkingLevel()).toBe(baselineAPI.getThinkingLevel());
  expect(events).toEqual(baselineEvents);
  expect(bridge.view.manager.getSessionName()).toBe("durable name");
  const target = bridge.view.manager.getBranch()[0];
  if (!target) throw new Error("Missing label target");
  api.setLabel(target.id, "bookmark");
  await bridge.mutations.flush();
  expect(bridge.view.manager.getLabel(target.id)).toBe("bookmark");
  api.setLabel(target.id, undefined);
  api.setSessionName("");
  api.setActiveTools([]);
  await bridge.mutations.flush();
  expect(bridge.view.manager.getLabel(target.id)).toBeUndefined();
  expect(bridge.view.manager.getSessionName()).toBeUndefined();
  expect(await opened.lane.getActiveTools(context)).toEqual([]);
  expect((await opened.session.getValue(modelChangeAddress("main"), context))?.value.status).toBe(
    "applied",
  );
  expect(f.upstream.state.messagesCalls).toHaveLength(0);
  await bridge.close();
  await opened.harness.close(context);
  await opened.session.close(context);
  const restored = await f.open();
  const restoredBridge = await attachQualificationExtension(
    f,
    restored,
    workspaceProbe(restored.bash, { restored: 0, effects: 0 }),
  );
  cleanup.push(restoredBridge.close);
  expect(restoredBridge.settingActions.actions.getActiveTools()).toEqual([]);
  expect(restoredBridge.settingActions.actions.getSessionName()).toBeUndefined();
  expect(restoredBridge.view.manager.getLabel(target.id)).toBeUndefined();
});

it("does not let a later unauthenticated selection hide a successfully applied thinking level", async () => {
  const { second } = modelPair();
  const settings = SettingsManager.inMemory();
  settings.setDefaultThinkingLevel("high");
  const { api, bridge, opened } = await fixture(undefined, settings);
  const selected = api.setModel(second);
  const declined = api.setModel({ ...second, provider: "missing-fixture-auth" });
  expect(await selected).toBe(true);
  expect(await declined).toBe(false);
  await bridge.mutations.flush();
  expect(api.getThinkingLevel()).toBe(await opened.lane.getThinkingLevel(context));
  expect(api.getThinkingLevel()).toBe("high");
});

it("keeps missing-auth selection non-fatal and allows model-select handlers to await another selection", async () => {
  const { first, second } = modelPair();
  const { api, bridge, opened } = await fixture((pi) => {
    pi.on("model_select", async (event) => {
      if (event.model.id === second.id) await pi.setModel(first);
    });
  });
  expect(await api.setModel({ ...second, provider: "missing-fixture-auth" })).toBe(false);
  await bridge.mutations.flush();
  expect(await api.setModel(second)).toBe(true);
  await bridge.mutations.flush();
  expect((await opened.lane.getModel(context))?.id).toBe(first.id);
  expect(bridge.runner.createContext().model?.id).toBe(first.id);
});

it("uses per-model thinking preferences and restores accepted model changes before startup", async () => {
  const { second } = modelPair();
  const settings = SettingsManager.inMemory();
  settings.setDefaultThinkingLevel("low");
  settings.setModelThinkingLevel(second.provider, second.id, "high");
  const { f, opened, api, bridge } = await fixture(undefined, settings);
  f.afterCommit = async (writes) => {
    if (writes.some((w) => w.kind === "value" && w.namespace === "pi.lane.config"))
      throw new Error("lost after model commit");
  };
  await expect(api.setModel(second)).rejects.toThrow();
  const accepted = (await opened.session.getValue(modelChangeAddress("main"), context))?.value;
  expect(accepted).toMatchObject({
    status: "accepted",
    thinkingLevel: "high",
    model: { modelId: second.id },
  });
  await bridge.close().catch(() => {});
  await opened.harness.close(context);
  await opened.session.close(context);
  f.afterCommit = undefined;
  const recovered = await f.open();
  let startupModel: string | undefined, startupThinking: string | undefined;
  const next = await attachQualificationExtension(
    f,
    recovered,
    (pi) => {
      pi.on("session_start", (_event, ctx) => {
        startupModel = ctx.model?.id;
        startupThinking = pi.getThinkingLevel();
      });
    },
    { settings },
  );
  cleanup.push(next.close);
  expect(startupModel).toBe(second.id);
  expect(startupThinking).toBe("high");
  expect((await recovered.session.getValue(modelChangeAddress("main"), context))?.value).toEqual({
    ...accepted,
    status: "applied",
  });
  expect(f.upstream.state.messagesCalls).toHaveLength(0);
});

it("holds effects for staged settings and latches a swallowed commit failure", async () => {
  const reached = deferred(),
    release = deferred();
  const { f, opened, witness, bridge } = await fixture((pi) => {
    pi.on("message_end", (event) => {
      if (event.message.role === "assistant") pi.setSessionName("before tools");
    });
  });
  const previous = f.beforeCommit;
  f.beforeCommit = async (writes) => {
    await previous?.(writes);
    if (writes.some((w) => w.kind === "value" && w.namespace === "pi.session.name")) {
      reached.resolve();
      await release.promise;
      throw new Error("settings commit rejected");
    }
  };
  const pending = expect(opened.lane.prompt("Write once", undefined, context)).rejects.toThrow();
  try {
    await reached.promise;
    expect(witness.effects).toBe(0);
    expect(await opened.harness.getName(context)).toBeUndefined();
  } finally {
    release.resolve();
  }
  await pending;
  await expect(bridge.mutations.flush()).rejects.toMatchObject({
    message: "AgentHarness storage or invariant fault",
    cause: expect.objectContaining({ message: "settings commit rejected" }),
  });
  expect(witness.effects).toBe(0);
  expect(f.upstream.state.messagesCalls).toHaveLength(1);
});

it.each(["assistant", "tool", "summary"] as const)(
  "refuses %s dispatch while a model change is incomplete",
  async (boundary) => {
    const { second } = modelPair();
    const { f, opened, witness } = await fixture();
    const acceptChange = () =>
      opened.session.setValue(
        modelChangeAddress("main"),
        {
          version: 1,
          id: crypto.randomUUID(),
          status: "accepted",
          model: { provider: second.provider, modelId: second.id },
          thinkingLevel: "high",
        },
        context,
      );
    if (boundary === "summary")
      getOrThrow(await opened.lane.prompt("Write once", undefined, context));
    const requests = f.upstream.state.messagesCalls.length,
      effects = witness.effects;
    if (boundary === "tool")
      opened.harness.hooks.on("after_response", async () => {
        await acceptChange();
        return undefined;
      });
    else await acceptChange();
    await expect(
      boundary === "summary"
        ? opened.lane.compact(undefined, context)
        : opened.lane.prompt("must not dispatch", undefined, context),
    ).rejects.toThrow();
    expect(f.upstream.state.messagesCalls).toHaveLength(requests + (boundary === "tool" ? 1 : 0));
    expect(witness.effects).toBe(effects);
  },
);

it("does not alter configuration when the model-change acceptance transaction is rejected", async () => {
  const { second } = modelPair();
  const { f, opened, api, bridge } = await fixture();
  const before = await opened.lane.getModel(context);
  const previous = f.beforeCommit;
  f.beforeCommit = async (writes) => {
    await previous?.(writes);
    if (
      writes.some((w) => w.kind === "value" && w.namespace === "nimplex.pi.extension.model-change")
    )
      throw new Error("model change acceptance rejected");
  };
  await expect(api.setModel(second)).rejects.toThrow("model change acceptance rejected");
  await expect(bridge.mutations.flush()).rejects.toThrow("model change acceptance rejected");
  expect(await opened.session.getValue(modelChangeAddress("main"), context)).toBeUndefined();
  expect((await opened.lane.getModel(context))?.id).toBe(before?.id);
  expect(f.upstream.state.messagesCalls).toHaveLength(0);
});

it("fails startup visibly when an accepted model change cannot restore its catalog", async () => {
  const { f, opened, bridge } = await fixture();
  const accepted = {
    version: 1 as const,
    id: crypto.randomUUID(),
    status: "accepted" as const,
    model: { provider: "missing-provider", modelId: "unavailable" },
    thinkingLevel: "high" as const,
  };
  await opened.session.setValue(modelChangeAddress("main"), accepted, context);
  await bridge.close();
  await opened.harness.close(context);
  await opened.session.close(context);
  const restored = await f.open();
  let started = false;
  await expect(
    attachQualificationExtension(f, restored, (pi) => {
      pi.on("session_start", () => {
        started = true;
      });
    }),
  ).rejects.toThrow("pinned model catalog");
  expect(started).toBe(false);
  expect((await restored.session.getValue(modelChangeAddress("main"), context))?.value).toEqual(
    accepted,
  );
  await expect(restored.lane.prompt("must not dispatch", undefined, context)).rejects.toThrow();
  expect(f.upstream.state.messagesCalls).toHaveLength(0);
});

it("rejects settings actions after ownership loss without staging a new value", async () => {
  const { f, opened, api, bridge } = await fixture();
  f.loseOwnership();
  expect(() => api.setSessionName("stale owner")).toThrow("Ownership lost");
  expect(() => api.setActiveTools([])).toThrow("Ownership lost");
  await bridge.mutations.flush();
  expect(await opened.harness.getName(context)).toBeUndefined();
  expect(await opened.lane.getActiveTools(context)).toEqual(["probe"]);
});

it.each(["queued", "committing"])(
  "drains a %s settings write before invalidating the extension view on close",
  async (boundary) => {
    let notifiedName: string | undefined;
    const { f, opened, api, bridge } = await fixture((pi) => {
      pi.on("session_info_changed", () => {
        notifiedName = pi.getSessionName();
      });
    });
    const reached = deferred(),
      release = deferred();
    const previous = f.beforeCommit;
    f.beforeCommit = async (writes) => {
      await previous?.(writes);
      if (writes.some((w) => w.kind === "value" && w.namespace === "pi.session.name")) {
        reached.resolve();
        await release.promise;
      }
    };
    api.setSessionName("accepted before close");
    if (boundary === "committing") await reached.promise;
    const closing = bridge.close();
    await reached.promise;
    expect(bridge.close()).toBe(closing);
    expect(() => api.setSessionName("late admission")).toThrow("closed");
    release.resolve();
    await closing;
    expect(await opened.harness.getName(context)).toBe("accepted before close");
    expect(notifiedName).toBe("accepted before close");
    expect(bridge.errors).toEqual([]);
    expect(() => bridge.view.manager.getEntries()).toThrow("no longer active");
  },
);
