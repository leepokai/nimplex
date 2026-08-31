import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { SplitText } from "gsap/SplitText";

gsap.registerPlugin(ScrollTrigger, SplitText, useGSAP);

// 背景分頁的 rAF 被節流時直接跳到正確時間點；回到前景才恢復平滑
// （不做的話切回分頁會看到動畫「跳格」補回落後的時間）
if (typeof document !== "undefined") {
  const syncLag = () =>
    document.hidden ? gsap.ticker.lagSmoothing(0) : gsap.ticker.lagSmoothing(500, 33);
  syncLag();
  document.addEventListener("visibilitychange", syncLag);
}

/** gsap.matchMedia 常用條件：動畫一律要有 reduced-motion 的靜態版本 */
export const MM = {
  motionOk: "(prefers-reduced-motion: no-preference)",
  desktop: "(min-width: 1024px) and (prefers-reduced-motion: no-preference)",
  reduced: "(prefers-reduced-motion: reduce)",
} as const;

export { gsap, ScrollTrigger, SplitText, useGSAP };
