"use client";
/* eslint-disable react-hooks/set-state-in-effect */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  RiArrowDownSLine,
  RiArrowRightUpLine,
  RiBriefcaseLine,
  RiChat3Line,
  RiCheckLine,
  RiCheckboxCircleLine,
  RiCloseCircleLine,
  RiErrorWarningLine,
  RiFileTextLine,
  RiGlobalLine,
  RiHistoryLine,
  RiLinkedinLine,
  RiLoopLeftLine,
  RiMailLine,
  RiMapPinLine,
  RiMoreLine,
  RiPauseLine,
  RiPhoneLine,
  RiPlayLine,
  RiRefreshLine,
  RiReplyLine,
  RiSaveLine,
  RiSendPlaneLine,
  RiShieldCheckLine,
  RiSkipForwardLine,
  RiSparklingLine,
  RiTimerLine,
  RiUserLine,
} from "@remixicon/react";
import * as Badge from "@/components/alignui/badge";
import * as Button from "@/components/alignui/button";
import * as Dropdown from "@/components/alignui/dropdown";
import * as Modal from "@/components/alignui/modal";
import * as SegmentedControl from "@/components/alignui/segmented-control";
import { Frame, FrameHeader, FramePanel } from "@/components/analytics/kit/Frame";
import { CHANNEL_META } from "@/components/analytics/theme";
import { CallButton } from "@/components/calls/CallButton";
import { CallsCard } from "@/components/calls/CallsCard";
import { EmptyState } from "@/components/page/EmptyState";
import { PageHeader } from "@/components/page/PageHeader";
import { StatRow } from "@/components/page/StatRow";
import { PersonWhatsappPanel } from "@/components/whatsapp/PersonWhatsappPanel";
import { WhatsappLogo } from "@/components/whatsapp/WhatsappLogo";
import { cn } from "@/utils/cn";
import {
  ErrorState,
  dangerButtonClass,
  fieldClass,
  primaryButtonClass,
  secondaryButtonClass,
  subtleButtonClass,
} from "./CrmLayout";
import { RecordBody } from "./CrmSkeletons";
import { asList, asObject, crmFetch, displayName, errorMessage, extractLeadContext, formatDate, relativeDate } from "./crm-utils";
import { ClassificationPicker, MoveStageDialog, moveStageSuccessMessage, RegenerateDraftDialog, humanize } from "./ActionRowTools";
import { ContactAvatar } from "./ContactAvatar";
import { takeRecordWorkspace } from "./recordPrefetch";
import { announceRecordChanged } from "./recordEvents";
import { setUnsavedReply } from "./recordQueue";
import { ChannelAvatar } from "./CrmActionsClient";

type Data = Record<string, unknown>;
type Channel = "email" | "linkedin" | "whatsapp";
type TimelineFilter = "all" | Channel;

const eventLabels: Record<string, string> = {
  "record.created": "CRM record created",
  "reply.received": "Reply received",
  "message.recorded": "Message sent outside AgentSDR",
  "workflow.state_changed": "Workflow updated",
  "classification.proposed": "AI classification proposed",
  "classification.auto_applied": "Classification applied",
  "classification.acknowledged": "Classification acknowledged",
  "classification.changed": "Classification changed",
  "classification.failed": "Classification failed",
  "classification.stale": "Classification became outdated",
  "classification.undone": "Classification undone",
  "classification.overridden": "Classification updated",
  "contact_policy.cleared": "Contact restriction cleared",
  "contact_policy.dnc_cleared": "Do Not Contact cleared",
  "contact_policy.dnc_set": "Do Not Contact enabled",
  "contact_policy.enforced": "Contact restriction enforced",
  "draft.generated": "Reply draft generated",
  "draft.edited": "Reply draft edited",
  "draft.discarded": "Reply draft discarded",
  "draft.failed": "Draft generation failed",
  "message.sending": "Message queued for delivery",
  "message.sent": "Message delivered",
  "message.failed": "Message failed",
  "message.delivery_uncertain": "Delivery needs reconciliation",
  "message.delivery_reconciled": "Delivery status reconciled",
  "sequence.started": "Sequence started",
  "sequence.interrupted": "Sequence interrupted",
  "sequence.override_set": "Sequence override set",
  "sequence.override_cleared": "Sequence override cleared",
  "sequence.paused": "Sequence paused",
  "sequence.resumed": "Sequence resumed",
  "sequence.snoozed": "Next step snoozed",
  "sequence.step_skipped": "Sequence step skipped",
  "record.closed": "Record closed",
  "record.reopened": "Record reopened",
  "stage.moved": "Stage moved",
};

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "?";
}

function channelLabel(channel: unknown): string {
  return channel === "linkedin" ? "LinkedIn" : channel === "whatsapp" ? "WhatsApp" : "Email";
}

function channelColor(channel: unknown): string | undefined {
  return CHANNEL_META[channel as keyof typeof CHANNEL_META]?.color;
}

function channelIcon(channel: unknown, className = "size-4") {
  if (channel === "whatsapp") return <WhatsappLogo className={className} />;
  const Icon = channel === "linkedin" ? RiLinkedinLine : RiMailLine;
  return <Icon className={className} aria-hidden="true" />;
}

/**
 * One lead's CRM workspace. `variant="modal"` is the same workspace inside the
 * record pop-up (src/app/@modal/(.)crm/records/[id]): no back link — the
 * pop-up's own bar closes it — and the workspace is sized to the pop-up
 * rather than the window.
 */
