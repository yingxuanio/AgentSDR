"use client";

import { RiCheckDoubleLine, RiDraftLine } from "@remixicon/react";
import type { CrmCategory, CrmSummary } from "@/lib/analytics/contract";
import { cn } from "@/utils/cn";
import { BarList, type BarListItem } from "../kit/BarList";
import { ChartCard } from "../kit/ChartCard";
import { DeltaPill } from "../kit/DeltaPill";
import { DonutChart, type DonutItem } from "../kit/DonutChart";
import { EmptyChart } from "../kit/EmptyChart";
import { Frame, FrameHeader, FramePanel } from "../kit/Frame";
import { SegmentedBar, type SegmentItem } from "../kit/SegmentedBar";
import { SeriesStats } from "../kit/SeriesStats";
import { seriesTotal, TimeSeriesChart, TimeSeriesTable, type SeriesKeys } from "../kit/TimeSeriesChart";
import { formatCompact, formatPercent, MUTED, ORDINAL_BLUE, ordinalRamp } from "../theme";

/**
 * The CRM cards of the Overview: replies by sentiment, the pipeline shape,
 * stage moves, the AI assistant and workflow states.
 *
 * Colour: CRM categories carry one fixed identity colour everywhere — the
 * sentiment chart, the pipeline and stage-move donuts, the top-stage bars —
 * (categorical slots 6, 7, 8, 4 and gray), none of them a channel colour.
 * Funnel stages use the ordinal blue ramp by stage rank.
 */

export const CATEGORY_LABEL: Record<CrmCategory, string> = { interested: "Interested", customer: "Customer", not_interested: "Not interested", other: "Other", unclassified: "Unclassified" };
const SENTIMENT_KEYS: SeriesKeys<CrmCategory> = {
  interested: { label: CATEGORY_LABEL.interested, color: "#1daf9c" },
  customer: { label: CATEGORY_LABEL.customer, color: "#7d52f4" },
  not_interested: { label: CATEGORY_LABEL.not_interested, color: "#fb3748" },
  other: { label: CATEGORY_LABEL.other, color: "#e5930a" },
  unclassified: { label: CATEGORY_LABEL.unclassified, color: MUTED },
};

type CardProps<K extends keyof CrmSummary> = { value: CrmSummary[K]; loading: boolean; className?: string };

export function SentimentCard({ series, bucket, loading, className }: { series: CrmSummary["repliesByCategory"]; bucket: "day" | "week"; loading: boolean; className?: string }) {
  const stats = (Object.keys(SENTIMENT_KEYS) as CrmCategory[]).map((k) => ({ label: SENTIMENT_KEYS[k].label, color: SENTIMENT_KEYS[k].color, value: formatCompact(seriesTotal(series, k)) }));
  return (
    <ChartCard
      className={className}
      title="Replies by sentiment"
      description={`Inbound replies each ${bucket}, by the category they were classified into.`}
      legend={<SeriesStats items={stats} />}
      loading={loading}
      table={<TimeSeriesTable series={series} keys={SENTIMENT_KEYS} bucket={bucket} caption="Replies by sentiment" />}
    >
      <TimeSeriesChart series={series} keys={SENTIMENT_KEYS} type="stackedBar" bucket={bucket} />
    </ChartCard>
  );
}

/** Category order for every CRM donut: validated adjacent-pair palette, gray last. */
const CATEGORY_ORDER: CrmCategory[] = ["interested", "customer", "not_interested", "other", "unclassified"];

function byCategory(rows: Array<{ categoryKey: CrmCategory; value: number }>, unclassifiedLabel?: string): DonutItem[] {
  const totals = new Map<CrmCategory, number>();
  for (const r of rows) totals.set(r.categoryKey, (totals.get(r.categoryKey) ?? 0) + r.value);
  return CATEGORY_ORDER.map((k) => ({
    key: k,
    label: k === "unclassified" && unclassifiedLabel ? unclassifiedLabel : CATEGORY_LABEL[k],
    value: totals.get(k) ?? 0,
    color: SENTIMENT_KEYS[k].color,
  }));
}

