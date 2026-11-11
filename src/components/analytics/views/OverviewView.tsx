"use client";

import {
  RiAlarmWarningLine,
  RiArrowRightSLine,
  RiCalendarEventLine,
  RiCheckboxCircleLine,
  RiDraftLine,
  RiInboxLine,
  RiLinkedinBoxLine,
  RiMailForbidLine,
  RiReplyLine,
  RiThumbUpLine,
  RiTimerLine,
  RiTrophyLine,
  RiUserSharedLine,
  RiWhatsappLine,
} from "@remixicon/react";
import * as Table from "@/components/alignui/table";
import type { AnalyticsView, OverviewAnalytics } from "@/lib/analytics/contract";
import { cn } from "@/utils/cn";
import { ChartCard } from "../kit/ChartCard";
import { Frame, FrameHeader, FramePanel } from "../kit/Frame";
import { FunnelChart } from "../kit/FunnelChart";
import { KpiCell, KpiStrip } from "../kit/KpiStrip";
import { ProgressList, type ProgressTone } from "../kit/ProgressList";
import { SectionHeading } from "../kit/SectionHeading";
import { CHANNEL_META, formatCompact, formatMinutes, formatPercent } from "../theme";
import { AiAssistantCard, PipelineCard, SentimentCard, StageMovesCard, WorkflowCard } from "./CrmCards";
import type { ViewProps } from "./types";

/**
 * Overview, CRM first: conversation KPIs, replies by sentiment, what needs
 * attention, the pipeline and stage moves, the AI assistant and workflow.
 * Then, smaller, the outreach that fed it: a channel table and the period
 * funnel from first touch to customer.
 */

const HINTS = {
  reached: "Distinct contacts sent an outbound touch (CRM outreach, email campaign, LinkedIn, or WhatsApp) in this period.",
  replies: "Inbound messages received in CRM conversations in this period, on any channel.",
  positive: "Distinct CRM records moved into Interested or Customer in this period.",
  meetings: "Distinct CRM records moved into a meeting or demo subcategory in this period. No-shows are not counted.",
  customers: "Distinct CRM records moved into Customer in this period.",
  response: "Median time from a lead's message to your next reply in that conversation.",
};

export function OverviewView({ data, loading, onSelectView }: ViewProps<"overview">) {
  const { kpis, range, crm } = data;
  const vsPrevious = (m: { previous: number | null }) => (m.previous === null ? undefined : `vs ${formatCompact(m.previous)} previous period`);
  const replySpark = crm.repliesByCategory.points.map((p) => crm.repliesByCategory.keys.reduce((sum, k) => sum + p[k], 0));
  const response = crm.kpis.medianFirstResponseMinutes;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-12 lg:gap-5">
      <KpiStrip className="lg:col-span-12" columns={6}>
        <KpiCell icon={RiUserSharedLine} label="Contacts reached" value={formatCompact(kpis.reached.value)} metric={kpis.reached} hint={HINTS.reached} context={vsPrevious(kpis.reached)} />
        <KpiCell icon={RiReplyLine} label="Replies" value={formatCompact(crm.kpis.replies.value)} metric={crm.kpis.replies} hint={HINTS.replies} context={`from ${formatCompact(kpis.replied.value)} ${kpis.replied.value === 1 ? "person" : "people"}`} spark={replySpark} />
        <KpiCell icon={RiThumbUpLine} label="Positive" value={formatCompact(kpis.positive.value)} metric={kpis.positive} hint={HINTS.positive} context={kpis.replied.value > 0 ? `${formatPercent(kpis.positive.value / kpis.replied.value)} of people who replied` : vsPrevious(kpis.positive)} />
        <KpiCell icon={RiCalendarEventLine} label="Meetings" value={formatCompact(kpis.meetings.value)} metric={kpis.meetings} hint={HINTS.meetings} context={vsPrevious(kpis.meetings)} />
        <KpiCell icon={RiTrophyLine} label="Customers" value={formatCompact(kpis.customers.value)} metric={kpis.customers} hint={HINTS.customers} context={vsPrevious(kpis.customers)} />
        <KpiCell icon={RiTimerLine} label="Median first response" value={formatMinutes(response.value)} metric={response} upIsGood={false} hint={HINTS.response} context={response.previous === null ? undefined : `vs ${formatMinutes(response.previous)} previous period`} />
      </KpiStrip>

      <SentimentCard className="lg:col-span-8" series={crm.repliesByCategory} bucket={range.bucket} loading={loading} />
      <AttentionCard attention={data.attention} loading={loading} />

      <PipelineCard className="lg:col-span-6 lg:self-start" value={crm.pipeline} loading={loading} />
      {/* Pipeline runs long; the two shorter cards stack beside it. */}
      <div className="flex flex-col gap-4 lg:col-span-6 lg:gap-5">
        <StageMovesCard value={crm.stageEntries} loading={loading} />
        <WorkflowCard value={crm.workflow} loading={loading} />
      </div>

      <AiAssistantCard className="lg:col-span-12" crm={crm} loading={loading} />

      <SectionHeading className="mt-2 lg:col-span-12" title="Outreach" description="Where these conversations came from. Open a channel for its detail." />
      <ChannelTable data={data} loading={loading} onSelectView={onSelectView} />
      <ChartCard className="lg:col-span-4" title="Conversion funnel" description="From first touch to customer." loading={loading} footer="Counts for this period — not one cohort followed through.">
        <FunnelChart stages={data.funnel} />
      </ChartCard>
    </div>
  );
}

