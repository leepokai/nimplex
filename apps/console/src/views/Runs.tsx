import type { RunEvent, RunResponse } from "@nimplex/sdk";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { nimplex, queryKeys } from "../client.ts";
import { Badge, CopyCall, Empty, ErrorNote, Panel } from "../ui.tsx";

const TONE: Record<string, "ok" | "warn" | "danger" | "neutral" | "info"> = {
  queued: "neutral",
  running: "info",
  awaiting_input: "warn",
  completed: "ok",
  failed: "danger",
  killed: "danger",
  canceled: "neutral",
};

const ACTIVE = new Set(["queued", "running", "awaiting_input"]);

export function RunsPage() {
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState<string | null>(null);

  const list = useQuery({
    queryKey: queryKeys.runs,
    queryFn: () => nimplex.runs.list({ limit: 50 }),
    // 有 run 在跑就跟緊一點；全部終態就放慢
    refetchInterval: (q) => (q.state.data?.some((r) => ACTIVE.has(r.status)) ? 2000 : 15000),
  });

  const kill = useMutation({
    mutationFn: (id: string) => nimplex.runs.kill(id, "console"),
    onSuccess: () => void qc.invalidateQueries({ queryKey: queryKeys.runs }),
  });
  const cancel = useMutation({
    mutationFn: (id: string) => nimplex.runs.cancel(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: queryKeys.runs }),
  });

  const rows = list.data ?? [];

  return (
    <>
      <h1>Runs</h1>
      <p className="lede">
        每一次執行：哪個 harness、哪個 sandbox、燒了多少錢。跑到一半也砍得掉—— 軟殺（閘道拒發下一個
        call）加硬殺（銷毀沙箱）。
      </p>

      <Panel
        title="最近的 run"
        actions={
          <CopyCall snippet="await nimplex.runs.list({ limit: 50 })" label="複製 list 呼叫" />
        }
      >
        <ErrorNote error={list.error} />
        {list.isPending ? <Empty>載入中…</Empty> : null}
        {!list.isPending && rows.length === 0 ? (
          <Empty>
            還沒有任何 run。用 SDK 開一個（<code>nimplex.agent(…).generate(…)</code>），或跑{" "}
            <code>examples/quickstart</code> 的冒煙測試。
          </Empty>
        ) : null}

        {rows.map((run) => (
          <div key={run.id} className="row-group">
            <button
              type="button"
              className="row-main"
              onClick={() => setExpanded(expanded === run.id ? null : run.id)}
            >
              <Badge tone={TONE[run.status] ?? "neutral"}>{run.status}</Badge>
              <span className="mono dim">{run.id.slice(0, 8)}</span>
              <span className="strong">{run.harness}</span>
              <span className="dim">
                {run.model.provider}/{run.model.id} · {run.sandbox.provider}
              </span>
              <span className="spacer" />
              <span className="mono">
                ${run.spent_usd.toFixed(4)}
                {run.budget_usd !== null ? <span className="dim"> / ${run.budget_usd}</span> : null}
              </span>
              <span className="dim">{new Date(run.created_at).toLocaleTimeString()}</span>
            </button>
            {expanded === run.id ? (
              <div className="row-detail">
                <RunDetail
                  run={run}
                  onKill={() => kill.mutate(run.id)}
                  onCancel={() => cancel.mutate(run.id)}
                  busy={kill.isPending || cancel.isPending}
                />
              </div>
            ) : null}
          </div>
        ))}
      </Panel>
    </>
  );
}

function RunDetail({
  run,
  onKill,
  onCancel,
  busy,
}: {
  run: RunResponse;
  onKill: () => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const events = useRunEvents(run.id);
  const active = ACTIVE.has(run.status);

  return (
    <div className="rundetail">
      <div className="rundetail-bar">
        {run.external_user_id ? <span className="tag mono">{run.external_user_id}</span> : null}
        <span className="tag mono">metering: {run.metering}</span>
        {run.error ? <span className="tag mono err">{run.error}</span> : null}
        <span className="spacer" />
        {active ? (
          <>
            <button type="button" className="btn" disabled={busy} onClick={onCancel}>
              Cancel（優雅收尾）
            </button>
            <button type="button" className="btn danger" disabled={busy} onClick={onKill}>
              Kill（銷毀沙箱）
            </button>
            <CopyCall snippet={`await nimplex.runs.kill("${run.id}")`} label="複製 kill 呼叫" />
          </>
        ) : (
          <CopyCall snippet={`await nimplex.runs.get("${run.id}")`} label="複製 get 呼叫" />
        )}
      </div>
      <div className="eventlog mono">
        {events.length === 0 ? <div className="dim">（尚無事件）</div> : null}
        {events.map((e) => (
          <div key={e.seq} className="eventline">
            <span className="dim">[{e.seq}]</span> <span className="strong">{e.type}</span>{" "}
            <span className="dim">
              {e.payload === undefined ? "" : JSON.stringify(e.payload).slice(0, 160)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** 可續傳事件流：SSE + Last-Event-ID。斷線由 SDK 內部帶 after 接回。 */
function useRunEvents(runId: string) {
  const [events, setEvents] = useState<RunEvent[]>([]);
  const seen = useRef(new Set<number>());

  useEffect(() => {
    setEvents([]);
    seen.current = new Set();
    const abort = new AbortController();
    void (async () => {
      try {
        for await (const ev of nimplex.runs.events(runId, { signal: abort.signal })) {
          if (seen.current.has(ev.seq)) continue;
          seen.current.add(ev.seq);
          setEvents((prev) => [...prev, ev].slice(-200));
        }
      } catch {
        // abort 或連線收尾都到這裡；列表 polling 會呈現最終狀態
      }
    })();
    return () => abort.abort();
  }, [runId]);

  return events;
}
