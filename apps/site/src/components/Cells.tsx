import { useRef } from "react";
import { gsap, MM, useGSAP } from "../lib/gsap.ts";

const CELLS = [
  {
    n: "01",
    title: "Any harness — including yours",
    body: "A harness is a manifest: install steps, run command, env mapping. Built-in and uploaded ones take the exact same path, so you can override ours or ship one we've never seen.",
    chips: ["claude-code", "codex", "opencode"],
    off: ["your own"],
  },
  {
    n: "02",
    title: "Any model provider",
    body: "Your keys, your contracts, your rates. They live in the gateway, and the sandbox only ever sees a short-lived Nimplex token — never the real one.",
    chips: ["anthropic", "openai", "openrouter"],
    off: ["bedrock", "vertex"],
  },
  {
    n: "03",
    title: "Any sandbox",
    body: "Session state is serializable, so any worker can reattach to a running box and tear it down. Adding a provider is one interface, not a fork.",
    chips: ["docker", "local"],
    off: ["e2b", "vercel", "daytona"],
  },
  {
    n: "04",
    title: "The plumbing you'd rather not write",
    body: "Provisioning, harness install, credential injection, a resumable event stream, lifecycle and a hard kill. This is the part that takes a month and never becomes your product.",
    chips: ["event stream", "SSE resume", "hard kill", "usage tracking", "audit log"],
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
        <h2>Everything a cloud agent needs, none of it locked down.</h2>
        <p className="lede">
          Running an agent on someone else's machine means provisioning a box, installing a harness,
          getting a key in without leaking it, and streaming what happens back out. You get all of
          that — and you stay free to change your mind about any of the pieces.
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
