import { afterEach, expect, it, vi } from "vitest";
import { readOptions } from "../config.ts";
import { startTerminal } from "./start.ts";

const state = vi.hoisted(() => ({ thinking: "low", received: undefined as unknown }));
vi.mock("../local-runtime.ts", () => ({ openRuntime: () => ({ close: async () => {} }) }));
vi.mock("./store.ts", () => ({
  SessionStore: class {
    preferences(defaults: object) {
      return { ...defaults, thinking: state.thinking };
    }
  },
}));
vi.mock("./controller.ts", () => ({
  Controller: class {
    cwd = "/tmp";
    constructor(_client: unknown, _store: unknown, preferences: unknown) {
      state.received = preferences;
    }
    close() {}
  },
  errorMessage: String,
}));
vi.mock("./resources.ts", () => ({ loadResources: () => ({}) }));
vi.mock("./view.ts", () => ({
  View: class {
    done = Promise.resolve();
    start() {}
    refreshResources() {}
    exit() {}
  },
}));
afterEach(() => {
  state.received = undefined;
});
it.each([
  [[], "low"],
  [["--thinking", "high"], "high"],
  [["--thinking", "off"], "off"],
])(
  "applies explicit terminal thinking flags while preserving saved defaults: %j",
  async (args, expected) => {
    await startTerminal(readOptions(args));
    expect(state.received).toMatchObject({ thinking: expected });
  },
);
