import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const e2b = vi.hoisted(() => ({
  create: vi.fn(),
  connect: vi.fn(),
  getInfo: vi.fn(),
}));
vi.mock("e2b", () => ({
  Sandbox: { create: e2b.create, connect: e2b.connect },
  CommandExitError: Error,
  NotFoundError: Error,
  TimeoutError: Error,
}));

const { E2bSandboxProvider } = await import("./e2b.ts");

function fakeSandbox() {
  return {
    sandboxId: "sbx-1",
    commands: { run: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })) },
    getInfo: e2b.getInfo,
    kill: vi.fn(async () => {}),
  };
}

beforeEach(() => {
  vi.stubEnv("E2B_API_KEY", "test-key");
  e2b.create.mockImplementation(async () => fakeSandbox());
  e2b.connect.mockImplementation(async () => fakeSandbox());
  e2b.getInfo.mockResolvedValue({ cpuCount: 2, memoryMB: 512 });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

describe("E2B lifetime setting", () => {
  it.each([
    [undefined, 3_600_000],
    ["", 3_600_000],
    ["600000", 600_000],
  ])("uses %j as a %d ms lifetime for creation, resume and estimates", async (value, expected) => {
    if (value !== undefined) vi.stubEnv("NIMPLEX_E2B_LIFETIME_MS", value);
    const provider = new E2bSandboxProvider();
    expect(provider.unavailableReason()).toBeNull();
    expect(provider.maxRunMs).toBe(expected);
    const session = await provider.create({ label: "t" });
    expect(e2b.create.mock.calls[0]?.at(-1)).toMatchObject({ timeoutMs: expected });
    // Connecting without a timeout would cut a resumed sandbox to the SDK default.
    await provider.resume(session.state);
    expect(e2b.connect).toHaveBeenCalledWith(
      "sbx-1",
      expect.objectContaining({ timeoutMs: expected }),
    );
  });

  it.each(["abc", "0", "-5"])(
    "reports %j as unavailable instead of using a broken lifetime",
    (value) => {
      vi.stubEnv("NIMPLEX_E2B_LIFETIME_MS", value);
      const provider = new E2bSandboxProvider();
      expect(provider.unavailableReason()).toBe(
        "NIMPLEX_E2B_LIFETIME_MS must be a positive number of milliseconds.",
      );
      expect(provider.maxRunMs).toBeUndefined();
    },
  );
});

describe("E2B sandbox size", () => {
  it("records the allocated size for estimates", async () => {
    e2b.getInfo.mockResolvedValue({ cpuCount: 4, memoryMB: 2048 });
    const session = await new E2bSandboxProvider().create({ label: "t" });
    expect(session.state.providerState).toMatchObject({ cpuCount: 4, memoryMB: 2048 });
    expect(e2b.getInfo).toHaveBeenCalledWith({ requestTimeoutMs: 3000 });
  });

  it("does not wait for a slow size lookup", async () => {
    e2b.getInfo.mockReturnValue(new Promise(() => {}));
    const started = Date.now();
    const session = await new E2bSandboxProvider().create({ label: "t" });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(session.state.providerState).toEqual({ sandboxId: "sbx-1", template: null });
  });

  it("still creates the sandbox when the size lookup fails", async () => {
    e2b.getInfo.mockRejectedValue(new Error("info unavailable"));
    const session = await new E2bSandboxProvider().create({ label: "t" });
    expect(session.state.providerState).toEqual({ sandboxId: "sbx-1", template: null });
  });
});
