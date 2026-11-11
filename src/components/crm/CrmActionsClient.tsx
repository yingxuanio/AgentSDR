"use client";
/* eslint-disable react-hooks/set-state-in-effect */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  RiAlarmWarningFill,
  RiArchiveStackFill,
  RiArrowRightLine,
  RiCalendarScheduleLine,
  RiCheckboxCircleFill,
  RiCheckDoubleLine,
  RiCheckLine,
  RiCloseLine,
  RiDeleteBinLine,
  RiDraftLine,
  RiEqualizer2Line,
  RiErrorWarningFill,
  RiErrorWarningLine,
  RiExternalLinkLine,
  RiFilterOffLine,
  RiFlashlightFill,
  RiForbid2Line,
  RiHourglass2Fill,
  RiInboxLine,
  RiLinkedinFill,
  RiLinkUnlink,
  RiMailFill,
  RiMailSendLine,
  RiMoreLine,
  RiPencilLine,
  RiPriceTag3Line,
  RiQuestionLine,
  RiRefreshLine,
  RiReplyLine,
  RiSendPlaneFill,
  RiSendPlaneLine,
  RiSparklingFill,
  RiTimeLine,
  RiTimerLine,
  RiWhatsappFill,
} from "@remixicon/react";
import * as Badge from "@/components/alignui/badge";
import * as Button from "@/components/alignui/button";
import * as Dropdown from "@/components/alignui/dropdown";
import * as Popover from "@/components/alignui/popover";
import * as Select from "@/components/alignui/select";
import * as Table from "@/components/alignui/table";
import { Frame, FrameHeader, FramePanel } from "@/components/analytics/kit/Frame";
import { KpiCell, KpiStrip } from "@/components/analytics/kit/KpiStrip";
import { CHANNEL_META, HUE, MUTED_STRONG } from "@/components/analytics/theme";
import { EmptyState } from "@/components/page/EmptyState";
import { PageHeader } from "@/components/page/PageHeader";
import { cn } from "@/utils/cn";
import { ContactAvatar } from "./ContactAvatar";
import { ErrorState, primaryButtonClass, secondaryButtonClass } from "./CrmLayout";
import { RowsSkeleton } from "./CrmSkeletons";
import { CategoryDot, ClassificationPicker, HoverPreview, HoverPreviewProvider, InlineDraftEditor, MoveStageDialog, moveStageSuccessMessage, RegenerateDraftDialog, SendDraftButton, humanize, type MoveStageBody, type RowMutation } from "./ActionRowTools";
import { asList, asObject, CATEGORY_LABELS, crmFetch, deriveCrmRecordStageDisplay, displayName, errorMessage, extractLeadContext, formatDate, LEAD_CRM_BADGE_STYLE, relativeDate, timeAgo } from "./crm-utils";
import { prefetchRecordWorkspace } from "./recordPrefetch";
import { useRecordChanged } from "./recordEvents";
import { publishRecordQueue, withdrawRecordQueue, type RecordQueue } from "./recordQueue";
import { CRM_DUE_STATE_LABELS, type CrmDueState } from "@/lib/crm/stateMachine";
import { CRM_ACTION_GROUP_LABELS, CRM_ACTION_GROUPS } from "@/lib/crm/actionGroups";

export type Data = Record<string, unknown>;
export type Action = Data;

// A missing category means the classifier has not applied one yet, which is a
// different thing from the Other category — a decision. Collapsing the two is
// what made the Other tab look like it held most of the CRM.
export function actionCategory(action: Action) {
  const value = action.category ?? asObject(action.record).categoryKey;
  return value ? String(value) : "unclassified";
}
export function actionDueState(action: Action): CrmDueState {
  const value = String(action.dueState ?? "none");
  return value in CRM_DUE_STATE_LABELS ? value as CrmDueState : "none";
}
export function actionChannel(action: Action) { return String(action.channel ?? asObject(action.conversation).channel ?? "none"); }
function actionType(action: Action) { return String(action.actionType ?? "Human review"); }
export function actionId(action: Action) { return String(action.id ?? action.recordId ?? asObject(action.record).id ?? ""); }

/** Rows per request on the Action required table; more load as the list scrolls. */
export const PAGE_SIZE = 30;

const CATEGORY_KEYS = ["interested", "customer", "not_interested", "other"] as const;
const CHANNELS = ["email", "linkedin", "whatsapp"] as const;

export function CompactSelect({ label, value, onChange, placeholder, children, className }: { label: string; value: string; onChange: (value: string) => void; placeholder: string; children: React.ReactNode; className?: string }) {
  return <Select.Root size="xsmall" value={value} onValueChange={onChange}>
    <Select.Trigger aria-label={label} className={cn("w-auto min-w-32", value ? "text-text-strong-950 ring-stroke-strong-950/40" : "text-text-sub-600", className)}><Select.Value placeholder={placeholder} /></Select.Trigger>
    <Select.Content>{children}</Select.Content>
  </Select.Root>;
}

/** Category options with their identity dot, shared by both CRM lists. */
export function categoryItems() {
  return CATEGORY_KEYS.map((key) => <Select.Item key={key} value={key}><ItemLabel><CategoryDot categoryKey={key} className="size-2" />{CATEGORY_LABELS[key]}</ItemLabel></Select.Item>);
}

/**
 * An option's mark and label on one line. Select.Item puts its children in
 * Radix's ItemText, a plain inline span, so a mark beside the text needs its
 * own flex row — without one the icon takes a line and the label wraps under
 * it. The same row is what the trigger shows once the option is picked.
 */
function ItemLabel({ children }: { children: React.ReactNode }) {
  return <span className="flex min-w-0 items-center gap-2">{children}</span>;
}

export function channelItems() {
  return CHANNELS.map((key) => {
    const Icon = CHANNEL_META[key].icon;
    return <Select.Item key={key} value={key}><ItemLabel><span className="flex shrink-0" style={{ color: CHANNEL_META[key].color }}><Icon className="size-4" /></span>{CHANNEL_META[key].label}</ItemLabel></Select.Item>;
  });
}

type Filters = { category: string; subcategoryId: string; channel: string; actionGroup: string; classificationReview: string; sequenceId: string; error: string; due: string };
const NO_FILTERS: Filters = { category: "", subcategoryId: "", channel: "", actionGroup: "", classificationReview: "", sequenceId: "", error: "", due: "" };

type QueueSummary = { queue: number; needsDecision: number; followUpsDue: number; errors: number; drafts: number | null };

/**
 * The headline numbers, from two reads the app already has: the CRM overview
 * (workflow-state counts) and the sidebar's badge counts. The queue and its
 * follow-ups are counted by the server with the same condition and action
 * groups the list filters by, so the strip agrees with the list. Follow-ups
 * overlap "awaiting a decision": a drafted follow-up is action_required too.
 */
function useQueueSummary() {
  const [summary, setSummary] = useState<QueueSummary | null>(null);
  const load = useCallback(async () => {
    try {
      const [overviewResult, badges] = await Promise.all([
        crmFetch("/overview"),
        fetch("/api/nav/badges").then((response) => response.ok ? response.json() : null).catch(() => null),
      ]);
      const overview = asObject(overviewResult);
      const states = asObject(overview.byWorkflowState);
      const needsDecision = Number(overview.actionRequired ?? 0);
      const errors = Number(states.error ?? 0);
      const followUpsDue = Number(overview.followUpsDue ?? 0);
      const drafts = badges && typeof badges.draftsAwaitingReview === "number" ? badges.draftsAwaitingReview : null;
      setSummary({ queue: Number(overview.queue ?? 0), needsDecision, followUpsDue, errors, drafts });
    } catch { /* The strip is a convenience; the queue below still works without it. */ }
  }, []);
  useEffect(() => { void load(); }, [load]);
  return [summary, load] as const;
}

