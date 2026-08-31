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
 * 開機序列。刻意做得短（約 1.1 秒）並且能被跳過——
 * 這是一個 waitlist 頁，表單越晚出現轉換越差，動畫不該擋在使用者前面。
 * reduced-motion 或背景分頁直接略過。
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
      {/* 沒有 JS 就不該看到一塊永遠不會消失的黑幕 */}
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
