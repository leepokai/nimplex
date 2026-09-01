import type { RunEvent, RunResponse } from "@nimplex/sdk";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { nimplex } from "../client.ts";
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

// 本機 DB 還沒有 run 時的示意資料：讓頁面形狀（含撞頂被砍的樣子）先看得見。
const MOCK_RUNS: RunResponse[] = [
  {
    id: "run_mock_a1b2c3d4",
    status: "running",
    external_user_id: "team-alpha",
    harness: "claude-code",
    model: { provider: "anthropic", id: "claude-sonnet-5" },
    sandbox: { provider: "e2b" },
    sandbox_ref: "sbx_9f21",
    metering: "exact",
    budget_usd: 1,
    spent_usd: 0.3182,
    error: null,
    created_at: new Date(Date.now() - 4 * 60_000).toISOString(),
    started_at: new Date(Date.now() - 3.6 * 60_000).toISOString(),
    completed_at: null,
  },
  {
    id: "run_mock_e5f6a7b8",
    status: "awaiting_input",
    external_user_id: "team-alpha",
    harness: "claude-code",
    model: { provider: "anthropic", id: "claude-sonnet-5" },
    sandbox: { provider: "docker" },
    sandbox_ref: "sbx_11d0",
    metering: "exact",
    budget_usd: 0.5,
    spent_usd: 0.1027,
    error: null,
    created_at: new Date(Date.now() - 11 * 60_000).toISOString(),
    started_at: new Date(Date.now() - 10.5 * 60_000).toISOString(),
    completed_at: null,
  },
  {
    id: "run_mock_c9d0e1f2",
    status: "killed",
    external_user_id: "ci-bot",
    harness: "codex",
    model: { provider: "openai", id: "gpt-5" },
    sandbox: { provider: "e2b" },
    sandbox_ref: null,
    metering: "exact",
    budget_usd: 0.05,
    spent_usd: 0.0523,
    error: "budget_exceeded",
    created_at: new Date(Date.now() - 42 * 60_000).toISOString(),
    started_at: new Date(Date.now() - 41 * 60_000).toISOString(),
    completed_at: new Date(Date.now() - 33 * 60_000).toISOString(),
  },
  {
    id: "run_mock_00112233",
    status: "completed",
    external_user_id: "default",
    harness: "builtin",
    model: { provider: "anthropic", id: "claude-haiku-4-5" },
    sandbox: { provider: "local" },
    sandbox_ref: null,
    metering: "exact",
    budget_usd: 0.2,
    spent_usd: 0.0341,
    error: null,
    created_at: new Date(Date.now() - 2 * 3600_000).toISOString(),
    started_at: new Date(Date.now() - 2 * 3600_000).toISOString(),
    completed_at: new Date(Date.now() - 1.9 * 3600_000).toISOString(),
  },
  {
    id: "run_mock_44556677",
    status: "failed",
    external_user_id: "team-beta",
    harness: "hello-harness",
    model: { provider: "openrouter", id: "anthropic/claude-sonnet-4.5" },
    sandbox: { provider: "docker" },
    sandbox_ref: null,
    metering: "exact",
    budget_usd: 0.1,
    spent_usd: 0.0009,
    error: "harness exited 1",
    created_at: new Date(Date.now() - 5 * 3600_000).toISOString(),
    started_at: new Date(Date.now() - 5 * 3600_000).toISOString(),
    completed_at: new Date(Date.now() - 4.9 * 3600_000).toISOString(),
  },
];

