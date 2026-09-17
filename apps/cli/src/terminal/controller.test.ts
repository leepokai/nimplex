import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutorRunContext, RunExecutor } from "@nimplex/core";
import { NimplexRuntime } from "@nimplex/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Controller, type TerminalView } from "./controller.ts";
import { type Preferences, SessionStore } from "./store.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
});
const preferences: Preferences = {
  theme: "dark",
  model: "claude-haiku-4-5",
  sandbox: "docker",
  budget: 0.2,
  timeout: 180,
  mode: "build",
  expanded: false,
  statusline: true,
};
function fixture(hold = false) {
  const dir = mkdtempSync(join(tmpdir(), "nimplex-controller-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const calls: ExecutorRunContext[] = [];
  let release: (() => void) | undefined;
  const executor: RunExecutor = async (run, signal) => {
    calls.push(run);
    if (hold && !signal.aborted)
      await new Promise<void>((resolve) => {
        release = resolve;
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    signal.throwIfAborted();
    return { files: run.files, events: [], costUsd: 0, stopReason: "stop" };
  };
  const client = new NimplexRuntime({
    directory: join(dir, "state"),
    credential: () => ({ apiKey: "fake", baseUrl: null }),
    executor,
  });
  cleanup.push(() => client.close());
  const store = new SessionStore(client, dir, dir);
  const controller = new Controller(client, store, { ...preferences }, dir);
  const view: TerminalView = {
    refresh: vi.fn(),
    notice: vi.fn(),
    choose: async () => undefined,
    draft: vi.fn(),
    externalEditor: async (text) => text,
    exit: vi.fn(),
    authenticate: async () => {},
  };
  controller.view = view;
  return { controller, client, store, calls, dir, release: () => release?.(), view };
}

describe("terminal runtime client", () => {
  it("reloads resources without replacing running owners; invalid reloads keep the previous snapshot", async () => {
    const f = fixture(true);
    vi.stubEnv("PI_CODING_AGENT_DIR", join(f.dir, "pi"));
    writeFileSync(join(f.dir, "AGENTS.md"), "Before reload");
    const owner = f.controller.session;
    const running = f.controller.submit("Keep working");
    await vi.waitFor(() => expect(f.calls).toHaveLength(1));
    const task = f.controller.active;
    mkdirSync(join(f.dir, ".pi/prompts"), { recursive: true });
    writeFileSync(join(f.dir, ".pi/prompts/test.md"), "Test $1");
    writeFileSync(join(f.dir, "AGENTS.md"), "After reload");
    f.store.savePreferences({ ...preferences, mode: "read_only", theme: "light" });
    f.controller.reloadResources();
    expect(f.controller.session).toBe(owner);
    expect(f.controller.active).toBe(task);
    expect(f.calls[0]?.config).toMatchObject({
      execution_mode: "build",
      instructions: expect.stringContaining("Before reload"),
    });
    expect(f.controller.preferences.mode).toBe("read_only");
    expect(f.controller.resources.commands[0]?.name).toBe("test");
    const snapshot = f.controller.resources;
    writeFileSync(join(f.store.directory, "preferences.json"), "broken");
    expect(() => f.controller.reloadResources()).toThrow();
    expect(f.controller.resources).toBe(snapshot);
    expect(f.controller.preferences.theme).toBe("light");
    f.release();
    await running;
    const next = f.controller.submit("Inspect again");
    await vi.waitFor(() => expect(f.calls).toHaveLength(2));
    expect(f.calls[1]?.config).toMatchObject({
      execution_mode: "read_only",
      instructions: expect.stringContaining("After reload"),
    });
    f.release();
    await next;
  });
  it("stops background and foreground owners, including a turn still being created", async () => {
    const f = fixture(true);
    const first = f.controller.session;
    const running = f.controller.submit("First background task");
    await vi.waitFor(() => expect(f.calls).toHaveLength(1));
    f.controller.fresh();
    const second = f.controller.session;
    const starting = f.controller.submit("Second task");
    await f.controller.stopAll();
    await Promise.all([running, starting]);
    expect(f.controller.tasks.size).toBe(0);
    for (const session of [first, second])
      expect(f.client.getSession(session.id).turns.at(-1)?.result?.status).toBe("canceled");
  });
  it("binds submission and early stop to the original session while another is visible", async () => {
    const f = fixture(true);
    writeFileSync(join(f.dir, "AGENTS.md"), "Keep modules small.");
    f.controller.preferences.mode = "read_only";
    const source = f.controller.session;
    const running = f.controller.submit("Inspect files");
    await f.controller.stop();
    f.controller.fresh();
    await running;
    expect(f.client.getSession(source.id).turns.at(-1)?.result?.status).toBe("canceled");
    expect(f.controller.session.turns).toEqual([]);
    expect(f.controller.tasks.size).toBe(0);
    if (f.calls.length)
      expect(f.calls[0]?.config).toMatchObject({
        execution_mode: "read_only",
        instructions: expect.stringContaining("Keep modules small."),
      });
  });
  it("delegates branching to runtime and cannot rewrite canonical history through UI saves", async () => {
    const f = fixture();
    await f.controller.submit("First");
    const source = f.controller.session;
    f.controller.fork();
    const branch = f.controller.session;
    await f.controller.submit("Next");
    expect(f.client.getSession(source.id).turns).toHaveLength(1);
    expect(f.client.getSession(branch.id).turns).toHaveLength(2);
    source.turns.length = 0;
    f.store.save(source);
    expect(f.client.getSession(source.id).turns).toHaveLength(1);
    expect(branch.parentSessionId).toBe(source.id);
  });
  it("resumes the live session owner while work is backgrounded", async () => {
    const f = fixture(true);
    const source = f.controller.session;
    const running = f.controller.submit("Inspect workspace");
    await vi.waitFor(() => expect(f.calls).toHaveLength(1));
    f.controller.fresh();
    await f.controller.resume(f.client.getSession(source.id));
    expect(f.controller.session).toBe(source);
    f.release();
    await running;
    expect(f.controller.session.turns[0]?.result?.status).toBe("completed");
  });
});

describe("Pi harness steering", () => {
  it("steers the running turn on Enter and queues follow-ups by command", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimplex-controller-harness-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const { startFakeAnthropic } = await import("@nimplex/testkit");
    const upstream = await startFakeAnthropic(0, { toolCalls: 2, delayMs: 150 });
    cleanup.push(upstream.close);
    const client = new NimplexRuntime({
      directory: join(dir, "state"),
      engine: "pi-harness",
      credential: () => ({ apiKey: "fake", baseUrl: upstream.url }),
    });
    cleanup.push(() => client.close());
    const store = new SessionStore(client, dir, dir);
    const controller = new Controller(client, store, { ...preferences }, dir);
    const notices: string[] = [];
    controller.view = {
      refresh: vi.fn(),
      notice: (title) => {
        notices.push(title);
      },
      choose: async () => undefined,
      draft: vi.fn(),
      externalEditor: async (text) => text,
      exit: vi.fn(),
      authenticate: async () => {},
    };
    expect(controller.session.engine).toBe("pi-harness");
    const running = controller.submit("Slow task");
    const deadline = Date.now() + 10_000;
    while (!controller.active?.turn.events.some((e) => e.type === "tool.result")) {
      if (Date.now() > deadline) throw new Error("Turn did not reach a tool boundary");
      await new Promise((r) => setTimeout(r, 20));
    }
    await controller.submit("STEER FROM ENTER");
    await controller.queue("followUp", "FOLLOW UP FROM COMMAND");
    expect(notices).toEqual(["Steering queued", "Follow-up queued"]);
    await running;
    expect(controller.session.turns).toHaveLength(1);
    expect(controller.session.turns[0]?.result?.status).toBe("completed");
    const bodies = upstream.state.messagesCalls.map((call) => JSON.stringify(call.body.messages));
    expect(bodies.some((body) => body.includes("STEER FROM ENTER"))).toBe(true);
    expect(bodies.at(-1)).toContain("FOLLOW UP FROM COMMAND");
    await expect(controller.queue("steer", "too late")).rejects.toThrow("No running task");
  }, 30_000);
});