export function CrmActionsClient() {
  const [actions, setActions] = useState<Action[]>([]);
  const [categories, setCategories] = useState<Data[]>([]);
  const [sequences, setSequences] = useState<Data[]>([]);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true); const [error, setError] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextOffset, setNextOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState<number | null>(null);
  const [summary, reloadSummary] = useQueueSummary();
  useEffect(() => {
    void Promise.all([crmFetch("/categories"), crmFetch("/sequences?includeArchived=true")]).then(([categoryResult, sequenceResult]) => {
      setCategories(asList<Data>(asObject(categoryResult).categories));
      setSequences(asList<Data>(sequenceResult, ["sequences"]));
    }).catch((cause) => setError(errorMessage(cause)));
  }, []);
  // Rebuilt only when a filter moves, so `load` stays stable across pages and
  // the scroll sentinel does not re-fire on every render.
  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (filters.category) params.set("category", filters.category);
    if (filters.subcategoryId) params.set("subcategoryId", filters.subcategoryId);
    if (filters.channel) params.set("channel", filters.channel);
    if (filters.actionGroup) params.set("actionGroup", filters.actionGroup);
    if (filters.classificationReview) params.set("classificationReview", filters.classificationReview);
    if (filters.sequenceId) params.set("sequenceId", filters.sequenceId);
    if (filters.error) params.set("error", "true");
    if (filters.due === "overdue") params.set("overdue", "true");
    if (filters.due === "today") params.set("dueBefore", new Date(new Date().setHours(23, 59, 59, 999)).toISOString());
    if (filters.due === "upcoming") params.set("dueAfter", new Date().toISOString());
    params.set("limit", String(PAGE_SIZE));
    return params.toString();
  }, [filters]);
  // Only the AI review post-filter makes the server total a count of this page
  // rather than of the queue.
  const postFiltered = Boolean(filters.classificationReview);
  const load = useCallback(async (offset: number) => {
    const firstPage = offset === 0;
    if (firstPage) setLoading(true); else setLoadingMore(true);
    setError("");
    try {
      const params = new URLSearchParams(query);
      params.set("offset", String(offset));
      const result = await crmFetch(`/actions?${params}`);
      const page = asList<Action>(result, ["actions"]);
      const body = asObject(result);
      // Append, never splice by index: a later page can arrive after the row
      // it would have replaced was opened and resolved.
      setActions((old) => firstPage ? page : [...old, ...page]);
      setNextOffset(Number(body.nextOffset ?? offset + page.length));
      setHasMore(Boolean(body.hasMore));
      if (firstPage) setTotal(typeof body.total === "number" ? body.total : null);
      setLoaded(true);
    } catch (cause) { setError(errorMessage(cause)); } finally { setLoading(false); setLoadingMore(false); }
  }, [query]);
  // A filter change resets to the first page; `load` changes with the query.
  useEffect(() => { void load(0); }, [load]);
  const loadMore = useCallback(() => { void load(nextOffset); }, [load, nextOffset]);
  const subcategories = useMemo(() => categories.flatMap((category) => asList<Data>(category.subcategories))
    .filter((subcategory) => !filters.category || subcategory.categoryKey === filters.category), [categories, filters.category]);
  const setFilter = (key: keyof Filters, value: string) => setFilters((old) => ({ ...old, [key]: value, ...(key === "category" ? { subcategoryId: "" } : {}) }));
  const activeFilterCount = Object.values(filters).filter(Boolean).length;
  const secondaryFilterCount = [filters.subcategoryId, filters.classificationReview, filters.sequenceId, filters.error].filter(Boolean).length;
  const clearFilters = () => setFilters(NO_FILTERS);

  // A row that leaves the queue changes the counts; one read of the summary a
  // moment after a burst of edits keeps the strip honest without a read per click.
  const summaryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (summaryTimer.current) clearTimeout(summaryTimer.current); }, []);
  const onMutated = useCallback(() => {
    if (summaryTimer.current) clearTimeout(summaryTimer.current);
    summaryTimer.current = setTimeout(() => void reloadSummary(), 1500);
  }, [reloadSummary]);

  const refresh = () => { void load(0); void reloadSummary(); };
  const shown = actions.length;
  const detail = !loaded ? "Loading…"
    : total !== null && !(postFiltered && hasMore) ? `${(postFiltered ? shown : total).toLocaleString()} ${(postFiltered ? shown : total) === 1 ? "item" : "items"}${activeFilterCount ? " match these filters" : ""} · newest reply first`
    : `${shown}+ items · newest reply first`;

  return <>
    <PageHeader
      title="Action required"
      description="Replies, drafts and follow-ups that need a person's decision before the CRM moves on."
      actions={<Button.Root variant="neutral" mode="stroke" size="small" onClick={refresh} disabled={loading}>
        <Button.Icon as={RiRefreshLine} className={cn(loading && loaded && "animate-spin")} />Refresh
      </Button.Root>}
    />

    <KpiStrip className="mt-6" columns={4}>
      <KpiCell icon={RiInboxLine} label="In the queue" value={summary ? summary.queue.toLocaleString() : "—"} context={summary ? `${summary.needsDecision.toLocaleString()} awaiting a decision` : undefined} hint="Every record waiting on a person: new replies, drafts to approve, AI changes to confirm, follow-ups past due and processing errors." selected={activeFilterCount === 0} onSelect={clearFilters} />
      <KpiCell icon={RiDraftLine} label="Drafts to review" value={summary?.drafts != null ? summary.drafts.toLocaleString() : "—"} context="AI-written replies waiting for approval" hint="Drafts the AI has written that nobody has sent, edited or discarded yet. Hover a row's draft to read it, then Edit or Send." />
      <KpiCell icon={RiTimerLine} label="Follow-ups due" value={summary ? summary.followUpsDue.toLocaleString() : "—"} context="Drafted or past their scheduled time" hint="Follow-ups waiting on a person: drafts to approve, and scheduled steps past their time with nothing drafted yet. Select to show only these." selected={filters.actionGroup === "follow_up"} onSelect={() => setFilter("actionGroup", filters.actionGroup === "follow_up" ? "" : "follow_up")} />
      <KpiCell icon={RiErrorWarningLine} label="Errors" value={summary ? summary.errors.toLocaleString() : "—"} context={summary?.errors ? "Processing failed — open the record to retry" : "Nothing failed"} hint="Records whose classification, drafting or sending failed. Select to show only these." selected={Boolean(filters.error)} onSelect={() => setFilter("error", filters.error ? "" : "true")} />
    </KpiStrip>

    <Frame className="mt-5">
      <FrameHeader title="Queue" description={detail} actions={<>
          <CompactSelect label="Category" placeholder="All categories" value={filters.category} onChange={(value) => setFilter("category", value)}><Select.Item value="">All categories</Select.Item>{categoryItems()}</CompactSelect>
          <CompactSelect label="Channel" placeholder="All channels" value={filters.channel} onChange={(value) => setFilter("channel", value)}><Select.Item value="">All channels</Select.Item>{channelItems()}</CompactSelect>
          <CompactSelect label="Action type" placeholder="All action types" value={filters.actionGroup} onChange={(value) => setFilter("actionGroup", value)}><Select.Item value="">All action types</Select.Item>{CRM_ACTION_GROUPS.map((group) => <Select.Item key={group} value={group}>{CRM_ACTION_GROUP_LABELS[group]}</Select.Item>)}</CompactSelect>
          <CompactSelect label="Due time" placeholder="Any due time" value={filters.due} onChange={(value) => setFilter("due", value)}><Select.Item value="">Any due time</Select.Item><Select.Item value="overdue">Overdue</Select.Item><Select.Item value="today">Due today</Select.Item><Select.Item value="upcoming">Upcoming</Select.Item></CompactSelect>
          <Popover.Root>
            <Popover.Trigger asChild>
              <Button.Root variant="neutral" mode="stroke" size="xsmall" className={cn(secondaryFilterCount > 0 && "text-text-strong-950")}>
                <Button.Icon as={RiEqualizer2Line} />More filters
                {secondaryFilterCount > 0 && <span className="flex size-4 items-center justify-center rounded-full bg-primary-base text-label-xs text-static-white">{secondaryFilterCount}</span>}
              </Button.Root>
            </Popover.Trigger>
            <Popover.Content align="start" showArrow={false} sideOffset={8} className="w-80 max-w-[calc(100vw-2rem)] p-4">
              <p className="text-label-sm text-text-strong-950">More filters</p>
              <div className="mt-3 grid gap-3">
                <FilterField label="Subcategory"><CompactSelect label="Subcategory" placeholder="All subcategories" className="w-full" value={filters.subcategoryId} onChange={(value) => setFilter("subcategoryId", value)}><Select.Item value="">All subcategories</Select.Item>{subcategories.map((value) => <Select.Item key={String(value.id)} value={String(value.id)}><ItemLabel><CategoryDot categoryKey={String(value.categoryKey ?? "")} className="size-2" />{String(value.name)}</ItemLabel></Select.Item>)}</CompactSelect></FilterField>
                <FilterField label="AI classification"><CompactSelect label="Classification review" placeholder="Any classification" className="w-full" value={filters.classificationReview} onChange={(value) => setFilter("classificationReview", value)}><Select.Item value="">Any classification</Select.Item><Select.Item value="true">Needs review</Select.Item><Select.Item value="false">Reviewed</Select.Item></CompactSelect></FilterField>
                <FilterField label="Sequence"><CompactSelect label="Sequence" placeholder="All sequences" className="w-full" value={filters.sequenceId} onChange={(value) => setFilter("sequenceId", value)}><Select.Item value="">All sequences</Select.Item>{sequences.map((value) => <Select.Item key={String(value.id)} value={String(value.id)}>{String(value.name)}</Select.Item>)}</CompactSelect></FilterField>
                <FilterField label="Errors"><CompactSelect label="Error state" placeholder="All states" className="w-full" value={filters.error} onChange={(value) => setFilter("error", value)}><Select.Item value="">All states</Select.Item><Select.Item value="true">Errors only</Select.Item></CompactSelect></FilterField>
              </div>
            </Popover.Content>
          </Popover.Root>
          {activeFilterCount > 0 && <Button.Root variant="neutral" mode="ghost" size="xsmall" onClick={clearFilters}><Button.Icon as={RiCloseLine} />Clear {activeFilterCount === 1 ? "filter" : `${activeFilterCount} filters`}</Button.Root>}
      </>} />
      <FramePanel className="overflow-hidden p-0 sm:p-0">
        {!loaded && loading ? <RowsSkeleton rows={8} />
          : error && !actions.length ? <div className="p-4"><ErrorState message={error} onRetry={() => void load(0)} /></div>
          : <>
            {error && <div className="p-3"><ErrorState message={error} onRetry={() => void load(0)} /></div>}
            <ActionRows
              actions={actions}
              categories={categories}
              onActionsChange={setActions}
              onMutated={onMutated}
              refreshing={loading}
              hasMore={hasMore && !loadingMore}
              onLoadMore={loadMore}
              empty={activeFilterCount
                ? { icon: RiFilterOffLine, title: "Nothing matches these filters", detail: "The queue has items, just none that fit every filter you picked.", action: <Button.Root variant="neutral" mode="stroke" size="small" onClick={clearFilters}>Clear filters</Button.Root> }
                : { icon: RiCheckDoubleLine, title: "You're all caught up", detail: "New replies, drafts to approve and due follow-ups will show up here." }}
            />
            {hasMore && <LoadMoreOnScroll onLoadMore={loadMore} busy={loadingMore} />}
          </>}
      </FramePanel>
    </Frame>
  </>;
}

