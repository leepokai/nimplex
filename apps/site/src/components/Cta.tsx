import { useRef } from "react";
import { gsap, MM, SplitText, useGSAP } from "../lib/gsap.ts";
import { Waitlist } from "../Waitlist.tsx";

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
    <section ref={root} id="get" data-section="join" className="wrap cta">
      <h2 data-cta-h2>Build on cloud agents without betting on one.</h2>
      <p data-cta-rest className="lede">
        We're onboarding a small number of teams building on cloud agents. Tell us what you run
        today — and what you'd want to swap out if swapping were free.
      </p>
      <div data-cta-rest className="hero-form">
        <Waitlist />
      </div>
    </section>
  );
}
