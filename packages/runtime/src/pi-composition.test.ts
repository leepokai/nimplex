import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { compositionFixture, deferred } from "./testing/pi-composition-fixture.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture(...args: Parameters<typeof compositionFixture>) {
  const result = await compositionFixture(...args);
  cleanup.push(result.close);
  return result;
}

// These are negative qualification tests. Passing confirms a migration blocker,
// not that AgentSession's observer API supplies durable storage barriers.
describe("Pi 0.85.1 composition qualification", () => {
  it("does not await an AgentSession model-response observer before executing tools", async () => {
    const f = await fixture();
    const commit = deferred();
    let pending = false;
    f.session.subscribe(async (event) => {
      if (event.type !== "message_end" || event.message.role !== "assistant") return;
      pending = true;
      await commit.promise;
      pending = false;
    });
    try {
      await f.session.prompt("Write a probe file.");
      expect(pending).toBe(true);
      expect(f.effects).toBe(1);
      expect(f.upstream.state.messagesCalls).toHaveLength(2);
    } finally {
      commit.resolve();
    }
  });

  it("does not await an AgentSession tool-result observer before the next model call", async () => {
    const f = await fixture();
    const commit = deferred();
    let pending = false;
    f.session.subscribe(async (event) => {
      if (event.type !== "message_end" || event.message.role !== "toolResult") return;
      pending = true;
      await commit.promise;
      pending = false;
    });
    try {
      await f.session.prompt("Write a probe file.");
      expect(pending).toBe(true);
      expect(f.upstream.state.messagesCalls).toHaveLength(2);
    } finally {
      commit.resolve();
    }
  });

  it.each(["message_end", "tool_result"] as const)(
    "reports a rejected %s extension hook but continues dependent effects",
    async (boundary) => {
      const f = await fixture((pi) => {
        if (boundary === "message_end") {
          pi.on("message_end", async (event) => {
            if (event.message.role === "assistant") throw new Error("required commit failed");
          });
        } else {
          pi.on("tool_result", async () => {
            throw new Error("required commit failed");
          });
        }
      });
      await f.session.prompt("Write a probe file.");
      expect(f.errors).toContain("required commit failed");
      expect(f.effects).toBe(1);
      expect(f.upstream.state.messagesCalls).toHaveLength(2);
    },
  );

  it("can await the lower-level Agent listener before tool dispatch", async () => {
    const f = await fixture();
    const reached = deferred();
    const commit = deferred();
    f.session.agent.subscribe(async (event) => {
      if (event.type !== "message_end" || event.message.role !== "assistant") return;
      reached.resolve();
      await commit.promise;
    });
    const run = f.session.prompt("Write a probe file.");
    try {
      await reached.promise;
      expect(f.effects).toBe(0);
      expect(f.upstream.state.messagesCalls).toHaveLength(1);
    } finally {
      commit.resolve();
      await run;
    }
    expect(f.effects).toBe(1);
  });

  it("halts tools on a rejected lower-level listener, but cannot make it a session-wide barrier", async () => {
    const f = await fixture();
    f.session.agent.subscribe(async (event) => {
      if (event.type === "message_end" && event.message.role === "assistant") {
        throw new Error("required commit failed");
      }
    });
    await expect(f.session.prompt("Write a probe file.")).rejects.toThrow("required commit failed");
    expect(f.effects).toBe(0);
    expect(f.upstream.state.messagesCalls).toHaveLength(1);
    // Names and extension entries bypass Agent events entirely.
    f.session.setSessionName("outside the agent loop");
    expect(f.session.sessionManager.getSessionName()).toBe("outside the agent loop");
  });

  it("awaits the lower-level tool-result listener before another model request", async () => {
    const f = await fixture();
    const reached = deferred();
    const commit = deferred();
    f.session.agent.subscribe(async (event) => {
      if (event.type !== "message_end" || event.message.role !== "toolResult") return;
      reached.resolve();
      await commit.promise;
    });
    const run = f.session.prompt("Write a probe file.");
    try {
      await reached.promise;
      expect(f.effects).toBe(1);
      expect(f.upstream.state.messagesCalls).toHaveLength(1);
    } finally {
      commit.resolve();
      await run;
    }
    expect(f.upstream.state.messagesCalls).toHaveLength(2);
  });

  it("does not recover queued steering or follow-ups from session entries", async () => {
    const f = await fixture();
    await f.session.steer("steer once");
    await f.session.followUp("follow once");
    expect(f.session.pendingMessageCount).toBe(2);
    const manager = f.session.sessionManager;
    const header = manager.getHeader();
    if (!header) throw new Error("Missing fixture session header");
    const restored = SessionManager.inMemory(f.directory, undefined, [
      header,
      ...manager.getEntries(),
    ]);
    expect(JSON.stringify(restored.getEntries())).not.toContain("steer once");
    expect(JSON.stringify(restored.getEntries())).not.toContain("follow once");
    f.session.clearQueue();
  });

  it("executes user shell and stores its entry outside the lower-level Agent listener", async () => {
    const f = await fixture();
    let agentEvents = 0;
    let executions = 0;
    f.session.agent.subscribe(async () => {
      agentEvents++;
      throw new Error("required commit failed");
    });
    await f.session.executeBash("synthetic command", undefined, {
      operations: {
        async exec(_command, _cwd, options) {
          executions++;
          options.onData(Buffer.from("synthetic result"));
          return { exitCode: 0 };
        },
      },
    });
    expect(executions).toBe(1);
    expect(agentEvents).toBe(0);
    expect(f.session.sessionManager.getEntries()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "message",
          message: expect.objectContaining({ role: "bashExecution", output: "synthetic result" }),
        }),
      ]),
    );
  });

  it("cannot await a synchronous extension custom-entry call before subsequent extension effects", async () => {
    const commit = deferred();
    let pending = false;
    let extensionEffect = false;
    const f = await fixture((pi) => {
      pi.registerCommand("probe-entry", {
        description: "Qualification only",
        handler: async () => {
          pi.appendEntry("probe-intent", { operation: "opaque-effect" });
          extensionEffect = true;
        },
      });
    });
    f.session.subscribe(async (event) => {
      if (event.type !== "entry_appended") return;
      pending = true;
      await commit.promise;
      pending = false;
    });
    try {
      await f.session.prompt("/probe-entry");
      expect(pending).toBe(true);
      expect(extensionEffect).toBe(true);
      expect(f.upstream.state.messagesCalls).toHaveLength(0);
    } finally {
      commit.resolve();
    }
  });

  it("preserves entry identity through compaction, branch navigation, custom entries and reload", async () => {
    let starts = 0;
    const f = await fixture((pi) => {
      pi.on("session_start", async () => {
        starts++;
      });
      pi.on("agent_end", async () => {
        pi.appendEntry("probe-state", { counter: 1 });
      });
      pi.on("session_before_compact", async (event) => ({
        compaction: {
          summary: "Synthetic summary retaining probe state.",
          firstKeptEntryId: event.preparation.firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore,
          details: { source: "qualification-extension" },
        },
      }));
      pi.on("session_before_tree", async () => ({
        summary: { summary: "Synthetic branch summary.", details: { branch: 1 } },
      }));
    });
    await f.session.prompt("Write a probe file.");
    f.session.setSessionName("qualification session");
    const target = f.session.sessionManager.getEntries().find((e) => e.type === "message");
    if (!target) throw new Error("Missing fixture message entry");
    await f.session.compact();
    await f.session.navigateTree(target.id, { summarize: true, label: "checkpoint" });
    const before = structuredClone(f.session.sessionManager.getEntries());
    const leaf = f.session.sessionManager.getLeafId();
    await f.session.reload();
    expect(f.session.sessionManager.getEntries()).toEqual(before);
    expect(starts).toBe(2);
    expect(before.some((e) => e.type === "compaction")).toBe(true);
    expect(before.some((e) => e.type === "branch_summary")).toBe(true);
    expect(before.some((e) => e.type === "custom" && e.customType === "probe-state")).toBe(true);
    const header = f.session.sessionManager.getHeader();
    if (!header) throw new Error("Missing fixture session header");
    const restored = SessionManager.inMemory(f.directory, undefined, [header, ...before]);
    if (leaf) restored.branch(leaf);
    else restored.resetLeaf();
    expect(restored.getEntries()).toEqual(before);
    expect(restored.getLeafId()).toBe(leaf);
    expect(restored.buildSessionContext()).toEqual(f.session.sessionManager.buildSessionContext());
  });
});
