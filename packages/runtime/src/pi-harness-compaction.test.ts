import { value } from "@earendil-works/pi-agent-core/harness/session";
import type { ExtensionFactory, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it } from "vitest";
import { isPiEffectDispatch } from "./pi-extensions/model-change.ts";
import { compositionFixture, deferred } from "./testing/pi-composition-fixture.ts";
import { attachQualificationExtension } from "./testing/pi-extension-fixture.ts";
import { context, getOrThrow, harnessFixture } from "./testing/pi-harness-fixture.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const messages = ["Earlier ".repeat(100), "Recent ".repeat(100), "Newest"].map(
  (content, index) => ({
    role: "user" as const,
    content,
    timestamp: index + 1,
  }),
);
const usage = {
  input: 7,
  output: 3,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 10,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
async function fixture(
  factory: ExtensionFactory,
  options: Parameters<typeof harnessFixture>[0] = {},
) {
  const f = await harnessFixture({ ...options, compatibility: true });
  cleanup.push(f.close);
  const opened = await f.open();
  const bridge = await attachQualificationExtension(f, opened, factory);
  cleanup.push(async () => {
    await bridge.close().catch(() => {});
  });
  for (const message of messages) await opened.lane.appendMessage(message, context);
  return { f, opened, bridge };
}
function preparation(event: SessionBeforeCompactEvent) {
  const { firstKeptEntryId, ...shared } = event.preparation;
  const kept = event.branchEntries.find((entry) => entry.id === firstKeptEntryId);
  return { shared, kept: kept?.type === "message" ? kept.message : kept?.type };
}
function withoutSummaryTime(
  messages: ReturnType<
    import("@earendil-works/pi-coding-agent").SessionManager["buildSessionContext"]
  >["messages"],
) {
  return messages.map((message) =>
    message.role === "compactionSummary" ? { ...message, timestamp: 0 } : message,
  );
}

it("matches baseline preparation, custom retained context and committed completion notifications", async () => {
  const observations: unknown[][] = [[], []];
  const hooks =
    (index: number): ExtensionFactory =>
    (pi) => {
      pi.on("session_before_compact", (event) => {
        observations[index]?.push(preparation(event));
        expect(event.customInstructions).toBe("Keep decisions");
        expect(event.reason).toBe("manual");
        expect(event.willRetry).toBe(false);
        expect(event.signal.aborted).toBe(false);
        return {
          compaction: {
            summary: "Extension summary",
            firstKeptEntryId: event.preparation.firstKeptEntryId,
            tokensBefore: event.preparation.tokensBefore,
            details: { checkpoint: 1 },
          },
        };
      });
      pi.on("session_compact", (event, ctx) => {
        expect(ctx.sessionManager.getEntry(event.compactionEntry.id)).toEqual(
          event.compactionEntry,
        );
        expect(event.fromExtension).toBe(true);
        pi.setSessionName("summary committed");
      });
    };
  const baseline = await compositionFixture(hooks(0));
  cleanup.push(baseline.close);
  for (const message of messages) baseline.session.sessionManager.appendMessage(message);
  const { f, opened, bridge } = await fixture(hooks(1));
  await baseline.session.compact("Keep decisions");
  expect(
    getOrThrow(await bridge.compaction.compact({ customInstructions: "Keep decisions" }, context))
      .compaction.status,
  ).toBe("completed");
  expect(observations[1]).toEqual(observations[0]);
  await bridge.refresh();
  expect(withoutSummaryTime(bridge.view.manager.buildSessionContext().messages)).toEqual(
    withoutSummaryTime(baseline.session.sessionManager.buildSessionContext().messages),
  );
  expect(await opened.harness.getName(context)).toBe("summary committed");
  expect(f.upstream.state.messagesCalls).toHaveLength(0);
  expect(bridge.errors).toEqual([]);
  // A second compaction must retain the previous summary exactly as legacy Pi does.
  const next = { role: "user" as const, content: "Next long turn ".repeat(100), timestamp: 4 };
  baseline.session.sessionManager.appendMessage(next);
  await opened.lane.appendMessage(next, context);
  await baseline.session.compact("Keep decisions");
  getOrThrow(await bridge.compaction.compact({ customInstructions: "Keep decisions" }, context));
  await bridge.refresh();
  expect(observations[1]).toEqual(observations[0]);
  expect(withoutSummaryTime(bridge.view.manager.buildSessionContext().messages)).toEqual(
    withoutSummaryTime(baseline.session.sessionManager.buildSessionContext().messages),
  );
});

it("matches cancellation hooks without publishing a summary or calling a provider", async () => {
  const outcomes: unknown[][] = [[], []];
  const hooks =
    (index: number): ExtensionFactory =>
    (pi) => {
      pi.on("session_before_compact", () => ({ cancel: true }));
      pi.on("session_compact", () => {
        throw new Error("Cancelled compaction completed");
      });
      pi.on("session_compact_failed", (event) => {
        outcomes[index]?.push(event);
      });
    };
  const baseline = await compositionFixture(hooks(0));
  cleanup.push(baseline.close);
  for (const message of messages) baseline.session.sessionManager.appendMessage(message);
  const { f, opened, bridge } = await fixture(hooks(1));
  const before = await opened.compatibility?.snapshot("main", context);
  await expect(baseline.session.compact()).rejects.toThrow("cancelled");
  expect(getOrThrow(await bridge.compaction.compact(undefined, context)).compaction.status).toBe(
    "declined",
  );
  expect(outcomes[1]).toEqual(outcomes[0]);
  expect(await opened.compatibility?.snapshot("main", context)).toEqual(before);
  expect(f.upstream.state.messagesCalls).toHaveLength(0);
  expect(bridge.errors).toEqual([]);
});

it("drains pre-hook custom state and waits for the atomic summary commit before notifying", async () => {
  const reached = deferred(),
    release = deferred();
  let notified = false,
    acknowledged = false;
  const { f, opened, bridge } = await fixture((pi) => {
    pi.on("session_before_compact", (event) => {
      pi.appendEntry("summary-input", { version: 1 });
      return {
        compaction: {
          summary: "Committed",
          firstKeptEntryId: event.preparation.firstKeptEntryId,
          tokensBefore: 1,
          usage,
        },
      };
    });
    pi.on("session_compact", (_event, ctx) => {
      expect(
        ctx.sessionManager
          .getEntries()
          .some((entry) => entry.type === "custom" && entry.customType === "summary-input"),
      ).toBe(true);
      notified = true;
      pi.setSessionName("after summary");
    });
  });
  const previous = f.beforeCommit;
  f.beforeCommit = async (writes) => {
    await previous?.(writes);
    if (writes.some((write) => write.kind === "entry" && write.entry.type === "compaction")) {
      reached.resolve();
      await release.promise;
    }
  };
  const pending = bridge.compaction.compact(undefined, context).then((result) => {
    acknowledged = true;
    return result;
  });
  try {
    await reached.promise;
    expect(notified).toBe(false);
    expect(acknowledged).toBe(false);
    expect(await opened.storage.scanUsage({}, context)).toEqual([]);
    expect(
      (await opened.storage.scanEntries({ limit: 1000 }, context)).some(
        (entry) => entry.type === "compaction",
      ),
    ).toBe(false);
  } finally {
    release.resolve();
  }
  expect(getOrThrow(await pending).compaction.status).toBe("completed");
  expect(notified).toBe(true);
  expect(await opened.storage.scanUsage({}, context)).toMatchObject([{ usage }]);
  expect(await opened.harness.getName(context)).toBe("after summary");
  expect(bridge.errors).toEqual([]);
  expect(f.upstream.state.messagesCalls).toHaveLength(0);
});

it.each([
  "retention",
  "details",
  "tokens",
  "pre-write",
  "summary-write",
  "notification-write",
] as const)("blocks fallback/dependent requests after a required %s failure", async (boundary) => {
  let completed = false;
  const { f, opened, bridge } = await fixture((pi) => {
    pi.on("session_before_compact", (event) => {
      if (boundary === "pre-write") pi.setSessionName("before summary");
      return {
        compaction: {
          summary: "Must commit",
          firstKeptEntryId:
            boundary === "retention" ? "other-branch" : event.preparation.firstKeptEntryId,
          tokensBefore: boundary === "tokens" ? -1 : 1,
          details: boundary === "details" ? { invalid: Number.NaN } : undefined,
          usage,
        },
      };
    });
    pi.on("session_compact", () => {
      completed = true;
      if (boundary === "notification-write") pi.setSessionName("after summary");
    });
  });
  const previous = f.beforeCommit;
  f.beforeCommit = async (writes) => {
    await previous?.(writes);
    if (
      (boundary === "summary-write" &&
        writes.some((w) => w.kind === "entry" && w.entry.type === "compaction")) ||
      ((boundary === "pre-write" || boundary === "notification-write") &&
        writes.some((w) => w.kind === "value" && w.namespace === "pi.session.name"))
    )
      throw new Error(`Rejected ${boundary}`);
  };
  await expect(bridge.compaction.compact(undefined, context)).rejects.toThrow();
  await expect(bridge.mutations.flush()).rejects.toThrow();
  await expect(opened.lane.prompt("must not dispatch", undefined, context)).rejects.toThrow();
  expect(f.upstream.state.messagesCalls).toHaveLength(0);
  expect(completed).toBe(boundary === "notification-write");
  expect(await opened.storage.scanUsage({}, context)).toHaveLength(
    boundary === "notification-write" ? 1 : 0,
  );
  expect(
    (await opened.storage.scanEntries({ limit: 1000 }, context)).filter(
      (entry) => entry.type === "compaction",
    ),
  ).toHaveLength(boundary === "notification-write" ? 1 : 0);
});

it("propagates cancellation to the hook and refuses a late summary", async () => {
  const reached = deferred();
  let observed: AbortSignal | undefined;
  const failures: boolean[] = [];
  const { f, opened, bridge } = await fixture((pi) => {
    pi.on("session_before_compact", async (event) => {
      observed = event.signal;
      reached.resolve();
      await new Promise<void>((resolve) =>
        event.signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      return {
        compaction: {
          summary: "Too late",
          firstKeptEntryId: event.preparation.firstKeptEntryId,
          tokensBefore: 1,
        },
      };
    });
    pi.on("session_compact_failed", (event) => {
      failures.push(event.aborted);
    });
  });
  const pending = bridge.compaction.compact(undefined, context);
  await reached.promise;
  getOrThrow(await opened.lane.abort(context));
  expect(getOrThrow(await pending).compaction.status).toBe("aborted");
  expect(observed?.aborted).toBe(true);
  expect(failures).toEqual([true]);
  expect(
    (await opened.session.findEntries(undefined, context)).some(
      (entry) => entry.type === "compaction",
    ),
  ).toBe(false);
  expect(f.upstream.state.messagesCalls).toHaveLength(0);
});

it("uses the real default summarizer when an extension does not override the summary", async () => {
  const events: boolean[] = [];
  const { f, opened, bridge } = await fixture(
    (pi) => {
      pi.on("session_before_compact", () => {
        pi.setSessionName("before default summary");
      });
      pi.on("session_compact", (event) => {
        events.push(event.fromExtension);
      });
    },
    { upstream: { script: [] } },
  );
  expect(getOrThrow(await bridge.compaction.compact(undefined, context)).compaction.status).toBe(
    "completed",
  );
  expect(events).toEqual([false]);
  expect(f.upstream.state.messagesCalls).toHaveLength(1);
  expect(await opened.harness.getName(context)).toBe("before default summary");
  expect(await opened.storage.scanUsage({}, context)).toHaveLength(1);
  expect(bridge.view.manager.getLeafEntry()).toMatchObject({
    type: "compaction",
    summary: expect.stringContaining("hello from the fake upstream"),
    fromHook: false,
  });
});

it("reports provider failure through the legacy failure hook without publishing a summary", async () => {
  const failures: unknown[] = [];
  const { f, opened, bridge } = await fixture((pi) => {
    pi.on("session_compact_failed", (event) => {
      failures.push(event);
      pi.setSessionName("summary failed");
    });
  });
  await f.upstream.close();
  expect(getOrThrow(await bridge.compaction.compact(undefined, context)).compaction.status).toBe(
    "failed",
  );
  expect(failures).toEqual([
    expect.objectContaining({
      reason: "manual",
      aborted: false,
      fromExtension: false,
      willRetry: false,
      errorMessage: expect.any(String),
    }),
  ]);
  expect(await opened.storage.scanEntries({ type: "compaction" }, context)).toEqual([]);
  expect(await opened.harness.getName(context)).toBe("summary failed");
  expect(bridge.errors).toEqual([]);
});

it("rejects a custom summary when ownership is lost while its hook is running", async () => {
  const reached = deferred(),
    release = deferred();
  const { f, opened, bridge } = await fixture((pi) => {
    pi.on("session_before_compact", async (event) => {
      reached.resolve();
      await release.promise;
      return {
        compaction: {
          summary: "Stale owner",
          firstKeptEntryId: event.preparation.firstKeptEntryId,
          tokensBefore: 1,
        },
      };
    });
  });
  const pending = expect(bridge.compaction.compact(undefined, context)).rejects.toThrow();
  await reached.promise;
  f.loseOwnership();
  release.resolve();
  await pending;
  await expect(bridge.mutations.flush()).rejects.toThrow("Ownership lost");
  expect(await opened.storage.scanEntries({ type: "compaction" }, context)).toEqual([]);
  expect(f.upstream.state.messagesCalls).toHaveLength(0);
});

it.each([false, true])(
  "preserves a metadata retention boundary with following messages: %s",
  async (withTail) => {
    let firstKeptEntryId = "";
    const { f, opened, bridge } = await fixture((pi) => {
      pi.on("session_before_compact", (event) => {
        const boundary = event.branchEntries.find(
          (entry) => entry.type === "custom" && entry.customType === "retention-boundary",
        );
        if (!boundary) throw new Error("Missing metadata boundary");
        firstKeptEntryId = boundary.id;
        return {
          compaction: {
            summary: "Metadata retained",
            firstKeptEntryId,
            tokensBefore: 1,
            details: { kind: "extension-payload", data: [1, 2] },
          },
        };
      });
    });
    await opened.lane.appendCustomEntry("retention-boundary", { value: 1 }, context);
    const tail = { role: "user" as const, content: "After metadata", timestamp: 100 };
    if (withTail) await opened.lane.appendMessage(tail, context);
    getOrThrow(await bridge.compaction.compact(undefined, context));
    const entry = bridge.view.manager.getLeafEntry();
    expect(entry).toMatchObject({
      type: "compaction",
      firstKeptEntryId,
      details: { kind: "extension-payload", data: [1, 2] },
    });
    expect(bridge.view.manager.buildSessionContext().messages.slice(1)).toEqual(
      withTail ? [tail] : [],
    );
    expect((await opened.storage.scanEntries({ type: "compaction" }, context))[0]).toMatchObject({
      details: { kind: "nimplex.pi.extension.compaction", version: 1, firstKeptEntryId },
    });
    await bridge.close();
    await opened.harness.close(context);
    await opened.session.close(context);
    const restored = await f.open();
    const recovered = await attachQualificationExtension(f, restored, () => {});
    cleanup.push(recovered.close);
    expect(recovered.view.manager.getLeafEntry()).toEqual(entry);
    expect(recovered.view.manager.buildSessionContext().messages.slice(1)).toEqual(
      withTail ? [tail] : [],
    );
    expect(f.upstream.state.messagesCalls).toHaveLength(0);
  },
);

it.each([false, true])(
  "drains automatic-compaction notifications before provider dispatch (reject: %s)",
  async (reject) => {
    const reasons: string[] = [];
    const namesAtDispatch: (string | undefined)[] = [];
    const { f, opened, bridge } = await fixture(
      (pi) => {
        pi.on("session_before_compact", (event) => {
          reasons.push(event.reason);
          expect(event.willRetry).toBe(false);
          return { cancel: true };
        });
        pi.on("session_compact_failed", () => {
          pi.setSessionName("threshold handled");
        });
      },
      { upstream: { script: [] } },
    );
    await opened.harness.setCompactionSettings(
      { enabled: true, reserveTokens: f.model.contextWindow - 1, keepRecentTokens: 10 },
      context,
    );
    const previous = f.beforeCommit;
    f.beforeCommit = async (writes) => {
      await previous?.(writes);
      if (reject && writes.some((w) => w.kind === "value" && w.namespace === "pi.session.name"))
        throw new Error("Notification commit rejected");
      if (isPiEffectDispatch(writes))
        namesAtDispatch.push(
          (await opened.storage.getValue(value<string>("pi.session.name"), context))?.value,
        );
    };
    const pending = opened.lane.prompt("Continue", undefined, context);
    if (reject) await expect(pending).rejects.toThrow();
    else {
      getOrThrow(await pending);
      await bridge.mutations.flush();
      expect(namesAtDispatch).toEqual(["threshold handled"]);
      expect(bridge.errors).toEqual([]);
    }
    expect(reasons.length).toBeGreaterThan(0);
    expect(reasons.every((reason) => reason === "threshold")).toBe(true);
    expect(f.upstream.state.messagesCalls).toHaveLength(reject ? 0 : 1);
  },
);
