import type { HarnessManifest } from "@nimplex/contracts";
import { describe, expect, it } from "vitest";
import { collectUnknownVariables, renderHarness } from "./harness.ts";
import { computeCost } from "./pricing.ts";

const base: HarnessManifest = {
  slug: "t",
  name: "t",
  version: "1.0.0",
  source: { kind: "inline" },
  install: [],
  command: "run {{prompt}} --model {{model}}",
  env: { BASE: "{{gateway.anthropic}}", KEY: "{{run.token}}" },
  provider: "anthropic",
  output: "text",
  workdir: "/workspace",
  timeout_seconds: 60,
};

const ctx = {
  runId: "r1",
  runToken: "nmx_run_abc",
  model: "claude-sonnet-5",
  prompt: "hi",
  gateway: {
    anthropic: "http://gw/gw/anthropic",
    openai: "http://gw/gw/openai/v1",
    openrouter: "",
  },
  workdir: "/workspace",
};

describe("renderHarness", () => {
  it("env 原樣代入，command 代入後被單引號包起來", () => {
    const out = renderHarness(base, ctx);
    expect(out.env).toEqual({ BASE: "http://gw/gw/anthropic", KEY: "nmx_run_abc" });
    expect(out.command).toBe("run 'hi' --model 'claude-sonnet-5'");
  });

  it("prompt 無法逃出引號做 shell injection", () => {
    const out = renderHarness(base, { ...ctx, prompt: "x'; rm -rf /; echo '" });
    expect(out.command).toBe(`run 'x'\\''; rm -rf /; echo '\\''' --model 'claude-sonnet-5'`);
  });

  it("command 沒有 {{prompt}} 時改走 stdin", () => {
    const out = renderHarness({ ...base, command: "run" }, ctx);
    expect(out.stdin).toBe("hi");
  });

  it("抓出 manifest 引用的未知變數", () => {
    expect(collectUnknownVariables({ ...base, command: "run {{nope}}" })).toEqual(["nope"]);
  });
});

describe("computeCost", () => {
  it("照價格表算錢", () => {
    const out = computeCost("anthropic", "claude-sonnet-5", {
      inputTokens: 1_000,
      outputTokens: 1_000,
    });
    expect(out.costUsd).toBeCloseTo(0.012, 9);
    expect(out.estimated).toBe(false);
  });

  it("不認得的 model 用保守 fallback 價並標記為估計", () => {
    const out = computeCost("anthropic", "who-knows", { inputTokens: 1_000, outputTokens: 0 });
    expect(out.estimated).toBe(true);
    expect(out.costUsd).toBeGreaterThan(0);
  });
});
