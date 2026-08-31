import { useRef, useState } from "react";
import { gsap, MM, ScrollTrigger, useGSAP } from "../lib/gsap.ts";

/** 同一段整合，換掉三個值就換掉整個技術棧。 */
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
 * 釘住 + scrub：捲動時只有三行在換，其餘每一個字元都不動。
 *
 * 這是整頁的主張本身 —— 中立性不是講出來的，是讓你「看著它不動」。
 * 值用 state 換而不是用 GSAP 補間文字：文字補間會產生沒有意義的中間狀態，
 * 而這裡要的恰恰是「乾淨的一刀切換」。GSAP 只負責釘住、推進度、以及切換當下那一下閃動。
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

  // 換值的當下讓三行閃一下，讓「哪三行動了」一眼看得出來
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
