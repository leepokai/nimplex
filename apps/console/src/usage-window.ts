import type { UsageBucket } from "@nimplex/sdk";

/**
 * Usage 頁的時間邊界都用瀏覽器的本地時區算（今日／本月／近 7 天），
 * 再把同一個時區名稱交給 API 做 day 分桶——兩邊對齊，桶的 key 才對得上。
 */

export function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function startOfMonth(d: Date): Date {
  const x = startOfDay(d);
  x.setDate(1);
  return x;
}

export function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

/** YYYY-MM-DD（本地時區），與 API day 桶的 key 同形 */
export function dayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export interface DayCell {
  key: string;
  usd: number;
  runs: number;
}

/** 把稀疏的 day 桶攤成連續 n 天（缺的補 0），最後一天是 end 當天。 */
export function fillDays(buckets: readonly UsageBucket[], end: Date, n: number): DayCell[] {
  const byKey = new Map(buckets.map((b) => [b.key, b]));
  return Array.from({ length: n }, (_, i) => {
    const key = dayKey(addDays(end, i - (n - 1)));
    const hit = byKey.get(key);
    return { key, usd: hit?.usd ?? 0, runs: hit?.runs ?? 0 };
  });
}

export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
