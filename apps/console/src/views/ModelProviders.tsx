import type { ModelProvider } from "@nimplex/sdk";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { nimplex, queryKeys } from "../client.ts";
import { Badge, CopyCall, Empty, ErrorNote, Field, Panel } from "../ui.tsx";

/**
 * 頁型抄 OpenRouter 的 BYOK 頁：已連接的在上、Available 在下，
 * 每列 = logo 磚 + 名字 + 右側狀態（"n keys" / "Not configured"）。
 * 最上面多一列 Nimplex router（統一 key）—— 那是產品方向，後端還沒有，
 * 所以明確標示尚未開放，絕不做成看起來能按的樣子。
 */
const PROVIDERS: {
  id: ModelProvider;
  name: string;
  desc: string;
  logo: string;
  invert?: boolean;
}[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    desc: "Claude 系列",
    logo: "https://cdn.simpleicons.org/anthropic/ffffff",
  },
  {
    id: "openai",
    name: "OpenAI",
    desc: "GPT 系列",
    // OpenAI 已從 simple-icons 下架（商標），用 jsDelivr 上的舊版 + CSS 反白
    logo: "https://cdn.jsdelivr.net/npm/simple-icons@11/icons/openai.svg",
    invert: true,
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    desc: "一把 key 打多家模型",
    logo: "https://cdn.simpleicons.org/openrouter/ffffff",
  },
];

