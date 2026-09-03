import { describe, expect, it } from "vitest";
import { durationExceeded } from "./duration.ts";

describe("durationExceeded", () => {
  const t0 = Date.parse("2026-09-02T00:00:00Z");
  it("沒設上限或沒開始就不算超時", () => {
    expect(durationExceeded(null, 60, t0)).toBe(false);
    expect(durationExceeded(new Date(t0), null, t0 + 999_999)).toBe(false);
    expect(durationExceeded(new Date(t0), 0, t0 + 999_999)).toBe(false);
  });
  it("超過 max_duration_seconds 才算", () => {
    expect(durationExceeded(new Date(t0), 60, t0 + 59_000)).toBe(false);
    expect(durationExceeded(new Date(t0), 60, t0 + 60_001)).toBe(true);
    expect(durationExceeded("2026-09-02T00:00:00Z", 60, t0 + 61_000)).toBe(true);
  });
});
