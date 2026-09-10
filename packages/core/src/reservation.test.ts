import { describe, expect, it } from "vitest";
import { planReservation } from "./reservation.ts";

describe("model reservation", () => {
  const rate = { inputPerMtok: 1, outputPerMtok: 5 };
  it("rejects a call whose input alone exhausts the budget", () => {
    expect(planReservation(0.001, 1000, rate)).toBeNull();
  });
  it("reduces output tokens to the available allowance without fractional-token overspend", () => {
    expect(planReservation(0.001013, 1000, rate)).toEqual({
      maxOutputTokens: 2,
      reservedUsd: 0.00101,
    });
  });
  it("rounds fractional input cost up and never reserves more than available", () => {
    for (let micros = 1; micros < 20000; micros += 31) {
      const result = planReservation(micros / 1e6, 1001, {
        inputPerMtok: 1.25,
        outputPerMtok: 7.5,
      });
      if (result) expect(result.reservedUsd).toBeLessThanOrEqual(micros / 1e6);
    }
  });
});
