import { describe, expect, it } from "vitest";
import { addDays, dayKey, fillDays, startOfDay, startOfMonth } from "./usage-window.ts";

describe("usage-window", () => {
  it("dayKey 補零、用本地日期", () => {
    expect(dayKey(new Date(2026, 8, 3, 23, 59))).toBe("2026-09-03");
    expect(dayKey(new Date(2026, 0, 9, 0, 0))).toBe("2026-01-09");
  });

  it("startOfDay / startOfMonth 切到本地午夜", () => {
    const d = new Date(2026, 8, 17, 15, 42, 7);
    expect(startOfDay(d).toISOString()).toBe(new Date(2026, 8, 17, 0, 0, 0, 0).toISOString());
    expect(startOfMonth(d).toISOString()).toBe(new Date(2026, 8, 1, 0, 0, 0, 0).toISOString());
  });

  it("addDays 跨月、跨年都對", () => {
    expect(dayKey(addDays(new Date(2026, 8, 1), -1))).toBe("2026-08-31");
    expect(dayKey(addDays(new Date(2026, 11, 31), 1))).toBe("2027-01-01");
  });

  it("fillDays 攤成連續 n 天、缺的補 0、最後一天是 end", () => {
    const end = new Date(2026, 8, 3);
    const cells = fillDays(
      [
        { key: "2026-09-01", usd: 1.5, runs: 2 },
        { key: "2026-09-03", usd: 0.25, runs: 1 },
        { key: "2026-08-20", usd: 99, runs: 9 }, // 窗口外的桶不該出現
      ],
      end,
      3,
    );
    expect(cells).toEqual([
      { key: "2026-09-01", usd: 1.5, runs: 2 },
      { key: "2026-09-02", usd: 0, runs: 0 },
      { key: "2026-09-03", usd: 0.25, runs: 1 },
    ]);
  });
});
