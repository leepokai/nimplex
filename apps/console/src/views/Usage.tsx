import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { nimplex, queryKeys } from "../client.ts";
import { CopyCall, Empty, ErrorNote, Panel } from "../ui.tsx";
import {
  addDays,
  browserTimeZone,
  dayKey,
  fillDays,
  startOfDay,
  startOfMonth,
} from "../usage-window.ts";

const DAYS = 7;
// 帳務不是即時儀表：30 秒一輪就夠，分頁不在前景時 TanStack 會自動暫停
const REFRESH_MS = 30_000;

/**
 * 帳務 rollup：資料來自 GET /v1/usage（usage_records 逐筆記帳的分桶加總）。
 * 今日／本月／近 7 天的邊界用瀏覽器時區算，同一個 tz 交給 API 做 day 分桶。
 */
export function UsagePage() {
  // 邊界以進頁面那一刻為準：query key 只到日期粒度，同一天內不會一直換 key 重抓
  const window = useMemo(() => {
    const now = new Date();
    const today = startOfDay(now);
    return {
      tz: browserTimeZone(),
      today,
      todayKey: dayKey(now),
      weekFrom: addDays(today, 1 - DAYS).toISOString(),
      monthFrom: startOfMonth(now).toISOString(),
    };
  }, []);

  const days = useQuery({
    queryKey: queryKeys.usage("day", window.weekFrom, window.tz),
    queryFn: () => nimplex.usage.summary({ from: window.weekFrom, groupBy: "day", tz: window.tz }),
    refetchInterval: REFRESH_MS,
  });
  const byHarness = useQuery({
    queryKey: queryKeys.usage("harness", window.monthFrom, window.tz),
    queryFn: () => nimplex.usage.summary({ from: window.monthFrom, groupBy: "harness" }),
    refetchInterval: REFRESH_MS,
  });
  const byUser = useQuery({
    queryKey: queryKeys.usage("external_user_id", window.monthFrom, window.tz),
    queryFn: () => nimplex.usage.summary({ from: window.monthFrom, groupBy: "external_user_id" }),
    refetchInterval: REFRESH_MS,
  });

  const today = days.data?.buckets.find((b) => b.key === window.todayKey)?.usd ?? 0;
  const month = byHarness.data?.total_usd ?? 0;
  const monthRuns = byHarness.data?.runs ?? 0;
  const bars = fillDays(days.data?.buckets ?? [], window.today, DAYS);
  const maxBar = Math.max(0, ...bars.map((b) => b.usd));
  const harnessBuckets = byHarness.data?.buckets ?? [];
  const maxHarness = Math.max(0, ...harnessBuckets.map((b) => b.usd));
  const userBuckets = byUser.data?.buckets ?? [];

  const pending = days.isPending || byHarness.isPending || byUser.isPending;
  const error = days.error ?? byHarness.error ?? byUser.error;

  return (
    <>
      <h1>Usage</h1>
      <p className="lede">
        錢燒去哪了。每一筆花費在 <code>usage_records</code> 都掛著 run、model 與{" "}
        <code>external_user_id</code> 歸因標籤——你要 per-user 對帳，就在建 run 時帶標籤， 這裡直接
        rollup 給你。時區：<span className="mono">{window.tz}</span>。
      </p>

      <ErrorNote error={error} />

      <div className="statgrid">
        <div className="stat">
          <span className="stat-label">今日</span>
          <span className="stat-num mono">{pending ? "…" : usd(today)}</span>
        </div>
        <div className="stat">
          <span className="stat-label">本月</span>
          <span className="stat-num mono">{pending ? "…" : usd(month)}</span>
        </div>
        <div className="stat">
          <span className="stat-label">本月 runs</span>
          <span className="stat-num mono">{pending ? "…" : monthRuns}</span>
        </div>
      </div>

      <Panel
        title={`近 ${DAYS} 天`}
        hint="每一根都對得回 usage_records 的逐筆記帳"
        actions={
          <CopyCall
            snippet={`await nimplex.usage.summary({ from: "${window.weekFrom}", groupBy: "day", tz: "${window.tz}" })`}
            label="複製 summary 呼叫"
          />
        }
      >
        <div className="daybars">
          {bars.map((d) => (
            <div key={d.key} className="daybar" title={`${d.key} · ${d.runs} runs`}>
              <span className="daybar-amt mono">{usd(d.usd)}</span>
              <span
                className="daybar-fill"
                style={{ height: `${maxBar > 0 ? Math.max(4, (d.usd / maxBar) * 90) : 4}px` }}
              />
              <span className="daybar-label mono">{d.key.slice(5)}</span>
            </div>
          ))}
        </div>
        {!pending && maxBar === 0 ? <Empty>近 {DAYS} 天還沒有花費紀錄。</Empty> : null}
      </Panel>

      <Panel title="本月 · 按 harness" hint="錶與 harness 無關——換 harness，錶照轉">
        <div className="estlist">
          {harnessBuckets.map((h) => (
            <div key={h.key} className="estrow">
              <span className="mono strong">{h.key}</span>
              <span className="dim">{h.runs} runs</span>
              <span className="spacer" />
              <span className="mono">{usd(h.usd)}</span>
              <span
                className="estbar"
                style={{ width: `${maxHarness > 0 ? (h.usd / maxHarness) * 120 : 0}px` }}
              />
            </div>
          ))}
        </div>
        {!pending && harnessBuckets.length === 0 ? (
          <Empty>這個月還沒有任何 run 花過錢；跑一次就會出現在這裡。</Empty>
        ) : null}
      </Panel>

      <Panel
        title="本月 · 按 external_user_id 標籤"
        hint="標籤由你在建 run 時帶進來；不帶就進 default 桶"
        actions={
          <CopyCall
            snippet={`await nimplex.usage.summary({ from: "${window.monthFrom}", groupBy: "external_user_id" })`}
            label="複製 summary 呼叫"
          />
        }
      >
        <div className="estlist">
          {userBuckets.map((l) => (
            <div key={l.key} className="estrow">
              <span className="tag mono">{l.key}</span>
              <span className="dim">{l.runs} runs</span>
              <span className="spacer" />
              <span className="mono strong">{usd(l.usd)}</span>
            </div>
          ))}
        </div>
        {!pending && userBuckets.length === 0 ? <Empty>這個月還沒有花費紀錄。</Empty> : null}
      </Panel>
    </>
  );
}

function usd(n: number): string {
  return `$${n.toFixed(n >= 100 ? 0 : 2)}`;
}
