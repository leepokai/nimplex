import { useRef } from "react";
import { gsap, MM, SplitText, useGSAP } from "../lib/gsap.ts";
import { GetStarted } from "./GetStarted.tsx";

/** Closing CTA: reveal title characters, then slide remaining elements upward. */
export function Cta() {
  const root = useRef<HTMLElement>(null);

  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add(MM.motionOk, () => {
        void document.fonts.ready.then(() => {
          const split = SplitText.create("[data-cta-h2]", { type: "words,chars" });
          gsap.from(split.chars, {
            autoAlpha: 0,
            duration: 0.3,
            ease: "power2.out",
            stagger: 0.028,
            scrollTrigger: { trigger: root.current, start: "top 68%" },
          });
        });
        gsap.from("[data-cta-rest]", {
          autoAlpha: 0,
          y: 24,
          duration: 0.5,
          ease: "power2.out",
          stagger: 0.12,
          scrollTrigger: { trigger: root.current, start: "top 52%" },
        });
      });
    },
    { scope: root },
  );

  return (
    <section ref={root} id="get" data-section="get started" className="wrap cta">
      <h2 data-cta-h2>Run it on your laptop.</h2>
      <p data-cta-rest className="lede">
        nimplex is early and pre-release: contracts and flags still change. It needs Node 22.13+ and
        pnpm 10, and one model key or a Codex login. Read what is not done yet in the README before
        relying on it.
      </p>
      <div data-cta-rest className="hero-form">
        <GetStarted />
      </div>
    </section>
  );
}
