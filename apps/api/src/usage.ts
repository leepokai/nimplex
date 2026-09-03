import type { UsageGroupBy, UsageQuery, UsageResponse } from "@nimplex/contracts";
import { type Db, endUsers, runs, usageRecords } from "@nimplex/db";
import { and, eq, gte, lt, type SQL, sql } from "drizzle-orm";
import { PG_INVALID_PARAMETER_VALUE, pgErrorCode } from "./pg-errors.ts";

const DAY_MS = 86_400_000;
const DEFAULT_WINDOW_DAYS = 30;
/** 一次最多看這麼多天：再長就該走報表匯出，不是即時 rollup */
export const MAX_WINDOW_DAYS = 400;

export class UsageQueryError extends Error {
  constructor(
    readonly code: "window_too_large" | "invalid_timezone",
    message: string,
  ) {
    super(message);
  }
}

/**
 * 帳務 rollup：把 usage_records 在窗口內的紀錄按一個維度分桶加總。
 * 每一句都帶 org_id；harness / model 從 run 帶出來，external_user_id 從 end_users 帶出來。
 */
export async function rollupUsage(
  db: Db,
  orgId: string,
  query: UsageQuery,
  now = new Date(),
): Promise<UsageResponse> {
  const to = query.to ? new Date(query.to) : now;
  const from = query.from
    ? new Date(query.from)
    : new Date(to.getTime() - DEFAULT_WINDOW_DAYS * DAY_MS);
  if (to.getTime() - from.getTime() > MAX_WINDOW_DAYS * DAY_MS) {
    throw new UsageQueryError("window_too_large", `窗口最多 ${MAX_WINDOW_DAYS} 天`);
  }

  const inWindow = and(
    eq(usageRecords.orgId, orgId),
    gte(usageRecords.createdAt, from),
    lt(usageRecords.createdAt, to),
  );
  const distinctRuns = sql<number>`count(distinct ${usageRecords.runId})::int`;

  try {
    // 時區只在 day 分桶用到；窗口裡沒資料時 to_char 不會被評估，所以先獨立驗一次，行為才穩定
    if (query.group_by === "day") {
      await db.execute(sql`select now() at time zone ${query.tz}::text`);
    }

    // GROUP BY / ORDER BY 用位置：day 的 key 表達式帶了 tz 參數，重複寫一次會變成不同的 $n 而對不上。
    // 只在分桶維度需要時才 join：day 只看 usage_records 自己。
    let bucketQuery = db
      .select({
        key: keyExpression(query.group_by, query.tz),
        usd: sql<number>`sum(${usageRecords.amountUsd})::float8`,
        runs: distinctRuns,
      })
      .from(usageRecords)
      .$dynamic();
    if (query.group_by === "harness" || query.group_by === "model") {
      bucketQuery = bucketQuery.leftJoin(runs, eq(usageRecords.runId, runs.id));
    }
    if (query.group_by === "external_user_id") {
      bucketQuery = bucketQuery.innerJoin(endUsers, eq(usageRecords.endUserId, endUsers.id));
    }
    const [buckets, [total]] = await Promise.all([
      bucketQuery
        .where(inWindow)
        .groupBy(sql`1`)
        .orderBy(query.group_by === "day" ? sql`1 asc` : sql`2 desc, 1 asc`),
      db
        .select({
          usd: sql<number>`coalesce(sum(${usageRecords.amountUsd}), 0)::float8`,
          runs: distinctRuns,
        })
        .from(usageRecords)
        .where(inWindow),
    ]);

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      tz: query.tz,
      group_by: query.group_by,
      total_usd: total?.usd ?? 0,
      runs: total?.runs ?? 0,
      buckets: buckets.map((b) => ({ key: b.key, usd: b.usd, runs: b.runs })),
    };
  } catch (err) {
    // invalid_parameter_value：Postgres 不認得這個時區名稱
    if (pgErrorCode(err) === PG_INVALID_PARAMETER_VALUE) {
      throw new UsageQueryError("invalid_timezone", `不認得的時區：${query.tz}`);
    }
    throw err;
  }
}

function keyExpression(groupBy: UsageGroupBy, tz: string): SQL<string> {
  switch (groupBy) {
    case "day":
      return sql<string>`to_char(${usageRecords.createdAt} at time zone ${tz}::text, 'YYYY-MM-DD')`;
    case "harness":
      return sql<string>`coalesce(${runs.harness}, '(deleted run)')`;
    case "external_user_id":
      return sql<string>`${endUsers.externalId}`;
    case "model":
      return sql<string>`coalesce(${runs.modelProvider} || '/' || ${runs.model}, '(deleted run)')`;
  }
}