export default function CrmRecordClient({ recordId, variant = "page" }: { recordId: string; variant?: "page" | "modal" }) {
  const [data, setData] = useState<Data>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [workspaceRef, workspaceHeight] = useWorkspaceHeight<HTMLDivElement>(Boolean(data.id));
  const [notice, setNotice] = useState("");
  // Bumped after a call starts so the Calls card below refetches without the
  // rest of the page reloading.
  const [callsRefreshKey, setCallsRefreshKey] = useState(0);
  // Shared by the stage controls in the reply header and the AI-proposal
  // notice, which both resolve subcategory names from it.
  const [categories, setCategories] = useState<Data[]>([]);
  useEffect(() => { void crmFetch("/categories").then((result) => setCategories(asList<Data>(asObject(result).categories))).catch(() => setCategories([])); }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    // The Action required table starts this request while the pointer rests
    // on a row, so the first load usually finds it already in flight.
    try { setData(asObject(await (takeRecordWorkspace(recordId) ?? crmFetch(`/records/${recordId}`)))); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setLoading(false); }
  }, [recordId]);

  useEffect(() => { void load(); }, [load]);

  const mutate = async (path: string, body: Data = {}, method = "POST", success = "Changes saved"): Promise<boolean> => {
    setNotice("");
    setError("");
    try {
      await crmFetch(path, { method, body: JSON.stringify(body) });
      setNotice(success);
      // A list under the pop-up holding this record re-reads its row.
      announceRecordChanged(recordId);
      await load();
      return true;
    } catch (cause) {
      setError(errorMessage(cause));
      return false;
    }
  };

  // Only the first load blanks the page; a reload after an action keeps the
  // workspace on screen, dimmed, so the reader does not lose their place.
  if (loading && !data.id) return <RecordBody />;
  if (error && !data.id) return <div className="space-y-6"><PageHeader back={variant === "page" ? BACK : undefined} title="Conversation" /><ErrorState message={error} onRetry={() => void load()} /></div>;

  const person = asObject(data.person);
  const companyObj = asObject(data.company);
  const leadContext = extractLeadContext(person, companyObj);
  const draft = asObject(data.draft);
  const conversations = asList<Data>(data.conversations);
  const events = asList<Data>(data.events);
  const drafts = asList<Data>(data.drafts);
  const sendAttempts = asList<Data>(data.sendAttempts);
  const citations = asList<Data>(data.citations).filter((citation) => citation.draftId === draft.id);
  const uncertainAttempt = sendAttempts.find((attempt) => attempt.draftId === draft.id && attempt.status === "delivery_uncertain");
  // The API merges CRM rows with the LinkedIn outreach history the sending
  // engine recorded; fall back to the per-conversation lists if it is absent.
  const timeline = asList<Data>(data.timeline);
  const messages = timeline.length ? timeline : conversations.flatMap((conversation) => asList<Data>(conversation.messages).map((message) => ({
    ...message,
    channel: message.channel ?? conversation.channel,
    conversationId: message.conversationId ?? conversation.id,
  })));
  const runs = asList<Data>(data.runs);
  const activeRunRow = runs.find((row) => ["active", "paused"].includes(String(asObject(row.run).status)));
  const activeRun = asObject(activeRunRow?.run);
  const activeSequence = asObject(activeRunRow?.sequence);
  const stepRuns = asList<Data>(data.stepRuns).filter((row) => asObject(row.stepRun).sequenceRunId === activeRun.id);
  const currentStepRow = stepRuns.find((row) => Number(asObject(row.step).position) === Number(activeRun.currentStepPosition));
  const currentStep = asObject(currentStepRow?.step);
  const name = displayName({ ...data, person });
  const avatarUrl = person.profilePictureUrl ? String(person.profilePictureUrl) : null;
  const channels = [...new Set([...conversations, ...messages].map((item) => item.channel).filter(Boolean))].map(channelLabel);
  const lastInbound = data.lastInboundAt ? relativeDate(data.lastInboundAt).replace(" overdue", " ago") : "No reply yet";
  const nextAction = text(currentStep.name, data.nextActionAt ? relativeDate(data.nextActionAt) : "None scheduled");
  // The message being answered: the newest inbound one on any channel.
  const lastMessage = ([...messages] as Data[]).filter((message) => message.direction === "inbound")
    .sort((a, b) => String(b.sentAt ?? b.createdAt).localeCompare(String(a.sentAt ?? a.createdAt)))[0];

  return (
    <div className={cn("space-y-5 transition-opacity", loading && "opacity-60")} aria-busy={loading || undefined}>
      <RecordHeader
        back={variant === "page" ? BACK : undefined}
        data={data}
        person={person}
        name={name}
        avatarUrl={avatarUrl}
        currentStep={currentStep}
        activeRun={activeRun}
        onAction={mutate}
        onCallStarted={() => setCallsRefreshKey((key) => key + 1)}
        moveStage={<MoveStageDialog
          categories={categories}
          categoryKey={String(data.categoryKey ?? asObject(data.classification).category ?? "other")}
          subcategoryId={data.subcategoryId ? String(data.subcategoryId) : null}
          contextVersion={Number(data.contextVersion)}
          onMove={(body) => mutate(`/records/${String(data.id)}/stage`, body, "POST", moveStageSuccessMessage(body))}
        />}
      />

      {notice && <div role="status" className="flex items-center gap-2 rounded-xl bg-success-lighter px-4 py-2.5 text-paragraph-sm text-success-dark ring-1 ring-inset ring-success-light"><RiCheckLine className="size-4 shrink-0" aria-hidden="true" /><span className="min-w-0 flex-1">{notice}</span><button type="button" onClick={() => setNotice("")} className="text-label-xs opacity-70 hover:opacity-100">Dismiss</button></div>}
      {error && <ErrorState message={error} onRetry={() => void load()} />}

      <StatRow items={[
        { label: "Last reply", value: lastInbound, icon: RiReplyLine, hint: data.lastInboundAt ? formatDate(data.lastInboundAt) : undefined },
        { label: "Next step", value: nextAction, icon: RiTimerLine, hint: data.nextActionAt ? formatDate(data.nextActionAt) : undefined },
        { label: "Sequence", value: activeSequence.name ? `${String(activeSequence.name)}${activeRun.status === "paused" ? " · paused" : ""}` : "None running", icon: RiLoopLeftLine },
        { label: channels.length > 1 ? "Channels" : "Channel", value: channels.join(", ") || "—", icon: RiChat3Line },
      ]} />

      {(leadContext.leadReason || leadContext.verificationNote) && (
        <LeadContextCard leadReason={leadContext.leadReason} verificationNote={leadContext.verificationNote} />
      )}

      {/* The measured height only holds if the grid row is allowed to be
          smaller than its content: an auto row grows to the longest thread and
          pushes the page down regardless of the container's height, so the row
          is minmax(0,1fr) and each column is min-h-0 so the panels' own scroll
          areas do the shrinking. */}
      <div ref={workspaceRef} style={workspaceHeight ? { height: workspaceHeight } : undefined} className="grid items-start gap-5 xl:grid-cols-2 xl:grid-rows-[minmax(0,1fr)] xl:items-stretch">
        <div className="min-w-0 xl:min-h-0">
          <ReplyComposer
            record={data}
            draft={draft}
            conversations={conversations}
            citations={citations}
            uncertainAttempt={uncertainAttempt}
            lastMessage={lastMessage}
            onAction={mutate}
            stage={<ClassificationSelect record={data} categories={categories} onAction={mutate} />}
            activity={<ActivityDrawer events={events} drafts={drafts} sendAttempts={sendAttempts} />}
            stageNotice={<ProposedClassificationNotice record={data} categories={categories} onAction={mutate} />}
          />
        </div>
        <div className="min-w-0 xl:min-h-0">
          {data.activeChannel === "whatsapp"
            ? <WhatsappRecordPanel personId={String(person.id ?? data.personId)} onSent={() => { announceRecordChanged(recordId); void load(); }}>
                <ConversationPanel conversations={conversations} messages={messages} name={name} avatarUrl={avatarUrl} />
              </WhatsappRecordPanel>
            : <ConversationPanel conversations={conversations} messages={messages} name={name} avatarUrl={avatarUrl} />}
        </div>
      </div>
      <CallsCard personId={String(person.id ?? data.personId)} refreshKey={callsRefreshKey} />
    </div>
  );
}

