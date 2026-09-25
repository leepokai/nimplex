import type { SandboxUsageRecord, SandboxUsageSummary } from "@nimplex/contracts";
import {
  lookupSandboxRate,
  roundUsdPrecise,
  type SandboxSessionState,
  type SandboxSize,
} from "@nimplex/core";
import type { RuntimeStore, StoredSession } from "./store.ts";

// Sandbox time is metered per session as running intervals. An interval opens when
// creation begins or a sandbox is resumed (`sandboxRunningSince` on the session) and
// settles into the session's `sandbox_usage` ledger at the next observed transition.
// Settlement follows provider transitions, not the turn, so it is recorded even when the
// turn was cancelled or interrupted meanwhile. A running turn also receives a
// `sandbox.usage` event; finished turns are never modified. No interval runs past the
// lifetime the provider set at the last create or resume, and time nobody observed is
// marked uncertain. Call these inside a store transaction.

/**
 * `unobserved`: the sandbox may have changed state without us seeing it (a failed pause,
 * a dropped connection); it stays metered as running, but uncertain.
 */
export type SandboxTransition = "running" | "paused" | "unobserved" | "deleted" | "missing";

const EMPTY: SandboxUsageSummary = {
  usd: 0,
  seconds: 0,
  unpriced_seconds: 0,
  uncertain: false,
  free: true,
};

/** Applies one provider transition to the session's open interval. */
export function recordSandboxTransition(
  store: RuntimeStore,
  sessionId: string,
  transition: SandboxTransition,
  options: { turnId?: string; at?: Date; maxRunMs?: number } = {},
) {
  const session = store.session(sessionId);
  // A late transition after cleanup deleted the sandbox has nothing left to meter.
  if (!session.sandboxState) return;
  if (transition === "unobserved") {
    if (session.sandboxRunningSince && !session.sandboxRunningUncertain) {
      session.sandboxRunningUncertain = true;
      store.saveSession(session);
    }
    return;
  }
  if (transition === "running") {
    if (!session.sandboxRunningSince)
      return startSandboxUsage(store, sessionId, options.at, options.maxRunMs);
    if (!session.sandboxRunningUncertain) {
      // A resume of a sandbox we watched run extends its provider lifetime.
      session.sandboxRunDeadline = deadlineFrom(options.maxRunMs, options.at);
      store.saveSession(session);
      return;
    }
    // Reattached to a sandbox nobody watched: close the unobserved stretch here and meter
    // what follows as observed time.
    settleSandboxUsage(store, sessionId, "reconnected", options);
    return startSandboxUsage(store, sessionId, options.at, options.maxRunMs);
  }
  settleSandboxUsage(store, sessionId, transition, {
    ...options,
    uncertain: transition === "missing",
  });
}

/** Opens an interval unless one is already open; `maxRunMs` is the provider lifetime. */
export function startSandboxUsage(
  store: RuntimeStore,
  sessionId: string,
  at = new Date(),
  maxRunMs?: number,
) {
  const session = store.session(sessionId);
  if (session.sandboxRunningSince) return;
  session.sandboxRunningSince = at.toISOString();
  session.sandboxRunDeadline = deadlineFrom(maxRunMs, at);
  store.saveSession(session);
}

/**
 * Called when a runtime opens a state root: an interval left open by a previous process
 * was not observed meanwhile, and one past its provider deadline has ended.
 */
export function inheritSandboxUsage(store: RuntimeStore, session: StoredSession, now = new Date()) {
  if (!session.sandboxRunningSince || !session.sandboxProvider) return;
  if (session.sandboxRunDeadline && Date.parse(session.sandboxRunDeadline) <= now.getTime())
    return settleSandboxUsage(store, session.id, "expired", { at: now, uncertain: true });
  if (session.sandboxRunningUncertain) return;
  session.sandboxRunningUncertain = true;
  store.saveSession(session);
}

export function settleSandboxUsage(
  store: RuntimeStore,
  sessionId: string,
  reason: SandboxUsageRecord["reason"],
  options: { turnId?: string; at?: Date; uncertain?: boolean } = {},
) {
  const session = store.session(sessionId);
  const since = session.sandboxRunningSince;
  if (!since || !session.sandboxProvider) return;
  const started = Date.parse(since);
  const observedEnd = (options.at ?? new Date()).getTime();
  // The provider stops a sandbox at its deadline whether or not anyone saw it happen.
  const deadline = session.sandboxRunDeadline ? Date.parse(session.sandboxRunDeadline) : Infinity;
  const end = Math.max(started, Math.min(observedEnd, deadline));
  appendUsage(store, sessionId, {
    provider: session.sandboxProvider,
    size: sizeOf(session.sandboxState),
    reason,
    started,
    end,
    uncertain: Boolean(options.uncertain || session.sandboxRunningUncertain || end < observedEnd),
    turnId: options.turnId,
  });
  const updated = store.session(sessionId);
  delete updated.sandboxRunningSince;
  delete updated.sandboxRunningUncertain;
  delete updated.sandboxRunDeadline;
  store.saveSession(updated);
}

