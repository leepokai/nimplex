import { describe, expect, it } from "vitest";
import { canTransition, isTerminal } from "./status.ts";

describe("canTransition", () => {
  it("允許合法轉移", () => {
    expect(canTransition("queued", "running")).toBe(true);
    expect(canTransition("running", "killed")).toBe(true);
    expect(canTransition("awaiting_input", "running")).toBe(true);
  });

  it("拒絕非法轉移", () => {
    expect(canTransition("completed", "running")).toBe(false);
    expect(canTransition("killed", "running")).toBe(false);
    expect(canTransition("queued", "completed")).toBe(false);
  });
});

describe("isTerminal", () => {
  it("終態判定", () => {
    expect(isTerminal("killed")).toBe(true);
    expect(isTerminal("running")).toBe(false);
  });
});
