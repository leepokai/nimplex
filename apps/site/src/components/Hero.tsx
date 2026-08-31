import { useRef } from "react";
import { gsap, SplitText, useGSAP } from "../lib/gsap.ts";
import { Waitlist } from "../Waitlist.tsx";
import { BOOT_EVENT } from "./Preloader.tsx";
import { SignalField } from "./SignalField.tsx";

const WORKS_WITH = ["claude-code", "codex", "opencode", "your own manifest"];

/**
 * 置中的大標題，逐字組裝進場。
 * 兩個把關：等 document.fonts.ready 才切字（否則字寬會在動畫中途跳動）；
 * 等 Preloader 廣播 BOOT_EVENT 才開演，另外留 timeout 保險。
 */
export function Hero() {
  const root = useRef<HTMLElement>(null);

  useGSAP(
    () => {
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        gsap.set("[data-hero-item]", { autoAlpha: 1 });
        return;
      }

      gsap.set("[data-hero-item]", { autoAlpha: 0 });
      gsap.set("[data-hero-sub]", { y: 14 });

      let played = false;
      const play = async () => {
        if (played) return;
        played = true;
        await document.fonts.ready;

        // 一定要連 words 一起切：只切 chars 的話換行會發生在單字中間
        const split = SplitText.create("[data-hero-h1]", { type: "words,chars" });
        gsap.set("[data-hero-h1]", { autoAlpha: 1 });

        gsap
          .timeline({ defaults: { ease: "power3.out" } })
          .to("[data-hero-eyebrow]", { autoAlpha: 1, duration: 0.3 })
          .from(
            split.chars,
            {
              autoAlpha: 0,
              y: () => gsap.utils.random(-34, 34, 2),
              duration: 0.5,
              stagger: { each: 0.014, from: "random" },
            },
            "-=0.1",
          )
          .to("[data-hero-sub]", { autoAlpha: 1, y: 0, duration: 0.4 }, "-=0.3")
          // 表單最後進場，但從頭到尾沒有被 display:none —— 它是這頁唯一要做的事
          .to("[data-hero-form]", { autoAlpha: 1, duration: 0.35 }, "-=0.15")
          .to("[data-hero-note]", { autoAlpha: 1, duration: 0.3 }, "-=0.2");
      };

      window.addEventListener(BOOT_EVENT, play, { once: true });
      const fallback = setTimeout(play, 2000);
      return () => {
        window.removeEventListener(BOOT_EVENT, play);
        clearTimeout(fallback);
      };
    },
    { scope: root },
  );

  return (
    <>
      <section ref={root} className="hero" data-section="hero">
        <SignalField />
        <div className="wrap">
          <span data-hero-item data-hero-eyebrow className="pill">
            Private beta
          </span>
          <h1 data-hero-item data-hero-h1>
            <span className="soft">OpenRouter</span> for cloud agents
          </h1>
          <p data-hero-item data-hero-sub className="hero-sub">
            Run any coding agent, on any sandbox, against any model — through one API. Swap any
            piece later without touching the rest of your code.
          </p>
          <div data-hero-item data-hero-form className="hero-form">
            <Waitlist id="join" />
          </div>
          <p data-hero-item data-hero-note className="join-note">
            Bring your own provider keys. We're the routing layer, not the reseller — so we have no
            reason to make one vendor easier than another.
          </p>
        </div>
      </section>

      <div className="strip">
        <div className="wrap">
          <span className="label">Runs whatever writes the code</span>
          <div className="items">
            {WORKS_WITH.map((w) => (
              <span key={w}>{w}</span>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