function FilterField({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><p className="mb-1 text-label-xs text-text-sub-600">{label}</p>{children}</div>;
}

/**
 * Fetches the next page when the bottom of the list comes into view, with a
 * button fallback so the list stays reachable without an IntersectionObserver
 * (and for keyboard users, who never scroll the sentinel into view).
 */
export function LoadMoreOnScroll({ onLoadMore, busy, className }: { onLoadMore: () => void; busy: boolean; className?: string }) {
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = sentinel.current;
    if (!node || busy || typeof IntersectionObserver === "undefined") return;
    // rootMargin starts the fetch a screen early so the rows are usually there
    // before the reader reaches them.
    const observer = new IntersectionObserver(
      (entries) => { if (entries.some((entry) => entry.isIntersecting)) onLoadMore(); },
      { rootMargin: "300px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [onLoadMore, busy]);
  return <div className={cn("flex items-center justify-center border-t border-stroke-soft-200 p-3", className)}>
    <div ref={sentinel} aria-hidden="true" className="h-px w-px" />
    <Button.Root variant="neutral" mode="stroke" size="xsmall" onClick={onLoadMore} disabled={busy}>
      {busy ? "Loading…" : "Load more"}
    </Button.Root>
  </div>;
}

/** A draft a person can act on from the row. Uncertain deliveries need the record page. */
export function editableDraft(action: Action) {
  const draft = asObject(action.draft);
  return draft.id && (draft.status === "awaiting_review" || draft.status === "failed") ? draft : null;
}

type Notice = { tone: "success" | "error"; text: string };

/**
 * The rows carry their own edits: every mutation posts, then re-reads just
 * that record through `?recordId=` and swaps the row in place — or drops it
 * when the record is no longer actionable (a sent reply moves it to waiting).
 * Reloading the whole list instead would lose the reader's scroll position
 * and every page they had loaded.
 */
export function useRowMutations({ onActionsChange, pipeline, onMutated, onRowGone }: {
  onActionsChange: React.Dispatch<React.SetStateAction<Action[]>>;
  pipeline?: boolean;
  onMutated?: () => void;
  onRowGone?: (id: string) => void;
}) {
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
  const [notice, setNotice] = useState<Notice | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => { for (const timer of timers.current) clearTimeout(timer); }, []);

  const refreshRow = useCallback(async (id: string) => {
    // The pipeline re-reads in its own scope, so a sent reply moves the row to
    // Waiting rather than dropping it the way the Action required queue does.
    const result = await crmFetch(`/actions?recordId=${encodeURIComponent(id)}&limit=1${pipeline ? "&scope=pipeline" : ""}`);
    const [fresh] = asList<Action>(result, ["actions"]);
    onActionsChange((old) => fresh ? old.map((item) => actionId(item) === id ? fresh : item) : old.filter((item) => actionId(item) !== id));
    if (!fresh) onRowGone?.(id);
    return fresh ?? null;
  }, [onActionsChange, pipeline, onRowGone]);

  const mutateRow = useCallback(async (id: string, path: string, body: Data, method: string, success: string) => {
    setBusyIds((old) => new Set(old).add(id));
    setNotice(null);
    try {
      await crmFetch(path, { method, body: JSON.stringify(body) });
      const fresh = await refreshRow(id);
      setNotice({ tone: "success", text: fresh ? success : `${success} — this contact no longer needs attention.` });
      onMutated?.();
      return true;
    } catch (cause) {
      setNotice({ tone: "error", text: errorMessage(cause) });
      return false;
    } finally {
      setBusyIds((old) => { const next = new Set(old); next.delete(id); return next; });
    }
  }, [refreshRow, onMutated]);

  // Reclassifying queues a fresh draft in the background, so the row read
  // straight after the call has no draft yet. A second read a few seconds
  // later usually catches it; if not, the row still shows the action type and
  // the reader can open the record.
  const refreshLater = useCallback((id: string) => {
    timers.current.push(setTimeout(() => { void refreshRow(id).catch(() => undefined); }, 8_000));
  }, [refreshRow]);

  const classify = useCallback(async (action: Action, choice: { categoryKey: string; subcategoryId: string | null }) => {
    const id = actionId(action);
    const record = asObject(action.record);
    const ok = await mutateRow(id, `/records/${id}/classification`, { ...choice, expectedContextVersion: record.contextVersion, classificationId: asObject(action.classification).id }, "PATCH", "Classification updated — a new draft is being written");
    if (ok) refreshLater(id);
  }, [mutateRow, refreshLater]);

  return { busyIds, notice, setNotice, mutateRow, classify, refreshRow };
}

/**
 * Keeps a list current while a record is changed in the pop-up over it: a
 * change to a record this list holds re-reads that one row (swap or drop, as
 * an inline edit does). Records the list does not hold are ignored.
 */
export function useSyncRecordChanges(actions: Action[], refreshRow: (id: string) => Promise<unknown>, onMutated?: () => void) {
  const ids = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => { ids.current = new Set(actions.map(actionId)); }, [actions]);
  useRecordChanged((recordId) => {
    if (!ids.current.has(recordId)) return;
    void refreshRow(recordId).then(() => onMutated?.()).catch(() => undefined);
  });
}

/**
 * Hands these rows, in the order shown, to the record pop-up so it can step
 * from one lead to the next (see recordQueue.ts).
 */
function usePublishRecordQueue(actions: Action[], hasMore = false, loadMore?: () => void) {
  const published = useRef<RecordQueue | null>(null);
  useEffect(() => {
    const queue: RecordQueue = {
      items: actions.map((action) => {
        const person = asObject(action.person);
        return {
          id: actionId(action),
          name: displayName({ ...action, ...asObject(action.record) }),
          avatarUrl: person.profilePictureUrl ? String(person.profilePictureUrl) : null,
          channel: actionChannel(action),
        };
      }).filter((item) => item.id),
      hasMore,
      loadMore,
    };
    published.current = queue;
    publishRecordQueue(queue);
  }, [actions, hasMore, loadMore]);
  useEffect(() => () => withdrawRecordQueue(published.current), []);
}

export function NoticeBar({ notice, onDismiss, className }: { notice: Notice | null; onDismiss: () => void; className?: string }) {
  if (!notice) return null;
  return <div role="status" className={cn("flex items-center gap-2 px-4 py-2 text-paragraph-sm", notice.tone === "error" ? "bg-error-lighter text-error-dark" : "bg-success-lighter text-success-dark", className)}>
    {notice.tone === "error" ? <RiCloseLine className="size-4 shrink-0" aria-hidden="true" /> : <RiCheckLine className="size-4 shrink-0" aria-hidden="true" />}
    <span className="min-w-0 flex-1 truncate">{notice.text}</span>
    <button type="button" onClick={onDismiss} className="text-label-xs opacity-70 hover:opacity-100">Dismiss</button>
  </div>;
}

type EmptyCopy = { icon: React.ComponentType<{ className?: string }>; title: string; detail: string; action?: React.ReactNode };

type RowsProps = {
  actions: Action[];
  categories: Data[];
  onActionsChange: React.Dispatch<React.SetStateAction<Action[]>>;
  /** Rows from the Pipeline: they stay after being acted on, and the last column reads as a status. */
  pipeline?: boolean;
  /** A refetch is under way: the rows stay, dimmed, instead of blanking. */
  refreshing?: boolean;
  onMutated?: () => void;
  empty: EmptyCopy;
  /** More pages exist; the record pop-up loads them when it steps near the end. */
  hasMore?: boolean;
  onLoadMore?: () => void;
};

export function ActionRows({ actions, categories, onActionsChange, pipeline, refreshing, onMutated, empty, hasMore, onLoadMore }: RowsProps) {
  const router = useRouter();
  const [editingId, setEditingId] = useState("");
  // Read once per mount so the "follow-up overdue" arithmetic stays pure.
  const [now] = useState(() => Date.now());
  const onRowGone = useCallback((id: string) => setEditingId((current) => current === id ? "" : current), []);
  const { busyIds, notice, setNotice, mutateRow, classify, refreshRow } = useRowMutations({ onActionsChange, pipeline, onMutated, onRowGone });
  useSyncRecordChanges(actions, refreshRow, onMutated);
  usePublishRecordQueue(actions, hasMore, onLoadMore);

  if (!actions.length) return <EmptyState icon={empty.icon} title={empty.title} description={empty.detail} action={empty.action} />;
  return <HoverPreviewProvider>
    <NoticeBar notice={notice} onDismiss={() => setNotice(null)} className="border-b border-stroke-soft-200" />
    {/* Below md the table would only scroll sideways, so each row is a card. */}
    <div aria-busy={refreshing || undefined} className={cn("space-y-2 bg-bg-weak-50 p-2 transition-opacity md:hidden", refreshing && "pointer-events-none opacity-60")}>
      {actions.map((action, index) => {
        const id = actionId(action);
        return <ActionCard
          key={`${id}-${index}`}
          action={action}
          categories={categories}
          now={now}
          busy={busyIds.has(id)}
          pipeline={pipeline}
          onOpen={() => router.push(id ? `/crm/records/${id}` : "/crm/actions")}
          onMutate={(path, body, method, success) => mutateRow(id, path, body, method, success)}
          onClassify={(choice) => classify(action, choice)}
        />;
      })}
    </div>
    <div aria-busy={refreshing || undefined} className={cn("hidden overflow-x-auto p-2 transition-opacity md:block", refreshing && "pointer-events-none opacity-60")}>
      <Table.Root className="min-w-[1000px]" style={{ tableLayout: "fixed" }}>
        <caption className="sr-only">People and CRM actions requiring review</caption>
        <Table.Header>
          <Table.Row>
            <Table.Head scope="col" className="w-[19%] px-4">Contact</Table.Head>
            <Table.Head scope="col" className="w-[18%] px-4">Classification</Table.Head>
            <Table.Head scope="col" className="w-[20%] px-4">Latest reply</Table.Head>
            <Table.Head scope="col" className="w-[23%] px-4">Draft reply</Table.Head>
            <Table.Head scope="col" className="w-[17%] px-3 text-right">{pipeline ? "Status" : "Due"}</Table.Head>
            <Table.Head scope="col" className="w-12 px-2"><span className="sr-only">More actions</span></Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body spacing={4}>{actions.map((action, index) => {
          const id = actionId(action);
          const busy = busyIds.has(id);
          const editing = editingId === id;
          const onMutate: RowMutation = async (path, body, method, success) => {
            const ok = await mutateRow(id, path, body, method, success);
            // Send and discard end the edit: the draft they acted on is gone.
            // A regenerate keeps it open so the rewrite is read right there,
            // and a failed call keeps the editor open with the text intact.
            if (ok && method === "POST" && !path.endsWith("/regenerate")) setEditingId("");
            return ok;
          };
          return <ActionRow
            key={`${id}-${index}`}
            action={action}
            categories={categories}
            busy={busy}
            editing={editing}
            pipeline={pipeline}
            now={now}
            onOpen={() => router.push(id ? `/crm/records/${id}` : "/crm/actions")}
            onToggleEdit={() => setEditingId(editing ? "" : id)}
            onMutate={onMutate}
            onClassify={(choice) => classify(action, choice)}
          />;
        })}</Table.Body>
      </Table.Root>
    </div>
  </HoverPreviewProvider>;
}

/** Contact avatar with the reply channel's mark on its corner, in the channel's own colour. */
export function ChannelAvatar({ src, name, channel, className }: { src: string | null; name: string; channel: string; className?: string }) {
  const avatarText = name === "Unknown contact" ? "?" : name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();
  const meta = CHANNEL_META[channel as keyof typeof CHANNEL_META];
  const Icon = channel === "whatsapp" ? RiWhatsappFill : channel === "linkedin" ? RiLinkedinFill : RiMailFill;
  return <span className="relative shrink-0">
    <ContactAvatar src={src} fallback={avatarText} className={cn("size-9 bg-bg-weak-50 text-label-xs text-text-sub-600 ring-1 ring-inset ring-stroke-soft-200", className)} />
    {meta && <span title={meta.label} className="absolute -bottom-0.5 -right-0.5 flex size-4 items-center justify-center rounded-full text-static-white ring-2 ring-bg-white-0" style={{ backgroundColor: meta.color }}>
      <Icon className="size-2.5" aria-hidden="true" /><span className="sr-only">{meta.label}</span>
    </span>}
  </span>;
}

type IconType = React.ComponentType<{ className?: string }>;

/**
 * Pipeline stages. Each has the colour the Analytics workflow donut gives that
 * state and an icon that says what the stage means at a glance: something to
 * do now, a wait, and a sequence that has run out.
 */
export const STAGE_META = {
  needs_action: { label: "Needs action", short: "Needs action", color: HUE.amber, badge: "orange", icon: RiFlashlightFill as IconType, detail: "A reply, draft or follow-up is due" },
  waiting: { label: "Waiting on them", short: "Waiting", color: HUE.purple, badge: "purple", icon: RiHourglass2Fill as IconType, detail: "Outreach sent, replied to, or follow-up scheduled" },
  exhausted: { label: "Follow-ups exhausted", short: "Exhausted", color: MUTED_STRONG, badge: "gray", icon: RiArchiveStackFill as IconType, detail: "Every follow-up sent, no reply yet" },
} as const;
export type PipelineStage = keyof typeof STAGE_META;

/** A stage's icon on a soft tile of its own colour — the column headers' mark. */
export function StageIcon({ stage, className, iconClassName }: { stage: PipelineStage; className?: string; iconClassName?: string }) {
  const meta = STAGE_META[stage];
  const Icon = meta.icon;
  return <span aria-hidden="true" className={cn("flex size-7 shrink-0 items-center justify-center rounded-lg", className)} style={{ backgroundColor: `color-mix(in srgb, ${meta.color} 16%, transparent)`, color: meta.color }}>
    <Icon className={cn("size-4", iconClassName)} />
  </span>;
}

type Tone = "success" | "warning" | "error" | "info" | "neutral";
const TONE_TEXT: Record<Tone, string> = {
  success: "text-success-base",
  warning: "text-warning-base",
  error: "text-error-base",
  info: "text-information-base",
  neutral: "text-text-soft-400",
};
const TONE_LABEL: Record<Tone, string> = {
  success: "text-success-dark",
  warning: "text-warning-dark",
  error: "text-error-dark",
  info: "text-information-dark",
  neutral: "text-text-sub-600",
};

/** Where the row's reply stands: one label, one colour, one icon — and what to do when it is not ready. */
type DraftState = { label: string; tone: Tone; icon: IconType; hint?: string };

function draftStateOf({ editable, draftFull, status, dnc, sendable, actionText }: { editable: boolean; draftFull: string; status: string; dnc: boolean; sendable: boolean; actionText: string }): DraftState {
  if (editable) {
    if (status === "failed") return { label: "Draft failed", tone: "error", icon: RiErrorWarningFill, hint: "Edit it or regenerate" };
    if (dnc) return { label: "Do not contact", tone: "error", icon: RiForbid2Line, hint: "Sending is blocked" };
    if (!sendable) return { label: "Out of date", tone: "warning", icon: RiErrorWarningFill, hint: "A newer reply arrived — edit before sending" };
    return { label: "Ready to send", tone: "success", icon: RiCheckboxCircleFill };
  }
  if (draftFull) return { label: humanize(status || "draft"), tone: "neutral", icon: RiDraftLine };
  switch (actionText) {
    case "Processing error": return { label: "Processing error", tone: "error", icon: RiErrorWarningFill, hint: "Open the record to retry" };
    case "Classification review": return { label: "Needs classification", tone: "warning", icon: RiPriceTag3Line, hint: "Confirm the classification first" };
    case "No sequence assigned": return { label: "No sequence", tone: "neutral", icon: RiLinkUnlink, hint: "Nothing runs for this classification" };
    case "Delivery reconciliation": return { label: "Confirm delivery", tone: "warning", icon: RiQuestionLine, hint: "Open the record to confirm the last send" };
    case "Outreach review":
    case "Reply review":
    case "Human review": return { label: "Needs a reply", tone: "info", icon: RiReplyLine, hint: "No draft yet — write one on the record" };
    default: return { label: actionText, tone: "neutral", icon: RiTimeLine };
  }
}

/** Everything a row or card shows about one action, computed once. */
export function describeAction(action: Action, categories: Data[], pipeline: boolean | undefined, now: number) {
  const record = asObject(action.record);
  const person = asObject(action.person);
  const company = asObject(action.company);
  const activeRun = asObject(action.activeRun);
  const sequence = asObject(activeRun.sequence);
  const step = asObject(activeRun.step);
  const inbound = asObject(action.latestInbound);
  const subcategory = asObject(action.subcategory);
  const classification = asObject(action.classification);
  // The AI may only move a record forward; a sideways or backward proposal is
  // held as `status: "proposed"` instead of applied, so it needs a human
  // decision here rather than sitting silent in the classification history.
  const proposedCategoryKey = classification.proposedCategoryKey ? String(classification.proposedCategoryKey) : null;
  const proposedSubcategoryId = classification.proposedSubcategoryId ? String(classification.proposedSubcategoryId) : null;
  const proposedSubcategoryName = proposedSubcategoryId
    ? categories.flatMap((item) => asList<Data>(item.subcategories)).find((entry) => String(entry.id) === proposedSubcategoryId)?.name
    : null;
  const proposedLabel = proposedSubcategoryName ? String(proposedSubcategoryName) : humanize(proposedCategoryKey);
  const keepCategoryKey = String(record.categoryKey ?? classification.category ?? "other");
  const keepSubcategoryId = record.subcategoryId ? String(record.subcategoryId) : null;
  const id = actionId(action);
  const href = id ? `/crm/records/${id}` : "/crm/actions";
  const category = actionCategory(action);
  const channel = actionChannel(action);
  const due = action.dueAt ?? action.nextActionAt;
  const dueState = actionDueState(action);
  // A drafted follow-up's nextActionAt is the moment it was drafted, which is
  // within a minute of when it came due — so once a day has passed it is a
  // follow-up that is overdue, not merely ready, and the row says by how much.
  const followUpOverdueDays = dueState === "follow_up_ready" && due
    ? Math.floor((now - new Date(String(due)).getTime()) / 86_400_000)
    : 0;
  const followUpOverdue = followUpOverdueDays >= 1;
  // On the pipeline, a record off the queue has no due action to name; the
  // column says which stage it is in and the next or last thing that happened.
  const stage = (pipeline ? String(action.stage ?? "needs_action") : "needs_action") as PipelineStage;
  const lastSent = record.lastOutboundAt ? `Sent ${timeAgo(record.lastOutboundAt)}` : "";
  const dueLabel = stage === "exhausted" ? "Exhausted"
    : stage === "waiting" ? "Waiting"
    : followUpOverdue ? "Follow-up due" : CRM_DUE_STATE_LABELS[dueState];
  // "Immediate reply" is already the whole story; a timestamp next to it
  // just repeats "now". The scheduled states are the ones worth dating.
  const dueDetail = stage === "exhausted" ? lastSent
    : stage === "waiting" ? due ? `Next ${relativeDate(due)}` : lastSent
    : dueState === "past_due" || dueState === "follow_up" || followUpOverdue ? relativeDate(due) : "";
  const urgent = dueState === "immediate_reply" || dueState === "past_due" || followUpOverdue;
  const dueColor: React.ComponentProps<typeof Badge.Root>["color"] = stage === "exhausted" ? "gray"
    : stage === "waiting" ? "purple"
    : urgent ? "red"
    : dueState === "follow_up_ready" ? "orange"
    : dueState === "auto_follow_up" ? "blue"
    : dueState === "follow_up" ? "blue"
    : "gray";
  const dueIcon: IconType = stage === "exhausted" ? STAGE_META.exhausted.icon
    : stage === "waiting" ? STAGE_META.waiting.icon
    : dueState === "past_due" || followUpOverdue ? RiAlarmWarningFill
    : dueState === "immediate_reply" ? RiFlashlightFill
    : dueState === "follow_up_ready" || dueState === "auto_follow_up" ? RiMailSendLine
    : dueState === "follow_up" ? RiCalendarScheduleLine
    : RiTimeLine;
  const name = displayName({ ...action, ...record });
  const personTitle = typeof person.title === "string" && person.title.trim() ? person.title.trim() : "";
  // The channel already shows on the avatar, so the line under the name says
  // which company this is — its domain, or the email's when no company is
  // linked — rather than repeating the address or profile URL.
  const companyDomain = company.domain ? String(company.domain)
    : person.email ? String(person.email).split("@")[1] ?? "" : "";
  const companyName = company.name ? String(company.name).trim() : "";
  const companyLabel = [personTitle, companyName || companyDomain].filter(Boolean).join(" · ");
  const leadContext = extractLeadContext(person, company);
  const leadContextSummary = leadContext.leadReason || leadContext.verificationNote;
  const leadContextFull = [
    leadContext.leadReason ? `录入理由与切入方案：\n${leadContext.leadReason}` : "",
    leadContext.verificationNote ? `联系人核验依据：\n${leadContext.verificationNote}` : "",
  ].filter(Boolean).join("\n\n");
  const latestReplyFull = String(inbound.bodyText ?? action.latestInboundExcerpt ?? "").trim();
  const latestReply = String(action.latestInboundExcerpt ?? "").replace(/\s+/g, " ").trim();
  // The draft is the thing a reviewer actually opens the row for, so it
  // takes the column the action type used to hold — the action type only
  // fills in for the rows that have no draft waiting.
  const draft = asObject(action.draft);
  const draftFull = String(draft.editedBodyText ?? draft.aiBodyText ?? "").trim();
  const draftReply = draftFull.replace(/\s+/g, " ");
  const editable = editableDraft(action);
  const repliedAt = record.lastInboundAt ?? record.updatedAt;
  // The sequence is context for the action, not a decision of its own, so
  // it rides underneath it and simply disappears when nothing is running.
  // A drafted follow-up names its number so "Follow-up ready" on the right
  // reads as "Follow-up 2 · Share Information" here, not just the step's name.
  const stepLabel = action.draftStepLabel ? String(action.draftStepLabel) : step.name ? String(step.name) : "";
  const lastRun = asObject(action.lastRun);
  const sequenceLabel = sequence.name ? `${String(sequence.name)}${stepLabel ? ` · ${stepLabel}` : ""}`
    : stage === "exhausted" && lastRun.sequenceName ? `${String(lastRun.sequenceName)} · completed` : "";
  // Send-as-written needs a draft the server will accept unchanged: not
  // stale against the conversation and not to a Do-Not-Contact person.
  const dnc = Boolean(asObject(action.contactPolicy).doNotContact);
  const sendableDraft = Boolean(editable) && !dnc && Number(editable?.expectedContextVersion) === Number(record.contextVersion);
  const actionText = actionType(action);
  const draftState = draftStateOf({ editable: Boolean(editable), draftFull, status: String(draft.status ?? ""), dnc, sendable: sendableDraft, actionText });
  const crmStageDisplay = deriveCrmRecordStageDisplay(
    {
      record,
      draft,
      subcategoryName: subcategory.name ? String(subcategory.name) : null,
      dnc,
    },
    now,
  );
  return {
    id, href, record, person, activeRun, inbound, subcategory, classification, category, channel, stage,
    proposedCategoryKey, proposedSubcategoryId, proposedLabel, keepCategoryKey, keepSubcategoryId,
    dueLabel, dueDetail, dueColor, dueIcon, actionText, name, companyDomain, companyLabel,
    leadContext, leadContextSummary, leadContextFull,
    latestReplyFull, latestReply, draft, draftFull, draftReply, editable, repliedAt, sequenceLabel, stepLabel, sendableDraft, draftState,
    crmStageDisplay,
    avatarUrl: person.profilePictureUrl ? String(person.profilePictureUrl) : null,
  };
}

type Row = ReturnType<typeof describeAction>;

/**
 * Warm the record page once the pointer has rested on a row: the route shell
 * through Next and the workspace through our own cache. The delay keeps a
 * scroll across the table from firing thirty requests.
 */
export function useRecordPrefetch(id: string, href: string) {
  const router = useRouter();
  const prefetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const arm = () => {
    if (!id || prefetchTimer.current) return;
    prefetchTimer.current = setTimeout(() => { prefetchTimer.current = null; router.prefetch(href); prefetchRecordWorkspace(id); }, 150);
  };
  const cancel = () => { if (prefetchTimer.current) { clearTimeout(prefetchTimer.current); prefetchTimer.current = null; } };
  useEffect(() => () => { if (prefetchTimer.current) clearTimeout(prefetchTimer.current); }, []);
  return { arm, cancel };
}

/**
 * The AI's held proposal as one compact pill: what it suggests, then Accept
 * (✓) and Keep current (✕) as labelled icon buttons, so the decision fits on
 * the line under the classification instead of stacking three.
 */
export function ProposalInline({ label, busy, onAccept, onKeep, className }: { label: string; busy: boolean; onAccept: () => void; onKeep: () => void; className?: string }) {
  const button = "flex h-full w-6 shrink-0 items-center justify-center transition hover:bg-bg-white-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-stroke-strong-950 disabled:opacity-60";
  return <div className={cn("inline-flex h-6 max-w-full items-stretch overflow-hidden rounded-md bg-warning-lighter text-warning-dark ring-1 ring-inset ring-warning-light", className)}>
    <span className="flex min-w-0 items-center gap-1 pl-1.5 pr-1.5 text-label-xs" title={`AI suggests: ${label}`}>
      <RiSparklingFill className="size-3 shrink-0" aria-hidden="true" />
      <span className="truncate"><span className="sr-only">AI suggests </span>{label}</span>
    </span>
    <button type="button" disabled={busy} onClick={onAccept} aria-label={`Accept AI suggestion: ${label}`} title={`Accept: move to ${label}`} className={cn(button, "border-l border-warning-light")}>
      <RiCheckLine className="size-3.5" aria-hidden="true" />
    </button>
    <button type="button" disabled={busy} onClick={onKeep} aria-label="Keep the current classification" title="Keep current classification" className={cn(button, "border-l border-warning-light")}>
      <RiCloseLine className="size-3.5" aria-hidden="true" />
    </button>
  </div>;
}

/** Classification chip — the cell centres it in the row — and, while the AI holds a proposal, the choice to accept it. */
function ClassificationCell({ row, categories, busy, onClassify }: { row: Row; categories: Data[]; busy: boolean; onClassify: (choice: { categoryKey: string; subcategoryId: string | null }) => Promise<void> }) {
  const categoryKey = row.category === "unclassified" ? null : row.category;
  const subcategoryName = row.subcategory.name ? String(row.subcategory.name) : null;
  const stageStyle = LEAD_CRM_BADGE_STYLE[row.crmStageDisplay.kind];
  return <div className="min-w-0">
    <ClassificationPicker
      compact
      quiet
      categories={categories}
      categoryKey={categoryKey}
      subcategoryId={row.record.subcategoryId ? String(row.record.subcategoryId) : null}
      subcategoryName={subcategoryName}
      placeholderLabel={row.crmStageDisplay.chip}
      placeholderTone={stageStyle.tone}
      placeholderDot={stageStyle.dot}
      disabled={busy}
      title={categoryKey ? "Fix classification — the AI misread this reply" : `${row.crmStageDisplay.chip} — click to set category manually`}
      onChange={(choice) => void onClassify(choice)}
    />
    {row.classification.status === "proposed" && <ProposalInline
        className="mt-1"
        label={row.proposedLabel}
        busy={busy}
        onAccept={() => void onClassify(row.proposedCategoryKey ? { categoryKey: row.proposedCategoryKey, subcategoryId: row.proposedSubcategoryId } : { categoryKey: row.keepCategoryKey, subcategoryId: row.keepSubcategoryId })}
        onKeep={() => void onClassify({ categoryKey: row.keepCategoryKey, subcategoryId: row.keepSubcategoryId })}
      />}
  </div>;
}

/** The channel's own mark in its identity colour. */
function ChannelMark({ channel, className }: { channel: string; className?: string }) {
  const meta = CHANNEL_META[channel as keyof typeof CHANNEL_META];
  if (!meta) return null;
  const Icon = meta.icon;
  return <span className={cn("flex shrink-0", className)} style={{ color: meta.color }} title={meta.label}><Icon className="size-3.5" aria-hidden="true" /></span>;
}

/** Their last message as a quote, with where and when it arrived underneath (falls back to lead context before first reply). */
function ReplyQuote({ row, lines = 1 }: { row: Row; lines?: 1 | 2 }) {
  if (!row.latestReply && row.leadContextSummary) {
    return <div className="min-w-0 border-l-2 border-primary-alpha-24 pl-2.5">
      <p className={cn("text-paragraph-sm text-text-sub-600", lines === 1 ? "truncate" : "line-clamp-2")}>{row.leadContextSummary}</p>
      <p className="mt-0.5 flex items-center gap-1.5 text-paragraph-xs text-text-soft-400">
        <span>录入依据</span>
        {row.leadContext.region && <><span>·</span><span className="truncate">{row.leadContext.region}</span></>}
      </p>
    </div>;
  }
  return <div className="min-w-0 border-l-2 border-stroke-soft-200 pl-2.5">
    <p className={cn("text-paragraph-sm", lines === 1 ? "truncate" : "line-clamp-2", row.latestReply ? "text-text-strong-950" : "italic text-text-soft-400")}>{row.latestReply || "No message text"}</p>
    <p className="mt-0.5 flex items-center gap-1.5 text-paragraph-xs text-text-sub-600">
      <ChannelMark channel={row.channel} />
      <span title={formatDate(row.repliedAt)}>{timeAgo(row.repliedAt)}</span>
    </p>
  </div>;
}

/** The draft's state as coloured icon + label. */
function DraftStateLabel({ state, className }: { state: DraftState; className?: string }) {
  const Icon = state.icon;
  return <span className={cn("inline-flex shrink-0 items-center gap-1 text-label-xs", TONE_LABEL[state.tone], className)}>
    <Icon className={cn("size-3.5 shrink-0", TONE_TEXT[state.tone])} aria-hidden="true" />{state.label}
  </span>;
}

/**
 * The draft column. With a draft: its opening words, then its state and the
 * sequence step. Without one: what is missing, and the one thing to do about it.
 */
function DraftSummary({ row }: { row: Row }) {
  const state = row.draftState;
  const Icon = state.icon;
  if (!row.draftReply) {
    return <div className="min-w-0">
      <p className={cn("flex min-w-0 items-center gap-1.5 text-label-sm", TONE_LABEL[state.tone])}>
        <Icon className={cn("size-4 shrink-0", TONE_TEXT[state.tone])} aria-hidden="true" /><span className="truncate">{state.label}</span>
      </p>
      {(state.hint || row.sequenceLabel) && <p className="mt-0.5 truncate pl-5.5 text-paragraph-xs text-text-soft-400" title={state.hint || row.sequenceLabel}>{state.hint || row.sequenceLabel}</p>}
    </div>;
  }
  return <div className="min-w-0">
    <p className="truncate text-paragraph-sm text-text-sub-600">{row.draftReply}</p>
    <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-paragraph-xs">
      <DraftStateLabel state={state} />
      {/* The step, not the sequence: the sequence is usually named after the
          classification the column to the left already shows. */}
      {row.sequenceLabel && <><span aria-hidden="true" className="text-text-disabled-300">·</span><span className="truncate text-text-soft-400" title={row.sequenceLabel}>{row.stepLabel || row.sequenceLabel}</span></>}
    </p>
  </div>;
}

/** Due (or, on the pipeline, stage) as one chip with an icon; the when, if any, underneath. */
function DueChip({ row, align = "end" }: { row: Row; align?: "start" | "end" }) {
  if (row.dueLabel === "—") return <span className="text-paragraph-sm text-text-soft-400" title="Nothing scheduled">—</span>;
  return <div className={cn("flex min-w-0 flex-col gap-1", align === "end" ? "items-end" : "items-start")}>
    <Badge.Root variant="lighter" size="medium" color={row.dueColor} className="h-6 max-w-full shrink-0 gap-1 whitespace-nowrap px-2" title={row.dueLabel}>
      <Badge.Icon as={row.dueIcon} className="-ml-0.5 mr-0 size-3.5" /><span>{row.dueLabel}</span>
    </Badge.Root>
    {row.dueDetail && row.dueDetail !== "—" && <span className="whitespace-nowrap text-paragraph-xs tabular-nums text-text-sub-600">{row.dueDetail}</span>}
  </div>;
}

function sendDraft(row: Row, onMutate: RowMutation, scheduleInWorkingHours = false) {
  const editable = row.editable;
  if (!editable) return;
  const payload = scheduleInWorkingHours
    ? { revision: Number(editable.revision ?? 1), scheduleInWorkingHours: true }
    : { revision: Number(editable.revision ?? 1) };
  void onMutate(
    `/drafts/${String(editable.id)}/send`,
    payload,
    "POST",
    scheduleInWorkingHours ? "Queued for working hours" : "Message sent",
  );
}

function ActionRow({ action, categories, busy, editing, pipeline, now, onOpen, onToggleEdit, onMutate, onClassify }: {
  action: Action;
  categories: Data[];
  busy: boolean;
  editing: boolean;
  pipeline?: boolean;
  now: number;
  onOpen: () => void;
  onToggleEdit: () => void;
  onMutate: RowMutation;
  onClassify: (choice: { categoryKey: string; subcategoryId: string | null }) => Promise<void>;
}) {
  const row = describeAction(action, categories, pipeline, now);
  const { id, href, record, editable } = row;
  const { arm, cancel } = useRecordPrefetch(id, href);
  const sendable = row.sendableDraft && !busy;
  const openRow = (event: React.MouseEvent<HTMLTableRowElement>) => {
    // Controls inside the row act on their own, and a click that ends a text
    // selection is a read, not a request to leave the page.
    if ((event.target as HTMLElement).closest("a, button, select, input, textarea, [role='menu'], [role='listbox'], [role='dialog'], [data-row-tools]")) return;
    if (window.getSelection()?.toString()) return;
    onOpen();
  };
  const sendTitle = sendable ? "Send this draft as written" : "This draft cannot be sent as-is; edit it first";

  return <>
    <Table.Row
      tabIndex={0}
      onClick={openRow}
      onKeyDown={(event) => { if (event.target === event.currentTarget && event.key === "Enter") onOpen(); }}
      onMouseEnter={arm}
      onMouseLeave={cancel}
      onFocus={arm}
      aria-busy={busy || undefined}
      className={cn("group cursor-pointer outline-none focus-visible:[&>td]:bg-bg-weak-50", busy && "pointer-events-none opacity-60", editing && "[&>td]:bg-bg-weak-50")}
    >
      <Table.Cell className="px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <ChannelAvatar src={row.avatarUrl} name={row.name} channel={row.channel} />
          <div className="min-w-0">
            <Link href={href} className="block truncate text-label-sm text-text-strong-950 hover:text-primary-base" title={row.name}>{row.name}</Link>
            {row.companyLabel && <p className="mt-0.5 flex items-center gap-1.5 text-paragraph-xs text-text-sub-600">
              {row.companyDomain && <CompanyFavicon domain={row.companyDomain} />}
              <span className="truncate" title={row.companyLabel}>{row.companyLabel}</span>
            </p>}
          </div>
        </div>
      </Table.Cell>
      <Table.Cell className="px-4 py-3 align-middle" data-row-tools>
        <ClassificationCell row={row} categories={categories} busy={busy} onClassify={onClassify} />
      </Table.Cell>
      <Table.Cell className="px-4 py-3">
        <HoverPreview
          title={row.latestReplyFull ? (String(row.inbound.subject ?? "").trim() || row.name) : `${row.name}${row.leadContext.companyCode ? ` · ${row.leadContext.companyCode}` : ""}`}
          meta={row.latestReplyFull ? formatDate(row.inbound.sentAt ?? row.repliedAt) : (row.leadContext.region || "拓客录入依据")}
          body={row.latestReplyFull || row.leadContextFull}
        >
          <ReplyQuote row={row} />
        </HoverPreview>
      </Table.Cell>
      <Table.Cell className="relative px-4 py-3">
        {/* Hover the text for the whole draft (with Edit and Send there too);
            the same two actions float in at the cell's end while the row is
            hovered or focused, so a ready draft is one click from sent. */}
        <HoverPreview
          className="min-w-0"
          title={String(row.draft.subject ?? "").trim() || (row.draftFull ? "Draft reply" : "")}
          meta={row.draftState.label}
          body={row.draftFull}
          disabled={editing}
          onActivate={editable ? onToggleEdit : undefined}
          actions={editable && <>
            <button type="button" className={cn(secondaryButtonClass, "h-8")} onClick={onToggleEdit}><RiPencilLine className="size-4" aria-hidden="true" />{editing ? "Close editor" : "Edit"}</button>
            <SendDraftButton
              size="sm"
              disabled={!sendable}
              title={sendTitle}
              onSendNow={() => sendDraft(row, onMutate, false)}
              onQueueInWorkingHours={() => sendDraft(row, onMutate, true)}
            />
          </>}
        >
          <DraftSummary row={row} />
        </HoverPreview>
        {editable && !editing && <div data-row-tools className="pointer-events-none absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1 rounded-lg bg-bg-white-0 p-1 opacity-0 shadow-regular-md ring-1 ring-inset ring-stroke-soft-200 transition-opacity group-hover/row:pointer-events-auto group-hover/row:opacity-100 group-focus-within/row:pointer-events-auto group-focus-within/row:opacity-100 has-[[data-state=open]]:pointer-events-auto has-[[data-state=open]]:opacity-100">
          <Button.Root variant="neutral" mode="ghost" size="xxsmall" onClick={onToggleEdit} aria-label={`Edit the draft to ${row.name}`} title="Edit the draft here"><Button.Icon as={RiPencilLine} /></Button.Root>
          <SendDraftButton
            size="xs"
            disabled={!sendable}
            title={sendTitle}
            ariaLabel={`Send the draft to ${row.name} now`}
            onSendNow={() => sendDraft(row, onMutate, false)}
            onQueueInWorkingHours={() => sendDraft(row, onMutate, true)}
          />
        </div>}
      </Table.Cell>
      <Table.Cell className="px-3 py-3 text-right">
        <DueChip row={row} />
      </Table.Cell>
      <Table.Cell className="px-2 py-3" data-row-tools onKeyDown={(event) => event.stopPropagation()}>
        <RowMenu
          href={href}
          draft={editable}
          hasRun={Boolean(row.activeRun.run)}
          recordId={id}
          categories={categories}
          categoryKey={row.category === "unclassified" ? null : row.category}
          subcategoryId={record.subcategoryId ? String(record.subcategoryId) : null}
          contextVersion={Number(record.contextVersion)}
          onMutate={onMutate}
          onMoveStage={(body) => onMutate(`/records/${id}/stage`, body, "POST", moveStageSuccessMessage(body))}
          label={`More actions for ${row.name}`}
        />
      </Table.Cell>
    </Table.Row>
    {editing && editable && <tr>
      <td colSpan={6} className="rounded-xl bg-bg-weak-50 px-4 pb-4 pt-2">
        <InlineDraftEditor action={action} busy={busy} onMutate={onMutate} onClose={onToggleEdit} />
      </td>
    </tr>}
  </>;
}

export function RowMenu({ href, draft, hasRun, recordId, categories, categoryKey, subcategoryId, contextVersion, onMutate, onMoveStage, label, className }: {
  href: string;
  draft: Data | null;
  hasRun: boolean;
  recordId: string;
  categories: Data[];
  categoryKey: string | null;
  subcategoryId: string | null;
  contextVersion: number;
  onMutate: RowMutation;
  onMoveStage: (body: MoveStageBody) => Promise<boolean>;
  label: string;
  className?: string;
}) {
  const tomorrow = () => new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const [regenerateOpen, setRegenerateOpen] = useState(false);
  const [moveStageOpen, setMoveStageOpen] = useState(false);
  return <>
    {draft && <RegenerateDraftDialog open={regenerateOpen} onOpenChange={setRegenerateOpen} onSubmit={(feedback) => onMutate(`/drafts/${String(draft.id)}/regenerate`, { feedback }, "POST", "Draft rewritten with your notes")} />}
    <MoveStageDialog open={moveStageOpen} onOpenChange={setMoveStageOpen} categories={categories} categoryKey={categoryKey} subcategoryId={subcategoryId} contextVersion={contextVersion} onMove={onMoveStage} />
    <Dropdown.Root>
      <Dropdown.Trigger asChild>
        <Button.Root variant="neutral" mode="ghost" size="xsmall" aria-label={label} className={className}><Button.Icon as={RiMoreLine} /></Button.Root>
      </Dropdown.Trigger>
      <Dropdown.Content align="end">
        <Dropdown.Item asChild><Link href={href}><Dropdown.ItemIcon as={RiExternalLinkLine} />Open record</Link></Dropdown.Item>
        <Dropdown.Item onSelect={() => setMoveStageOpen(true)}><Dropdown.ItemIcon as={RiArrowRightLine} />Move stage…</Dropdown.Item>
        {hasRun && <Dropdown.Item onSelect={() => void onMutate(`/records/${recordId}/snooze`, { until: tomorrow() }, "POST", "Snoozed for a day")}><Dropdown.ItemIcon as={RiTimerLine} />Snooze a day</Dropdown.Item>}
        {draft && <>
          <Dropdown.Separator />
          <Dropdown.Item onSelect={() => setRegenerateOpen(true)}><Dropdown.ItemIcon as={RiRefreshLine} />Regenerate draft…</Dropdown.Item>
          <Dropdown.Item destructive onSelect={() => void onMutate(`/drafts/${String(draft.id)}/discard`, {}, "POST", "Draft discarded")}><Dropdown.ItemIcon as={RiDeleteBinLine} />Discard draft</Dropdown.Item>
        </>}
      </Dropdown.Content>
    </Dropdown.Root>
  </>;
}

/** The company's favicon; one that fails to load is dropped, not left broken. */
export function CompanyFavicon({ domain }: { domain: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  // eslint-disable-next-line @next/next/no-img-element -- remote favicon service, sized by CSS
  return <img src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=32`} alt="" className="size-3.5 shrink-0 rounded-sm" onError={() => setFailed(true)} />;
}

/**
 * One action as a card: the pipeline board's unit, and the Action required
 * list's below md, where a six-column table would only scroll sideways.
 * Drafts are sent from the card or opened in the record pop-up; the inline
 * editor needs the table's width.
 */
export function ActionCard({ action, categories, now, busy, onOpen, onMutate, onClassify, pipeline }: {
  pipeline?: boolean;
  action: Action;
  categories: Data[];
  now: number;
  busy: boolean;
  onOpen: () => void;
  onMutate: RowMutation;
  onClassify: (choice: { categoryKey: string; subcategoryId: string | null }) => Promise<void>;
}) {
  const row = describeAction(action, categories, pipeline, now);
  const { id, href, record, editable } = row;
  const { arm, cancel } = useRecordPrefetch(id, href);
  const sendable = row.sendableDraft && !busy;
  const open = (event: React.MouseEvent) => {
    if ((event.target as HTMLElement).closest("a, button, input, textarea, [role='menu'], [role='dialog'], [data-row-tools]")) return;
    if (window.getSelection()?.toString()) return;
    onOpen();
  };
  const sendTitle = sendable ? "Send this draft as written" : "This draft cannot be sent as-is; edit it first";
  // Off the queue (pipeline Waiting / Exhausted) the chip names what the
  // record is waiting for rather than a due action it does not have.
  const chipRow = row.stage === "needs_action" ? row : { ...row, dueLabel: row.actionText };

  return <article
    tabIndex={0}
    aria-label={row.name}
    aria-busy={busy || undefined}
    onClick={open}
    onKeyDown={(event) => { if (event.target === event.currentTarget && event.key === "Enter") onOpen(); }}
    onMouseEnter={arm}
    onMouseLeave={cancel}
    onFocus={arm}
    className={cn("cursor-pointer rounded-xl bg-bg-white-0 p-3.5 shadow-regular-xs ring-1 ring-inset ring-stroke-soft-200 outline-none transition hover:ring-stroke-sub-300 focus-visible:ring-2 focus-visible:ring-primary-base", busy && "pointer-events-none opacity-60")}
  >
    <div className="flex items-start gap-3">
      <ChannelAvatar src={row.avatarUrl} name={row.name} channel={row.channel} className="size-8" />
      <div className="min-w-0 flex-1">
        <Link href={href} className="block truncate text-label-sm text-text-strong-950 hover:text-primary-base" title={row.name}>{row.name}</Link>
        {row.companyLabel && <p className="mt-0.5 flex items-center gap-1.5 text-paragraph-xs text-text-sub-600">
          {row.companyDomain && <CompanyFavicon domain={row.companyDomain} />}
          <span className="truncate" title={row.companyLabel}>{row.companyLabel}</span>
        </p>}
      </div>
      <div data-row-tools className="-mr-1.5 -mt-1">
        <RowMenu
          href={href}
          draft={editable}
          hasRun={Boolean(row.activeRun.run)}
          recordId={id}
          categories={categories}
          categoryKey={row.category === "unclassified" ? null : row.category}
          subcategoryId={record.subcategoryId ? String(record.subcategoryId) : null}
          contextVersion={Number(record.contextVersion)}
          onMutate={onMutate}
          onMoveStage={(body) => onMutate(`/records/${id}/stage`, body, "POST", moveStageSuccessMessage(body))}
          label={`More actions for ${row.name}`}
        />
      </div>
    </div>

    <div className="mt-3 flex flex-wrap items-center gap-1.5" data-row-tools>
      {(() => {
        const cardCategoryKey = row.category === "unclassified" ? null : row.category;
        const stageStyle = LEAD_CRM_BADGE_STYLE[row.crmStageDisplay.kind];
        return <ClassificationPicker
          compact
          quiet
          categories={categories}
          categoryKey={cardCategoryKey}
          subcategoryId={record.subcategoryId ? String(record.subcategoryId) : null}
          subcategoryName={row.subcategory.name ? String(row.subcategory.name) : null}
          placeholderLabel={row.crmStageDisplay.chip}
          placeholderTone={stageStyle.tone}
          placeholderDot={stageStyle.dot}
          disabled={busy}
          title={cardCategoryKey ? "Fix classification — the AI misread this reply" : `${row.crmStageDisplay.chip} — click to set category manually`}
          onChange={(choice) => void onClassify(choice)}
        />;
      })()}
      {row.classification.status === "proposed" && <ProposalInline
        label={row.proposedLabel}
        busy={busy}
        onAccept={() => void onClassify(row.proposedCategoryKey ? { categoryKey: row.proposedCategoryKey, subcategoryId: row.proposedSubcategoryId } : { categoryKey: row.keepCategoryKey, subcategoryId: row.keepSubcategoryId })}
        onKeep={() => void onClassify({ categoryKey: row.keepCategoryKey, subcategoryId: row.keepSubcategoryId })}
      />}
    </div>

    {(row.latestReply || row.leadContextSummary) && <HoverPreview
      title={row.latestReplyFull ? (String(row.inbound.subject ?? "").trim() || row.name) : `${row.name}${row.leadContext.companyCode ? ` · ${row.leadContext.companyCode}` : ""}`}
      meta={row.latestReplyFull ? formatDate(row.inbound.sentAt ?? row.repliedAt) : (row.leadContext.region || "拓客录入依据")}
      body={row.latestReplyFull || row.leadContextFull}
      className="mt-3"
    >
      <ReplyQuote row={row} lines={2} />
    </HoverPreview>}

    {row.draftReply ? <div className="mt-3 rounded-lg bg-bg-weak-50 p-2.5 ring-1 ring-inset ring-stroke-soft-200">
      <HoverPreview
        title={String(row.draft.subject ?? "").trim() || "Draft reply"}
        meta={row.draftState.label}
        body={row.draftFull}
        onActivate={onOpen}
        actions={editable && <>
          <Link href={href} className={cn(secondaryButtonClass, "h-8")}>Open to edit</Link>
          <button type="button" className={cn(primaryButtonClass, "h-8")} disabled={!sendable} onClick={() => sendDraft(row, onMutate)} title={sendTitle}><RiSendPlaneLine className="size-4" aria-hidden="true" />Send</button>
        </>}
      >
        <p className="line-clamp-2 text-paragraph-xs text-text-sub-600">{row.draftReply}</p>
      </HoverPreview>
      <div className="mt-2 flex items-center justify-between gap-2">
        <DraftStateLabel state={row.draftState} className="min-w-0 truncate" />
        {editable && <div data-row-tools className="flex shrink-0 items-center gap-1">
          <Button.Root variant="neutral" mode="stroke" size="xxsmall" asChild><Link href={href} aria-label={`Open ${row.name} to edit the draft`}><Button.Icon as={RiPencilLine} />Edit</Link></Button.Root>
          <Button.Root variant="primary" mode="filled" size="xxsmall" disabled={!sendable} onClick={() => sendDraft(row, onMutate)} aria-label={`Send the draft to ${row.name}`} title={sendTitle}><Button.Icon as={RiSendPlaneFill} />Send</Button.Root>
        </div>}
      </div>
    </div>
      : row.stage === "needs_action" && <div className="mt-3"><DraftSummary row={row} /></div>}

    <div className="mt-3 flex items-center justify-between gap-2 border-t border-stroke-soft-200 pt-3">
      <Badge.Root variant="lighter" size="medium" color={chipRow.dueColor} className="h-6 min-w-0 shrink gap-1 px-2" title={chipRow.dueLabel}>
        <Badge.Icon as={chipRow.dueIcon} className="-ml-0.5 mr-0 size-3.5" /><span className="truncate">{chipRow.dueLabel === "—" ? "Nothing due" : chipRow.dueLabel}</span>
      </Badge.Root>
      {/* The quote above already says when they replied; this is the when of the chip. */}
      <span className="shrink-0 text-paragraph-xs tabular-nums text-text-sub-600" title={formatDate(row.repliedAt)}>{row.dueDetail && row.dueDetail !== "—" ? row.dueDetail : row.latestReply ? "" : timeAgo(row.repliedAt)}</span>
    </div>
    {row.sequenceLabel && <p className="mt-1.5 truncate text-paragraph-xs text-text-soft-400" title={row.sequenceLabel}>{row.sequenceLabel}</p>}
  </article>;
}
