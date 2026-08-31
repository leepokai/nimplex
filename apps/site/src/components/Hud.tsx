import { useRef } from "react";
import { gsap, MM, ScrollTrigger, useGSAP } from "../lib/gsap.ts";

/**
 * 右下角讀數：目前章節 + 全頁捲動進度。
 * 只在桌機出現——手機螢幕上它會擋住內容，而且沒有滑鼠停留的閱讀節奏。
 */
export function Hud() {
  const root = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add(MM.desktop, () => {
        const label = root.current?.querySelector<HTMLElement>("[data-hud-label]");
        const bar = root.current?.querySelector<HTMLElement>("[data-hud-bar]");

        // 章節都在 Hud 的 DOM 之外，不能靠 useGSAP 的 scope 選取
        for (const sec of document.querySelectorAll<HTMLElement>("[data-section]")) {
          ScrollTrigger.create({
            trigger: sec,
            start: "top 55%",
            end: "bottom 55%",
            // Hud 比章節先掛載，它的 trigger 也就比 pin 先建立。
            // refreshPriority 負值 = 最後才重新量測，這樣 pin 撐出來的高度已經算進去了。
            refreshPriority: -1,
            // 用 onEnter/onEnterBack 而不是 onToggle：釘住的章節會讓下一段同時「active」，
            // 取最後進入的那一段才符合捲動方向
            onEnter: () => {
              if (label) label.textContent = sec.dataset.section ?? "";
            },
            onEnterBack: () => {
              if (label) label.textContent = sec.dataset.section ?? "";
            },
          });
        }

        // 進度不能用 self.progress：這個 trigger 建立時 pin 還不存在，
        // end 會停在「加 pin 之前」的頁高，捲到一半就先跑到 100%。
        // 綁在 documentElement 上當更新的節拍器，數字每次都現算。
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
