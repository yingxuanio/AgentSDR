import "server-only";

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { currentOrganizationId } from "@/lib/tenancy/scope";
import {
  ANALYTICS_CHANNELS,
  MEETING_SUBCATEGORY_KEYS,
  ratio,
  type AnalyticsChannel,
  type AnalyticsRange,
  type Metric,
  type OverviewAnalytics,
} from "./contract";
import { getCrmSummary, runQueries, STAGE_CHANGE_EVENTS } from "./crm.server";
import { createLimiter, inCurrentOrPreviousRange, inRange, num } from "./server";

/**
 * The Overview: the CRM summary plus the outreach funnel and channel table.
 * Four statements here and seven in getCrmSummary, all through one limiter:
 * at most three in flight in total. Counts are per-period events (see
 * contract.ts), so the funnel is not a cohort.
 */

/** LinkedIn message types that are outbound touches (everything except RECEIVED). */
const LINKEDIN_OUTBOUND = sql`('INVITATION', 'ACCEPTANCE', 'FOLLOW_UP_1', 'FOLLOW_UP_2', 'FOLLOW_UP_3', 'CUSTOM_SENT')`;

/**
 * Every outbound touch in the current and previous period: (channel, person, ts).
 * WhatsApp messages skip history imported by backfill (same rule as
 * whatsapp.server.ts) and chats not linked to a person.
 */
function touches(range: AnalyticsRange) {
  const org = currentOrganizationId();
  return sql`
    SELECT 'email'::text AS ch, l.person_id, e.sent_at AS ts
    FROM outreach_emails e JOIN outreach_leads l ON l.id = e.lead_id
    WHERE e.status = 'sent' AND ${inCurrentOrPreviousRange(sql`e.sent_at`, range)}
      AND l.campaign_id IN (SELECT id FROM outreach_campaigns WHERE organization_id = ${org})
    UNION ALL
    SELECT 'linkedin', ld."personId", m."createdAt"
    FROM "Message" m JOIN "Lead" ld ON ld.id = m."leadId"
    WHERE m."organizationId" = ${org} AND ld."organizationId" = ${org} AND m.type IN ${LINKEDIN_OUTBOUND} AND m."duplicateOfMessageId" IS NULL
      AND ${inCurrentOrPreviousRange(sql`m."createdAt"`, range)}
    UNION ALL
    SELECT 'whatsapp', s.person_id, s.created_at
    FROM call_sessions s
    WHERE s.organization_id = ${org} AND ${inCurrentOrPreviousRange(sql`s.created_at`, range)}
    UNION ALL
    SELECT 'whatsapp', c.person_id, m.sent_at
    FROM whatsapp_messages m JOIN whatsapp_chats c ON c.id = m.chat_id
    WHERE m.direction = 'outbound' AND c.person_id IS NOT NULL
      AND c.account_id IN (SELECT id FROM whatsapp_accounts WHERE organization_id = ${org})
      AND NOT (m.raw IS NULL AND m.origin <> 'agentsdr' AND m.created_at - m.sent_at > interval '1 hour')
      AND ${inCurrentOrPreviousRange(sql`m.sent_at`, range)}
    UNION ALL
    SELECT m.channel::text, m.person_id, m.sent_at
    FROM crm_conversation_messages m
    JOIN crm_conversations cv ON cv.id = m.conversation_id
    WHERE cv.organization_id = ${org}
      AND m.direction = 'outbound'
      AND ${inCurrentOrPreviousRange(sql`m.sent_at`, range)}`;
}

type PeopleRow = { cur: boolean; ch: string | null; people: number };
type StageRow = { cur: boolean; ch: string | null; positive: number; meetings: number; customers: number };

const emptyByChannel = () => Object.fromEntries(ANALYTICS_CHANNELS.map((c) => [c, 0])) as Record<AnalyticsChannel, number>;

