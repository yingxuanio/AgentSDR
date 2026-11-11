import "server-only";

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { crmActionGroupSql } from "@/lib/crm/actionGroups.server";
import { currentOrganizationId } from "@/lib/tenancy/scope";
import { ratio, toSeries, type AnalyticsRange, type BreakdownRow, type CrmCategory, type CrmSummary } from "./contract";
import { inCurrentOrPreviousRange, inRange, isHumanInboundMessageSql, localDay, num, type QueryLimiter } from "./server";

/** Runs each query through `limit`, keeping each query's own row type. */
export function runQueries<const T extends readonly (() => PromiseLike<unknown>)[]>(
  limit: QueryLimiter,
  tasks: T,
): Promise<{ -readonly [K in keyof T]: Awaited<ReturnType<T[K]>> }> {
  return Promise.all(tasks.map((task) => limit(task))) as Promise<{ -readonly [K in keyof T]: Awaited<ReturnType<T[K]>> }>;
}

/**
 * The CRM half of the Overview: replies and classification, drafts, and the
 * pipeline snapshot. Seven statements, through the caller's limiter so they
 * share its cap with the overview's own queries.
 */

const CATEGORIES: readonly CrmCategory[] = ["customer", "interested", "not_interested", "other", "unclassified"];
const asCategory = (key: string | null): CrmCategory => (CATEGORIES.includes(key as CrmCategory) ? (key as CrmCategory) : "unclassified");

/** Events that move a record between stages (src/lib/crm/records.ts, operations.ts, stageMove.ts). */
export const STAGE_CHANGE_EVENTS = sql`('classification.changed', 'stage.moved', 'classification.auto_applied')`;

/**
 * Follow-ups waiting on a person — the Follow-ups due figure on Action required
 * (getCrmOverview), from the same grouping.
 */
export const OVERDUE_SQL = sql`(${crmActionGroupSql({ id: sql.raw("r.id"), workflowState: sql.raw("r.workflow_state"), nextActionAt: sql.raw("r.next_action_at") })} = 'follow_up')`;

const titleCase = (value: string) =>
  value.split("_").filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");

