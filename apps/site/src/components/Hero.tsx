import { useRef } from "react";
import { gsap, SplitText, useGSAP } from "../lib/gsap.ts";
import { GetStarted } from "./GetStarted.tsx";
import { BOOT_EVENT } from "./Preloader.tsx";
import { SignalField } from "./SignalField.tsx";

const BUILT_ON = ["Pi agent harness", "SQLite", "just-bash", "Docker · E2B"];

/**
 * Centered title assembled character by character.
 * Wait for document.fonts.ready before splitting to prevent changing glyph widths;
 * wait for the preloader BOOT_EVENT, with a timeout fallback.
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

        // Split words as well as characters to prevent line breaks inside words.
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
          // Reveal the form last, but never hide the primary action with display:none.
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
            Open source · MIT · early
          </span>
          <h1 data-hero-item data-hero-h1>
            <span className="soft">A coding agent that</span> survives kill -9
          </h1>
          <p data-hero-item data-hero-sub className="hero-sub">
            nimplex runs Pi's coding agent and commits every model response, tool result and file
            change to SQLite before the next step. Kill the process, lose the sandbox or drop the
            network, then resume exactly where it stopped, with nothing run twice.
          </p>
          <div data-hero-item data-hero-form className="hero-form">
            <GetStarted id="start" />
          </div>
          <p data-hero-item data-hero-note className="join-note">
            Runs on your laptop as the <code>nimplex</code> terminal. No server, no database
            service. Bring your own model keys or a Codex subscription.
          </p>
        </div>
      </section>

      <div className="strip">
        <div className="wrap">
          <span className="label">Built on</span>
          <div className="items">
            {BUILT_ON.map((w) => (
              <span key={w}>{w}</span>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
