// Pure max_duration_seconds checks.
// Duration limits remain independent of model usage.
// The worker checks them during execution and through its watchdog.

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
