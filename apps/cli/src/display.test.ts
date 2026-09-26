import { describe, expect, it } from "vitest";
import { sandboxEstimate, sandboxIntervalText, sandboxWarning } from "./display.ts";

const summary = { usd: 0.000279, seconds: 6, unpriced_seconds: 0, uncertain: false, free: false };

describe("sandbox estimate wording", () => {
  it("always labels the amount as an estimate and omits it when nothing was metered", () => {
    expect(sandboxEstimate(undefined)).toBeUndefined();
    expect(sandboxEstimate(summary)).toBe("sandbox ~$0.000279 (est.)");
    expect(sandboxEstimate(summary, "short")).toBe("sandbox ~$0.000279 (est.)");
    expect(sandboxEstimate({ ...summary, usd: 1.23456 })).toBe("sandbox ~$1.2346 (est.)");
  });
  it("flags unobserved, unpriced and still-running time in both styles", () => {
    const flagged = {
      usd: 0.01,
      seconds: 400,
      unpriced_seconds: 120,
      uncertain: true,
      free: false,
      running_since: "2026-09-25T10:00:00.000Z",
    };
    expect(sandboxEstimate(flagged)).toBe(
      "sandbox ~$0.0100 (est.; includes unobserved time; 120s unpriced; running since 2026-09-25T10:00:00.000Z)",
    );
    expect(sandboxEstimate(flagged, "short")).toBe(
      "sandbox ~$0.0100 (est.; unobserved; unpriced; running)",
    );
  });
  it("shows nothing for a zero-rate sandbox and rounds sub-second unpriced time up", () => {
    expect(
      sandboxEstimate({ usd: 0, seconds: 90, unpriced_seconds: 0, uncertain: true, free: true }),
    ).toBeUndefined();
    expect(
      sandboxEstimate({
        usd: 0,
        seconds: 0.3,
        unpriced_seconds: 0.3,
        uncertain: false,
        free: false,
      }),
    ).toBe("sandbox ~$0.000000 (est.; 1s unpriced)");
    // Unobserved paid time is flagged even before anything has settled.
    expect(
      sandboxEstimate(
        {
          usd: 0,
          seconds: 0,
          unpriced_seconds: 0,
          uncertain: true,
          free: false,
          running_since: "t",
        },
        "short",
      ),
    ).toBe("sandbox ~$0.000000 (est.; unobserved; running)");
  });
});

describe("sandbox interval breakdown", () => {
  const record = {
    provider: "e2b",
    reason: "paused" as const,
    started_at: "2026-09-25T10:00:00.000Z",
    ended_at: "2026-09-25T10:00:03.737Z",
    seconds: 3.737,
    cost_usd: 0.000113044,
    uncertain: false,
    basis: "E2B list price for 2 vCPU / 512 MiB",
    turn_id: null,
  };
  it("shows each interval's reason, duration, estimate and observation", () => {
    expect(sandboxIntervalText(record)).toBe("  e2b paused 3.7s ~$0.000113");
    expect(
      sandboxIntervalText({ ...record, cost_usd: null, uncertain: true, reason: "missing" }),
    ).toBe("  e2b missing 3.7s unpriced (unobserved)");
  });
});

describe("sandbox warning", () => {
  it("suggests another sandbox only when it is available", () => {
    expect(sandboxWarning("e2b", "E2B_API_KEY is not set", "docker")).toBe(
      "e2b sandbox is not available: E2B_API_KEY is not set. Native commands will fail; pass --sandbox docker to use docker instead.",
    );
    expect(sandboxWarning("docker", "docker is not running")).toBe(
      "docker sandbox is not available: docker is not running. Native commands will fail; configure it before running commands that need node, git or package installs.",
    );
  });
});
