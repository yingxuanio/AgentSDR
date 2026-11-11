import "server-only";

import { resolveTimeZone } from "@/lib/timeZone";
import { sql, type SQL } from "drizzle-orm";
import {
  dayCount,
  MAX_ANALYTICS_RANGE_DAYS,
  previousRange,
  WEEKLY_BUCKET_AFTER_DAYS,
  type AnalyticsRange,
} from "./contract";

/**
 * Shared server helpers for the analytics queries. Every view file takes an
 * AnalyticsRange and builds its SQL from these, so "in range" and "which day"
 * mean the same thing everywhere.
 */

export class AnalyticsRangeError extends Error {}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export { resolveTimeZone };

/** Validates ?from&to&tz into a range; weekly buckets past WEEKLY_BUCKET_AFTER_DAYS. */
export function parseAnalyticsRange(params: URLSearchParams): AnalyticsRange {
  const from = params.get("from") ?? "";
  const to = params.get("to") ?? "";
  if (!DATE_RE.test(from) || !DATE_RE.test(to) || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) {
    throw new AnalyticsRangeError("from and to must be dates as YYYY-MM-DD");
  }
  if (from > to) throw new AnalyticsRangeError("from must not be after to");
  const days = dayCount(from, to);
  if (days > MAX_ANALYTICS_RANGE_DAYS) {
    throw new AnalyticsRangeError(`The range can be at most ${MAX_ANALYTICS_RANGE_DAYS} days`);
  }
  return { from, to, tz: resolveTimeZone(params.get("tz")), bucket: days > WEEKLY_BUCKET_AFTER_DAYS ? "week" : "day" };
}

/** `column` (a timestamptz) falls inside [from 00:00, to+1 00:00) in the range's zone. Parameterised. */
export function inRange(column: SQL | SQL.Aliased | unknown, range: Pick<AnalyticsRange, "from" | "to" | "tz">): SQL {
  return sql`(${column} >= (${range.from}::date)::timestamp AT TIME ZONE ${range.tz}
    AND ${column} < ((${range.to}::date + 1)::timestamp AT TIME ZONE ${range.tz}))`;
}

/** The same window for the equally long period just before the range. */
export function inPreviousRange(column: SQL | SQL.Aliased | unknown, range: Pick<AnalyticsRange, "from" | "to" | "tz">): SQL {
  return inRange(column, { ...previousRange(range), tz: range.tz });
}

/** Both periods at once, for queries that compute `value` and `previous` in one pass with FILTER. */
export function inCurrentOrPreviousRange(column: SQL | SQL.Aliased | unknown, range: Pick<AnalyticsRange, "from" | "to" | "tz">): SQL {
  return inRange(column, { from: previousRange(range).from, to: range.to, tz: range.tz });
}

/** YYYY-MM-DD of `column` in the range's zone — group by this, then toSeries() in JS. */
export function localDay(column: SQL | SQL.Aliased | unknown, range: Pick<AnalyticsRange, "tz">): SQL<string> {
  return sql<string>`to_char((${column} AT TIME ZONE ${range.tz})::date, 'YYYY-MM-DD')`;
}

/**
 * Runs query thunks with at most `limit` in flight. The app's pool is small
 * (DB_POOL_MAX, default 8, on a server shared with other deployments — see
 * CLAUDE.md), so a dashboard must not fan out one query per chart at once.
 */
export async function runLimited<T>(tasks: ReadonlyArray<() => Promise<T>>, limit = 3): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const index = next++;
      results[index] = await tasks[index]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

/** Runs one query when a slot is free. One limiter shared by several loaders caps them together. */
export type QueryLimiter = <T>(task: () => PromiseLike<T>) => Promise<T>;

/** A limiter with at most `limit` queries in flight; see runLimited for why. */
export function createLimiter(limit = 3): QueryLimiter {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async (task) => {
    // A finishing task hands its slot straight to the next waiter, so a new
    // caller can never slip in between and push `active` past the limit.
    if (active < limit) active += 1;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active -= 1;
    }
  };
}

/** Postgres count/sum values arrive as strings or bigints; this makes them numbers. */
export function num(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Excludes automated machine replies (RFC 3834 Auto-Submitted / X-Autoreply,
 * explicit Auto-Reply / Out of Office subjects, and messages classified by AI
 * into `out_of_office` or `left_company`) so Analytics `Replied` / `Reply Rate`
 * reflects genuine human responses while keeping auto-replies in CRM threads.
 */
export function isHumanInboundMessageSql(alias: SQL = sql.raw("m")): SQL {
  return sql`(
    coalesce((${alias}.raw->>'isAutoReply')::boolean, false) = false
    AND coalesce(${alias}.subject, '') !~* '^\\s*(auto[- ]?reply|automatic reply|out of office|autoreply|自动回复|自動回覆)([:：\\s\\-]|$)'
    AND NOT EXISTS (
      SELECT 1
      FROM crm_classifications cc_ar
      JOIN crm_subcategories sc_ar ON sc_ar.id = coalesce(cc_ar.applied_subcategory_id, cc_ar.proposed_subcategory_id)
      WHERE cc_ar.message_id = ${alias}.id
        AND cc_ar.status IN ('auto_applied', 'accepted', 'overridden', 'proposed')
        AND sc_ar.key IN ('out_of_office', 'left_company')
    )
  )`;
}
