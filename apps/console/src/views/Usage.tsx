import { Badge, Empty, Panel } from "../ui.tsx";

/**
 * 帳務 rollup（目前為示意資料）。
 * 真資料來源已存在：usage_events 每筆花費都記了 run／provider／external_user_id，
 * 缺的只是 rollup endpoint（GET /v1/usage?group_by=…），接上後這頁換真。
 */
const MOCK = {
  today: 3.42,
  month: 61.87,
  byHarness: [
    { key: "claude-code", usd: 41.2 },
    { key: "builtin", usd: 12.35 },
    { key: "hello-harness", usd: 8.32 },
  ],
  byLabel: [
    { key: "team-alpha", usd: 24.8, runs: 61 },
    { key: "default", usd: 20.1, runs: 118 },
    { key: "team-beta", usd: 12.4, runs: 33 },
    { key: "ci-bot", usd: 4.57, runs: 210 },
  ],
  last7d: [
    { day: "08-26", usd: 6.1 },
    { day: "08-27", usd: 9.8 },
    { day: "08-28", usd: 4.2 },
    { day: "08-29", usd: 12.6 },
    { day: "08-30", usd: 8.9 },
    { day: "08-31", usd: 11.3 },
    { day: "09-01", usd: 3.42 },
  ],
};

export function UsagePage() {
  const maxH = Math.max(...MOCK.byHarness.map((h) => h.usd));
  return (
    <>
      <h1>
        Usage <Badge tone="warn">示意資料</Badge>
      </h1>
      <p className="lede">
        錢燒去哪了。每一筆花費在 <code>usage_events</code> 都掛著 run、provider 與{" "}
        <code>external_user_id</code> 歸因標籤——你要 per-user 對帳，就在建 run 時帶標籤， 這裡直接
        rollup 給你。
      </p>

      <div className="statgrid">
        <div className="stat">
          <span className="stat-label">今日</span>
          <span className="stat-num mono">${MOCK.today.toFixed(2)}</span>
        </div>
        <div className="stat">
          <span className="stat-label">本月</span>
          <span className="stat-num mono">${MOCK.month.toFixed(2)}</span>
        </div>
        <div className="stat">
          <span className="stat-label">計量模式</span>
          <span className="stat-num mono">exact</span>
        </div>
      </div>

      <Panel title="近 7 天" hint="每一根都對得回 usage_events 的逐筆記帳">
        <div className="daybars">
          {MOCK.last7d.map((d) => {
            const max = Math.max(...MOCK.last7d.map((x) => x.usd));
            return (
              <div key={d.day} className="daybar">
                <span className="daybar-amt mono">${d.usd.toFixed(0)}</span>
                <span
                  className="daybar-fill"
                  style={{ height: `${Math.max(8, (d.usd / max) * 90)}px` }}
                />
                <span className="daybar-label mono">{d.day.slice(3)}</span>
              </div>
            );
          })}
        </div>
      </Panel>

      <Panel title="按 harness" hint="錶與 harness 無關——換 harness，錶照轉">
        <div className="estlist">
          {MOCK.byHarness.map((h) => (
            <div key={h.key} className="estrow">
              <span className="mono strong">{h.key}</span>
              <span className="spacer" />
              <span className="mono">${h.usd.toFixed(2)}</span>
              <span className="estbar" style={{ width: `${(h.usd / maxH) * 120}px` }} />
            </div>
          ))}
        </div>
      </Panel>

      <Panel title="按 external_user_id 標籤" hint="標籤由你在建 run 時帶進來；不帶就進 default 桶">
        <div className="estlist">
          {MOCK.byLabel.map((l) => (
            <div key={l.key} className="estrow">
              <span className="tag mono">{l.key}</span>
              <span className="dim">{l.runs} runs</span>
              <span className="spacer" />
              <span className="mono strong">${l.usd.toFixed(2)}</span>
            </div>
          ))}
        </div>
        <Empty>
          rollup API（<code>GET /v1/usage</code>）尚未實作——這頁目前是形狀示意，資料層已就緒。
        </Empty>
      </Panel>
    </>
  );
}
