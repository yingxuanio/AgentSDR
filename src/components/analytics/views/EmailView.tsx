"use client";

import Link from "next/link";
import { RiAlertLine, RiInformationLine, RiMailSendLine, RiMailForbidLine, RiChat1Line, RiPercentLine, RiUserSharedLine, RiUserUnfollowLine } from "@remixicon/react";
import * as Table from "@/components/alignui/table";
import type { EmailAnalytics } from "@/lib/analytics/contract";
import { cn } from "@/utils/cn";
import { CapacityMeter } from "../kit/CapacityMeter";
import { ChartCard } from "../kit/ChartCard";
import { Frame, FrameFooterLink, FrameHeader, FramePanel } from "../kit/Frame";
import { KpiCell, KpiStrip } from "../kit/KpiStrip";
import { RateCell } from "../kit/RateCell";
import { SeriesStats } from "../kit/SeriesStats";
import { Sparkline } from "../kit/Sparkline";
import { StatusDotBadge } from "../kit/StatusDotBadge";
import { TickMeter } from "../kit/TickMeter";
import { seriesTotal, TimeSeriesChart, TimeSeriesTable, type SeriesKeys } from "../kit/TimeSeriesChart";
import { CHANNEL_META, formatCompact, formatPercent, MUTED } from "../theme";
import type { ViewProps } from "./types";

/**
 * Email: KPI strip, sending activity (first touch vs follow-ups) beside
 * today's mailbox capacity, replies over time beside a "not tracked" note, and
 * the campaigns table.
 */

const EMAIL = CHANNEL_META.email.color;

const SEND_KEYS: SeriesKeys<"firstTouch" | "followUp"> = {
  firstTouch: { label: "First touch", color: EMAIL },
  followUp: { label: "Follow-ups", color: MUTED },
};
const REPLY_KEYS: SeriesKeys<"replies"> = { replies: { label: "Replies", color: EMAIL } };

const HINTS = {
  sent: "Emails sent in this period across direct CRM outreach and email campaigns, first touches and follow-ups both.",
  contacted: "Distinct leads who were sent their first email in this period.",
  replied: "Distinct people who sent an inbound email reply in this period.",
  replyRate: "Replied divided by leads contacted, for the same period.",
  bounced: "Distinct recipient addresses that bounced or failed SMTP delivery in this period.",
  unsubscribed: "Addresses added to the suppression list as unsubscribed in this period.",
};

const CAMPAIGN_STATUS: Record<string, { tone: "good" | "warning" | "neutral" | "info"; label: string }> = {
  active: { tone: "good", label: "Active" },
  paused: { tone: "warning", label: "Paused" },
  draft: { tone: "neutral", label: "Draft" },
  completed: { tone: "info", label: "Completed" },
};

function totalsSpark(series: EmailAnalytics["sends"]): number[] {
  return series.points.map((p) => p.firstTouch + p.followUp);
}

