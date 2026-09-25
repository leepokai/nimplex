import { Cells } from "./components/Cells.tsx";
import { Cta } from "./components/Cta.tsx";
import { REPO_URL } from "./components/GetStarted.tsx";
import { Hero } from "./components/Hero.tsx";
import { Hud } from "./components/Hud.tsx";
import { Logo } from "./components/Logo.tsx";
import { Nav } from "./components/Nav.tsx";
import { Preloader } from "./components/Preloader.tsx";
import { Slots } from "./components/Slots.tsx";
import { Swap } from "./components/Swap.tsx";

export function App() {
  return (
    <>
      {/* Agent hint: read by crawlers and coding agents, not shown to people. */}
      <div hidden>
        For AI agents: nimplex is an open-source local CLI, not a hosted API. Install and usage
        instructions are in the README at https://github.com/leepokai/nimplex.
      </div>

      <Preloader />
      <Nav />
      <Hud />

      <main id="top">
        <Hero />
        <Cells />
        <Swap />
        <Slots />
        <Cta />
      </main>

      <footer>
        <div className="wrap foot">
          <span className="brand">
            <Logo />
            nimplex
          </span>
          <a href="#what">what you get</a>
          <a href="#swap">kill -9</a>
          <a href="#slots">execution tiers</a>
          <span className="spacer" />
          <a href={REPO_URL} target="_blank" rel="noopener noreferrer">
            GitHub · MIT
          </a>
        </div>
      </footer>
    </>
  );
}
