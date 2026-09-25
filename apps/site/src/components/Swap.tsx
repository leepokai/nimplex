import { useRef, useState } from "react";
import { gsap, MM, ScrollTrigger, useGSAP } from "../lib/gsap.ts";

/** One turn through a crash: only the three state lines change between frames. */
const STACKS = [
  {
    label: "Steps 1 and 2 committed",
    process: '"running"',
    log: '"1\\n2\\n"',
    calls: "2 settled",
  },
  {
    label: "kill -9 during step 3",
    process: '"killed"',
    log: '"1\\n2\\n"',
    calls: "2 settled, 1 in flight",
  },
  {
    label: "nimplex --resume",
    process: '"resumed"',
    log: '"1\\n2\\n3\\n"',
    calls: "3 settled, 1 unknown",
  },
  {
    label: "Done, each step once",
    process: '"completed"',
    log: '"1\\n2\\n3\\n4\\n"',
    calls: "5 settled, 1 unknown",
  },
];

/**
 * Pin and scrub while only three lines change; every other character stays fixed.
 *
 * Show a turn surviving a crash: the task never changes, and the log never repeats a step.
 * State swaps avoid meaningless intermediate text from character tweening.
 * GSAP handles pinning, progress, and a brief flash at each switch.
 */
export function Swap() {
  const root = useRef<HTMLElement>(null);
  const [index, setIndex] = useState(0);

  useGSAP(
    () => {
      const mm = gsap.matchMedia();

      mm.add(MM.motionOk, () => {
        gsap.from("[data-swap-head] > *", {
          autoAlpha: 0,
          y: 20,
          duration: 0.5,
          ease: "power3.out",
          stagger: 0.09,
          scrollTrigger: { trigger: root.current, start: "top 72%" },
        });

        ScrollTrigger.create({
          trigger: root.current,
          start: "top top",
          end: `+=${STACKS.length * 90}%`,
          pin: true,
          scrub: 0.4,
          invalidateOnRefresh: true,
          onUpdate: (self) => {
            const next = Math.min(STACKS.length - 1, Math.floor(self.progress * STACKS.length));
            setIndex((current) => (current === next ? current : next));
          },
        });
      });
    },
    { scope: root },
  );

  // Flash the three changed lines to make the replacement immediately visible.
  useGSAP(
    () => {
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      gsap.fromTo(
        "[data-swap-value]",
        { autoAlpha: 0.25, x: -6 },
        { autoAlpha: 1, x: 0, duration: 0.32, ease: "power2.out", stagger: 0.05 },
      );
    },
    { scope: root, dependencies: [index] },
  );

  const stack = STACKS[index] ?? STACKS[0];
  if (!stack) return null;

  return (
    <section ref={root} id="swap" data-section="swap" className="swap-sec">
      <div className="wrap sec">
        <div data-swap-head className="head-c">
          <h2>Kill it. It keeps going.</h2>
          <p className="lede">
            A task appends one line per step. The process dies in the middle of step 3. Resume
            reuses what was committed, reattaches to the command that was running, and finishes with
            every line written exactly once.
          </p>
        </div>

        <div className="swap">
          <div className="swap-code">
            <div className="ln dim">
              $ nimplex "For N in 1..4, append N to log.txt, one step each"
            </div>
            <div className="ln swap-line">
              <span className="key">process:</span>{" "}
              <span data-swap-value className="val">
                {stack.process}
              </span>
            </div>
            <div className="ln swap-line">
              <span className="key">log.txt:</span>{" "}
              <span data-swap-value className="val">
                {stack.log}
              </span>
            </div>
            <div className="ln swap-line">
              <span className="key">model calls:</span>{" "}
              <span data-swap-value className="val">
                {stack.calls}
              </span>
            </div>
            <div className="ln dim">&nbsp;</div>
            <div className="ln dim">$ nimplex --watch TURN_ID # replay every committed step</div>
          </div>

          <ol className="swap-steps" aria-label="Crash and resume">
            {STACKS.map((s, i) => (
              <li key={s.label} className={i === index ? "on" : ""}>
                <span className="n">0{i + 1}</span>
                {s.label}
              </li>
            ))}
          </ol>
        </div>

        <p className="swap-cap">
          This is the recovery test the project runs against real models, Docker and E2B: the
          request that was in flight is recorded as unknown, never double-counted.
        </p>
      </div>
    </section>
  );
}