export function EmailView({ data, loading }: ViewProps<"email">) {
  const { kpis, range } = data;
  const unit = range.bucket === "week" ? "week" : "day";
  const vsPrevious = (m: { previous: number | null }) => (m.previous === null ? undefined : `vs ${formatCompact(m.previous)} previous period`);
  const repliesTotal = seriesTotal(data.replies, "replies");

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-12 lg:gap-5">
      <KpiStrip className="lg:col-span-12" columns={6}>
        <KpiCell icon={RiMailSendLine} label="Emails sent" value={formatCompact(kpis.sent.value)} metric={kpis.sent} hint={HINTS.sent} context={vsPrevious(kpis.sent)} spark={totalsSpark(data.sends)} />
        <KpiCell icon={RiUserSharedLine} label="Leads contacted" value={formatCompact(kpis.contacted.value)} metric={kpis.contacted} hint={HINTS.contacted} context={vsPrevious(kpis.contacted)} />
        <KpiCell icon={RiChat1Line} label="Replied" value={formatCompact(kpis.replied.value)} metric={kpis.replied} hint={HINTS.replied} context={`of ${formatCompact(kpis.contacted.value)} contacted`} spark={data.replies.points.map((p) => p.replies)} />
        <KpiCell icon={RiPercentLine} label="Reply rate" value={formatPercent(kpis.replyRate.value)} metric={kpis.replyRate} hint={HINTS.replyRate} context={kpis.replyRate.previous === null ? undefined : `vs ${formatPercent(kpis.replyRate.previous)} previous period`} />
        <KpiCell icon={RiMailForbidLine} label="Bounced" value={formatCompact(kpis.bounced.value)} metric={kpis.bounced} upIsGood={false} hint={HINTS.bounced} context={vsPrevious(kpis.bounced)} />
        <KpiCell icon={RiUserUnfollowLine} label="Unsubscribed" value={formatCompact(kpis.unsubscribed.value)} metric={kpis.unsubscribed} upIsGood={false} hint={HINTS.unsubscribed} context={vsPrevious(kpis.unsubscribed)} />
      </KpiStrip>

      <ChartCard
        className="lg:col-span-8"
        title="Sending activity"
        description={`Emails sent each ${unit}: first touches and follow-ups.`}
        legend={
          <SeriesStats
            items={[
              { label: SEND_KEYS.firstTouch.label, color: SEND_KEYS.firstTouch.color, value: formatCompact(seriesTotal(data.sends, "firstTouch")) },
              { label: SEND_KEYS.followUp.label, color: SEND_KEYS.followUp.color, value: formatCompact(seriesTotal(data.sends, "followUp")) },
            ]}
          />
        }
        loading={loading}
        table={<TimeSeriesTable series={data.sends} keys={SEND_KEYS} bucket={range.bucket} caption="Emails sent by type" />}
        footer={
          data.failedSends > 0 ? (
            <span className="flex items-center gap-1.5">
              <RiAlertLine className="size-4 shrink-0 text-warning-base" aria-hidden="true" />
              {data.failedSends.toLocaleString("en-US")} {data.failedSends === 1 ? "send" : "sends"} failed in this period
            </span>
          ) : undefined
        }
      >
        <TimeSeriesChart series={data.sends} keys={SEND_KEYS} type="stackedBar" bucket={range.bucket} height={440} />
      </ChartCard>

      <MailboxCapacity mailboxes={data.mailboxes} loading={loading} />

      <ChartCard
        className="lg:col-span-8"
        title="Replies"
        description={`Inbound email replies each ${unit}.`}
        legend={<SeriesStats items={[{ label: "Replies", color: EMAIL, value: formatCompact(repliesTotal), metric: kpis.replied }]} />}
        loading={loading}
        table={<TimeSeriesTable series={data.replies} keys={REPLY_KEYS} bucket={range.bucket} caption="Email replies" />}
      >
        <TimeSeriesChart series={data.replies} keys={REPLY_KEYS} type="bar" bucket={range.bucket} />
      </ChartCard>

      <Frame className="self-start lg:col-span-4">
        <FrameHeader title="Not tracked" />
        <FramePanel className="bg-information-lighter ring-information-light/40 sm:p-5">
          <div className="flex items-start gap-3">
            <RiInformationLine className="mt-0.5 size-5 shrink-0 text-information-base" aria-hidden="true" />
            <p className="text-paragraph-sm text-text-sub-600">
              Opens and clicks aren&apos;t recorded, so there are no open or click rates here. Reply rate is the engagement metric to watch.
            </p>
          </div>
        </FramePanel>
      </Frame>

      <CampaignsTable campaigns={data.campaigns} loading={loading} />
    </div>
  );
}