const BACK = { href: "/crm/actions", label: "Action required" };

/**
 * Height of the workspace row, measured rather than assumed.
 *
 * The page chrome above it — header, stat row, notices — is variable: the
 * meta line wraps at narrow widths and a notice adds a row. A hard-coded
 * `100vh - Nrem` was wrong by roughly the height of the send row, which is
 * exactly the part that must stay on screen. Below the two-column breakpoint
 * the columns stack and the page scrolls normally, so no height is imposed.
 */
const WORKSPACE_MIN_HEIGHT = 520;
const TWO_COLUMN_WIDTH = 1280;

function useWorkspaceHeight<T extends HTMLElement>(ready: boolean) {
  const ref = useRef<T>(null);
  const [height, setHeight] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (!ready) return;
    const measure = () => {
      const element = ref.current;
      if (!element) return;
      if (window.innerWidth < TWO_COLUMN_WIDTH) { setHeight(undefined); return; }
      // Relative to the viewport, not the document: the app scrolls inside
      // its own pane, so window.scrollY is always 0 here. Inside the record
      // pop-up the bottom edge is the pop-up's scroll area, not the window.
      const bounds = element.closest("[data-record-scroll]");
      const top = element.getBoundingClientRect().top - (bounds ? bounds.getBoundingClientRect().top - bounds.scrollTop : 0);
      const bottom = bounds ? bounds.clientHeight : window.innerHeight;
      setHeight(Math.max(WORKSPACE_MIN_HEIGHT, bottom - top - 24));
    };
    measure();
    // Fonts and the header settle a frame after the data lands.
    const frame = requestAnimationFrame(measure);
    window.addEventListener("resize", measure);
    return () => { cancelAnimationFrame(frame); window.removeEventListener("resize", measure); };
  }, [ready]);
  return [ref, height] as const;
}

const WORKFLOW_BADGE: Record<string, { label: string; color: React.ComponentProps<typeof Badge.Root>["color"] }> = {
  action_required: { label: "Action required", color: "orange" },
  error: { label: "Error", color: "red" },
  waiting: { label: "Waiting", color: "purple" },
  paused: { label: "Paused", color: "pink" },
  closed: { label: "Closed", color: "green" },
  classifying: { label: "Classifying", color: "gray" },
  unclassified: { label: "Unclassified", color: "gray" },
  idle: { label: "Idle", color: "gray" },
};

function RecordHeader({ back, data, person, name, avatarUrl, currentStep, activeRun, onAction, onCallStarted, moveStage }: {
  /** The full page's way back to its list; the pop-up has its own close. */
  back?: { href: string; label: string };
  data: Data;
  person: Data;
  name: string;
  avatarUrl: string | null;
  currentStep: Data;
  activeRun: Data;
  onAction: (path: string, body?: Data, method?: string, success?: string) => Promise<boolean>;
  /** Bumps the Calls card's refreshKey once the extension accepts a call. */
  onCallStarted: () => void;
  /** Move stage: record something that happened and move the lead on. */
  moveStage: React.ReactNode;
}) {
  const id = String(data.id);
  const personId = String(person.id ?? data.personId);
  const dnc = Boolean(data.dnc);
  const workflowState = String(data.workflowState ?? "");
  const closed = workflowState === "closed";
  const paused = workflowState === "paused" || activeRun.status === "paused";
  // Skipping needs a running sequence with a step to skip.
  const canSkip = !closed && !paused && activeRun.status === "active" && Boolean(currentStep.name);
  const title = text(person.title);
  const companyRecord = asObject(data.company);
  const company = text(person.company) || text(companyRecord.name);
  const companyDomain = text(companyRecord.domain);
  const companyHref = companyDomain ? (companyDomain.startsWith("http") ? companyDomain : `https://${companyDomain}`) : "";
  const leadContext = extractLeadContext(person, companyRecord);
  const email = text(person.email);
  const phone = text(person.phone) || null;
  const linkedin = text(person.linkedinUrl);
  // Show the profile address the way the email address is shown, rather than a
  // "Profile" label that hides which account it points at.
  const linkedinHref = linkedin.startsWith("http") ? linkedin : `https://www.linkedin.com/in/${linkedin}`;
  const linkedinSlug = linkedin.replace(/\/+$/, "").split("/").pop() || linkedin;
  const state = WORKFLOW_BADGE[workflowState];

  return (
    <PageHeader
      back={back}
      title={<span className="flex min-w-0 items-center gap-3">
        <ChannelAvatar src={avatarUrl} name={name} channel={String(data.activeChannel ?? "")} className="size-10" />
        <span className="truncate">{name}</span>
      </span>}
      badge={<>
        {leadContext.companyCode && <Badge.Root variant="lighter" size="medium" color="gray">{leadContext.companyCode}</Badge.Root>}
        {state && <Badge.Root variant="lighter" size="medium" color={state.color}><Badge.Dot />{state.label}</Badge.Root>}
        {dnc && <Badge.Root variant="lighter" size="medium" color="red"><Badge.Dot />Do not contact</Badge.Root>}
      </>}
      description={<div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-paragraph-sm text-text-sub-600">
        {(title || company) && <span className="inline-flex min-w-0 items-center gap-1.5"><RiBriefcaseLine className="size-4 shrink-0 text-text-soft-400" aria-hidden="true" /><span className="truncate">{[title, company].filter(Boolean).join(" · ")}</span></span>}
        {companyDomain && <a href={companyHref} target="_blank" rel="noreferrer" className="inline-flex min-w-0 items-center gap-1.5 transition hover:text-text-strong-950"><RiGlobalLine className="size-4 shrink-0 text-text-soft-400" aria-hidden="true" /><span className="truncate">{companyDomain}</span><RiArrowRightUpLine className="size-3.5 shrink-0 text-text-soft-400" aria-hidden="true" /></a>}
        {leadContext.region && <span className="inline-flex items-center gap-1.5"><RiMapPinLine className="size-4 shrink-0 text-text-soft-400" aria-hidden="true" /><span>{leadContext.region}</span></span>}
        {email && <a href={`mailto:${email}`} className="inline-flex min-w-0 items-center gap-1.5 transition hover:text-text-strong-950"><RiMailLine className="size-4 shrink-0 text-text-soft-400" aria-hidden="true" /><span className="truncate">{email}</span></a>}
        {phone && <span className="inline-flex items-center gap-1.5"><RiPhoneLine className="size-4 shrink-0 text-text-soft-400" aria-hidden="true" />{phone}</span>}
        {linkedin && <a href={linkedinHref} target="_blank" rel="noreferrer" title={`Open ${name} on LinkedIn`} className="inline-flex min-w-0 items-center gap-1.5 transition hover:text-text-strong-950"><RiLinkedinLine className="size-4 shrink-0 text-text-soft-400" aria-hidden="true" /><span className="truncate">{linkedinSlug}</span><RiArrowRightUpLine className="size-3.5 shrink-0 text-text-soft-400" aria-hidden="true" /></a>}
      </div>}
      actions={<>
        <CallButton personId={personId} crmRecordId={id} phone={phone} onCallStarted={onCallStarted} />
        {canSkip && <Button.Root
          variant="neutral"
          mode="stroke"
          size="xsmall"
          title={`Mark "${String(currentStep.name)}" as done without sending it; the next step waits its usual delay`}
          onClick={() => void onAction(`/records/${id}/skip`, {}, "POST", "Step skipped — the next one is scheduled")}
        aria-label="Skip step"><Button.Icon as={RiSkipForwardLine} /><span className="hidden sm:inline">Skip step</span></Button.Root>}
        {moveStage}
        <Dropdown.Root>
          <Dropdown.Trigger asChild>
            <Button.Root variant="neutral" mode="stroke" size="xsmall" title="Manage record" aria-label="Manage record"><Button.Icon as={RiMoreLine} /></Button.Root>
          </Dropdown.Trigger>
          <Dropdown.Content align="end">
            {/* Pause and snooze are one-click record actions, so they sit
                with the other record actions rather than in a card of their own. */}
            {!closed && <>
              <Dropdown.Item onSelect={() => void onAction(`/records/${id}/${paused ? "resume" : "pause"}`, {}, "POST", paused ? "Sequence resumed" : "Sequence paused")}>
                <Dropdown.ItemIcon as={paused ? RiPlayLine : RiPauseLine} />{paused ? "Resume sequence" : "Pause sequence"}
              </Dropdown.Item>
              <Dropdown.Item onSelect={() => void onAction(`/records/${id}/snooze`, { until: new Date(Date.now() + 86_400_000).toISOString() }, "POST", "Next action snoozed for one day")}>
                <Dropdown.ItemIcon as={RiTimerLine} />Snooze a day
              </Dropdown.Item>
              <Dropdown.Separator />
            </>}
            <Dropdown.Item onSelect={() => void onAction(`/people/${personId}/dnc`, { enabled: !dnc }, "POST", dnc ? "Do not contact removed" : "Contact marked as do not contact")}>
              <Dropdown.ItemIcon as={RiUserLine} />{dnc ? "Clear do not contact" : "Mark do not contact"}
            </Dropdown.Item>
            <Dropdown.Item destructive={!closed} onSelect={() => void onAction(`/records/${id}/${closed ? "reopen" : "close"}`, closed ? {} : { reason: "Closed by operator" }, "POST", closed ? "Record reopened" : "Record closed")}>
              <Dropdown.ItemIcon as={closed ? RiPlayLine : RiCloseCircleLine} />{closed ? "Reopen record" : "Close record"}
            </Dropdown.Item>
          </Dropdown.Content>
        </Dropdown.Root>
      </>}
    />
  );
}

