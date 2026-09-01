import { useState } from "react";
import { Badge, CopyCall, Empty, Field, Panel } from "../ui.tsx";

/**
 * MCP servers（agent 用的）：agent 在沙箱裡可以連的 MCP endpoint 白名單。
 * 定義：註冊過的 server 才連得出去（未來的 egress allowlist 一部分）；
 * auth 只收 broker 引用，明文憑證不落地、不進沙箱。
 * 建 run 時帶 `mcp_servers: ["slug"]` 掛給該 run 的 harness。
 * 這頁目前是示意操作：/v1/mcp-servers 尚未實作。
 */
type McpServer = {
  slug: string;
  url: string;
  auth: "none" | "bearer_ref";
  enabled: boolean;
};

const SEED: McpServer[] = [
  { slug: "github", url: "https://api.githubcopilot.com/mcp/", auth: "bearer_ref", enabled: true },
  { slug: "internal-crm", url: "https://crm.example.com/mcp", auth: "bearer_ref", enabled: true },
  { slug: "docs-search", url: "https://mcp.example.dev/docs", auth: "none", enabled: false },
];

export function McpServersPage() {
  const [servers, setServers] = useState(SEED);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ slug: "", url: "" });

  return (
    <>
      <h1>
        MCP servers <Badge tone="warn">示意操作</Badge>
      </h1>
      <p className="lede">
        agent 在沙箱裡連得到的 MCP endpoint——註冊過的才放行。這是「把你自己產品的功能 變成 agent
        工具」的入口：把你的 MCP server 掛進來，agent 就能操作你的產品本身。
      </p>

      <Panel
        title="已註冊的 server"
        hint="/v1/mcp-servers 尚未實作；操作先走本地示意。auth 只收 broker 引用，明文不落地"
        actions={
          <button type="button" className="btn" onClick={() => setAdding(true)}>
            ＋ 註冊 server
          </button>
        }
      >
        {servers.map((s) => (
          <div key={s.slug} className="keyline">
            <span className="mono strong">{s.slug}</span>
            <span className="dim mono">{s.url}</span>
            <span className="tag mono">
              {s.auth === "none" ? "無驗證" : "bearer（broker 引用）"}
            </span>
            <span className="spacer" />
            <Badge tone={s.enabled ? "ok" : "neutral"}>{s.enabled ? "啟用" : "停用"}</Badge>
            <button
              type="button"
              className="btn ghost"
              onClick={() =>
                setServers((prev) =>
                  prev.map((x) => (x.slug === s.slug ? { ...x, enabled: !x.enabled } : x)),
                )
              }
            >
              {s.enabled ? "停用" : "啟用"}
            </button>
            <button
              type="button"
              className="btn danger ghost"
              onClick={() => setServers((prev) => prev.filter((x) => x.slug !== s.slug))}
            >
              移除
            </button>
            <CopyCall snippet={`mcp_servers: ["${s.slug}"]`} label="複製掛載設定" />
          </div>
        ))}
        {servers.length === 0 ? <Empty>還沒有註冊任何 MCP server。</Empty> : null}

        {adding ? (
          <form
            className="form-grid"
            onSubmit={(e) => {
              e.preventDefault();
              const slug = draft.slug.trim();
              const url = draft.url.trim();
              if (!slug || !url) return;
              setServers((prev) => [...prev, { slug, url, auth: "none", enabled: true }]);
              setDraft({ slug: "", url: "" });
              setAdding(false);
            }}
          >
            <Field htmlFor="mcp-slug" label="Slug">
              <input
                id="mcp-slug"
                value={draft.slug}
                onChange={(e) => setDraft((d) => ({ ...d, slug: e.target.value }))}
                placeholder="my-product"
              />
            </Field>
            <Field htmlFor="mcp-url" label="Endpoint URL">
              <input
                id="mcp-url"
                value={draft.url}
                onChange={(e) => setDraft((d) => ({ ...d, url: e.target.value }))}
                placeholder="https://…/mcp"
              />
            </Field>
            <div className="form-actions">
              <button type="submit" className="btn">
                註冊
              </button>
              <button type="button" className="btn ghost" onClick={() => setAdding(false)}>
                取消
              </button>
            </div>
          </form>
        ) : null}
      </Panel>

      <Panel
        title="另一件事：用你的 AI 工具管 nimplex"
        hint="上面是「agent 用的 MCP」；這張是「你用來操作 nimplex 的 MCP」——刻意分開"
      >
        <p className="lede small">
          console 用到的每一個操作，MCP catalog 裡都有對應 tool（同一組公開 API 產生）。
          裝好之後可以直接說「列出今天燒超過 $1 的 run」「砍掉跑超過 30 分鐘的 run」。
        </p>
        <CopyCall snippet="claude mcp add nimplex -- npx @nimplex/mcp" label="複製安裝指令" />
      </Panel>
    </>
  );
}