function MailboxCapacity({ mailboxes, loading }: { mailboxes: EmailAnalytics["mailboxes"]; loading: boolean }) {
  const top = [...mailboxes.rows].sort((a, b) => b.sentToday - a.sentToday).slice(0, 5);
  return (
    <Frame className="lg:col-span-4">
      <FrameHeader title="Mailbox capacity today" description="Right now, regardless of the date range." />
      <FramePanel className={cn("transition-opacity", loading && "opacity-60")}>
        {mailboxes.total === 0 ? (
          <p className="py-6 text-center text-paragraph-sm text-text-sub-600">No mailboxes connected yet.</p>
        ) : (
          <>
            <TickMeter label="Sent today" used={mailboxes.sentToday} limit={mailboxes.capacityToday} caption={`${mailboxes.sentToday.toLocaleString("en-US")} of ${mailboxes.capacityToday.toLocaleString("en-US")} sent today`} />
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <StatusDotBadge status="good">{mailboxes.connected} connected</StatusDotBadge>
              <StatusDotBadge status={mailboxes.failing > 0 ? "critical" : "neutral"}>{mailboxes.failing} failing</StatusDotBadge>
            </div>
            {top.length > 0 && (
              <ul className="mt-5 flex flex-col gap-4 border-t border-stroke-soft-200 pt-4">
                {top.map((m) => (
                  <li key={m.id}>
                    <CapacityMeter label={m.email} used={m.sentToday} limit={m.dailyLimit} segments={16} />
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </FramePanel>
      <FrameFooterLink href="/settings/email-accounts">Manage mailboxes</FrameFooterLink>
    </Frame>
  );
}

function CampaignsTable({ campaigns, loading }: { campaigns: EmailAnalytics["campaigns"]; loading: boolean }) {
  const maxRate = Math.max(...campaigns.map((c) => c.replyRate ?? 0), 0.0001);
  const num = "h-12 text-right text-paragraph-sm tabular-nums text-text-strong-950";
  return (
    <Frame className="lg:col-span-12">
      <FrameHeader title="Campaigns & Outreach" description="Sends are for this period; leads, replies and bounces are all time. Sorted by sends." />
      <FramePanel className={cn("overflow-x-auto p-2 transition-opacity sm:p-3", loading && "opacity-60")}>
        {campaigns.length === 0 ? (
          <p className="py-10 text-center text-paragraph-sm text-text-sub-600">No email outreach activity yet.</p>
        ) : (
          <Table.Root>
            <Table.Caption className="sr-only">Email campaigns and outreach</Table.Caption>
            <Table.Header>
              <Table.Row>
                <Table.Head scope="col">Source</Table.Head>
                <Table.Head scope="col" className="text-right">Leads</Table.Head>
                <Table.Head scope="col" className="text-right">Contacted</Table.Head>
                <Table.Head scope="col">Sent</Table.Head>
                <Table.Head scope="col" className="text-right">Replied</Table.Head>
                <Table.Head scope="col">Reply rate</Table.Head>
                <Table.Head scope="col" className="text-right">Bounced</Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body spacing={4}>
              {campaigns.map((c) => {
                const status = CAMPAIGN_STATUS[c.status] ?? { tone: "neutral" as const, label: c.status };
                const href = c.id === "__direct_crm_email__" ? "/crm/pipeline" : `/outreach/campaigns/${c.id}`;
                return (
                  <Table.Row key={c.id}>
                    <Table.Cell className="h-12">
                      <div className="flex min-w-0 items-center gap-3">
                        <Link href={href} className="max-w-64 truncate rounded-md text-label-sm text-text-strong-950 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-primary-base">{c.name}</Link>
                        <StatusDotBadge status={status.tone}>{status.label}</StatusDotBadge>
                      </div>
                    </Table.Cell>
                    <Table.Cell className={num}>{formatCompact(c.leads)}</Table.Cell>
                    <Table.Cell className={num}>{formatCompact(c.contacted)}</Table.Cell>
                    <Table.Cell className="h-12">
                      <div className="flex items-center gap-3">
                        <span className="w-10 text-paragraph-sm tabular-nums text-text-strong-950">{formatCompact(c.sentInRange)}</span>
                        <Sparkline data={c.trend} color={MUTED} className="hidden w-16 sm:block" />
                      </div>
                    </Table.Cell>
                    <Table.Cell className={num}>{formatCompact(c.replied)}</Table.Cell>
                    <Table.Cell className="h-12"><RateCell rate={c.replyRate} max={maxRate} color={EMAIL} /></Table.Cell>
                    <Table.Cell className={cn(num, c.bounced === 0 && "text-text-soft-400")}>{formatCompact(c.bounced)}</Table.Cell>
                  </Table.Row>
                );
              })}
            </Table.Body>
          </Table.Root>
        )}
      </FramePanel>
    </Frame>
  );
}
