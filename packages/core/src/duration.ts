// max_duration_seconds 的判斷（純函式）。
// metering=none 的唯一上限就是時間；metering=exact / provider_reported 也可以疊一層時間上限。
// 誰執行：worker 的看門狗（沙箱路徑、managed-agent 路徑）與內建 loop 的每一步。

export function durationExceeded(
  startedAt: Date | string | null | undefined,
  maxDurationSeconds: number | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!startedAt || !maxDurationSeconds || maxDurationSeconds <= 0) return false;
  const started = typeof startedAt === "string" ? Date.parse(startedAt) : startedAt.getTime();
  if (!Number.isFinite(started)) return false;
  return now - started > maxDurationSeconds * 1000;
}