/** A small uppercase label between a card's donut and its list. */
function SubHeading({ children }: { children: React.ReactNode }) {
  return <h3 className="mb-3 mt-5 border-t border-stroke-soft-200 pt-4 text-subheading-2xs uppercase text-text-soft-400">{children}</h3>;
}

export function PipelineCard({ value: pipeline, loading, className }: CardProps<"pipeline">) {
  const ranked = pipeline.filter((p) => p.stageRank !== null);
  const ramp = ordinalRamp(Math.max(ranked.length, 1));
  const stages: BarListItem[] = ranked.map((p, i) => ({ key: `r-${p.subcategoryId ?? i}`, label: `${p.name} · ${CATEGORY_LABEL[p.categoryKey]}`, value: p.count, color: ramp[i] }));
  return (
    <Frame className={className} aria-busy={loading || undefined}>
      <FrameHeader title="Pipeline now" description="Open records by category, right now, and how far along the funnel they are." />
      <FramePanel className={cn("transition-opacity", loading && "opacity-60")}>
        <DonutChart items={byCategory(pipeline.map((p) => ({ categoryKey: p.categoryKey, value: p.count })), "Outreach / Pre-reply")} centerLabel="open records" emptyLabel="No open records" emptyDescription="Nothing is open in the CRM right now." />
        {stages.length > 0 && (
          <>
            <SubHeading>Funnel stages · darker as they advance</SubHeading>
            <BarList items={stages} />
          </>
        )}
      </FramePanel>
    </Frame>
  );
}

export function StageMovesCard({ value: entries, loading, className }: CardProps<"stageEntries">) {
  const moved = entries.filter((e) => e.entered > 0);
  const top: BarListItem[] = [...moved]
    .sort((a, b) => b.entered - a.entered)
    .slice(0, 5)
    .map((e) => ({ key: e.subcategoryId, label: `${e.name} · ${CATEGORY_LABEL[e.categoryKey]}`, value: e.entered, color: SENTIMENT_KEYS[e.categoryKey].color }));
  return (
    <Frame className={className} aria-busy={loading || undefined}>
      <FrameHeader title="Stage moves this period" description="Records moved into a new stage, by the category they moved into." />
      <FramePanel className={cn("transition-opacity", loading && "opacity-60")}>
        <DonutChart items={byCategory(moved.map((e) => ({ categoryKey: e.categoryKey, value: e.entered })))} centerLabel="moves" emptyLabel="No stage moves" />
        {top.length > 0 && (
          <>
            <SubHeading>Top stages</SubHeading>
            <BarList items={top} />
          </>
        )}
      </FramePanel>
    </Frame>
  );
}

/**
 * Workflow states in a fixed order with fixed colours: adjacent pairs pass the
 * CVD check (pink sits beside amber, never beside teal, which it can't be told
 * apart from with deuteranopia).
 * Idle and the not-yet-classified states are neutral grays.
 */
const WORKFLOW_META: Record<string, { label: string; color: string }> = {
  paused: { label: "Paused", color: "#fb4ba3" },
  action_required: { label: "Action required", color: "#e5930a" },
  error: { label: "Error", color: "#fb3748" },
  waiting: { label: "Waiting", color: "#7d52f4" },
  closed: { label: "Closed", color: "#1daf9c" },
  unclassified: { label: "Unclassified", color: "var(--chart-muted-strong)" },
  classifying: { label: "Classifying", color: "var(--chart-muted-strong)" },
  idle: { label: "Idle", color: MUTED },
};

export function WorkflowCard({ value: workflow, loading, className }: CardProps<"workflow">) {
  const order = Object.keys(WORKFLOW_META);
  const items: DonutItem[] = [...workflow]
    .sort((a, b) => (order.indexOf(a.key) + 1 || 99) - (order.indexOf(b.key) + 1 || 99))
    .map((w) => ({ key: w.key, label: WORKFLOW_META[w.key]?.label ?? w.label, value: w.value, color: WORKFLOW_META[w.key]?.color ?? MUTED }));
  return (
    <Frame className={className} aria-busy={loading || undefined}>
      <FrameHeader title="Workflow" description="Every record by workflow state, right now." />
      <FramePanel className={cn("transition-opacity", loading && "opacity-60")}>
        <DonutChart items={items} centerLabel="records" emptyLabel="No records yet" emptyDescription="Records appear once a lead replies." />
      </FramePanel>
    </Frame>
  );
}

