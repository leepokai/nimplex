import type { McpAuthKind, McpServerRequestInput, McpServerResponse } from "@nimplex/sdk";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { nimplex, queryKeys } from "../client.ts";
import { Badge, CopyCall, Empty, ErrorNote, Field, Panel } from "../ui.tsx";
import { omit } from "../util.ts";

/**
 * MCP servers（agent 用的）：agent 在沙箱裡可以連的 MCP endpoint 白名單，存在 org 的 registry
 * （/v1/mcp-servers）。註冊過的 server 才連得出去（未來 egress allowlist 的一部分）；
 * auth 只收 broker 引用，明文憑證不落地、不進沙箱。
 * 建 run 時帶 `mcp_servers: ["slug"]` 掛給該 run 的 harness——這段注入路徑還沒接，這頁先把 registry 做真。
 */
export function McpServersPage() {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: queryKeys.mcpServers,
    queryFn: () => nimplex.mcpServers.list(),
  });
  const [adding, setAdding] = useState(false);

  const invalidate = () => void qc.invalidateQueries({ queryKey: queryKeys.mcpServers });
  const put = useMutation({
    mutationFn: (request: McpServerRequestInput) => nimplex.mcpServers.put(request),
    onSuccess: () => {
      invalidate();
      setAdding(false);
    },
  });
  const toggle = useMutation({
    mutationFn: (s: McpServerResponse) =>
      nimplex.mcpServers.put({ ...stripMeta(s), enabled: !s.enabled }),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (slug: string) => nimplex.mcpServers.delete(slug),
    onSuccess: invalidate,
  });

  return (
    <>
      <h1>MCP servers</h1>
      <p className="lede">
        agent 在沙箱裡連得到的 MCP endpoint——註冊過的才放行。這是「把你自己產品的功能 變成 agent
        工具」的入口：把你的 MCP server 掛進來，agent 就能操作你的產品本身。
      </p>

      <Panel
        title="已註冊的 server"
        hint="已落地：/v1/mcp-servers（PUT 冪等覆寫）。auth 只收 broker 引用，明文不落地；建 run 時的 mcp_servers: [slug] 注入路徑是下一步"
        actions={
          <>
            <CopyCall snippet="await nimplex.mcpServers.list()" label="複製 list 呼叫" />
            <button type="button" className="btn" onClick={() => setAdding(true)}>
              ＋ 註冊 server
            </button>
          </>
        }
      >
        <ErrorNote error={list.error ?? toggle.error ?? remove.error} />
        {list.isPending ? <Empty>載入中…</Empty> : null}
        {list.data?.map((s) => (
          <div key={s.slug} className="keyline">
            <span className="mono strong">{s.slug}</span>
            <span className="dim mono">{s.url}</span>
            <span className="tag mono">
              {s.auth === "none" ? "無驗證" : `bearer（${s.credential_ref}）`}
            </span>
            <span className="spacer" />
            <Badge tone={s.enabled ? "ok" : "neutral"}>{s.enabled ? "啟用" : "停用"}</Badge>
            <button
              type="button"
              className="btn ghost"
              disabled={toggle.isPending}
              onClick={() => toggle.mutate(s)}
            >
              {s.enabled ? "停用" : "啟用"}
            </button>
            <button
              type="button"
              className="btn danger ghost"
              disabled={remove.isPending}
              onClick={() => remove.mutate(s.slug)}
            >
              移除
            </button>
            <CopyCall
              snippet={`await nimplex.mcpServers.put(${JSON.stringify(stripMeta(s), null, 2)})`}
              label="複製 put 呼叫"
            />
          </div>
        ))}
        {list.data?.length === 0 && !adding ? <Empty>還沒有註冊任何 MCP server。</Empty> : null}

        {adding ? (
          <McpServerForm
            pending={put.isPending}
            error={put.error}
            onCancel={() => setAdding(false)}
            onSubmit={(r) => put.mutate(r)}
          />
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

function McpServerForm({
  pending,
  error,
  onCancel,
  onSubmit,
}: {
  pending: boolean;
  error: unknown;
  onCancel: () => void;
  onSubmit: (request: McpServerRequestInput) => void;
}) {
  const [slug, setSlug] = useState("");
  const [url, setUrl] = useState("");
  const [auth, setAuth] = useState<McpAuthKind>("none");
  const [credentialRef, setCredentialRef] = useState("");

  return (
    <form
      className="form-grid"
      onSubmit={(e) => {
        e.preventDefault();
        const trimmedSlug = slug.trim();
        const trimmedUrl = url.trim();
        if (!trimmedSlug || !trimmedUrl || pending) return;
        onSubmit({
          slug: trimmedSlug,
          url: trimmedUrl,
          auth,
          credential_ref: auth === "bearer_ref" ? credentialRef.trim() : undefined,
        });
      }}
    >
      <Field htmlFor="mcp-slug" label="Slug" hint="小寫英數與連字號；同名註冊就是覆寫">
        <input
          id="mcp-slug"
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          placeholder="my-product"
        />
      </Field>
      <Field htmlFor="mcp-url" label="Endpoint URL" hint="只收 http(s)">
        <input
          id="mcp-url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://…/mcp"
        />
      </Field>
      <Field htmlFor="mcp-auth" label="驗證">
        <select id="mcp-auth" value={auth} onChange={(e) => setAuth(e.target.value as McpAuthKind)}>
          <option value="none">無驗證</option>
          <option value="bearer_ref">bearer（broker 引用）</option>
        </select>
      </Field>
      {auth === "bearer_ref" ? (
        <Field
          htmlFor="mcp-cred"
          label="憑證引用"
          hint="形如 nango:conn_abc；這裡永遠不收明文 token"
        >
          <input
            id="mcp-cred"
            value={credentialRef}
            onChange={(e) => setCredentialRef(e.target.value)}
            placeholder="nango:conn_abc"
          />
        </Field>
      ) : null}
      <ErrorNote error={error} />
      <div className="form-actions">
        <button type="submit" className="btn" disabled={pending}>
          {pending ? "註冊中…" : "註冊"}
        </button>
        <button type="button" className="btn ghost" onClick={onCancel}>
          取消
        </button>
      </div>
    </form>
  );
}

/** 回應多了 id / created_at / updated_at，且 credential_ref 是 nullable；回填成 request 時整理掉。 */
function stripMeta(row: McpServerResponse): McpServerRequestInput {
  const { credential_ref, ...rest } = omit(row, ["id", "created_at", "updated_at"]);
  return { ...rest, credential_ref: credential_ref ?? undefined };
}