/**
 * A sandbox created for a turn that ended before it could be recorded: it never became
 * the session's sandbox, but it ran from creation until it was stopped. If stopping
 * failed it may still be running, so it is charged, uncertain, up to its lifetime.
 */
export function recordDiscardedSandbox(
  store: RuntimeStore,
  sessionId: string,
  discarded: {
    provider: string;
    state: SandboxSessionState;
    startedAt: Date;
    stopped: boolean;
    turnId: string;
    maxRunMs?: number;
  },
) {
  const started = discarded.startedAt.getTime();
  const end =
    discarded.stopped || discarded.maxRunMs === undefined
      ? Date.now()
      : started + discarded.maxRunMs;
  appendUsage(store, sessionId, {
    provider: discarded.provider,
    size: sizeOf(discarded.state),
    reason: "discarded",
    started,
    end,
    uncertain: !discarded.stopped,
    turnId: discarded.turnId,
  });
}

function sizeOf(state: SandboxSessionState | undefined): SandboxSize {
  const provider = state?.providerState ?? {};
  return {
    cpuCount: typeof provider.cpuCount === "number" ? provider.cpuCount : undefined,
    memoryMB: typeof provider.memoryMB === "number" ? provider.memoryMB : undefined,
    customTemplate: Boolean(provider.template),
  };
}

function appendUsage(
  store: RuntimeStore,
  sessionId: string,
  entry: {
    provider: string;
    size: SandboxSize;
    reason: SandboxUsageRecord["reason"];
    started: number;
    end: number;
    uncertain: boolean;
    turnId?: string;
  },
) {
  const seconds = Math.max(0, (entry.end - entry.started) / 1000);
  const rate = lookupSandboxRate(entry.provider, entry.size);
  const record: SandboxUsageRecord = {
    provider: entry.provider,
    reason: entry.reason,
    started_at: new Date(entry.started).toISOString(),
    ended_at: new Date(entry.end).toISOString(),
    seconds,
    cost_usd: rate ? roundUsdPrecise(seconds * rate.usdPerSecond) : null,
    uncertain: entry.uncertain,
    basis: rate?.basis ?? "no list rate for this sandbox size",
    turn_id: entry.turnId ?? null,
  };
  store.appendSandboxUsage(sessionId, record);
  if (entry.turnId && store.turn(entry.turnId).result.status === "running")
    store.append(entry.turnId, [{ type: "sandbox.usage", payload: record }]);
  const session = store.session(sessionId);
  session.sandboxUsage = addToSummary(session.sandboxUsage, record);
  store.saveSession(session);
}

/** Settled totals plus the still-running interval, for read projections. */
export function sandboxUsageSummary(session: StoredSession): SandboxUsageSummary | undefined {
  if (!session.sandboxUsage && !session.sandboxRunningSince) return undefined;
  const settled = session.sandboxUsage ?? EMPTY;
  const open = session.sandboxRunningSince;
  return {
    ...settled,
    uncertain: settled.uncertain || Boolean(session.sandboxRunningUncertain),
    free: settled.free && (!open || isFree(session.sandboxProvider)),
    ...(open ? { running_since: open } : {}),
  };
}

function isFree(provider: string | undefined) {
  return provider !== undefined && lookupSandboxRate(provider)?.usdPerSecond === 0;
}

/** The provider's lifetime is applied when an interval starts or resumes, not when it settles. */
function deadlineFrom(maxRunMs: number | undefined, at = new Date()) {
  return maxRunMs === undefined ? undefined : new Date(at.getTime() + maxRunMs).toISOString();
}

function addToSummary(
  summary: SandboxUsageSummary | undefined,
  record: SandboxUsageRecord,
): SandboxUsageSummary {
  const total = summary ?? EMPTY;
  return {
    usd: roundUsdPrecise(total.usd + (record.cost_usd ?? 0)),
    seconds: roundMs(total.seconds + record.seconds),
    unpriced_seconds: roundMs(
      total.unpriced_seconds + (record.cost_usd === null ? record.seconds : 0),
    ),
    uncertain: total.uncertain || record.uncertain,
    free: total.free && isFree(record.provider),
  };
}

/** Seconds are measured in milliseconds; keep sums free of float noise. */
function roundMs(seconds: number) {
  return Math.round(seconds * 1000) / 1000;
}