// 示意事件流：順便展示事件 union 的形狀（快照→增量→撞頂→砍）
const MOCK_EVENTS: Record<string, RunEvent[]> = {
  run_mock_a1b2c3d4: [
    {
      seq: 0,
      type: "run.created",
      payload: { harness: "claude-code", budget_usd: 1 },
      created_at: "",
    },
    {
      seq: 1,
      type: "run.snapshot",
      payload: { status: "running", spent_usd: 0.0 },
      created_at: "",
    },
    { seq: 2, type: "message.delta", payload: { text: "先讀一下 repo 結構…" }, created_at: "" },
    {
      seq: 3,
      type: "tool.call",
      payload: { name: "bash", input: "rg -n 'budget' src/" },
      created_at: "",
    },
    {
      seq: 4,
      type: "spend.updated",
      payload: { spent_usd: 0.1421, burn_per_min: 0.08 },
      created_at: "",
    },
    { seq: 5, type: "tool.result", payload: { name: "bash", exit: 0 }, created_at: "" },
    {
      seq: 6,
      type: "spend.updated",
      payload: { spent_usd: 0.3182, burn_per_min: 0.09 },
      created_at: "",
    },
  ],
  run_mock_e5f6a7b8: [
    { seq: 0, type: "run.created", payload: { harness: "claude-code" }, created_at: "" },
    {
      seq: 1,
      type: "tool.approval_requested",
      payload: { approvalId: "apr_01", tool: "bash", reason: "rm -rf node_modules" },
      created_at: "",
    },
  ],
  run_mock_c9d0e1f2: [
    {
      seq: 0,
      type: "run.created",
      payload: { harness: "codex", budget_usd: 0.05 },
      created_at: "",
    },
    { seq: 1, type: "spend.updated", payload: { spent_usd: 0.0489 }, created_at: "" },
    {
      seq: 2,
      type: "run.status",
      payload: { status: "killed", stop_reason: "budget_exceeded", overshoot_usd: 0.0023 },
      created_at: "",
    },
  ],
};

export function RunsPage() {
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ["runs"],
    queryFn: () => nimplex.runs.list({ limit: 50 }),
    // 有 run 在跑就跟緊一點；全部終態就放慢
    refetchInterval: (q) => (q.state.data?.some((r) => ACTIVE.has(r.status)) ? 2000 : 15000),
  });

  const kill = useMutation({
    mutationFn: (id: string) => nimplex.runs.kill(id, "console"),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["runs"] }),
  });
  const cancel = useMutation({
    mutationFn: (id: string) => nimplex.runs.cancel(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["runs"] }),
  });

  const showMock = !list.isPending && (list.data?.length ?? 0) === 0;
  const rows = showMock ? MOCK_RUNS : (list.data ?? []);

  return (
    <>
      <h1>Runs {showMock ? <Badge tone="warn">示意資料</Badge> : null}</h1>
      <p className="lede">
        每一次執行：哪個 harness、哪個 sandbox、燒了多少錢。跑到一半也砍得掉—— 軟殺（閘道拒發下一個
        call）加硬殺（銷毀沙箱）。
        {showMock ? (
          <>
            {" "}
            目前還沒有真的 run，先看示意；跑一次 <code>examples/quickstart</code> 就換真。
          </>
        ) : null}
      </p>

      <Panel
        title="最近的 run"
        actions={
          <CopyCall snippet="await nimplex.runs.list({ limit: 50 })" label="複製 list 呼叫" />
        }
      >
        <ErrorNote error={list.error} />
        {list.isPending ? <Empty>載入中…</Empty> : null}

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
                  mock={showMock}
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
  mock,
  onKill,
  onCancel,
  busy,
}: {
  run: RunResponse;
  mock: boolean;
  onKill: () => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const live = useRunEvents(run.id, !mock);
  const events = mock ? (MOCK_EVENTS[run.id] ?? []) : live;
  const active = ACTIVE.has(run.status);
  const disabled = busy || mock;

  return (
    <div className="rundetail">
      <div className="rundetail-bar">
        {run.external_user_id ? <span className="tag mono">{run.external_user_id}</span> : null}
        <span className="tag mono">metering: {run.metering}</span>
        {run.error ? <span className="tag mono err">{run.error}</span> : null}
        <span className="spacer" />
        {active ? (
          <>
            <button
              type="button"
              className="btn"
              disabled={disabled}
              title={mock ? "示意資料" : undefined}
              onClick={onCancel}
            >
              Cancel（優雅收尾）
            </button>
            <button
              type="button"
              className="btn danger"
              disabled={disabled}
              title={mock ? "示意資料" : undefined}
              onClick={onKill}
            >
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
function useRunEvents(runId: string, enabled: boolean) {
  const [events, setEvents] = useState<RunEvent[]>([]);
  const seen = useRef(new Set<number>());

  useEffect(() => {
    setEvents([]);
    seen.current = new Set();
    if (!enabled) return;
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
  }, [runId, enabled]);

  return events;
}
