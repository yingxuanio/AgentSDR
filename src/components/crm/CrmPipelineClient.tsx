"use client";
/* eslint-disable react-hooks/set-state-in-effect */

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  RiCheckDoubleLine,
  RiFilterOffLine,
  RiKanbanView2,
  RiListUnordered,
  RiTeamLine,
} from "@remixicon/react";
import * as Button from "@/components/alignui/button";
import * as SegmentedControl from "@/components/alignui/segmented-control";
import * as Select from "@/components/alignui/select";
import { Frame, FrameHeader, FramePanel } from "@/components/analytics/kit/Frame";
import { KpiCell, KpiStrip } from "@/components/analytics/kit/KpiStrip";
import { EmptyState } from "@/components/page/EmptyState";
import { PageHeader } from "@/components/page/PageHeader";
import { cn } from "@/utils/cn";
import { HoverPreviewProvider } from "./ActionRowTools";
import {
  ActionCard,
  ActionRows,
  CompactSelect,
  LoadMoreOnScroll,
  NoticeBar,
  PAGE_SIZE,
  STAGE_META,
  StageIcon,
  actionId,
  categoryItems,
  channelItems,
  useRowMutations,
  useSyncRecordChanges,
  type Action,
  type Data,
  type PipelineStage,
} from "./CrmActionsClient";
import { ErrorState } from "./CrmLayout";
import { RowsSkeleton } from "./CrmSkeletons";
import { asList, asObject, crmFetch, errorMessage } from "./crm-utils";

const STAGES = Object.keys(STAGE_META) as PipelineStage[];
/** Cards per column per request; a board shows three columns at once. */
const BOARD_PAGE = 20;

const EMPTY_COPY: Record<PipelineStage | "all", { title: string; detail: string }> = {
  all: { title: "No open leads", detail: "Active outreach leads and replies stay here until their CRM record is closed." },
  needs_action: { title: "Nothing needs attention", detail: "Drafts awaiting review, new replies, and due follow-ups land here." },
  waiting: { title: "No one is waiting", detail: "Leads with outreach sent, queued in working hours, or follow-ups scheduled land here." },
  exhausted: { title: "No exhausted sequences", detail: "Leads whose every follow-up went out without a reply land here." },
};

type Filters = { category: string; channel: string };
const DEFAULT_FILTERS: Filters = { category: "potential", channel: "" };

function filterParams(filters: Filters) {
  const params = new URLSearchParams({ scope: "pipeline" });
  // "potential" hides Not interested, which is what "leads in play" means;
  // unclassified and Other stay in because nobody has ruled them out yet.
  if (filters.category === "potential") params.set("potentialOnly", "true");
  else if (filters.category) params.set("category", filters.category);
  if (filters.channel) params.set("channel", filters.channel);
  return params;
}

/**
 * One paged pipeline read: the first page replaces, later pages append
 * (deduplicated — a card moved into this list by an edit may come back on a
 * later page). `enabled` lets the board and the list share the hook without
 * both fetching.
 */
