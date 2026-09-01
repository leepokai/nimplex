import {
  CalculatorIcon,
  ChartBarIcon,
  CircuitryIcon,
  CubeIcon,
  KeyIcon,
  LockKeyIcon,
  PlayCircleIcon,
  PlugsIcon,
  SparkleIcon,
  UsersIcon,
} from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { AgentConnect } from "./AgentConnect.tsx";
import { AuthScreen } from "./AuthScreen.tsx";
import { authClient } from "./auth-client.ts";
import { nimplex, queryKeys } from "./client.ts";
import { Logo } from "./Logo.tsx";
import { OrgSwitcher } from "./OrgSwitcher.tsx";
import { ApiKeysPage } from "./views/ApiKeys.tsx";
import { EstimatePage } from "./views/Estimate.tsx";
import { HarnessesPage } from "./views/Harnesses.tsx";
import { McpServersPage } from "./views/McpServers.tsx";
import { MembersPage } from "./views/Members.tsx";
import { ModelProvidersPage } from "./views/ModelProviders.tsx";
import { RunsPage } from "./views/Runs.tsx";
import { SandboxProvidersPage } from "./views/SandboxProviders.tsx";
import { SkillsPage } from "./views/Skills.tsx";
import { UsagePage } from "./views/Usage.tsx";

type Route =
  | "runs"
  | "usage"
  | "estimate"
  | "harness"
  | "model"
  | "sandbox"
  | "skills"
  | "mcp"
  | "keys"
  | "members";

const NAV: { section: string; items: { key: Route; label: string; icon: React.ReactNode }[] }[] = [
  {
    section: "執行",
    items: [
      { key: "runs", label: "Runs", icon: <PlayCircleIcon size={17} weight="regular" /> },
      { key: "usage", label: "Usage", icon: <ChartBarIcon size={17} weight="regular" /> },
      { key: "estimate", label: "跑前試算", icon: <CalculatorIcon size={17} weight="regular" /> },
    ],
  },
  {
    section: "三插槽",
    items: [
      { key: "harness", label: "Harness", icon: <CircuitryIcon size={17} weight="regular" /> },
      { key: "model", label: "LLM provider", icon: <KeyIcon size={17} weight="regular" /> },
      { key: "sandbox", label: "Sandbox", icon: <CubeIcon size={17} weight="regular" /> },
    ],
  },
  {
    section: "工具",
    items: [
      { key: "skills", label: "Skills", icon: <SparkleIcon size={17} weight="regular" /> },
      { key: "mcp", label: "MCP servers", icon: <PlugsIcon size={17} weight="regular" /> },
    ],
  },
  {
    section: "組織",
    items: [
      { key: "keys", label: "API keys", icon: <LockKeyIcon size={17} weight="regular" /> },
      { key: "members", label: "Members", icon: <UsersIcon size={17} weight="regular" /> },
    ],
  },
];

const ROUTES = new Set(NAV.flatMap((s) => s.items.map((i) => i.key)));

const VIEWS: Record<Route, React.ReactNode> = {
  runs: <RunsPage />,
  usage: <UsagePage />,
  estimate: <EstimatePage />,
  harness: <HarnessesPage />,
  model: <ModelProvidersPage />,
  sandbox: <SandboxProvidersPage />,
  skills: <SkillsPage />,
  mcp: <McpServersPage />,
  keys: <ApiKeysPage />,
  members: <MembersPage />,
};

function parseHash(): Route {
  const head = (location.hash || "#/runs").slice(2);
  return ROUTES.has(head as Route) ? (head as Route) : "runs";
}

/** session gate：登入前只有 AuthScreen，登入後才掛主畫面（與它的 queries）。 */
export function App() {
  const session = authClient.useSession();
  if (session.isPending) {
    return <div className="auth-screen" aria-busy="true" />;
  }
  if (!session.data) {
    return <AuthScreen />;
  }
  return <Console userEmail={session.data.user.email} />;
}

function Console({ userEmail }: { userEmail: string }) {
  const [route, setRoute] = useState<Route>(parseHash);

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
          <OrgSwitcher />
        </span>
        <span className="spacer" />
        <span className="topbar-status mono">integration {ready}/3</span>
        <a className="topbar-link" href="http://localhost:5176" target="_blank" rel="noreferrer">
          官網 ↗
        </a>
        <span className="topbar-user mono dim">{userEmail}</span>
        <button
          type="button"
          className="btn ghost"
          onClick={() => {
            void authClient.signOut();
          }}
        >
          登出
        </button>
      </header>

      <div className="shell">
        <nav className="sidebar">
          {NAV.map((group) => (
            <div key={group.section} className="nav-group">
              <div className="nav-sec">{group.section}</div>
              {group.items.map((n) => (
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
            </div>
          ))}
        </nav>

        <main className="main">{VIEWS[route]}</main>
      </div>

      <AgentConnect />
    </div>
  );
}
