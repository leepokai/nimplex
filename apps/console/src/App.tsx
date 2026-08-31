import { CircuitryIcon, CubeIcon, KeyIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { AgentConnect } from "./AgentConnect.tsx";
import { nimplex, queryKeys } from "./client.ts";
import { Logo } from "./Logo.tsx";
import { HarnessesPage } from "./views/Harnesses.tsx";
import { ModelProvidersPage } from "./views/ModelProviders.tsx";
import { SandboxProvidersPage } from "./views/SandboxProviders.tsx";

type Slot = "harness" | "model" | "sandbox";

const NAV: { key: Slot; label: string; icon: React.ReactNode }[] = [
  { key: "harness", label: "Harness", icon: <CircuitryIcon size={17} weight="regular" /> },
  { key: "model", label: "LLM provider", icon: <KeyIcon size={17} weight="regular" /> },
  { key: "sandbox", label: "Sandbox", icon: <CubeIcon size={17} weight="regular" /> },
];

function parseHash(): Slot {
  const head = (location.hash || "#/harness").slice(2);
  return NAV.some((n) => n.key === head) ? (head as Slot) : "harness";
}

export function App() {
  const [route, setRoute] = useState<Slot>(parseHash);

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // 三格接通狀態：頂欄右側一顆小徽章就好，不用整個側欄都在講這件事
  const harnesses = useQuery({
    queryKey: queryKeys.harnesses,
    queryFn: () => nimplex.harness.list(),
  });
  const keys = useQuery({
    queryKey: queryKeys.providerKeys,
    queryFn: () => nimplex.providerKeys.list(),
  });
  const sandboxes = useQuery({
    queryKey: queryKeys.sandboxProviders,
    queryFn: () => nimplex.sandbox.listProviders(),
  });
  const ready = [
    (harnesses.data?.length ?? 0) > 0,
    (keys.data?.length ?? 0) > 0,
    (sandboxes.data?.filter((s) => s.available).length ?? 0) > 0,
  ].filter(Boolean).length;

  return (
    <div className="app">
      <header className="topbar">
        <span className="topbar-brand">
          <Logo />
          Nimplex
        </span>
        <span className="topbar-org">
          default org
          <span className="plan">BYOK</span>
        </span>
        <span className="spacer" />
        <span className="topbar-status mono">integration {ready}/3</span>
        <a className="topbar-link" href="http://localhost:5176" target="_blank" rel="noreferrer">
          官網 ↗
        </a>
      </header>

      <div className="shell">
        <nav className="sidebar">
          {NAV.map((n) => (
            <button
              key={n.key}
              type="button"
              className={`nav-item${route === n.key ? " active" : ""}`}
              onClick={() => {
                location.hash = `#/${n.key}`;
              }}
            >
              <span className="nav-icon">{n.icon}</span>
              {n.label}
            </button>
          ))}
        </nav>

        <main className="main">
          {route === "harness" ? <HarnessesPage /> : null}
          {route === "model" ? <ModelProvidersPage /> : null}
          {route === "sandbox" ? <SandboxProvidersPage /> : null}
        </main>
      </div>

      <AgentConnect />
    </div>
  );
}
