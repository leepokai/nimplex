import { useRef, useState } from "react";
import { gsap, useGSAP } from "../lib/gsap.ts";
import { REPO_URL } from "./GetStarted.tsx";
import { Logo } from "./Logo.tsx";

const LINKS = [
  { id: "what", label: "what you get" },
  { id: "swap", label: "kill -9" },
  { id: "slots", label: "execution tiers" },
];

export function Nav() {
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  // Replay the entrance stagger whenever the menu opens via dependencies: [open].
  useGSAP(
    () => {
      if (!open) return;
      gsap.from("[data-menu-link]", {
        autoAlpha: 0,
        y: 22,
        duration: 0.38,
        ease: "power3.out",
        stagger: 0.06,
      });
    },
    { scope: root, dependencies: [open] },
  );

  const close = () => setOpen(false);

  return (
    <div ref={root}>
      <header className="nav">
        <div className="wrap">
          <a className="brand" href="#top">
            <Logo />
            nimplex
          </a>
          <nav className="nav-links" aria-label="Sections">
            {LINKS.map((l) => (
              <a key={l.id} href={`#${l.id}`}>
                {l.label}
              </a>
            ))}
          </nav>
          <span className="spacer" />
          <a
            className="btn btn-primary btn-sm"
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            GitHub
          </a>
          <button
            type="button"
            className="menu-toggle"
            aria-expanded={open}
            aria-controls="mobile-menu"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? "[x]" : "[≡]"}
          </button>
        </div>
      </header>

      {open ? (
        <div id="mobile-menu" className="mobile-menu">
          <nav aria-label="Sections">
            {LINKS.map((l, i) => (
              <a key={l.id} data-menu-link href={`#${l.id}`} onClick={close}>
                <span className="idx">0{i + 1}</span>
                {l.label}
              </a>
            ))}
            <a
              data-menu-link
              className="btn btn-primary"
              href={REPO_URL}
              target="_blank"
              rel="noopener noreferrer"
              onClick={close}
            >
              GitHub
            </a>
          </nav>
        </div>
      ) : null}
    </div>
  );
}
