import { useRef } from "react";
import { gsap, MM, ScrollTrigger, useGSAP } from "../lib/gsap.ts";

/**
 * Bottom-right readout: current section and overall scroll progress.
 * Desktop only; on mobile it obscures content without the same pointer-driven pacing.
 */
export function Hud() {
  const root = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add(MM.desktop, () => {
        const label = root.current?.querySelector<HTMLElement>("[data-hud-label]");
        const bar = root.current?.querySelector<HTMLElement>("[data-hud-bar]");

        // Sections lie outside the HUD DOM and cannot use the useGSAP scope.
        for (const sec of document.querySelectorAll<HTMLElement>("[data-section]")) {
          ScrollTrigger.create({
            trigger: sec,
            start: "top 55%",
            end: "bottom 55%",
            // HUD mounts before sections, so its trigger precedes their pin setup.
            // A negative refreshPriority measures last, including the added pin height.
            refreshPriority: -1,
            // onEnter/onEnterBack follows scroll direction; onToggle can mark overlapping
            // pinned sections active simultaneously.
            onEnter: () => {
              if (label) label.textContent = sec.dataset.section ?? "";
            },
            onEnterBack: () => {
              if (label) label.textContent = sec.dataset.section ?? "";
            },
          });
        }

        // self.progress uses an end measured before pinning and reaches 100% too early.
        // Use the document trigger only as an update clock, recalculating actual
        // document progress on every update.
        ScrollTrigger.create({
          trigger: document.documentElement,
          start: "top top",
          end: "bottom bottom",
          invalidateOnRefresh: true,
          refreshPriority: -1,
          onUpdate: () => {
            if (!bar) return;
            const max = ScrollTrigger.maxScroll(window);
            const p = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
            const filled = Math.round(p * 12);
            bar.textContent = `${"█".repeat(filled)}${"░".repeat(12 - filled)} ${String(
              Math.round(p * 100),
            ).padStart(3, "0")}%`;
          },
        });

        gsap.from(root.current, { autoAlpha: 0, duration: 0.5, delay: 1.4 });
      });
    },
    { scope: root },
  );

  return (
    <div ref={root} className="hud" aria-hidden="true">
      <span data-hud-label>hero</span>
      <span data-hud-bar>░░░░░░░░░░░░ 000%</span>
    </div>
  );
}