export async function getOverviewAnalytics(range: AnalyticsRange): Promise<OverviewAnalytics> {
  const org = currentOrganizationId();
  const meetingKeys = sql.join(MEETING_SUBCATEGORY_KEYS.map((key) => sql`${key}`), sql`, `);

  const limit = createLimiter(3);
  const [crm, [reachedRows, repliedRows, stageRows, attentionRows]] = await Promise.all([getCrmSummary(range, limit), runQueries(
    limit,
    [
      () =>
        // Distinct people reached: overall (ch null) and per channel.
        db.execute<PeopleRow>(sql`
          WITH t AS (${touches(range)})
          SELECT ${inRange(sql`t.ts`, range)} AS cur, t.ch, count(DISTINCT t.person_id)::int AS people
          FROM t GROUP BY GROUPING SETS ((1), (1, 2))`),
      () =>
        db.execute<PeopleRow>(sql`
          SELECT ${inRange(sql`m.sent_at`, range)} AS cur, m.channel AS ch, count(DISTINCT m.person_id)::int AS people
          FROM crm_conversation_messages m
          WHERE m.direction = 'inbound' AND ${inCurrentOrPreviousRange(sql`m.sent_at`, range)}
            AND m.conversation_id IN (SELECT id FROM crm_conversations WHERE organization_id = ${org})
          GROUP BY GROUPING SETS ((1), (1, 2))`),
      () =>
        // Judgement calls: "positive"/"customer" look at the category a record
        // was moved to (a move within Interested still counts, so meetings are
        // always a subset of positive); by channel, a record belongs to its
        // active_channel now.
        db.execute<StageRow>(sql`
          SELECT ${inRange(sql`e.created_at`, range)} AS cur, r.active_channel AS ch,
            count(DISTINCT e.crm_record_id) FILTER (WHERE e.to_data->>'categoryKey' IN ('interested', 'customer'))::int AS positive,
            count(DISTINCT e.crm_record_id) FILTER (WHERE s.key IN (${meetingKeys}))::int AS meetings,
            count(DISTINCT e.crm_record_id) FILTER (WHERE e.to_data->>'categoryKey' = 'customer')::int AS customers
          FROM crm_events e
          JOIN crm_records r ON r.id = e.crm_record_id AND r.organization_id = ${org}
          LEFT JOIN crm_subcategories s ON s.id = (e.to_data->>'subcategoryId')::uuid
          WHERE e.organization_id = ${org} AND e.event_type IN ${STAGE_CHANGE_EVENTS} AND ${inCurrentOrPreviousRange(sql`e.created_at`, range)}
          GROUP BY GROUPING SETS ((1), (1, 2))`),
      () =>
        // Account health; the CRM queues come from the CRM summary.
        db.execute<Record<string, number>>(sql`
          SELECT
            (SELECT count(*) FROM outreach_mailboxes WHERE organization_id = ${org} AND status = 'failed')::int AS mailboxes,
            (SELECT count(*) FROM "LinkedInAccount" WHERE "organizationId" = ${org} AND status = 'DISCONNECTED')::int AS linkedin,
            (SELECT count(*) FROM whatsapp_accounts WHERE organization_id = ${org} AND status <> 'connected')::int AS whatsapp`),
    ],
  )]);

  const isChannel = (ch: string | null): ch is AnalyticsChannel => ANALYTICS_CHANNELS.includes(ch as AnalyticsChannel);
  const people = (rows: PeopleRow[]) => {
    const all = { cur: 0, prev: 0 };
    const by = { cur: emptyByChannel(), prev: emptyByChannel() };
    for (const row of rows) {
      const side = row.cur ? "cur" : "prev";
      if (row.ch === null) all[side] = num(row.people);
      else if (isChannel(row.ch)) by[side][row.ch] = num(row.people);
    }
    return { all, by };
  };
  const reached = people([...reachedRows]);
  const replied = people([...repliedRows]);

  const stage = {
    all: { cur: { positive: 0, meetings: 0, customers: 0 }, prev: { positive: 0, meetings: 0, customers: 0 } },
    positiveByChannel: emptyByChannel(),
  };
  for (const row of stageRows) {
    if (row.ch === null) {
      stage.all[row.cur ? "cur" : "prev"] = { positive: num(row.positive), meetings: num(row.meetings), customers: num(row.customers) };
    } else if (row.cur && isChannel(row.ch)) {
      stage.positiveByChannel[row.ch] = num(row.positive);
    }
  }

  const metric = (value: number, previous: number): Metric => ({ value, previous });
  const kpis: OverviewAnalytics["kpis"] = {
    reached: metric(reached.all.cur, reached.all.prev),
    replied: metric(replied.all.cur, replied.all.prev),
    positive: metric(stage.all.cur.positive, stage.all.prev.positive),
    meetings: metric(stage.all.cur.meetings, stage.all.prev.meetings),
    customers: metric(stage.all.cur.customers, stage.all.prev.customers),
  };

  const a = attentionRows[0] ?? {};

  return {
    view: "overview",
    range,
    kpis,
    funnel: [
      { key: "reached", label: "Reached", value: kpis.reached.value },
      { key: "replied", label: "Replied", value: kpis.replied.value },
      { key: "positive", label: "Positive", value: kpis.positive.value },
      { key: "meeting", label: "Meeting", value: kpis.meetings.value },
      { key: "customer", label: "Customer", value: kpis.customers.value },
    ],
    channels: ANALYTICS_CHANNELS.map((channel) => ({
      channel,
      reached: reached.by.cur[channel],
      replied: replied.by.cur[channel],
      replyRate: ratio(replied.by.cur[channel], reached.by.cur[channel]),
      positive: stage.positiveByChannel[channel],
    })),
    attention: {
      actionRequired: crm.attention.actionRequired,
      overdue: crm.attention.overdue,
      draftsAwaitingReview: crm.drafts.awaitingReview,
      mailboxesFailing: num(a.mailboxes),
      linkedinDisconnected: num(a.linkedin),
      whatsappDisconnected: num(a.whatsapp),
    },
    crm,
  };
}