/** One figure in the AI card's stat row. */
function AiStat({ label, value, metric, upIsGood, note }: { label: string; value: string; metric?: { value: number | null; previous: number | null }; upIsGood?: boolean; note: string }) {
  return (
    <div className="min-w-0 bg-bg-white-0 px-4 py-3 first:pl-0 last:pr-0">
      <p className="truncate text-paragraph-xs text-text-sub-600">{label}</p>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
        <p className="text-title-h6 font-semibold leading-none tracking-tight text-text-strong-950">{value}</p>
        {metric && <DeltaPill metric={metric} upIsGood={upIsGood} />}
      </div>
      <p className="mt-1.5 truncate text-paragraph-xs text-text-soft-400">{note}</p>
    </div>
  );
}

/** Drafts and classification: how much of the AI's work goes out as written. */
export function AiAssistantCard({ crm, loading, className }: { crm: CrmSummary; loading: boolean; className?: string }) {
  const { drafts, kpis } = crm;
  const sent = drafts.sentAsIs + drafts.sentEdited;
  const items: SegmentItem[] = [
    { key: "asIs", label: "Sent as-is", value: drafts.sentAsIs, color: ORDINAL_BLUE[5] },
    { key: "edited", label: "Sent edited", value: drafts.sentEdited, color: ORDINAL_BLUE[0] },
    { key: "discarded", label: "Discarded", value: drafts.discarded, color: MUTED },
  ];
  const empty = items.every((i) => i.value === 0);
  return (
    <Frame className={className} aria-busy={loading || undefined}>
      <FrameHeader
        title="AI assistant"
        description={`${drafts.generated.toLocaleString("en-US")} drafts generated in this period.`}
        actions={
          drafts.awaitingReview > 0 ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-bg-white-0 px-2 py-1 text-label-xs text-text-sub-600 ring-1 ring-inset ring-stroke-soft-200">
              <RiDraftLine className="size-3.5" aria-hidden="true" />
              {drafts.awaitingReview.toLocaleString("en-US")} awaiting review
            </span>
          ) : undefined
        }
      />
      <FramePanel className={cn("grid gap-4 transition-opacity lg:grid-cols-2 lg:gap-8", loading && "opacity-60")}>
        <div className="grid grid-cols-3 gap-px self-start bg-stroke-soft-200">
          <AiStat label="Drafts sent" value={formatCompact(kpis.draftsSent.value)} metric={kpis.draftsSent} note="AI drafts that went out" />
          <AiStat label="Classified" value={formatCompact(kpis.classified.value)} metric={kpis.classified} note="Replies the AI labelled" />
          <AiStat label="Override rate" value={formatPercent(kpis.overrideRate.value)} metric={kpis.overrideRate} upIsGood={false} note="Labels a person changed" />
        </div>
        <div className="border-t border-stroke-soft-200 pt-4 lg:border-l lg:border-t-0 lg:pl-8 lg:pt-0">
          {empty ? (
            <EmptyChart height={120} title="No drafts resolved" description="Nothing was sent or discarded in this period." />
          ) : (
            <div>
              {sent > 0 && (
                <p className="mb-4 flex items-center gap-2 text-paragraph-sm text-text-strong-950">
                  <RiCheckDoubleLine className="size-4 shrink-0 text-text-sub-600" aria-hidden="true" />
                  <span>
                    <span className="text-label-sm">{formatPercent(drafts.sentAsIs / sent)}</span> of sent drafts went out unedited
                    <span className="text-text-sub-600"> ({drafts.sentAsIs.toLocaleString("en-US")} of {sent.toLocaleString("en-US")})</span>
                  </span>
                </p>
              )}
              <SegmentedBar items={items} />
            </div>
          )}
        </div>
      </FramePanel>
    </Frame>
  );
}
