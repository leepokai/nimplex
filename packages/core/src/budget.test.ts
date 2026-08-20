import { describe, expect, it } from "vitest";
import { checkBudget, settleSpend } from "./budget.ts";

describe("checkBudget", () => {
  it("回報剩餘額度", () => {
    expect(checkBudget(0.24, 0.3)).toEqual({ remainingUsd: 0.06, exceeded: false });
  });

  it("到達上限即視為超額", () => {
    expect(checkBudget(0.3, 0.3).exceeded).toBe(true);
    expect(checkBudget(0.36, 0.3).exceeded).toBe(true);
  });
});

describe("settleSpend", () => {
  it("避免浮點誤差", () => {
    expect(settleSpend(0.1, 0.2)).toBe(0.3);
    expect(settleSpend(0.12, 0.12)).toBe(0.24);
  });
});
