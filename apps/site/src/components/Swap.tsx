import { useRef, useState } from "react";
import { gsap, MM, ScrollTrigger, useGSAP } from "../lib/gsap.ts";

/** The same integration changes stacks by replacing only three values. */
const STACKS = [
  {
    label: "Anthropic on your own Docker",
    harness: '"claude-code"',
    model: '{ provider: "anthropic", id: "claude-sonnet-5" }',
    sandbox: '{ provider: "docker" }',
  },
  {
    label: "OpenAI on E2B",
    harness: '"codex"',
    model: '{ provider: "openai", id: "gpt-5" }',
    sandbox: '{ provider: "e2b" }',
  },
  {
    label: "OpenRouter on Vercel Sandbox",
    harness: '"opencode"',
    model: '{ provider: "openrouter", id: "anthropic/claude-sonnet-4.5" }',
    sandbox: '{ provider: "vercel" }',
  },
  {
    label: "Your harness, your cloud",
    harness: '"my-agent"',
    model: '{ provider: "anthropic", id: "claude-opus-5" }',
    sandbox: '{ provider: "my-cloud" }',
  },
];

/**
 * Pin and scrub while only three lines change; every other character stays fixed.
 *
 * Demonstrate provider neutrality through the unchanged integration.
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
          <h2>Same integration. Any stack underneath.</h2>
          <p className="lede">
            Harness, model provider and sandbox are three fields on one request. Swap any of them
            and nothing else in your code moves — no rewrite, no second SDK, no migration.
          </p>
        </div>

        <div className="swap">
          <div className="swap-code">
            <div className="ln dim">const run = await nimplex.agent({`{`}</div>
            <div className="ln swap-line">
              <span className="key">harness:</span>{" "}
              <span data-swap-value className="val">
                {stack.harness}
              </span>
              ,
            </div>
            <div className="ln swap-line">
              <span className="key">model:</span>{" "}
              <span data-swap-value className="val">
                {stack.model}
              </span>
              ,
            </div>
            <div className="ln swap-line">
              <span className="key">sandbox:</span>{" "}
              <span data-swap-value className="val">
                {stack.sandbox}
              </span>
              ,
            </div>
            <div className="ln dim">{`}).stream({ prompt: "fix the failing test" })`}</div>
            <div className="ln dim">&nbsp;</div>
            <div className="ln dim">for await (const event of run.events) render(event)</div>
          </div>

          <ol className="swap-steps" aria-label="Stacks">
            {STACKS.map((s, i) => (
              <li key={s.label} className={i === index ? "on" : ""}>
                <span className="n">0{i + 1}</span>
                {s.label}
              </li>
            ))}
          </ol>
        </div>

        <p className="swap-cap">
          Three lines change. The other four never do — and neither does anything downstream of
          them.
        </p>
      </div>
    </section>
  );
}
