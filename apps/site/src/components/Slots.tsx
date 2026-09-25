import { useRef } from "react";
import { gsap, MM, useGSAP } from "../lib/gsap.ts";

const SLOTS = [
  {
    n: "1",
    title: "Durable workspace",
    body: "The files are committed to SQLite with every tool result, including binaries, empty directories, symlinks and permissions. The workspace outlives any process or sandbox.",
    on: ["SQLite", "per-tool revisions"],
    off: [],
  },
  {
    n: "2",
    title: "In-process shell",
    body: "Pure shell work runs in just-bash, an in-memory virtual filesystem with 60+ commands. It starts in milliseconds and creates no sandbox at all.",
    on: ["just-bash"],
    off: [],
  },
  {
    n: "3",
    title: "Native sandbox",
    body: "Only commands that need a real machine (node, git, package installs) go to a disposable sandbox, through a journal the runtime can reattach to. E2B pauses between commands.",
    on: ["docker", "e2b"],
    off: ["daytona", "vercel"],
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
            Three tiers,
            <br />
            one workspace.
          </h2>
          <p className="lede">
            The runtime reads each shell script before it runs and sends it to the cheapest tier
            that can execute it. Whatever runs, the files end up in the same durable workspace.
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