function usePipelinePage(query: string, pageSize: number, enabled: boolean) {
  const [actions, setActions] = useState<Action[]>([]);
  const [stageCounts, setStageCounts] = useState<Partial<Record<PipelineStage, number>> | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [nextOffset, setNextOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const load = useCallback(async (offset: number) => {
    const firstPage = offset === 0;
    if (firstPage) setLoading(true); else setLoadingMore(true);
    setError("");
    try {
      const params = new URLSearchParams(query);
      params.set("limit", String(pageSize));
      params.set("offset", String(offset));
      const result = await crmFetch(`/actions?${params}`);
      const page = asList<Action>(result, ["actions"]);
      const body = asObject(result);
      setActions((old) => {
        if (firstPage) return page;
        const seen = new Set(old.map(actionId));
        return [...old, ...page.filter((item) => !seen.has(actionId(item)))];
      });
      if (firstPage) setStageCounts(asObject(body.stageCounts) as Partial<Record<PipelineStage, number>>);
      setNextOffset(Number(body.nextOffset ?? offset + page.length));
      setHasMore(Boolean(body.hasMore));
      setLoaded(true);
    } catch (cause) { setError(errorMessage(cause)); } finally { setLoading(false); setLoadingMore(false); }
  }, [query, pageSize]);
  useEffect(() => { if (enabled) void load(0); }, [load, enabled]);
  const loadMore = useCallback(() => { void load(nextOffset); }, [load, nextOffset]);
  return { actions, setActions, stageCounts, loaded, loading, loadingMore, error, hasMore, load, loadMore };
}

type View = "board" | "list";

/**
 * Every open lead, not only the ones due now. Action required drops a record
 * the moment it is acted on; this keeps it, so someone replied to yesterday
 * with a follow-up due tomorrow — or whose follow-ups have all gone out — is
 * still somewhere to be found. The board shows the three stages side by side;
 * the list is the same data as a table, with the inline draft editor.
 */
export function CrmPipelineClient() {
  const [view, setView] = useState<View>("board");
  const [categories, setCategories] = useState<Data[]>([]);
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [listStage, setListStage] = useState<PipelineStage | "all">("all");
  // Below lg the board shows one column at a time.
  const [mobileStage, setMobileStage] = useState<PipelineStage>("needs_action");
  const [categoryError, setCategoryError] = useState("");
  useEffect(() => {
    void crmFetch("/categories").then((result) => setCategories(asList<Data>(asObject(result).categories))).catch((cause) => setCategoryError(errorMessage(cause)));
  }, []);

  const base = useMemo(() => filterParams(filters).toString(), [filters]);
  const stageQuery = (stage: PipelineStage | "all") => {
    const params = new URLSearchParams(base);
    if (stage !== "all") params.set("stage", stage);
    return params.toString();
  };
  const needs = usePipelinePage(stageQuery("needs_action"), BOARD_PAGE, view === "board");
  const waiting = usePipelinePage(stageQuery("waiting"), BOARD_PAGE, view === "board");
  const exhausted = usePipelinePage(stageQuery("exhausted"), BOARD_PAGE, view === "board");
  const list = usePipelinePage(stageQuery(listStage), PAGE_SIZE, view === "list");
  const columns = { needs_action: needs, waiting, exhausted } as const;

  // Counts come back with every first page; after an edit moves a lead, one
  // cheap read refreshes them so the column headers agree with the cards.
  const [freshCounts, setFreshCounts] = useState<Partial<Record<PipelineStage, number>> | null>(null);
  const countsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (countsTimer.current) clearTimeout(countsTimer.current); }, []);
  useEffect(() => { setFreshCounts(null); }, [base]);
  const onMutated = useCallback(() => {
    if (countsTimer.current) clearTimeout(countsTimer.current);
    countsTimer.current = setTimeout(() => {
      void crmFetch(`/actions?${base}&limit=1`).then((result) => setFreshCounts(asObject(asObject(result).stageCounts) as Partial<Record<PipelineStage, number>>)).catch(() => undefined);
    }, 1200);
  }, [base]);
  const counts = freshCounts ?? (view === "list" ? list.stageCounts : needs.stageCounts ?? waiting.stageCounts ?? exhausted.stageCounts);
  const countFor = (stage: PipelineStage | "all") => counts
    ? stage === "all" ? STAGES.reduce((sum, key) => sum + Number(counts[key] ?? 0), 0) : Number(counts[stage] ?? 0)
    : null;
  const filtered = filters.category !== DEFAULT_FILTERS.category || Boolean(filters.channel);
  const setFilter = (key: keyof Filters, value: string) => setFilters((old) => ({ ...old, [key]: value }));
  const format = (value: number | null) => value === null ? "—" : value.toLocaleString();
  const total = countFor("all");

  return <>
    <PageHeader
      title="Pipeline"
      description="Every open lead, by where it stands: waiting on you, waiting on them, or out of follow-ups."
    />

    <KpiStrip className="mt-6" columns={4}>
      <KpiCell icon={RiTeamLine} label="Open leads" value={format(total)} context={filters.category === "potential" ? "Not counting “Not interested”" : "Under the current filters"} hint="Every CRM record that is not closed, under the category and channel filters below." />
      <KpiCell icon={STAGE_META.needs_action.icon} label={STAGE_META.needs_action.label} value={format(countFor("needs_action"))} context={STAGE_META.needs_action.detail} hint="The same records as Action required." />
      <KpiCell icon={STAGE_META.waiting.icon} label={STAGE_META.waiting.label} value={format(countFor("waiting"))} context={STAGE_META.waiting.detail} />
      <KpiCell icon={STAGE_META.exhausted.icon} label={STAGE_META.exhausted.label} value={format(countFor("exhausted"))} context={STAGE_META.exhausted.detail} hint="The last sequence run finished its final step without an answer. Move their stage or close them." />
    </KpiStrip>

    <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
      <SegmentedControl.Root value={view} onValueChange={(value) => setView(value as View)}>
        <SegmentedControl.List className="w-auto" aria-label="View">
          <SegmentedControl.Trigger value="board" className="gap-1.5 px-3"><RiKanbanView2 className="size-4" aria-hidden="true" />Board</SegmentedControl.Trigger>
          <SegmentedControl.Trigger value="list" className="gap-1.5 px-3"><RiListUnordered className="size-4" aria-hidden="true" />List</SegmentedControl.Trigger>
        </SegmentedControl.List>
      </SegmentedControl.Root>
      <div className="flex flex-wrap items-center gap-2">
        <CompactSelect label="Category" placeholder="All categories" value={filters.category} onChange={(value) => setFilter("category", value)}>
          <Select.Item value="potential">Potential (not “Not interested”)</Select.Item>
          <Select.Item value="">All categories</Select.Item>
          {categoryItems()}
        </CompactSelect>
        <CompactSelect label="Channel" placeholder="All channels" value={filters.channel} onChange={(value) => setFilter("channel", value)}><Select.Item value="">All channels</Select.Item>{channelItems()}</CompactSelect>
        {filtered && <Button.Root variant="neutral" mode="ghost" size="xsmall" onClick={() => setFilters(DEFAULT_FILTERS)}>Reset</Button.Root>}
      </div>
    </div>
    {categoryError && <div className="mt-3"><ErrorState message={categoryError} /></div>}

    {view === "board" ? <>
      <SegmentedControl.Root value={mobileStage} onValueChange={(value) => setMobileStage(value as PipelineStage)} className="mt-4 lg:hidden">
        <SegmentedControl.List aria-label="Stage">
          {STAGES.map((stage) => <SegmentedControl.Trigger key={stage} value={stage} className="gap-1 px-1.5 text-label-xs sm:gap-1.5 sm:px-2">
            <StageGlyph stage={stage} />
            {STAGE_META[stage].short}
            <span className="tabular-nums text-text-soft-400">{format(countFor(stage))}</span>
          </SegmentedControl.Trigger>)}
        </SegmentedControl.List>
      </SegmentedControl.Root>
      <HoverPreviewProvider>
        <div className="mt-4 grid grid-cols-1 items-start gap-4 lg:grid-cols-3 lg:gap-5">
          {STAGES.map((stage) => <BoardColumn
            key={stage}
            stage={stage}
            page={columns[stage]}
            columns={columns}
            count={countFor(stage)}
            categories={categories}
            filtered={filtered}
            onReset={() => setFilters(DEFAULT_FILTERS)}
            onMutated={onMutated}
            className={stage === mobileStage ? undefined : "hidden lg:flex"}
          />)}
        </div>
      </HoverPreviewProvider>
    </> : <Frame className="mt-4">
      <FrameHeader
        title="Open leads"
        description={list.loaded ? `${format(countFor(listStage))} leads · most recent activity first` : "Loading…"}
        actions={
          <SegmentedControl.Root value={listStage} onValueChange={(value) => setListStage(value as PipelineStage | "all")}>
            <SegmentedControl.List className="w-full sm:inline-grid sm:w-auto" aria-label="Pipeline stage">
              {(["all", ...STAGES] as const).map((stage) => <SegmentedControl.Trigger key={stage} value={stage} className="gap-1.5 px-2 sm:px-3">
                {stage !== "all" && <StageGlyph stage={stage} className="hidden sm:flex" />}
                {stage === "all" ? "All" : STAGE_META[stage].short}
                <span className="tabular-nums text-text-soft-400">{format(countFor(stage))}</span>
              </SegmentedControl.Trigger>)}
            </SegmentedControl.List>
          </SegmentedControl.Root>
        }
      />
      <FramePanel className="overflow-hidden p-0 sm:p-0">
        {!list.loaded && list.loading ? <RowsSkeleton rows={8} />
          : list.error && !list.actions.length ? <div className="p-4"><ErrorState message={list.error} onRetry={() => void list.load(0)} /></div>
          : <>
            <ActionRows
              actions={list.actions}
              categories={categories}
              onActionsChange={list.setActions}
              onMutated={onMutated}
              pipeline
              refreshing={list.loading}
              hasMore={list.hasMore && !list.loadingMore}
              onLoadMore={list.loadMore}
              empty={filtered
                ? { icon: RiFilterOffLine, title: "No leads match these filters", detail: "Try another category or channel.", action: <Button.Root variant="neutral" mode="stroke" size="small" onClick={() => setFilters(DEFAULT_FILTERS)}>Reset filters</Button.Root> }
                : { icon: RiCheckDoubleLine, ...EMPTY_COPY[listStage] }}
            />
            {list.hasMore && <LoadMoreOnScroll onLoadMore={list.loadMore} busy={list.loadingMore} />}
          </>}
      </FramePanel>
    </Frame>}
  </>;
}

