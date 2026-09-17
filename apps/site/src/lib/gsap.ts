import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { SplitText } from "gsap/SplitText";

gsap.registerPlugin(ScrollTrigger, SplitText, useGSAP);

// Catch up to the correct time after background-tab rAF throttling, then resume
// smooth foreground playback instead of replaying delayed animation frames.
if (typeof document !== "undefined") {
  const syncLag = () =>
    document.hidden ? gsap.ticker.lagSmoothing(0) : gsap.ticker.lagSmoothing(500, 33);
  syncLag();
  document.addEventListener("visibilitychange", syncLag);
}

/** Shared matchMedia conditions; every animation needs a reduced-motion fallback. */
export const MM = {
  motionOk: "(prefers-reduced-motion: no-preference)",
  desktop: "(min-width: 1024px) and (prefers-reduced-motion: no-preference)",
  reduced: "(prefers-reduced-motion: reduce)",
} as const;

export { gsap, ScrollTrigger, SplitText, useGSAP };