export function ModelProvidersPage() {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: queryKeys.providerKeys,
    queryFn: () => nimplex.providerKeys.list(),
  });
  const [expanded, setExpanded] = useState<ModelProvider | null>(null);
  const [adding, setAdding] = useState<ModelProvider | null>(null);

  const remove = useMutation({
    mutationFn: (id: string) => nimplex.providerKeys.delete(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: queryKeys.providerKeys }),
  });

  const keysFor = (p: ModelProvider) => list.data?.filter((k) => k.provider === p) ?? [];
  const configured = PROVIDERS.filter((p) => keysFor(p.id).length > 0);
  const available = PROVIDERS.filter((p) => keysFor(p.id).length === 0);

  return (
    <>
      <h1>LLM provider</h1>
      <p className="lede">
        在 Nimplex 上用你自己的 provider API key。明文只在送出那一次出現，落地即加密； 沙箱裡的
        harness 只拿得到 Nimplex 簽發的短期票，<strong>真 key 永不進箱子</strong>。
      </p>

      <Panel title="Nimplex router" hint="統一 key —— 產品方向，後端尚未支援">
        <div className="prow" style={{ cursor: "default" }}>
          <span className="plogo" aria-hidden="true">
            <img src="/favicon.svg" alt="" />
          </span>
          <span>
            <span className="pname">一把 Nimplex key 打全部 provider</span>
            <span className="pdesc" style={{ display: "block" }}>
              不用自己帶 key、統一計費。目前唯一可用的路徑是下面的 BYOK。
            </span>
          </span>
          <span className="pstatus">
            <Badge tone="neutral">尚未開放</Badge>
          </span>
        </div>
      </Panel>

      <ErrorNote error={list.error} />
      {list.isPending ? <Empty>載入中…</Empty> : null}

      {configured.length > 0 ? (
        <>
          <div className="sec-label">已連接</div>
          <Panel title="你的 key" hint="org 層 BYOK；per-user 切分由你的應用自己管">
            {configured.map((p) => {
              const keys = keysFor(p.id);
              const open = expanded === p.id;
              return (
                <div key={p.id} className="prow-group">
                  <button
                    type="button"
                    className="prow"
                    onClick={() => setExpanded(open ? null : p.id)}
                  >
                    <ProviderLogo p={p} />
                    <span>
                      <span className="pname">{p.name}</span>
                      <span className="pdesc" style={{ display: "block" }}>
                        {p.desc}
                      </span>
                    </span>
                    <span className="pstatus">
                      {keys.length} key{keys.length > 1 ? "s" : ""}
                      <span className="chev-r">{open ? "▾" : "›"}</span>
                    </span>
                  </button>
                  {open ? (
                    <div className="prow-detail">
                      {keys.map((k) => (
                        <div key={k.id} className="keyline">
                          <Badge tone="neutral">org 預設</Badge>
                          <span className="mono dim">••••{k.last4}</span>
                          {k.base_url ? <span className="tag mono">{k.base_url}</span> : null}
                          <span className="spacer" />
                          <button
                            type="button"
                            className="btn danger ghost"
                            disabled={remove.isPending}
                            onClick={() => remove.mutate(k.id)}
                          >
                            移除
                          </button>
                        </div>
                      ))}
                      <div>
                        <button type="button" className="btn" onClick={() => setAdding(p.id)}>
                          + 加一把 {p.name} key
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </Panel>
        </>
      ) : null}

      <div className="sec-label">Available</div>
      <Panel title="尚未連接" hint="點一列開始設定">
        {available.length === 0 ? <Empty>三家都接上了。</Empty> : null}
        {available.map((p) => (
          <div key={p.id} className="prow-group">
            <button type="button" className="prow" onClick={() => setAdding(p.id)}>
              <ProviderLogo p={p} />
              <span>
                <span className="pname">{p.name}</span>
                <span className="pdesc" style={{ display: "block" }}>
                  {p.desc}
                </span>
              </span>
              <span className="pstatus">
                Not configured
                <span className="chev-r">›</span>
              </span>
            </button>
          </div>
        ))}
      </Panel>

      {adding ? (
        <AddKeyModal
          provider={adding}
          onClose={() => setAdding(null)}
          onSaved={() => {
            setAdding(null);
            setExpanded(adding);
          }}
        />
      ) : null}
    </>
  );
}

function ProviderLogo({ p }: { p: (typeof PROVIDERS)[number] }) {
  return (
    <span className="plogo" aria-hidden="true">
      <img src={p.logo} alt="" className={p.invert ? "invert" : undefined} />
    </span>
  );
}

function AddKeyModal({
  provider,
  onClose,
  onSaved,
}: {
  provider: ModelProvider;
  onClose: () => void;
  onSaved: () => void;
}) {
  const qc = useQueryClient();
  const meta = PROVIDERS.find((p) => p.id === provider);
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const valid = apiKey.trim().length >= 8;
  const body = {
    provider,
    api_key: apiKey.trim(),
    scope: "org" as const,
    ...(baseUrl.trim() ? { base_url: baseUrl.trim() } : {}),
  };

  const save = useMutation({
    mutationFn: (payload: Parameters<typeof nimplex.providerKeys.put>[0]) =>
      nimplex.providerKeys.put(payload),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.providerKeys });
      onSaved();
    },
  });

  return (
    <div className="modal-backdrop">
      <div className="modal" role="dialog" aria-modal="true" aria-label={`連接 ${meta?.name}`}>
        <header className="modal-head">
          <div>
            <h2>連接 {meta?.name}</h2>
            <p>明文只在這一次請求裡出現，之後只讀得到後四碼。</p>
          </div>
          <button type="button" className="modal-x" onClick={onClose} aria-label="關閉">
            ✕
          </button>
        </header>
        <div className="modal-body">
          <Field htmlFor="ak-key" label="API key">
            <input
              id="ak-key"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-…"
            />
          </Field>
          <Field
            htmlFor="ak-base"
            label="Base URL（選填）"
            hint="自架 proxy 或相容端點；留空就打官方"
          >
            <input
              id="ak-base"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://…"
            />
          </Field>
          <ErrorNote error={save.error} />
        </div>
        <footer className="modal-foot">
          <CopyCall
            snippet={`await nimplex.providerKeys.put(${JSON.stringify({ ...body, api_key: "sk-…" }, null, 2)})`}
          />
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={!valid || save.isPending}
            onClick={() => save.mutate(body)}
          >
            {save.isPending ? "儲存中…" : "連接"}
          </button>
        </footer>
      </div>
    </div>
  );
}