type Page = ReturnType<typeof usePipelinePage>;

function BoardColumn({ stage, page, columns, count, categories, filtered, onReset, onMutated, className }: {
  stage: PipelineStage;
  page: Page;
  columns: Record<PipelineStage, Page>;
  count: number | null;
  categories: Data[];
  filtered: boolean;
  onReset: () => void;
  onMutated: () => void;
  className?: string;
}) {
  const router = useRouter();
  const [now] = useState(() => Date.now());
  // An edit can move a lead to another stage (a sent reply takes it from
  // Needs action to Waiting): the refreshed card leaves this column and joins
  // the head of its new one. Deduplicated by id, so a repeat is harmless.
  const setActions = page.setActions;
  const onActionsChange = useCallback<React.Dispatch<React.SetStateAction<Action[]>>>((update) => {
    setActions((old) => {
      const next = typeof update === "function" ? update(old) : update;
      const moved = next.filter((item) => String(item.stage ?? stage) !== stage);
      for (const item of moved) {
        const target = columns[String(item.stage) as PipelineStage];
        target?.setActions((current) => [item, ...current.filter((other) => actionId(other) !== actionId(item))]);
      }
      return moved.length ? next.filter((item) => String(item.stage ?? stage) === stage) : next;
    });
  }, [setActions, columns, stage]);
  const { busyIds, notice, setNotice, mutateRow, classify, refreshRow } = useRowMutations({ onActionsChange, pipeline: true, onMutated });
  // A lead changed in the record pop-up re-reads here, and moves column if its stage changed.
  useSyncRecordChanges(page.actions, refreshRow, onMutated);
  const meta = STAGE_META[stage];

  return <Frame className={cn("min-w-0", className)} aria-busy={page.loading || undefined} aria-labelledby={`stage-${stage}`}>
    <header className="flex items-center gap-3 px-3 pb-3 pt-2.5">
      <StageIcon stage={stage} className="size-9 rounded-xl" iconClassName="size-[18px]" />
      <div className="min-w-0 flex-1">
        <h2 id={`stage-${stage}`} className="truncate text-label-md text-text-strong-950">{meta.label}</h2>
        <p className="truncate text-paragraph-xs text-text-sub-600">{meta.detail}</p>
      </div>
      <span className="flex h-7 min-w-9 shrink-0 items-center justify-center rounded-lg bg-bg-white-0 px-2 text-label-sm tabular-nums text-text-strong-950 shadow-regular-xs ring-1 ring-inset ring-stroke-soft-200" title={`${count === null ? "—" : count.toLocaleString()} leads`}>{count === null ? "—" : count.toLocaleString()}</span>
    </header>
    <NoticeBar notice={notice} onDismiss={() => setNotice(null)} className="mb-1 rounded-lg" />
    {!page.loaded && page.loading ? <div className="space-y-2">{Array.from({ length: 4 }, (_, i) => <div key={i} className="h-36 animate-pulse rounded-xl bg-bg-white-0 ring-1 ring-inset ring-stroke-soft-200" />)}</div>
      : page.error && !page.actions.length ? <FramePanel className="p-3 sm:p-3"><ErrorState message={page.error} onRetry={() => void page.load(0)} /></FramePanel>
      : !page.actions.length ? <FramePanel className="p-0 sm:p-0">
        {filtered
          ? <EmptyState compact icon={RiFilterOffLine} title="No matches here" description="No lead in this stage fits the filters." action={<Button.Root variant="neutral" mode="stroke" size="xsmall" onClick={onReset}>Reset filters</Button.Root>} />
          : <EmptyState compact icon={RiCheckDoubleLine} title={EMPTY_COPY[stage].title} description={EMPTY_COPY[stage].detail} />}
      </FramePanel>
      // From lg each column scrolls on its own, like a board: the three stages
      // stay side by side instead of the page growing to the longest column.
      : <div className={cn("space-y-2 transition-opacity lg:max-h-[calc(100dvh-12rem)] lg:overflow-y-auto lg:overscroll-contain", page.loading && "pointer-events-none opacity-60")}>
        {page.actions.map((action) => {
          const id = actionId(action);
          return <ActionCard
            key={id}
            action={action}
            categories={categories}
            now={now}
            busy={busyIds.has(id)}
            onOpen={() => router.push(`/crm/records/${id}`)}
            onMutate={(path, body, method, success) => mutateRow(id, path, body, method, success)}
            onClassify={(choice) => classify(action, choice)}
            pipeline
          />;
        })}
        {page.hasMore && <Button.Root variant="neutral" mode="ghost" size="small" className="w-full" onClick={page.loadMore} disabled={page.loadingMore}>
          {page.loadingMore ? "Loading…" : "Load more"}
        </Button.Root>}
      </div>}
  </Frame>;
}

/** A stage's icon in its colour, bare — for segmented controls where a tile would crowd the label. */
function StageGlyph({ stage, className }: { stage: PipelineStage; className?: string }) {
  const Icon = STAGE_META[stage].icon;
  return <span aria-hidden="true" className={cn("flex shrink-0", className)} style={{ color: STAGE_META[stage].color }}><Icon className="size-3.5" /></span>;
}