const INLINE_URL_PATTERN = /(https?:\/\/[^\s)）\]"'>]+)/g;

function renderTextWithLinks(content: string): React.ReactNode {
  const parts = content.split(INLINE_URL_PATTERN);
  return parts.map((part, index) => {
    if (/^https?:\/\//.test(part)) {
      return (
        <a
          key={index}
          href={part}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-0.5 text-primary-base underline decoration-primary-alpha-24 underline-offset-2 transition hover:text-primary-dark"
        >
          <span className="break-all">{part}</span>
          <RiArrowRightUpLine className="size-3.5 shrink-0" aria-hidden="true" />
        </a>
      );
    }
    return <span key={index}>{part}</span>;
  });
}

function LeadContextCard({ leadReason, verificationNote }: { leadReason: string; verificationNote: string }) {
  return (
    <div className="grid gap-2.5 rounded-xl bg-bg-weak-50 px-4 py-3 text-paragraph-xs text-text-sub-600 ring-1 ring-inset ring-stroke-soft-200 lg:grid-cols-2">
      {leadReason && (
        <div className="flex min-w-0 items-start gap-2">
          <RiFileTextLine className="mt-0.5 size-4 shrink-0 text-text-soft-400" aria-hidden="true" />
          <div className="min-w-0">
            <span className="font-medium text-text-strong-950">录入理由与切入方案：</span>
            <span className="leading-5">{renderTextWithLinks(leadReason)}</span>
          </div>
        </div>
      )}
      {verificationNote && (
        <div className="flex min-w-0 items-start gap-2">
          <RiShieldCheckLine className="mt-0.5 size-4 shrink-0 text-success-base" aria-hidden="true" />
          <div className="min-w-0">
            <span className="font-medium text-text-strong-950">联系人核验依据：</span>
            <span className="leading-5">{renderTextWithLinks(verificationNote)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The right-hand column for a WhatsApp record: the lead's live WhatsApp thread
 * with a composer (sent through Unipile), and the CRM's all-channel timeline
 * one toggle away. The Call button lives in the lead header above.
 */
function WhatsappRecordPanel({ personId, onSent, children }: { personId: string; onSent: () => void; children: React.ReactNode }) {
  const [view, setView] = useState<"whatsapp" | "all">("whatsapp");
  return (
    <div className="flex h-full min-h-[28rem] flex-col gap-2">
      <SegmentedControl.Root value={view} onValueChange={(value) => setView(value as "whatsapp" | "all")} className="shrink-0">
        <SegmentedControl.List className="w-auto" aria-label="Conversation view">
          <SegmentedControl.Trigger value="whatsapp" className="gap-1.5 px-3"><WhatsappLogo className="size-3.5" />WhatsApp</SegmentedControl.Trigger>
          <SegmentedControl.Trigger value="all" className="px-3">All channels</SegmentedControl.Trigger>
        </SegmentedControl.List>
      </SegmentedControl.Root>
      <div className="min-h-0 flex-1">
        {view === "whatsapp"
          ? <Frame className="h-full">
              <FrameHeader title="WhatsApp" description="The live thread, sent through the linked number." />
              <FramePanel className="flex min-h-0 flex-col overflow-hidden p-4 sm:p-4">
                <PersonWhatsappPanel personId={personId} onSent={onSent} className="flex min-h-0 flex-1 flex-col" heightClass="min-h-0 flex-1" />
              </FramePanel>
            </Frame>
          : children}
      </div>
    </div>
  );
}

function ConversationPanel({ conversations, messages, name, avatarUrl }: { conversations: Data[]; messages: Data[]; name: string; avatarUrl: string | null }) {
  const [filter, setFilter] = useState<TimelineFilter>("all");
  const scrollRef = useRef<HTMLDivElement>(null);
  const visible = useMemo(() => messages.filter((message) => filter === "all" || message.channel === filter).sort((a, b) => String(a.sentAt ?? a.createdAt).localeCompare(String(b.sentAt ?? b.createdAt))), [messages, filter]);
  const channels = new Set([...conversations, ...messages].map((item) => item.channel));
  const channelSummary = [...channels].filter(Boolean).map(channelLabel);
  // The thread reads oldest first, but the message being replied to is the
  // last one, so the rail opens at the bottom rather than at an introduction
  // from three weeks ago.
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    // A second pass after paint, because bubble heights are only final once
    // the text has wrapped at the rail's real width.
    const frame = requestAnimationFrame(() => { element.scrollTop = element.scrollHeight; });
    return () => cancelAnimationFrame(frame);
  }, [visible, filter]);

  return (
    <Frame className="h-full min-h-0">
      <div className="flex shrink-0 flex-wrap items-start justify-between gap-x-4 gap-y-2 px-4 pb-3 pt-3">
        <div className="min-w-0">
          <h2 className="text-label-sm text-text-strong-950">Conversation</h2>
          <p className="mt-0.5 text-paragraph-xs text-text-sub-600">{messages.length} {messages.length === 1 ? "message" : "messages"}{channelSummary.length ? ` across ${channelSummary.join(" and ")}` : ""}</p>
        </div>
        <SegmentedControl.Root value={filter} onValueChange={(value) => setFilter(value as TimelineFilter)}>
          <SegmentedControl.List className="w-auto" aria-label="Channel">
            {(["all", "email", "linkedin", "whatsapp"] as TimelineFilter[]).map((item) => {
              const disabled = item !== "all" && !channels.has(item);
              return <SegmentedControl.Trigger key={item} value={item} disabled={disabled} className={cn("gap-1.5 px-2 text-label-xs sm:px-2.5", disabled && "opacity-40")}>{item !== "all" && channelIcon(item, "size-3.5")}{item === "all" ? "All" : channelLabel(item)}</SegmentedControl.Trigger>;
            })}
          </SegmentedControl.List>
        </SegmentedControl.Root>
      </div>
      <FramePanel className="flex min-h-0 flex-col overflow-hidden p-0 sm:p-0">
      {visible.length ? (
        <div ref={scrollRef} className="max-h-[60vh] min-h-0 flex-1 space-y-6 overflow-y-auto p-4 sm:p-5 xl:max-h-none">
          {visible.map((message, index) => {
            const inbound = message.direction === "inbound";
            const subject = text(message.subject);
            const body = text(message.body ?? message.bodyText, "Message content unavailable");
            const label = text(message.label);
            return (
              <article key={String(message.id ?? index)} className={cn("flex gap-3", !inbound && "flex-row-reverse")}>
                {inbound
                  ? <ContactAvatar src={avatarUrl} fallback={initials(name)} className="mt-1 size-8 bg-bg-white-0 text-label-xs text-text-sub-600 ring-1 ring-inset ring-stroke-soft-200" />
                  : <span className="mt-1 flex size-8 shrink-0 items-center justify-center rounded-full bg-primary-alpha-10 text-label-xs text-primary-base">You</span>}
                <div className={cn("min-w-0 max-w-[88%]", !inbound && "text-right")}>
                  <div className={cn("mb-1.5 flex flex-wrap items-center gap-2 text-paragraph-xs text-text-soft-400", !inbound && "justify-end")}>
                    <span className="inline-flex items-center gap-1" style={{ color: channelColor(message.channel) }}>{channelIcon(message.channel, "size-3.5")}<span className="text-text-soft-400">{channelLabel(message.channel)}</span></span>
                    {label && <span className="rounded bg-bg-weak-50 px-1.5 py-0.5 text-label-xs text-text-sub-600 ring-1 ring-inset ring-stroke-soft-200">{label}</span>}
                    <time title={formatDate(message.sentAt ?? message.createdAt)}>{formatDate(message.sentAt ?? message.createdAt)}</time>
                  </div>
                  <div className={cn("rounded-2xl px-4 py-3 text-left ring-1 ring-inset", inbound ? "rounded-tl-md bg-bg-white-0 shadow-regular-xs ring-stroke-soft-200" : "rounded-tr-md bg-primary-alpha-10 ring-primary-alpha-16")}>
                    {subject && <p className="mb-2 text-label-sm text-text-strong-950">{subject}</p>}
                    <p className="whitespace-pre-wrap break-words text-paragraph-sm leading-6 text-text-strong-950">{body}</p>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      ) : <EmptyState className="min-h-80 flex-1" icon={RiChat3Line} title={messages.length ? "No messages on this channel" : "No messages yet"} description={messages.length ? "Pick All to see the whole thread." : "Messages will appear here when this contact replies."} />}
      </FramePanel>
    </Frame>
  );
}

function ReplyComposer({ record, draft, conversations, citations, uncertainAttempt, lastMessage, onAction, stage, activity, stageNotice }: {
  record: Data;
  /** Their newest message, quoted above the reply when the thread is not beside it. */
  lastMessage?: Data;
  /** The stage picker: where this lead is, and fixing a misread. */
  stage: React.ReactNode;
  /** The activity-history drawer's trigger. */
  activity: React.ReactNode;
  /** A stage change the AI proposed and is holding for a person to decide. */
  stageNotice: React.ReactNode;
  draft: Data;
  conversations: Data[];
  citations: Data[];
  uncertainAttempt?: Data;
  onAction: (path: string, body?: Data, method?: string, success?: string) => Promise<boolean>;
}) {
  const draftConversationId = text(draft.conversationId);
  const defaultConversation = conversations.find((item) => item.id === draftConversationId) ?? conversations.find((item) => item.channel === record.activeChannel) ?? conversations[0];
  const [conversationId, setConversationId] = useState(String(defaultConversation?.id ?? ""));
  const [body, setBody] = useState(text(draft.body));
  const [subject, setSubject] = useState(text(draft.subject));
  const [reconciliationNote, setReconciliationNote] = useState("");
  const [providerMessageId, setProviderMessageId] = useState("");
  const [regenerateOpen, setRegenerateOpen] = useState(false);

  useEffect(() => {
    setConversationId(String((conversations.find((item) => item.id === draft.conversationId) ?? conversations.find((item) => item.channel === record.activeChannel) ?? conversations[0])?.id ?? ""));
    setBody(text(draft.body));
    setSubject(text(draft.subject));
  }, [conversations, draft.body, draft.conversationId, draft.subject, record.activeChannel]);

  const conversation = conversations.find((item) => String(item.id) === conversationId);
  const channel = String(conversation?.channel ?? draft.channel ?? "email") as Channel;
  const editingCurrentDraft = Boolean(draft.id && draftConversationId === conversationId);

  // Unsaved means differing from what is stored: the draft on its own
  // conversation, an empty reply on any other. The pop-up asks before
  // stepping to another lead while this holds.
  const recordId = String(record.id ?? "");
  const unsaved = conversationId === draftConversationId
    ? body !== text(draft.body) || subject !== text(draft.subject)
    : Boolean(body.trim() || subject.trim());
  useEffect(() => { setUnsavedReply(recordId, unsaved); }, [recordId, unsaved]);
  useEffect(() => () => setUnsavedReply(recordId, false), [recordId]);
  const stale = Boolean(draft.id && Number(draft.expectedContextVersion) !== Number(record.contextVersion));
  const revision = Number(draft.revision ?? 1);
  const ready = Boolean(body.trim() && (channel !== "email" || subject.trim()) && conversationId && !record.dnc && (!editingCurrentDraft || !stale));
  const requestSubject = channel === "email" ? subject : null;

  const changeConversation = (value: string) => {
    setConversationId(value);
    if (value !== draftConversationId) {
      setBody("");
      setSubject("");
    } else {
      setBody(text(draft.body));
      setSubject(text(draft.subject));
    }
  };

  return (
    <Frame className="h-full min-h-0">
      {/* Classification lives in the reply header because it is a property
          of the reply about to be sent, and drives the next draft. */}
      {/* Narrow: title and Activity share the first line, the classification
          takes the second whole. Wide: one line. */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 px-4 pb-3 pt-3">
        <h2 className="text-label-sm text-text-strong-950">Reply</h2>
        <div className="order-3 flex min-w-0 basis-full items-center sm:order-none sm:basis-auto">{stage}</div>
        <div className="order-2 ml-auto sm:order-none">{activity}</div>
      </div>
      {stageNotice && <div className="shrink-0 px-1 pb-2">{stageNotice}</div>}
      <FramePanel className="flex min-h-0 flex-col overflow-hidden p-0 sm:p-0">
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 sm:p-5">
        {Boolean(record.dnc) && <InlineWarning tone="danger" title="Sending is blocked" detail="This person is marked as Do Not Contact. Clear that status before replying." />}
        {editingCurrentDraft && draft.status === "failed" && <InlineWarning tone="danger" title="The draft could not be written" detail={text(draft.error, "Regenerate it, or write the reply yourself.")} />}
        {editingCurrentDraft && draft.status === "awaiting_review" && Boolean(draft.autoSendAt) && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-information-lighter p-3 ring-1 ring-inset ring-information-light">
            <Badge.Root variant="lighter" size="medium" color="blue" className="shrink-0 whitespace-nowrap"><Badge.Dot />Sends automatically</Badge.Root>
            <p className="min-w-0 flex-1 text-paragraph-xs text-information-dark">Goes out on its own when its account&apos;s next slot opens: one follow-up per account every 30 minutes by default (Sending rules), inside sending hours.</p>
            <button type="button" className={cn(secondaryButtonClass, "h-7 whitespace-nowrap px-2.5 text-label-xs")} onClick={() => void onAction(`/drafts/${String(draft.id)}/review`, {}, "POST", "Moved to Action required")}>Review before sending</button>
          </div>
        )}
        {stale && editingCurrentDraft && <InlineWarning tone="warning" title="This draft may be out of date" detail="A newer reply changed the conversation. Regenerate or carefully review before sending." />}
        {!conversations.length && <InlineWarning tone="warning" title="No reply channel available" detail="Email or LinkedIn must be connected before a reply can be sent." />}

        {/* Below xl the conversation stacks under this panel, so the message
            being answered is quoted here instead of a scroll away. */}
        {lastMessage && <figure className="shrink-0 rounded-lg bg-bg-weak-50 px-3 py-2.5 ring-1 ring-inset ring-stroke-soft-200 xl:hidden">
          <figcaption className="mb-1 flex items-center gap-1.5 text-paragraph-xs text-text-soft-400">{channelIcon(lastMessage.channel, "size-3.5")}Replying to their message · {formatDate(lastMessage.sentAt ?? lastMessage.createdAt)}</figcaption>
          <blockquote className="line-clamp-4 whitespace-pre-wrap text-paragraph-sm text-text-strong-950">{text(lastMessage.body ?? lastMessage.bodyText, "Message content unavailable")}</blockquote>
        </figure>}

        {!editingCurrentDraft && Boolean(draft.id) && <div className="rounded-lg bg-information-lighter p-3 text-paragraph-xs text-information-dark ring-1 ring-inset ring-information-light">You switched channels. This will create a separate {channelLabel(channel)} draft; the existing {channelLabel(draft.channel)} draft is preserved.</div>}

        {channel === "email" && <label className="block"><span className="mb-1.5 block text-label-xs text-text-sub-600">Subject</span><input className={fieldClass} value={subject} onChange={(event) => setSubject(event.target.value)} placeholder="Email subject" /></label>}
        <div className="flex min-h-40 flex-1 flex-col">
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-2">
              <label htmlFor="crm-reply-body" className="text-label-sm text-text-strong-950">{editingCurrentDraft ? "Draft reply" : "Your reply"}</label>
              {editingCurrentDraft && <DraftBadge draft={draft} stale={stale} dnc={Boolean(record.dnc)} />}
            </span>
            {editingCurrentDraft && <button type="button" className={cn(secondaryButtonClass, "h-7 gap-1.5 whitespace-nowrap px-2.5 text-label-xs")} onClick={() => setRegenerateOpen(true)} aria-label="Regenerate draft"><RiRefreshLine className="size-3.5" aria-hidden="true" /><span className="hidden sm:inline">Regenerate draft</span></button>}
          </div>
          <textarea id="crm-reply-body" className={cn(fieldClass, "min-h-32 flex-1 resize-y leading-6")} value={body} onChange={(event) => setBody(event.target.value)} placeholder={`Write a ${channelLabel(channel)} reply…`} />
        </div>

        {citations.length > 0 && editingCurrentDraft && <details className="shrink-0 rounded-lg bg-bg-weak-50 p-3 ring-1 ring-inset ring-stroke-soft-200"><summary className="cursor-pointer text-label-xs text-text-sub-600">Knowledge used ({citations.length})</summary>{citations.map((citation, index) => <blockquote key={String(citation.id ?? index)} className="mt-2 border-l-2 border-primary-alpha-24 pl-2 text-paragraph-xs text-text-sub-600">{String(citation.excerpt ?? "")}</blockquote>)}</details>}

      </div>
      <div className="shrink-0 border-t border-stroke-soft-200 px-4 py-3 sm:px-5">
        {uncertainAttempt && editingCurrentDraft ? (
          <div className="space-y-3 rounded-xl bg-warning-lighter p-3.5 ring-1 ring-inset ring-warning-light">
            <div className="flex gap-2"><RiErrorWarningLine className="mt-0.5 size-4 shrink-0 text-warning-base" aria-hidden="true" /><div><p className="text-label-sm text-warning-dark">Delivery needs confirmation</p><p className="mt-0.5 text-paragraph-xs text-warning-dark">Check the provider before recording the result.</p></div></div>
            <input value={providerMessageId} onChange={(event) => setProviderMessageId(event.target.value)} className={fieldClass} placeholder="Provider message ID (if delivered)" />
            <input value={reconciliationNote} onChange={(event) => setReconciliationNote(event.target.value)} className={fieldClass} placeholder="Required reconciliation note" />
            <div className="flex gap-2"><button disabled={!reconciliationNote.trim()} type="button" className={primaryButtonClass} onClick={() => void onAction(`/send-attempts/${String(uncertainAttempt.id)}/reconcile`, { delivered: true, providerMessageId: providerMessageId || null, note: reconciliationNote }, "POST", "Delivery confirmed")}>Confirm delivered</button><button disabled={!reconciliationNote.trim()} type="button" className={dangerButtonClass} onClick={() => void onAction(`/send-attempts/${String(uncertainAttempt.id)}/reconcile`, { delivered: false, note: reconciliationNote }, "POST", "Marked not delivered")}>Not delivered</button></div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            {/* Who the reply goes out as — the account, not the provider. */}
            <SenderPicker conversations={conversations} value={conversationId} onChange={changeConversation} />
            <div className="ml-auto flex items-center gap-2">
              {editingCurrentDraft ? <>
                <RegenerateDraftDialog open={regenerateOpen} onOpenChange={setRegenerateOpen} onSubmit={(feedback) => onAction(`/drafts/${String(draft.id)}/regenerate`, { feedback }, "POST", "Draft rewritten with your notes")} />
                <button type="button" disabled={!ready} className={secondaryButtonClass} onClick={() => void onAction(`/drafts/${String(draft.id)}`, { subject: requestSubject, body, revision }, "PATCH", "Draft saved")}><RiSaveLine className="size-4" aria-hidden="true" />Save</button>
                <button type="button" disabled={!ready} className={primaryButtonClass} onClick={() => void onAction(`/drafts/${String(draft.id)}/send`, { subject: requestSubject, body, revision }, "POST", "Reply queued for sending")}><RiSendPlaneLine className="size-4" aria-hidden="true" />Approve &amp; send</button>
              </> : <button type="button" disabled={!ready} className={primaryButtonClass} onClick={() => void onAction(`/records/${String(record.id)}/draft`, { conversationId, subject: requestSubject, bodyText: body, bodyHtml: null }, "POST", "Draft created and ready for review")}><RiSaveLine className="size-4" aria-hidden="true" />Create draft</button>}
            </div>
          </div>
        )}
      </div>
      </FramePanel>
    </Frame>
  );
}

/** Where the AI draft stands, in the same words the Action required table uses. */
function DraftBadge({ draft, stale, dnc }: { draft: Data; stale: boolean; dnc: boolean }) {
  const status = String(draft.status ?? "");
  const [label, color]: [string, React.ComponentProps<typeof Badge.Root>["color"]] = status === "failed" ? ["Draft failed", "red"]
    : dnc ? ["Do not contact", "red"]
    : stale ? ["Out of date", "orange"]
    : status === "awaiting_review" ? ["Ready to send", "green"]
    : [humanize(status || "draft"), "gray"];
  return <Badge.Root variant="lighter" size="medium" color={color} className="shrink-0 whitespace-nowrap"><Badge.Dot />{label}</Badge.Root>;
}

/**
 * The account a reply goes out through, shown as that account's person. One
 * conversation is just a label; with several it opens a menu to switch.
 */
function SenderPicker({ conversations, value, onChange }: { conversations: Data[]; value: string; onChange: (conversationId: string) => void }) {
  if (!conversations.length) return null;
  const current = conversations.find((item) => String(item.id) === value) ?? conversations[0]!;
  const senderName = (item: Data) => text(item.accountName ?? item.accountLabel ?? item.accountRef, "Connected account");
  const identity = (item: Data) => (
    <>
      <ContactAvatar src={item.accountAvatarUrl ? String(item.accountAvatarUrl) : null} fallback={initials(senderName(item))} className="size-6 shrink-0 bg-primary-alpha-10 text-[10px] text-primary-base" />
      <span className="min-w-0 truncate text-label-sm text-text-strong-950">{senderName(item)}</span>
      <span className="inline-flex shrink-0 items-center gap-1 text-paragraph-xs text-text-soft-400">{channelIcon(item.channel, "size-3.5")}{channelLabel(item.channel)}{item.status === "closed" ? " · closed" : ""}</span>
    </>
  );
  const title = `Sending as ${text(current.accountLabel ?? current.accountRef, "a connected account")} via ${channelLabel(current.channel)}`;
  if (conversations.length === 1) {
    return <div title={title} className="flex min-w-0 items-center gap-2">{identity(current)}</div>;
  }
  return (
    <Dropdown.Root>
      <Dropdown.Trigger asChild>
        <button type="button" title={title} aria-label={`${title}. Change`} className="flex min-w-0 items-center gap-2 rounded-lg px-1.5 py-1 transition hover:bg-bg-weak-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-stroke-strong-950">
          {identity(current)}
          <RiArrowDownSLine className="size-4 shrink-0 text-text-soft-400" aria-hidden="true" />
        </button>
      </Dropdown.Trigger>
      <Dropdown.Content align="start">
        {conversations.map((item) => (
          <Dropdown.Item key={String(item.id)} onSelect={() => onChange(String(item.id))}>
            {identity(item)}
            {String(item.id) === String(current.id) && <RiCheckLine className="ml-auto size-4 text-primary-base" aria-hidden="true" />}
          </Dropdown.Item>
        ))}
      </Dropdown.Content>
    </Dropdown.Root>
  );
}

function InlineWarning({ tone, title, detail }: { tone: "warning" | "danger"; title: string; detail: string }) {
  const danger = tone === "danger";
  return <div className={cn("flex gap-2 rounded-lg p-3 ring-1 ring-inset", danger ? "bg-error-lighter text-error-dark ring-error-light" : "bg-warning-lighter text-warning-dark ring-warning-light")}><RiErrorWarningLine className="mt-0.5 size-4 shrink-0" aria-hidden="true" /><div><p className="text-label-sm">{title}</p><p className="mt-0.5 text-paragraph-xs">{detail}</p></div></div>;
}

/**
 * Classification lives in the reply header because it is a property of the
 * reply about to be sent. The picker itself is shared with the Action
 * required table, so the two places cannot drift.
 *
 * Move stage is a separate control in the lead header: the picker fixes what
 * the AI misread from the last reply, Move stage records something the AI
 * never saw at all — the two need their own controls, not one dropdown doing
 * both jobs.
 */
function ClassificationSelect({ record, categories, onAction }: { record: Data; categories: Data[]; onAction: (path: string, body?: Data, method?: string, success?: string) => Promise<boolean> }) {
  const classification = asObject(record.classification);
  const categoryKey = String(record.categoryKey ?? classification.category ?? "other");
  const subcategoryId = record.subcategoryId ? String(record.subcategoryId) : null;
  const confidence = classification.confidence != null ? Math.round(Number(classification.confidence) * 100) : null;
  const reason = text(classification.reason);

  return (
    <div className="flex items-center gap-2">
      {confidence != null && <span title={reason || undefined} className="inline-flex items-center gap-1 text-paragraph-xs text-text-soft-400"><RiSparklingLine className="size-3.5" aria-hidden="true" />{confidence}%</span>}
      <ClassificationPicker
        compact
        quiet
        categories={categories}
        categoryKey={categoryKey}
        subcategoryId={subcategoryId}
        subcategoryName={record.subcategory ? String(record.subcategory) : null}
        title="Fix classification — the AI misread this reply"
        onChange={(chosen) => void onAction(`/records/${String(record.id)}/classification`, {
          ...chosen,
          expectedContextVersion: record.contextVersion,
          classificationId: classification.id,
        }, "PATCH", "Classification updated")}
      />
    </div>
  );
}

/**
 * The AI may only move a record forward; a proposal that would move it
 * sideways or backward is saved as `status: "proposed"` instead of applied,
 * and the record stays where it was. This surfaces that held proposal so a
 * human decides rather than it sitting silent in the classification history.
 */
function ProposedClassificationNotice({ record, categories, onAction }: { record: Data; categories: Data[]; onAction: (path: string, body?: Data, method?: string, success?: string) => Promise<boolean> }) {
  const classification = asObject(record.classification);
  if (classification.status !== "proposed") return null;
  const proposedCategoryKey = classification.proposedCategoryKey ? String(classification.proposedCategoryKey) : null;
  const proposedSubcategoryId = classification.proposedSubcategoryId ? String(classification.proposedSubcategoryId) : null;
  const proposedSubcategory = proposedSubcategoryId
    ? categories.flatMap((category) => asList<Data>(category.subcategories)).find((item) => String(item.id) === proposedSubcategoryId)
    : null;
  const proposedLabel = proposedSubcategory ? String(proposedSubcategory.name) : humanize(proposedCategoryKey);
  const currentCategoryKey = String(record.categoryKey ?? "other");
  const currentSubcategoryId = record.subcategoryId ? String(record.subcategoryId) : null;
  const currentLabel = record.subcategory ? String(record.subcategory) : humanize(currentCategoryKey);
  const respond = (choice: { categoryKey: string; subcategoryId: string | null }) => void onAction(`/records/${String(record.id)}/classification`, {
    ...choice,
    expectedContextVersion: record.contextVersion,
    classificationId: classification.id,
  }, "PATCH", "Classification updated");

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg bg-warning-lighter px-3 py-2 text-paragraph-xs text-warning-dark ring-1 ring-inset ring-warning-light">
      <RiSparklingLine className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1">AI suggests: <strong className="font-medium">{proposedLabel}</strong> — held for review, since it isn&apos;t a forward move.</span>
      <div className="flex shrink-0 gap-1.5">
        <button type="button" className="rounded-md bg-bg-white-0 px-2 py-1 text-label-xs text-warning-dark ring-1 ring-inset ring-warning-light transition hover:brightness-95" onClick={() => respond(proposedCategoryKey ? { categoryKey: proposedCategoryKey, subcategoryId: proposedSubcategoryId } : { categoryKey: currentCategoryKey, subcategoryId: currentSubcategoryId })}>Accept</button>
        <button type="button" className="rounded-md px-2 py-1 text-label-xs text-warning-dark transition hover:bg-bg-white-0" onClick={() => respond({ categoryKey: currentCategoryKey, subcategoryId: currentSubcategoryId })}>Keep {currentLabel}</button>
      </div>
    </div>
  );
}

function ActivityDrawer({ events, drafts, sendAttempts }: { events: Data[]; drafts: Data[]; sendAttempts: Data[] }) {
  return (
    <Modal.Root>
      <Modal.Trigger asChild>
        <button type="button" className={subtleButtonClass} title="Activity history" aria-label={`Activity history, ${events.length} events`}>
          <RiHistoryLine className="size-4" aria-hidden="true" />
          Activity
          {events.length > 0 && <span className="ml-0.5 rounded-full bg-bg-weak-50 px-1.5 text-label-xs text-text-sub-600">{events.length}</span>}
        </button>
      </Modal.Trigger>
      <Modal.SideContent size="max-w-xl">
        <Modal.Header icon={RiHistoryLine}>
          <Modal.Title>Activity history</Modal.Title>
          <Modal.Description>A complete audit trail of decisions, drafts, and delivery</Modal.Description>
        </Modal.Header>
        <div className="flex shrink-0 flex-wrap gap-2 px-5 pt-4">
          <Badge.Root variant="lighter" color="gray" size="medium">{events.length} events</Badge.Root>
          <Badge.Root variant="lighter" color="gray" size="medium">{drafts.length} drafts</Badge.Root>
          <Badge.Root variant="lighter" color="gray" size="medium">{sendAttempts.length} send attempts</Badge.Root>
        </div>
        <Modal.Body className="p-0 pt-4">
          {events.length ? (
            <div className="divide-y divide-stroke-soft-200 border-t border-stroke-soft-200">
              {events.map((event, index) => <EventRow key={String(event.id ?? index)} event={event} />)}
            </div>
          ) : (
            <div className="p-10 text-center">
              <RiHistoryLine className="mx-auto size-6 text-text-soft-400" aria-hidden="true" />
              <p className="mt-2 text-paragraph-sm text-text-sub-600">No activity has been recorded yet.</p>
            </div>
          )}
        </Modal.Body>
      </Modal.SideContent>
    </Modal.Root>
  );
}

function EventRow({ event }: { event: Data }) {
  const type = String(event.eventType ?? "event");
  const from = asObject(event.fromData);
  const to = asObject(event.toData);
  const meta = asObject(event.meta);
  const transition = text(from.workflowState ?? from.status ?? from.categoryKey);
  const destination = text(to.workflowState ?? to.status ?? to.categoryKey);
  const detail = transition && destination && transition !== destination
    ? `${humanize(transition)} → ${humanize(destination)}`
    : text(meta.reason ?? meta.error ?? to.reason ?? event.error);
  const failed = type.includes("failed") || type.includes("error") || type.includes("uncertain");
  return <div className="grid gap-3 px-5 py-4 sm:grid-cols-[36px_minmax(0,1fr)_auto] sm:items-center"><span className={cn("flex size-9 items-center justify-center rounded-full", failed ? "bg-error-lighter text-error-base" : "bg-bg-weak-50 text-text-soft-400")}><RiCheckboxCircleLine className="size-4" aria-hidden="true" /></span><div className="min-w-0"><p className="text-label-sm text-text-strong-950">{eventLabels[type] ?? humanize(type)}</p><p className="mt-0.5 truncate text-paragraph-xs text-text-sub-600">{detail || `${humanize(event.actorType)}${event.actorRef ? ` · ${String(event.actorRef)}` : ""}`}</p></div><div className="text-left sm:text-right"><time className="text-paragraph-xs text-text-soft-400">{formatDate(event.createdAt)}</time><p className="mt-0.5 text-subheading-2xs uppercase tracking-wider text-text-soft-400">{humanize(event.actorType)}</p></div></div>;
}
