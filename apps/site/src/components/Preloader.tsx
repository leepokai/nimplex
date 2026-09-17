import { useRef, useState } from "react";
import { gsap, useGSAP } from "../lib/gsap.ts";

export const BOOT_EVENT = "nmx:boot-done";

const LINES = [
  "nimplex@gateway:~$ ./boot",
  "harness registry ... claude-code · codex · opencode · +yours",
  "byok vault ....... sealed",
  "sandbox port ..... docker · local",
];

/**
 * Short, skippable boot sequence (about 1.1 seconds).
 * Keep the waitlist form accessible; animation must not delay the primary action.
 * Skip for reduced motion and background tabs.
 */
export function Preloader() {
  const root = useRef<HTMLDivElement>(null);
  const [done, setDone] = useState(false);

  useGSAP(
    () => {
      const finish = () => {
        window.dispatchEvent(new CustomEvent(BOOT_EVENT));
        setDone(true);
      };

      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || document.hidden) {
        finish();
        return;
      }

      const bar = root.current?.querySelector<HTMLElement>("[data-boot-bar]");
      const counter = { p: 0 };
      const tl = gsap.timeline({
        defaults: { ease: "none" },
        onComplete: () => {
          gsap.to(root.current, {
            yPercent: -100,
            duration: 0.42,
            ease: "power3.inOut",
            onComplete: finish,
          });
        },
      });

      tl.from("[data-boot-line]", { autoAlpha: 0, duration: 0.01, stagger: 0.17 }).to(
        counter,
        {
          p: 100,
          duration: 0.78,
          ease: "steps(20)",
          onUpdate: () => {
            if (!bar) return;
            const filled = Math.round(counter.p / 5);
            bar.textContent = `[${"█".repeat(filled)}${"░".repeat(20 - filled)}] ${Math.round(counter.p)}%`;
          },
        },
        0.12,
      );
    },
    { scope: root },
  );

  if (done) return null;

  return (
    <div ref={root} id="preloader" aria-hidden="true" className="preloader">
      {/* Without JavaScript, never leave a permanent opaque overlay. */}
      <noscript>
        <style>{"#preloader{display:none}"}</style>
      </noscript>
      <div className="boot">
        {LINES.map((line) => (
          <p key={line} data-boot-line>
            {line}
          </p>
        ))}
        <p data-boot-line data-boot-bar className="boot-bar">
          [░░░░░░░░░░░░░░░░░░░░] 0%
        </p>
      </div>
    </div>
  );
}
