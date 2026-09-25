import { useRef } from "react";
import { gsap, MM, useGSAP } from "../lib/gsap.ts";

const CELLS = [
  {
    n: "01",
    title: "Survives process death",
    body: "A model response is durable before its tools run; a tool result and workspace revision are durable before the next model call. After a crash, the runtime reopens the log and resumes the interrupted turn.",
    chips: ["kill -9", "dead sandbox", "lost network"],
    off: [],
  },
  {
    n: "02",
    title: "Nothing runs twice",
    body: "Committed responses are reused and only missing tool calls execute. A native command reattaches to its journal by call ID. A lost outcome is reported as unknown, never silently replayed.",
    chips: ["call identity", "command journals", "unknown outcomes"],
    off: [],
  },
  {
    n: "03",
    title: "All of Pi, not a subset",
    body: "Pi's loop, provider catalog, sessions, branching, compaction, steering, thinking levels and trust-gated extensions, through Pi's public APIs. No fork, no patched internals.",
    chips: ["every Pi provider", "Codex subscription", "branch · rewind", "extensions"],
    off: [],
  },
  {
    n: "04",
    title: "Every step on record",
    body: "Inputs, model calls with their cost, tool calls, file changes and sandbox time are events in one SQLite file. Replay any turn, and see model spend next to an estimated sandbox cost.",
    chips: ["SQLite log", "--watch replay", "model cost", "sandbox estimate"],
    off: [],
  },
];

export function Cells() {
  const root = useRef<HTMLElement>(null);

  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add(MM.motionOk, () => {
        gsap.from("[data-cell]", {
          autoAlpha: 0,
          y: 26,
          duration: 0.5,
          ease: "power3.out",
          stagger: 0.09,
          scrollTrigger: { trigger: "[data-cells]", start: "top 76%" },
        });
      });
    },
    { scope: root },
  );

  return (
    <section ref={root} id="what" data-section="what" className="wrap sec">
      <div className="head-c">
        <h2>The log is the runtime.</h2>
        <p className="lede">
          Pi drives the model and the tools. nimplex puts a commit barrier around every step, so the
          SQLite log, not the process, is what a session is made of.
        </p>
      </div>

      <div data-cells className="grid-cells">
        {CELLS.map((c) => (
          <div key={c.n} data-cell className="cell">
            <span className="num">{c.n}</span>
            <h3>{c.title}</h3>
            <p>{c.body}</p>
            <div className="chips">
              {c.chips.map((x) => (
                <span key={x} className="chip">
                  {x}
                </span>
              ))}
              {c.off.map((x) => (
                <span key={x} className="chip off">
                  {x}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
