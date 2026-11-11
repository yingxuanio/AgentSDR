import "server-only";

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { currentOrganizationId } from "@/lib/tenancy/scope";
import {
  bucketFor,
  bucketStarts,
  ratio,
  toSeries,
  type AnalyticsRange,
  type EmailAnalytics,
} from "./contract";
import { inCurrentOrPreviousRange, inPreviousRange, inRange, isHumanInboundMessageSql, localDay, num, runLimited } from "./server";

const CAMPAIGN_ROW_CAP = 25;

type EmailRow = {
  d: string | null;
  total: boolean;
  sent: unknown;
  sent_prev: unknown;
  first_touch: unknown;
  follow_up: unknown;
  contacted: unknown;
  contacted_prev: unknown;
  failed: unknown;
};

type ReplyRow = { d: string | null; total: boolean; replies: unknown; replied: unknown; replied_prev: unknown };

type SuppressionRow = { bounced: unknown; bounced_prev: unknown; unsub: unknown; unsub_prev: unknown };

type CampaignRow = {
  id: string;
  name: string;
  status: string;
  leads: unknown;
  contacted: unknown;
  replied: unknown;
  bounced: unknown;
};

type CampaignSendRow = { campaign_id: string; d: string; sends: unknown };

type MailboxRow = {
  id: string;
  email_address: string;
  status: string;
  today_emails_sent: number;
  daily_send_limit: number;
};

/**
 * Email view. Six queries, at most three in flight (runLimited):
 *  1. outreach_emails: sent / contacted / failed for both periods plus a per-day split
 *     (GROUPING SETS: the `d IS NULL` row is the total, the others are days).
 *  2. crm_conversation_messages: inbound email replies from people enrolled in an email
 *     campaign — rows per day and distinct people for both periods.
 *  3. outreach_suppression_list: bounced / unsubscribed for both periods.
 *  4. campaigns with lead-status counts (all time).
 *  5. sends per campaign per day in the range (feeds sentInRange and the trend).
 *  6. mailboxes now.
 *
 * Indexes that would help at scale: outreach_emails (status, sent_at),
 * crm_conversation_messages (channel, direction, sent_at).
 */