function ChannelTable({ data, loading, onSelectView }: { data: OverviewAnalytics; loading: boolean; onSelectView?: (view: AnalyticsView) => void }) {
  const maxRate = Math.max(...data.channels.map((c) => c.replyRate ?? 0), 0.0001);
  return (
    <Frame className="lg:col-span-8">
      <FrameHeader title="Channels" description="How each channel performed in this period. Select a row to open it." />
      <FramePanel className={cn("p-2 transition-opacity sm:p-3", loading && "opacity-60")}>
      <Table.Root>
        <Table.Caption className="sr-only">Channel comparison</Table.Caption>
        <Table.Header>
          <Table.Row>
            <Table.Head scope="col">Channel</Table.Head>
            <Table.Head scope="col" className="text-right">Reached</Table.Head>
            <Table.Head scope="col" className="text-right">Replied</Table.Head>
            <Table.Head scope="col">Reply rate</Table.Head>
            <Table.Head scope="col" className="text-right">Positive</Table.Head>
            <Table.Head scope="col" className="w-8"><span className="sr-only">Open</span></Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body spacing={4}>
          {data.channels.map((row) => {
            const meta = CHANNEL_META[row.channel];
            const Icon = meta.icon;
            return (
              <Table.Row key={row.channel} className="cursor-pointer" onClick={() => onSelectView?.(row.channel)}>
                <Table.Cell className="h-12">
                  <button type="button" onClick={(e) => { e.stopPropagation(); onSelectView?.(row.channel); }} className="flex items-center gap-2.5 rounded-md text-label-sm text-text-strong-950 outline-none focus-visible:ring-2 focus-visible:ring-primary-base">
                    <span className="flex size-6 items-center justify-center rounded-md" style={{ backgroundColor: meta.color }}>
                      <Icon className="size-4 text-white" />
                    </span>
                    {meta.label}
                  </button>
                </Table.Cell>
                <Table.Cell className="h-12 text-right text-paragraph-sm tabular-nums text-text-strong-950">{formatCompact(row.reached)}</Table.Cell>
                <Table.Cell className="h-12 text-right text-paragraph-sm tabular-nums text-text-strong-950">{formatCompact(row.replied)}</Table.Cell>
                <Table.Cell className="h-12">
                  <div className="flex items-center gap-3">
                    <span className="w-12 text-paragraph-sm tabular-nums text-text-strong-950">{formatPercent(row.replyRate)}</span>
                    <span aria-hidden="true" className="h-1.5 w-24 rounded-full bg-bg-weak-50">
                      <span className="block h-full rounded-full" style={{ width: `${((row.replyRate ?? 0) / maxRate) * 100}%`, backgroundColor: meta.color }} />
                    </span>
                  </div>
                </Table.Cell>
                <Table.Cell className="h-12 text-right text-paragraph-sm tabular-nums text-text-strong-950">{formatCompact(row.positive)}</Table.Cell>
                <Table.Cell className="h-12 w-8 text-text-soft-400"><RiArrowRightSLine className="size-4" aria-hidden="true" /></Table.Cell>
              </Table.Row>
            );
          })}
        </Table.Body>
      </Table.Root>
      </FramePanel>
    </Frame>
  );
}

type AttentionItem = { key: keyof OverviewAnalytics["attention"]; label: string; hint: string; href: string; icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>; tone: ProgressTone };

const ATTENTION: AttentionItem[] = [
  { key: "actionRequired", label: "Action required", hint: "Conversations waiting on you", href: "/crm/actions", icon: RiInboxLine, tone: "serious" },
  { key: "overdue", label: "Follow-ups due", hint: "Follow-ups drafted or past their time", href: "/crm/actions", icon: RiAlarmWarningLine, tone: "critical" },
  { key: "draftsAwaitingReview", label: "Drafts to review", hint: "AI replies waiting for approval", href: "/crm/actions", icon: RiDraftLine, tone: "warning" },
  { key: "mailboxesFailing", label: "Failing mailboxes", hint: "Email accounts that can't send", href: "/settings/email-accounts", icon: RiMailForbidLine, tone: "critical" },
  { key: "linkedinDisconnected", label: "LinkedIn disconnected", hint: "Accounts that need reconnecting", href: "/settings/linkedin-accounts", icon: RiLinkedinBoxLine, tone: "critical" },
  { key: "whatsappDisconnected", label: "WhatsApp disconnected", hint: "Numbers that need relinking", href: "/settings/whatsapp-accounts", icon: RiWhatsappLine, tone: "critical" },
];

function AttentionCard({ attention, loading }: { attention: OverviewAnalytics["attention"]; loading: boolean }) {
  const anyOpen = ATTENTION.some((item) => attention[item.key] > 0);
  return (
    <Frame className="lg:col-span-4">
      <FrameHeader title="Needs attention" description="Right now, regardless of the date range." />
      <FramePanel className={cn("transition-opacity", loading && "opacity-60")}>
        {anyOpen ? (
          <ProgressList
            items={ATTENTION.map((item) => ({
              key: item.key,
              label: item.label,
              value: attention[item.key],
              subline: item.hint,
              tone: attention[item.key] > 0 ? item.tone : "neutral",
              icon: attention[item.key] > 0 ? item.icon : undefined,
              href: item.href,
            }))}
          />
        ) : (
          <div className="flex flex-col items-center justify-center px-6 py-10 text-center">
            <RiCheckboxCircleLine className="size-6 text-success-base" aria-hidden="true" />
            <p className="mt-2 text-label-sm text-text-strong-950">All clear</p>
            <p className="mt-0.5 text-paragraph-xs text-text-sub-600">No replies waiting, no failing accounts.</p>
          </div>
        )}
      </FramePanel>
    </Frame>
  );
}
