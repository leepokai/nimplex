import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { nimplex } from "../client.ts";
import { Badge, Code, CopyCall, Empty, ErrorNote, Panel } from "../ui.tsx";

/**
 * Org API keys：程式化身分（一把 key 打得動全部 API）。
 * 明文只在建立當下顯示一次，hash 落地、之後只看得到 last4；撤銷立即生效。
 * 未來的花費控制掛點是 per-key limit（OpenRouter 模式：想 per-user 管控就發 per-user 的 key）。
 */
export function ApiKeysPage() {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [revealed, setRevealed] = useState<string | null>(null);

  const keys = useQuery({ queryKey: ["api-keys"], queryFn: () => nimplex.apiKeys.list() });

  const create = useMutation({
    mutationFn: (keyName: string) => nimplex.apiKeys.create(keyName),
    onSuccess: (res) => {
      setRevealed(res.key);
      setName("");
      void qc.invalidateQueries({ queryKey: ["api-keys"] });
    },
  });

  const revoke = useMutation({
    mutationFn: (id: string) => nimplex.apiKeys.revoke(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["api-keys"] }),
  });

  const active = keys.data?.filter((k) => !k.revoked_at) ?? [];
  const revoked = keys.data?.filter((k) => k.revoked_at) ?? [];

  return (
    <>
      <h1>API keys</h1>
      <p className="lede">
        一把 key 統一操作面：開 run、選 harness、查帳、砍 run 都是它。
        明文只出現一次，之後只看得到後四碼。未來的 per-key 花費上限就掛在這裡 ——想 per-user
        管控，就發 per-user 的 key。
      </p>

      <Panel
        title="你的 key"
        hint="Authorization: Bearer nmx_live_…；SDK 讀 NIMPLEX_API_KEY"
        actions={
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              const trimmed = name.trim();
              if (trimmed && !create.isPending) create.mutate(trimmed);
            }}
          >
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="key 名稱，如 production"
              aria-label="新 key 名稱"
            />
            <button type="submit" className="btn" disabled={!name.trim() || create.isPending}>
              {create.isPending ? "建立中…" : "＋ 建立 key"}
            </button>
          </form>
        }
      >
        <ErrorNote error={create.error ?? revoke.error ?? keys.error} />

        {revealed ? (
          <div className="oknote">
            <p>
              <strong>只顯示這一次</strong>——存好再關掉。
            </p>
            <Code>{revealed}</Code>
            <button type="button" className="btn ghost" onClick={() => setRevealed(null)}>
              我存好了
            </button>
          </div>
        ) : null}

        {active.map((k) => (
          <div key={k.id} className="keyline">
            <span className="strong">{k.name}</span>
            <span className="mono dim">nmx_live_••••{k.last4}</span>
            <span className="dim">建立 {k.created_at.slice(0, 10)}</span>
            <span className="dim">
              {k.last_used_at ? `最後使用 ${k.last_used_at.slice(0, 10)}` : "未使用"}
            </span>
            <span className="spacer" />
            <span className="tag mono">limit：未設（之後開放）</span>
            <button
              type="button"
              className="btn danger ghost"
              disabled={revoke.isPending}
              onClick={() => revoke.mutate(k.id)}
            >
              撤銷
            </button>
          </div>
        ))}
        {keys.isSuccess && active.length === 0 ? (
          <Empty>還沒有 key。建立一把之後拿去 SDK 用。</Empty>
        ) : null}

        {revoked.map((k) => (
          <div key={k.id} className="keyline">
            <span className="dim">{k.name}</span>
            <span className="mono dim">nmx_live_••••{k.last4}</span>
            <Badge tone="danger">已撤銷 {k.revoked_at?.slice(0, 10)}</Badge>
            <span className="spacer" />
          </div>
        ))}

        <CopyCall
          snippet={`const nimplex = new Nimplex({ apiKey: process.env.NIMPLEX_API_KEY });`}
          label="複製 SDK 初始化"
        />
      </Panel>
    </>
  );
}