export async function getEmailAnalytics(range: AnalyticsRange): Promise<EmailAnalytics> {
  const org = currentOrganizationId();
  /** Outreach leads of this organization, reached through their campaign. */
  const orgLeadIds = sql`(SELECT ol.id FROM outreach_leads ol JOIN outreach_campaigns oc ON oc.id = ol.campaign_id WHERE oc.organization_id = ${org})`;
  const sentDay = localDay(sql`e.sent_at`, range);
  const crmSentDay = localDay(sql`m.sent_at`, range);
  const msgDay = localDay(sql`m.sent_at`, range);
  const campaignDay = localDay(sql`e.sent_at`, range);
  const directCampaignId = "__direct_crm_email__";

  const results = await runLimited<unknown>(
    [
      () =>
        db.execute<EmailRow>(sql`
          SELECT d, GROUPING(d) = 1 AS total,
            count(*) FILTER (WHERE status = 'sent' AND ${inRange(sql`sent_at`, range)})::int AS sent,
            count(*) FILTER (WHERE status = 'sent' AND ${inPreviousRange(sql`sent_at`, range)})::int AS sent_prev,
            count(*) FILTER (WHERE status = 'sent' AND is_first AND ${inRange(sql`sent_at`, range)})::int AS first_touch,
            count(*) FILTER (WHERE status = 'sent' AND NOT is_first AND ${inRange(sql`sent_at`, range)})::int AS follow_up,
            count(DISTINCT contact_key) FILTER (WHERE status = 'sent' AND is_first AND ${inRange(sql`sent_at`, range)})::int AS contacted,
            count(DISTINCT contact_key) FILTER (WHERE status = 'sent' AND is_first AND ${inPreviousRange(sql`sent_at`, range)})::int AS contacted_prev,
            count(*) FILTER (WHERE status = 'failed' AND ${inRange(sql`created_at`, range)})::int AS failed
          FROM (
            SELECT
              e.status::text AS status,
              (e.step_number = 1) AS is_first,
              coalesce(l.person_id::text, 'lead:' || e.lead_id::text) AS contact_key,
              e.sent_at,
              e.created_at,
              CASE WHEN e.status = 'sent' THEN ${sentDay} END AS d
            FROM outreach_emails e
            JOIN outreach_leads l ON l.id = e.lead_id
            WHERE ((e.status = 'sent' AND ${inCurrentOrPreviousRange(sql`e.sent_at`, range)})
               OR (e.status = 'failed' AND ${inRange(sql`e.created_at`, range)})
            ) AND e.lead_id IN ${orgLeadIds}
            UNION ALL
            SELECT
              'sent'::text AS status,
              NOT EXISTS (
                SELECT 1
                FROM crm_conversation_messages prev
                JOIN crm_conversations pcv ON pcv.id = prev.conversation_id
                WHERE pcv.organization_id = ${org}
                  AND prev.person_id = m.person_id
                  AND prev.channel = 'email'
                  AND prev.direction = 'outbound'
                  AND (prev.sent_at < m.sent_at OR (prev.sent_at = m.sent_at AND prev.id < m.id))
              ) AS is_first,
              m.person_id::text AS contact_key,
              m.sent_at,
              m.created_at,
              ${crmSentDay} AS d
            FROM crm_conversation_messages m
            JOIN crm_conversations cv ON cv.id = m.conversation_id
            WHERE cv.organization_id = ${org}
              AND m.channel = 'email'
              AND m.direction = 'outbound'
              AND ${inCurrentOrPreviousRange(sql`m.sent_at`, range)}
              AND (
                m.provider_message_id IS NULL
                OR NOT EXISTS (
                  SELECT 1 FROM outreach_emails oe
                  WHERE oe.message_id = m.provider_message_id AND oe.status = 'sent'
                )
              )
            UNION ALL
            SELECT
              'failed'::text AS status,
              false AS is_first,
              r.person_id::text AS contact_key,
              NULL::timestamptz AS sent_at,
              sa.created_at,
              NULL::text AS d
            FROM crm_send_attempts sa
            JOIN crm_drafts d ON d.id = sa.draft_id
            JOIN crm_records r ON r.id = d.crm_record_id
            WHERE r.organization_id = ${org}
              AND d.channel = 'email'
              AND (sa.status IN ('failed', 'delivery_uncertain') OR (sa.status = 'reconciled' AND sa.provider_message_id IS NULL))
              AND ${inRange(sql`sa.created_at`, range)}
          ) t
          GROUP BY GROUPING SETS ((), (d))
        `),
      () =>
        db.execute<ReplyRow>(sql`
          SELECT d, GROUPING(d) = 1 AS total,
            count(*) FILTER (WHERE ${inRange(sql`sent_at`, range)})::int AS replies,
            count(DISTINCT person_id) FILTER (WHERE ${inRange(sql`sent_at`, range)})::int AS replied,
            count(DISTINCT person_id) FILTER (WHERE ${inPreviousRange(sql`sent_at`, range)})::int AS replied_prev
          FROM (
            SELECT m.person_id, m.sent_at, ${msgDay} AS d
            FROM crm_conversation_messages m
            WHERE m.direction = 'inbound' AND m.channel = 'email'
              AND ${inCurrentOrPreviousRange(sql`m.sent_at`, range)}
              AND m.conversation_id IN (SELECT id FROM crm_conversations WHERE organization_id = ${org})
              AND ${isHumanInboundMessageSql()}
          ) t
          GROUP BY GROUPING SETS ((), (d))
        `),
      () =>
        db.execute<SuppressionRow>(sql`
          WITH bounce_events AS (
            SELECT lower(email) AS addr, created_at
            FROM outreach_suppression_list
            WHERE organization_id = ${org} AND reason = 'bounced' AND ${inCurrentOrPreviousRange(sql`created_at`, range)}
            UNION ALL
            SELECT lower(coalesce(p.email, r.person_id::text)) AS addr, sa.created_at
            FROM crm_send_attempts sa
            JOIN crm_drafts d ON d.id = sa.draft_id
            JOIN crm_records r ON r.id = d.crm_record_id
            JOIN people p ON p.id = r.person_id
            WHERE r.organization_id = ${org}
              AND d.channel = 'email'
              AND (sa.status IN ('failed', 'delivery_uncertain') OR (sa.status = 'reconciled' AND sa.provider_message_id IS NULL))
              AND coalesce(sa.error, '') ~* '(55[0-9]|5\\.[0-9]\\.[0-9]|rejected|does not exist|doesn''t exist|bounced|user unknown)'
              AND ${inCurrentOrPreviousRange(sql`sa.created_at`, range)}
          )
          SELECT
            (SELECT count(DISTINCT addr) FROM bounce_events WHERE ${inRange(sql`created_at`, range)})::int AS bounced,
            (SELECT count(DISTINCT addr) FROM bounce_events WHERE ${inPreviousRange(sql`created_at`, range)})::int AS bounced_prev,
            count(*) FILTER (WHERE reason = 'unsubscribed' AND ${inRange(sql`created_at`, range)})::int AS unsub,
            count(*) FILTER (WHERE reason = 'unsubscribed' AND ${inPreviousRange(sql`created_at`, range)})::int AS unsub_prev
          FROM outreach_suppression_list
          WHERE organization_id = ${org} AND reason = 'unsubscribed' AND ${inCurrentOrPreviousRange(sql`created_at`, range)}
        `),
      () =>
        db.execute<CampaignRow>(sql`
          SELECT c.id::text AS id, c.name, c.status,
            count(l.id)::int AS leads,
            count(l.id) FILTER (WHERE l.sequence_status <> 'pending')::int AS contacted,
            count(l.id) FILTER (WHERE l.sequence_status = 'reply_received')::int AS replied,
            count(l.id) FILTER (WHERE l.sequence_status = 'bounced')::int AS bounced
          FROM outreach_campaigns c
          LEFT JOIN outreach_leads l ON l.campaign_id = c.id
          WHERE c.organization_id = ${org}
          GROUP BY c.id, c.name, c.status
          HAVING NOT (c.status = 'draft' AND count(l.id) = 0)
          UNION ALL
          SELECT
            ${directCampaignId}::text AS id,
            'Direct CRM outreach'::text AS name,
            'active'::text AS status,
            count(DISTINCT r.person_id)::int AS leads,
            count(DISTINCT r.person_id) FILTER (WHERE r.last_outbound_at IS NOT NULL)::int AS contacted,
            count(DISTINCT r.person_id) FILTER (
              WHERE EXISTS (
                SELECT 1
                FROM crm_conversation_messages m
                JOIN crm_conversations cv_r ON cv_r.id = m.conversation_id
                WHERE cv_r.crm_record_id = r.id
                  AND cv_r.organization_id = ${org}
                  AND m.channel = 'email'
                  AND m.direction = 'inbound'
                  AND ${isHumanInboundMessageSql()}
              )
            )::int AS replied,
            (
              SELECT count(DISTINCT r2.person_id)::int
              FROM crm_records r2
              JOIN people p2 ON p2.id = r2.person_id AND p2.organization_id = ${org}
              WHERE r2.organization_id = ${org}
                AND NOT EXISTS (
                  SELECT 1 FROM outreach_leads ol2
                  WHERE ol2.person_id = r2.person_id AND ol2.id IN ${orgLeadIds}
                )
                AND (
                  EXISTS (
                    SELECT 1 FROM outreach_suppression_list sl
                    WHERE sl.organization_id = ${org}
                      AND lower(sl.email) = lower(p2.email)
                      AND sl.reason = 'bounced'
                  )
                  OR EXISTS (
                    SELECT 1 FROM crm_send_attempts sa2
                    JOIN crm_drafts d2 ON d2.id = sa2.draft_id
                    WHERE d2.crm_record_id = r2.id
                      AND d2.channel = 'email'
                      AND (sa2.status IN ('failed', 'delivery_uncertain') OR (sa2.status = 'reconciled' AND sa2.provider_message_id IS NULL))
                      AND coalesce(sa2.error, '') ~* '(55[0-9]|5\\.[0-9]\\.[0-9]|rejected|does not exist|doesn''t exist|bounced|user unknown)'
                  )
                )
            ) AS bounced
          FROM crm_records r
          WHERE r.organization_id = ${org}
            AND (
              r.active_channel = 'email'
              OR EXISTS (
                SELECT 1 FROM crm_conversations cv
                WHERE cv.crm_record_id = r.id AND cv.channel = 'email'
              )
            )
            AND NOT EXISTS (
              SELECT 1 FROM outreach_leads ol
              WHERE ol.person_id = r.person_id AND ol.id IN ${orgLeadIds}
            )
          HAVING count(DISTINCT r.person_id) > 0
        `),
      () =>
        db.execute<CampaignSendRow>(sql`
          SELECT l.campaign_id::text AS campaign_id, ${campaignDay} AS d, count(*)::int AS sends
          FROM outreach_emails e
          JOIN outreach_leads l ON l.id = e.lead_id
          WHERE e.status = 'sent' AND ${inRange(sql`e.sent_at`, range)}
            AND l.campaign_id IN (SELECT id FROM outreach_campaigns WHERE organization_id = ${org})
          GROUP BY l.campaign_id, d
          UNION ALL
          SELECT ${directCampaignId}::text AS campaign_id, ${crmSentDay} AS d, count(*)::int AS sends
          FROM crm_conversation_messages m
          JOIN crm_conversations cv ON cv.id = m.conversation_id
          WHERE cv.organization_id = ${org}
            AND m.channel = 'email'
            AND m.direction = 'outbound'
            AND ${inRange(sql`m.sent_at`, range)}
            AND (
              m.provider_message_id IS NULL
              OR NOT EXISTS (
                SELECT 1 FROM outreach_emails oe
                WHERE oe.message_id = m.provider_message_id AND oe.status = 'sent'
              )
            )
          GROUP BY d
        `),
      () =>
        db.execute<MailboxRow>(sql`
          SELECT id, email_address, status, today_emails_sent, daily_send_limit
          FROM outreach_mailboxes
          WHERE organization_id = ${org}
          ORDER BY today_emails_sent DESC, email_address
        `),
    ],
    3,
  );
  const emailRows = results[0] as EmailRow[];
  const replyRows = results[1] as ReplyRow[];
  const suppressionRows = results[2] as SuppressionRow[];
  const campaignRows = results[3] as CampaignRow[];
  const campaignSendRows = results[4] as CampaignSendRow[];
  const mailboxRows = results[5] as MailboxRow[];

  const emailTotal = emailRows.find((r) => r.total);
  const emailDays = emailRows.filter((r) => !r.total && r.d !== null) as Array<EmailRow & { d: string }>;
  const replyTotal = replyRows.find((r) => r.total);
  const replyDays = replyRows.filter((r) => !r.total && r.d !== null) as Array<ReplyRow & { d: string }>;
  const sup = suppressionRows[0];

  const contacted = num(emailTotal?.contacted);
  const contactedPrev = num(emailTotal?.contacted_prev);
  const replied = num(replyTotal?.replied);
  const repliedPrev = num(replyTotal?.replied_prev);

  const starts = bucketStarts(range);
  const trends = new Map<string, Map<string, number>>();
  for (const r of campaignSendRows) {
    if (r.d < range.from || r.d > range.to) continue;
    const byBucket = trends.get(r.campaign_id) ?? new Map<string, number>();
    const b = bucketFor(r.d, range);
    byBucket.set(b, (byBucket.get(b) ?? 0) + num(r.sends));
    trends.set(r.campaign_id, byBucket);
  }

  const campaigns = campaignRows
    .map((c) => {
      const byBucket = trends.get(c.id);
      const trend = starts.map((s) => byBucket?.get(s) ?? 0);
      const contactedC = num(c.contacted);
      const repliedC = num(c.replied);
      return {
        id: c.id,
        name: c.name,
        status: c.status,
        leads: num(c.leads),
        contacted: contactedC,
        sentInRange: trend.reduce((a, b) => a + b, 0),
        replied: repliedC,
        replyRate: ratio(repliedC, contactedC),
        bounced: num(c.bounced),
        trend,
      };
    })
    .sort((a, b) => b.sentInRange - a.sentInRange || b.leads - a.leads)
    .slice(0, CAMPAIGN_ROW_CAP);

  const mailboxes = mailboxRows.map((m) => ({
    id: m.id,
    email: m.email_address,
    status: m.status,
    sentToday: num(m.today_emails_sent),
    dailyLimit: num(m.daily_send_limit),
  }));

  return {
    view: "email",
    range,
    kpis: {
      sent: { value: num(emailTotal?.sent), previous: num(emailTotal?.sent_prev) },
      contacted: { value: contacted, previous: contactedPrev },
      replied: { value: replied, previous: repliedPrev },
      replyRate: { value: ratio(replied, contacted), previous: ratio(repliedPrev, contactedPrev) },
      bounced: { value: num(sup?.bounced), previous: num(sup?.bounced_prev) },
      unsubscribed: { value: num(sup?.unsub), previous: num(sup?.unsub_prev) },
    },
    sends: toSeries(
      ["firstTouch", "followUp"] as const,
      range,
      emailDays.map((r) => ({ date: r.d, firstTouch: num(r.first_touch), followUp: num(r.follow_up) })),
    ),
    replies: toSeries(
      ["replies"] as const,
      range,
      replyDays.map((r) => ({ date: r.d, replies: num(r.replies) })),
    ),
    failedSends: num(emailTotal?.failed),
    campaigns,
    mailboxes: {
      total: mailboxes.length,
      connected: mailboxes.filter((m) => m.status === "connected").length,
      failing: mailboxes.filter((m) => m.status === "failed").length,
      sentToday: mailboxes.reduce((a, m) => a + m.sentToday, 0),
      capacityToday: mailboxRows
        .filter((m) => m.status === "connected")
        .reduce((a, m) => a + num(m.daily_send_limit), 0),
      rows: mailboxes,
    },
  };
}