export async function getCrmSummary(range: AnalyticsRange, limit: QueryLimiter): Promise<CrmSummary> {
  const org = currentOrganizationId();
  const [inboundRows, medianRows, classRows, draftRows, pipelineRows, workflowRows, stageRows] = await runQueries(
    limit,
    [
      () =>
        // Judgement call: an inbound message's category is its latest usable
        // classification (applied, else proposed); failed/stale/rejected ones
        // are ignored, and no classification means "unclassified".
        db.execute<{ cur: boolean; day: string; category: string | null; n: number }>(sql`
          SELECT ${inRange(sql`m.sent_at`, range)} AS cur, ${localDay(sql`m.sent_at`, range)} AS day,
                 cl.category, count(*)::int AS n
          FROM crm_conversation_messages m
          LEFT JOIN LATERAL (
            SELECT coalesce(c.applied_category_key, c.proposed_category_key) AS category
            FROM crm_classifications c
            WHERE c.message_id = m.id AND c.status IN ('auto_applied', 'accepted', 'overridden', 'proposed')
            ORDER BY c.created_at DESC LIMIT 1
          ) cl ON true
          WHERE m.direction = 'inbound' AND ${inCurrentOrPreviousRange(sql`m.sent_at`, range)}
            AND m.conversation_id IN (SELECT id FROM crm_conversations WHERE organization_id = ${org})
            AND ${isHumanInboundMessageSql()}
          GROUP BY 1, 2, 3`),
      () =>
        // Each inbound message, to the next outbound in its conversation;
        // inbound with no later outbound is left out.
        db.execute<{ cur: boolean; median: number | null }>(sql`
          SELECT x.cur, percentile_cont(0.5) WITHIN GROUP (ORDER BY x.minutes) AS median
          FROM (
            SELECT ${inRange(sql`m.sent_at`, range)} AS cur,
                   extract(epoch FROM (nxt.sent_at - m.sent_at)) / 60.0 AS minutes
            FROM crm_conversation_messages m
            CROSS JOIN LATERAL (
              SELECT o.sent_at FROM crm_conversation_messages o
              WHERE o.conversation_id = m.conversation_id AND o.direction = 'outbound' AND o.sent_at > m.sent_at
              ORDER BY o.sent_at ASC LIMIT 1
            ) nxt
            WHERE m.direction = 'inbound' AND ${inCurrentOrPreviousRange(sql`m.sent_at`, range)}
              AND m.conversation_id IN (SELECT id FROM crm_conversations WHERE organization_id = ${org})
              AND ${isHumanInboundMessageSql()}
          ) x
          GROUP BY x.cur`),
      () =>
        db.execute<{ cur: boolean; classified: number; overridden: number; decided: number }>(sql`
          SELECT ${inRange(sql`c.created_at`, range)} AS cur,
                 count(*) FILTER (WHERE c.status NOT IN ('failed', 'stale'))::int AS classified,
                 count(*) FILTER (WHERE c.status = 'overridden')::int AS overridden,
                 count(*) FILTER (WHERE c.status IN ('accepted', 'overridden', 'auto_applied'))::int AS decided
          FROM crm_classifications c
          WHERE ${inCurrentOrPreviousRange(sql`c.created_at`, range)}
            AND c.crm_record_id IN (SELECT id FROM crm_records WHERE organization_id = ${org})
          GROUP BY 1`),
      () =>
        // Drafts: "generated" is crm_drafts rows created in range (manual
        // drafts included, regenerations not double counted). "Sent" is by
        // the message.sent event time, one per draft (fromData.draftId).
        // Sent as-is = the sent body equals the AI body (trimmed): a sent
        // draft always has edited_body_text set, so "null" can't be the test.
        db.execute<Record<string, number>>(sql`
          WITH sent AS (
            SELECT DISTINCT ON (e.from_data->>'draftId')
                   ${inRange(sql`e.created_at`, range)} AS cur,
                   (btrim(coalesce(d.edited_body_text, d.ai_body_text, '')) = btrim(coalesce(d.ai_body_text, ''))) AS as_is
            FROM crm_events e
            JOIN crm_drafts d ON d.id = (e.from_data->>'draftId')::uuid
            WHERE e.event_type = 'message.sent' AND ${inCurrentOrPreviousRange(sql`e.created_at`, range)}
              AND e.organization_id = ${org}
              AND d.crm_record_id IN (SELECT id FROM crm_records WHERE organization_id = ${org})
            ORDER BY e.from_data->>'draftId', e.created_at ASC
          )
          SELECT
            (SELECT count(*) FROM sent WHERE cur)::int AS sent_cur,
            (SELECT count(*) FROM sent WHERE NOT cur)::int AS sent_prev,
            (SELECT count(*) FROM sent WHERE cur AND as_is)::int AS as_is,
            (SELECT count(*) FROM sent WHERE cur AND NOT as_is)::int AS edited,
            (SELECT count(*) FROM crm_drafts d WHERE ${inRange(sql`d.created_at`, range)}
              AND d.crm_record_id IN (SELECT id FROM crm_records WHERE organization_id = ${org}))::int AS generated,
            (SELECT count(*) FROM crm_events e WHERE e.organization_id = ${org} AND e.event_type = 'draft.discarded' AND ${inRange(sql`e.created_at`, range)})::int AS discarded,
            (SELECT count(*) FROM crm_drafts d WHERE d.status = 'awaiting_review'
              AND d.crm_record_id IN (SELECT id FROM crm_records WHERE organization_id = ${org}))::int AS awaiting`),
      () =>
        // Open records by subcategory; a record with none is grouped by category.
        db.execute<{
          subcategory_id: string | null; name: string | null; category_key: string | null;
          category_label: string | null; stage_rank: number | null; n: number;
        }>(sql`
          SELECT r.subcategory_id, s.name, r.category_key, cat.label AS category_label, s.stage_rank, count(*)::int AS n
          FROM crm_records r
          LEFT JOIN crm_subcategories s ON s.id = r.subcategory_id
          LEFT JOIN crm_categories cat ON cat.key = r.category_key
          WHERE r.organization_id = ${org} AND r.workflow_state <> 'closed'
          GROUP BY 1, 2, 3, 4, 5
          ORDER BY s.stage_rank ASC NULLS LAST, n DESC`),
      () =>
        db.execute<{ state: string; n: number; overdue: number }>(sql`
          SELECT r.workflow_state AS state, count(*)::int AS n,
                 count(*) FILTER (WHERE ${OVERDUE_SQL})::int AS overdue
          FROM crm_records r
          WHERE r.organization_id = ${org}
          GROUP BY 1
          ORDER BY n DESC`),
      () =>
        // An entry is a stage-change event whose subcategory differs from the previous one.
        db.execute<{ subcategory_id: string; name: string; category_key: string; entered: number }>(sql`
          SELECT s.id AS subcategory_id, s.name, s.category_key, count(*)::int AS entered
          FROM crm_events e
          JOIN crm_subcategories s ON s.id = (e.to_data->>'subcategoryId')::uuid
          WHERE e.organization_id = ${org} AND e.event_type IN ${STAGE_CHANGE_EVENTS} AND ${inRange(sql`e.created_at`, range)}
            AND (e.from_data->>'subcategoryId') IS DISTINCT FROM (e.to_data->>'subcategoryId')
          GROUP BY 1, 2, 3
          ORDER BY entered DESC, s.name ASC`),
    ],
  );

  // ---- replies
  let repliesCur = 0, repliesPrev = 0;
  const categoryDays: Array<{ date: string } & Partial<Record<CrmCategory, number>>> = [];
  for (const row of inboundRows) {
    const n = num(row.n);
    if (!row.cur) {
      repliesPrev += n;
      continue;
    }
    repliesCur += n;
    categoryDays.push({ date: row.day, [asCategory(row.category)]: n });
  }

  const median = (cur: boolean) => {
    const row = medianRows.find((r) => r.cur === cur);
    return row?.median === null || row?.median === undefined ? null : num(row.median);
  };

  const cls = (cur: boolean) => classRows.find((r) => r.cur === cur);
  const overrideRate = (cur: boolean) => ratio(num(cls(cur)?.overridden), num(cls(cur)?.decided));

  const drafts = draftRows[0] ?? {};

  const pipeline = pipelineRows.map((row) => {
    const categoryKey = asCategory(row.category_key);
    const label = row.category_label ?? "Unclassified";
    return {
      subcategoryId: row.subcategory_id,
      name: row.name ?? `${label} (no subcategory)`,
      categoryKey,
      stageRank: row.stage_rank === null ? null : num(row.stage_rank),
      count: num(row.n),
    };
  });

  const workflow: BreakdownRow[] = workflowRows.map((row) => ({ key: row.state, label: titleCase(row.state), value: num(row.n) }));
  const actionRequired = num(workflowRows.find((r) => r.state === "action_required")?.n);
  const overdue = workflowRows.reduce((sum, r) => sum + num(r.overdue), 0);

  return {
    kpis: {
      replies: { value: repliesCur, previous: repliesPrev },
      classified: { value: num(cls(true)?.classified), previous: num(cls(false)?.classified) },
      draftsSent: { value: num(drafts.sent_cur), previous: num(drafts.sent_prev) },
      medianFirstResponseMinutes: { value: median(true), previous: median(false) },
      overrideRate: { value: overrideRate(true), previous: overrideRate(false) },
    },
    repliesByCategory: toSeries(CATEGORIES, range, categoryDays),
    pipeline,
    stageEntries: stageRows.map((row) => ({
      subcategoryId: row.subcategory_id,
      name: row.name,
      categoryKey: asCategory(row.category_key),
      entered: num(row.entered),
    })),
    drafts: {
      generated: num(drafts.generated),
      sentAsIs: num(drafts.as_is),
      sentEdited: num(drafts.edited),
      discarded: num(drafts.discarded),
      awaitingReview: num(drafts.awaiting),
    },
    workflow,
    attention: { actionRequired, overdue },
  };
}
