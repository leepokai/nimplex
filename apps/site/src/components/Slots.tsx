import { useRef } from "react";
import { gsap, MM, useGSAP } from "../lib/gsap.ts";

const SLOTS = [
  {
    n: "1",
    title: "Harness",
    body: "Whatever loop actually writes the code — ours, theirs, or one you upload. A harness is a manifest, not a plugin we have to ship.",
    on: ["claude-code", "codex", "opencode"],
    off: ["your own"],
  },
  {
    n: "2",
    title: "Model",
    body: "Your keys, your contracts, your rates. They live in the gateway and are never written into a sandbox.",
    on: ["anthropic", "openai", "openrouter"],
    off: ["bedrock", "vertex"],
  },
  {
    n: "3",
    title: "Sandbox",
    body: "Where the agent's computer lives. Swapping it is one field on the request — nothing else moves.",
    on: ["docker", "local"],
    off: ["e2b", "vercel", "daytona"],
  },
];

/**
 * Desktop: pin the section and translate three side-by-side slots with vertical scrolling.
 * Mobile/reduced motion: stack vertically without animation.
 *
 * Functional end plus invalidateOnRefresh recalculates distance from scrollWidth
 * after resize instead of retaining stale measurements.
 */
export function Slots() {
  const wrap = useRef<HTMLElement>(null);
  const track = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add(MM.desktop, () => {
        const el = track.current;
        if (!el) return;
        const distance = () => el.scrollWidth - window.innerWidth;
        gsap.to(el, {
          x: () => -distance(),
          ease: "none",
          scrollTrigger: {
            trigger: wrap.current,
            start: "top top",
            end: () => `+=${distance()}`,
            pin: true,
            scrub: 1,
            invalidateOnRefresh: true,
          },
        });
      });
    },
    { scope: wrap },
  );

  return (
    <section ref={wrap} id="slots" data-section="slots" className="slots-sec">
      <div ref={track} className="slots-track">
        <div className="slot-intro">
          <h2>
            What actually sits
            <br />
            in each slot.
          </h2>
          <p className="lede">
            None of these is a wrapper we maintain on your behalf. Each one is an interface with a
            registry behind it, so the list grows without us shipping a release.
          </p>
        </div>

        {SLOTS.map((s) => (
          <article key={s.title} className="slot-card">
            <div className="idx" aria-hidden="true">
              {s.n}
            </div>
            <div>
              <h3>{s.title}</h3>
              <p>{s.body}</p>
            </div>
            <div className="chips">
              {s.on.map((p) => (
                <span key={p} className="chip">
                  {p}
                </span>
              ))}
              {s.off.map((p) => (
                <span key={p} className="chip off">
                  {p}
                </span>
              ))}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
