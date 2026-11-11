"use client";
/* eslint-disable react-hooks/set-state-in-effect */

import { useEffect, useRef, useState } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import {
  RiArrowDownSLine,
  RiArrowRightLine,
  RiCheckLine,
  RiDeleteBinLine,
  RiErrorWarningLine,
  RiRefreshLine,
  RiSaveLine,
  RiSendPlaneLine,
  RiSparklingLine,
  RiTimerLine,
} from "@remixicon/react";
import * as Dropdown from "@/components/alignui/dropdown";
import * as Modal from "@/components/alignui/modal";
import * as Select from "@/components/alignui/select";
import { cn } from "@/utils/cn";
import { dangerButtonClass, fieldClass, primaryButtonClass, secondaryButtonClass, subtleButtonClass } from "./CrmLayout";
import { asList, asObject, CATEGORY_COLOR, categoryColor, formatDate } from "./crm-utils";

type Data = Record<string, unknown>;

export function humanize(value: unknown): string {
  const input = String(value ?? "").replaceAll("_", " ").replaceAll(".", " ").trim();
  return input ? input.charAt(0).toUpperCase() + input.slice(1) : "—";
}

export type ClassificationChoice = { categoryKey: string; subcategoryId: string | null };

/**
 * Badge colours per category, the CRM identity colours Analytics uses:
 * interested green, customer purple, not interested red, other amber. The
 * tint alone carries the category — chips have no dot.
 */
export const categoryToneClass: Record<string, string> = {
  customer: CATEGORY_COLOR.customer.tone,
  interested: CATEGORY_COLOR.interested.tone,
  not_interested: CATEGORY_COLOR.not_interested.tone,
  other: CATEGORY_COLOR.other.tone,
};

/** The category's swatch as a small dot, for menu rows and filter options (chips are tinted instead). */
export function CategoryDot({ categoryKey, className }: { categoryKey: string | null | undefined; className?: string }) {
  return <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", className)} style={{ backgroundColor: categoryColor(categoryKey).color }} />;
}

/**
 * One control for the whole taxonomy: every active subcategory grouped under
 * its category, so picking a subcategory sets both. The bare categories lead
 * each group for the replies no subcategory describes.
 *
 * `compact` renders it as a badge that opens a menu, for the table. The badge
 * names the subcategory when there is one — "Meeting requested" says more
 * than "Interested" — and takes its colour from the category, so the column
 * still scans by outcome. The sequence and next draft follow whatever is
 * picked here, which is why it is worth having on the row at all.
 */
export function ClassificationPicker({ categories, categoryKey, subcategoryId, subcategoryName, onChange, compact, quiet, disabled, className, title, placeholderLabel, placeholderTone, placeholderDot }: {
  categories: Data[];
  categoryKey: string | null;
  subcategoryId: string | null;
  subcategoryName?: string | null;
  onChange: (choice: ClassificationChoice) => void;
  compact?: boolean;
  /**
   * With `compact`: unclassified gets a dashed outline instead of the grey
   * tint — it is a gap to fill, not a category.
   */
  quiet?: boolean;
  disabled?: boolean;
  className?: string;
  /** Overrides the compact badge's hover title — used where a second, different action (Move stage) sits next to it and the two need to read as distinct. */
  title?: string;
  /** Pre-reply lifecycle label & tint (`Contacted`, `Draft ready`, `Queued`, etc.) shown when `categoryKey` is null so Leads & CRM stay unified. */
  placeholderLabel?: string;
  placeholderTone?: string;
  placeholderDot?: string;
}) {
  const value = subcategoryId || (categoryKey ? `category:${categoryKey}` : "");
  const save = (next: string) => {
    if (!next) return;
    const chosen: ClassificationChoice = next.startsWith("category:")
      ? { categoryKey: next.slice("category:".length), subcategoryId: null }
      : {
        categoryKey: String(categories.flatMap((item) => asList<Data>(item.subcategories)).find((item) => String(item.id) === next)?.categoryKey ?? categoryKey ?? "other"),
        subcategoryId: next,
      };
    if (chosen.categoryKey === categoryKey && (chosen.subcategoryId ?? "") === (subcategoryId ?? "")) return;
    onChange(chosen);
  };
  const groups = categories.map((category) => ({
    key: String(category.key),
    subcategories: asList<Data>(category.subcategories).filter((item) => item.active !== false),
  }));
  const fallbackLabel = placeholderLabel || "Unclassified";
  const categoryLabel = categoryKey ? humanize(categoryKey) : fallbackLabel;

  if (!compact) {
    return (
      <Select.Root
        size="xsmall"
        value={value}
        disabled={disabled}
        onValueChange={(next) => save(next)}
      >
        <Select.Trigger aria-label="Classification" className={cn("max-w-56", className)}>
          <Select.Value placeholder={fallbackLabel} />
        </Select.Trigger>
        <Select.Content>
          {groups.length === 0 && categoryKey && <Select.Item value={value}>{categoryLabel}{subcategoryName ? ` · ${subcategoryName}` : ""}</Select.Item>}
          {groups.map((group) => (
            <Select.Group key={group.key}>
              <Select.GroupLabel>{humanize(group.key)}</Select.GroupLabel>
              <Select.Item value={`category:${group.key}`}>{humanize(group.key)} · no subcategory</Select.Item>
              {group.subcategories.map((item) => <Select.Item key={String(item.id)} value={String(item.id)}>{String(item.name)}</Select.Item>)}
            </Select.Group>
          ))}
        </Select.Content>
      </Select.Root>
    );
  }

  const label = subcategoryName || categoryLabel;
  const tone = !categoryKey && placeholderTone
    ? placeholderTone
    : quiet && !categoryKey
      ? "bg-bg-white-0 text-text-sub-600 ring-0 outline-dashed outline-1 -outline-offset-1 outline-stroke-sub-300 hover:bg-bg-weak-50"
      : categoryToneClass[categoryKey ?? ""] ?? "bg-bg-weak-50 text-text-sub-600 ring-stroke-soft-200";
  return (
    <Dropdown.Root>
      <Dropdown.Trigger asChild>
        <button
          type="button"
          disabled={disabled || groups.length === 0}
          aria-label={`Classification: ${label}. Change`}
          title={title ?? (subcategoryName ? `${categoryLabel} · ${subcategoryName}` : categoryLabel)}
          className={cn("inline-flex h-6 max-w-full items-center gap-1.5 rounded-md pl-2 pr-1.5 text-label-xs ring-1 ring-inset transition", (categoryKey || placeholderTone) && "hover:brightness-95", "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-stroke-strong-950 disabled:opacity-60 data-[state=open]:ring-2 data-[state=open]:ring-stroke-strong-950", tone, className)}
        >
          {!categoryKey && placeholderDot && <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: placeholderDot }} />}
          <span className="truncate">{label}</span>
          <RiArrowDownSLine className="size-3.5 shrink-0 opacity-70" aria-hidden="true" />
        </button>
      </Dropdown.Trigger>
      <ClassificationMenu groups={groups} value={value} onPick={save} />
    </Dropdown.Root>
  );
}

/**
 * The menu body. Each category heads its group as the same chip the table
 * shows, so the colours line up; the current choice is tinted and checked,
 * and the menu opens scrolled to it with focus there, so a long taxonomy
 * never has to be hunted through to find where the record stands.
 */
function ClassificationMenu({ groups, value, onPick }: {
  groups: { key: string; subcategories: Data[] }[];
  value: string;
  onPick: (next: string) => void;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<HTMLDivElement>(null);
  // One step darker than the hover tint, so the current choice still reads
  // as "current" when the pointer is resting on a neighbour.
  const itemClass = (selected: boolean) => cn(selected && "bg-bg-soft-200 text-text-strong-950 data-[highlighted]:bg-bg-sub-300/60");
  const check = <RiCheckLine className="size-4 shrink-0 text-primary-base" aria-hidden="true" />;
  return (
    <Dropdown.Content ref={contentRef} align="start" className="max-h-80 w-64 overflow-y-auto">
      <RevealSelected contentRef={contentRef} itemRef={selectedRef} />
      {groups.map((group, index) => {
        const categoryValue = `category:${group.key}`;
        return (
          <Dropdown.Group key={group.key}>
            {index > 0 && <Dropdown.Separator />}
            <Dropdown.Item ref={value === categoryValue ? selectedRef : undefined} onSelect={() => onPick(categoryValue)} className={itemClass(value === categoryValue)}>
              <span className={cn("inline-flex h-6 items-center rounded-md px-2 text-label-xs ring-1 ring-inset", categoryToneClass[group.key] ?? "bg-bg-weak-50 text-text-sub-600 ring-stroke-soft-200")}>{humanize(group.key)}</span>
              <span className="flex-1" />
              {value === categoryValue && check}
            </Dropdown.Item>
            {group.subcategories.map((item) => {
              const id = String(item.id);
              const selected = value === id;
              return (
                <Dropdown.Item key={id} ref={selected ? selectedRef : undefined} onSelect={() => onPick(id)} className={cn("pl-4 text-text-sub-600 data-[highlighted]:text-text-strong-950", itemClass(selected))}>
                  <span className="flex-1 truncate">{String(item.name)}</span>
                  {selected && check}
                </Dropdown.Item>
              );
            })}
          </Dropdown.Group>
        );
      })}
    </Dropdown.Content>
  );
}

/**
 * Radix mounts the menu body on every open, so an effect here runs exactly
 * then: it moves focus to the current choice and scrolls the menu (only the
 * menu, never the page behind it) so the choice sits mid-list.
 */
function RevealSelected({ contentRef, itemRef }: { contentRef: React.RefObject<HTMLDivElement | null>; itemRef: React.RefObject<HTMLDivElement | null> }) {
  useEffect(() => {
    // After Radix's own open-focus has run, so ours is the one that sticks.
    const frame = requestAnimationFrame(() => {
      const item = itemRef.current;
      const content = contentRef.current;
      if (!item || !content) return;
      item.focus({ preventScroll: true });
      const box = content.getBoundingClientRect();
      const target = item.getBoundingClientRect();
      content.scrollTop += target.top - box.top - (box.height - target.height) / 2;
    });
    return () => cancelAnimationFrame(frame);
  }, [contentRef, itemRef]);
  return null;
}

/**
 * Full text on hover for a cell that only has room for one line. The card is
 * hoverable so a long message can be scrolled, and the trigger is focusable so
 * keyboard users get the same preview.
 *
 * `onActivate` makes the text itself a control: clicking it (or the card) runs
 * the action instead of letting the click reach the row and open the record —
 * a reader who clicks a draft means to edit it, not to leave the page.
 */
export function HoverPreview({ title, body, meta, children, className, onActivate, actions, disabled }: {
  title?: string;
  body: string;
  meta?: string;
  children: React.ReactNode;
  className?: string;
  onActivate?: () => void;
  /** Buttons shown along the bottom of the card; clicks there do not count as activating the card. */
  actions?: React.ReactNode;
  /** No card at all — for a row whose editor is already open underneath. */
  disabled?: boolean;
}) {
  // Controlled so that acting from the card (Edit, Send, or clicking the text)
  // also dismisses it: what the click produced is underneath, and the card
  // would otherwise sit on top of it until the pointer wandered off.
  const [open, setOpen] = useState(false);
  const activate = (event: React.MouseEvent) => {
    if (!onActivate) return;
    event.stopPropagation();
    // A click that ends a text selection is a read, not a request to edit.
    if (window.getSelection()?.toString()) return;
    setOpen(false);
    onActivate();
  };
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (!onActivate || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    setOpen(false);
    onActivate();
  };
  const triggerClass = cn("min-w-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-stroke-strong-950", className);
  if (!body.trim() || disabled) return <div className={triggerClass} tabIndex={onActivate ? 0 : undefined} role={onActivate ? "button" : undefined} onClick={activate} onKeyDown={onKeyDown}>{children}</div>;
  return (
    <Tooltip.Root open={open} onOpenChange={setOpen}>
      <Tooltip.Trigger asChild>
        <div tabIndex={0} role={onActivate ? "button" : undefined} className={triggerClass} onClick={activate} onKeyDown={onKeyDown}>{children}</div>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content side="bottom" align="start" sideOffset={6} collisionPadding={12} onClick={activate} className={cn("z-50 w-[28rem] max-w-[calc(100vw-2rem)] rounded-xl bg-bg-white-0 p-3.5 shadow-regular-md ring-1 ring-inset ring-stroke-soft-200 data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0", onActivate && "cursor-pointer")}>
          {(title || meta) && <div className="mb-2 flex items-baseline justify-between gap-3">
            {title && <p className="truncate text-label-sm text-text-strong-950">{title}</p>}
            {meta && <p className="shrink-0 text-paragraph-xs text-text-soft-400">{meta}</p>}
          </div>}
          <p className="max-h-72 overflow-y-auto whitespace-pre-wrap text-paragraph-sm leading-6 text-text-sub-600">{body}</p>
          {actions && <div className="mt-3 flex items-center gap-2 border-t border-stroke-soft-200 pt-3" onClick={(event) => {
            event.stopPropagation();
            if ((event.target as HTMLElement).closest("[data-keep-preview], [aria-haspopup='menu']")) return;
            setOpen(false);
          }}>{actions}</div>}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

export const HoverPreviewProvider = ({ children }: { children: React.ReactNode }) => <Tooltip.Provider delayDuration={350} skipDelayDuration={400}>{children}</Tooltip.Provider>;

/** Where a row's draft edits and sends go. `path` is relative to `/api/crm`. */
export type RowMutation = (path: string, body: Data, method: string, success: string) => Promise<boolean>;

/** Starting points for feedback; each appends a line so several can be combined. */
const REGENERATE_HINTS: { label: string; text: string }[] = [
  { label: "Shorter", text: "Make it shorter — three or four lines at most." },
  { label: "Less formal", text: "Less formal, more like a person writing." },
  { label: "Answer their question", text: "Answer their actual question before anything else." },
  { label: "Less salesy", text: "Drop the sales pitch; just be helpful." },
  { label: "One next step", text: "Propose one concrete next step." },
];

/**
 * Regenerating with no brief just reruns the same prompt and gets much the
 * same draft back. This asks the reviewer what is wrong or what they want
 * instead; the model then sees both the rejected draft and that note.
 */
export function RegenerateDraftDialog({ open, onOpenChange, onSubmit, busy }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Resolves true when the draft was rewritten; the dialog closes itself then. */
  onSubmit: (feedback: string) => Promise<boolean>;
  busy?: boolean;
}) {
  const [feedback, setFeedback] = useState("");
  const [working, setWorking] = useState(false);
  useEffect(() => { if (!open) { setFeedback(""); setWorking(false); } }, [open]);
  const ready = feedback.trim().length > 0 && !working && !busy;
  const submit = async () => {
    if (!ready) return;
    setWorking(true);
    const ok = await onSubmit(feedback.trim());
    setWorking(false);
    if (ok) onOpenChange(false);
  };
  const addHint = (hint: string) => setFeedback((current) => current.includes(hint) ? current : [current.trim(), hint].filter(Boolean).join("\n"));
  return (
    // The dialog is portaled, but React still bubbles its clicks up this tree —
    // into a table row whose click opens the record. `contents` keeps the
    // wrapper out of the layout while it swallows those.
    <div className="contents" onClick={(event) => event.stopPropagation()}>
    <Modal.Root open={open} onOpenChange={(next) => { if (!working) onOpenChange(next); }}>
      <Modal.Content size="max-w-lg">
        <Modal.Header icon={RiRefreshLine}>
          <Modal.Title>Regenerate this draft</Modal.Title>
          <Modal.Description>Tell the AI what to change. It rewrites the reply with your notes and the current draft in front of it.</Modal.Description>
        </Modal.Header>
        <Modal.Body className="space-y-3">
          <textarea
            aria-label="What should change"
            autoFocus
            value={feedback}
            disabled={working}
            onChange={(event) => setFeedback(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void submit(); } }}
            placeholder="e.g. Too long and too salesy. They asked about pricing — answer that first, then offer the 20-minute call."
            className={cn(fieldClass, "min-h-28 resize-y leading-6")}
          />
          <div className="flex flex-wrap gap-1.5">
            {REGENERATE_HINTS.map((hint) => (
              <button key={hint.label} type="button" disabled={working} onClick={() => addHint(hint.text)} className="rounded-full bg-bg-weak-50 px-2.5 py-1 text-label-xs text-text-sub-600 ring-1 ring-inset ring-stroke-soft-200 transition hover:bg-bg-soft-200 hover:text-text-strong-950 disabled:opacity-60">{hint.label}</button>
            ))}
          </div>
        </Modal.Body>
        <Modal.Footer>
          <span className="mr-auto text-paragraph-xs text-text-soft-400">⌘↵ to regenerate</span>
          <Modal.Close asChild><button type="button" className={secondaryButtonClass} disabled={working}>Cancel</button></Modal.Close>
          <button type="button" className={primaryButtonClass} disabled={!ready} onClick={() => void submit()}>
            <RiRefreshLine className={cn("size-4", working && "animate-spin")} aria-hidden="true" />{working ? "Rewriting…" : "Regenerate"}
          </button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
    </div>
  );
}

export type MoveStageBody = {
  categoryKey: string;
  subcategoryId: string | null;
  expectedContextVersion: number;
  occurredAt: string | null;
  note: string | null;
  /** "follow_up": the immediate reply is already handled, schedule the follow-ups. "reply": draft it now. */
  next: "follow_up" | "reply";
};

/** The toast for a finished move, which differs by what happens next. */
export function moveStageSuccessMessage(body: MoveStageBody): string {
  return body.next === "reply"
    ? "Stage moved — the first reply is being drafted"
    : "Stage moved — follow-ups scheduled";
}

/** yyyy-mm-dd for today in the browser's own timezone, not UTC — so the date input's default and max agree with what the reviewer calls "today". */
function todayLocalDate(): string {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

/**
 * A yyyy-mm-dd date has no time of its own; parsed as UTC midnight it can land
 * on the wrong side of midnight in the reviewer's timezone, so a past day is
 * sent as local noon. Today is sent as null — "now" on the server — because
 * noon today is still in the future every morning, and the server refuses that.
 */
function occurredAtIso(date: string): string | null {
  if (date >= todayLocalDate()) return null;
  return new Date(`${date}T12:00:00`).toISOString();
}

/**
 * "Something happened off-thread" — a meeting happened, a deal closed — that
 * the AI has no reply to read and classify. Distinct from
 * `ClassificationPicker`: that corrects what the AI read into the last
 * message; this records an event the AI never saw and starts the new stage's
 * sequence from it.
 *
 * Self-manages its own open state and renders a default trigger when neither
 * `open`/`onOpenChange` is supplied (like `ActivityDrawer`); pass those two to
 * drive it from a menu item instead, with no trigger of its own (like
 * `RegenerateDraftDialog`).
 */
export function MoveStageDialog({ categories, categoryKey, subcategoryId, contextVersion, onMove, trigger, disabled, open: openProp, onOpenChange: onOpenChangeProp }: {
  categories: Data[];
  categoryKey: string | null;
  subcategoryId: string | null;
  contextVersion: number;
  onMove: (body: MoveStageBody) => Promise<boolean | void>;
  trigger?: React.ReactNode;
  disabled?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const controlled = openProp !== undefined;
  const open = controlled ? Boolean(openProp) : internalOpen;
  const setOpen = (next: boolean) => { if (controlled) onOpenChangeProp?.(next); else setInternalOpen(next); };

  const currentValue = subcategoryId || (categoryKey ? `category:${categoryKey}` : "");
  const groups = categories.map((category) => ({
    key: String(category.key),
    subcategories: asList<Data>(category.subcategories).filter((item) => item.active !== false && String(item.id) !== subcategoryId),
  }));

  const [stage, setStage] = useState("");
  const [date, setDate] = useState(todayLocalDate);
  const [note, setNote] = useState("");
  // Which of the two submit buttons is in flight, so only that one says so.
  const [working, setWorking] = useState<MoveStageBody["next"] | null>(null);
  useEffect(() => { if (open) { setStage(""); setDate(todayLocalDate()); setNote(""); setWorking(null); } }, [open]);

  const ready = Boolean(stage) && !working;
  const submit = async (next: MoveStageBody["next"]) => {
    if (!ready) return;
    const chosen: ClassificationChoice = stage.startsWith("category:")
      ? { categoryKey: stage.slice("category:".length), subcategoryId: null }
      : {
        categoryKey: String(categories.flatMap((item) => asList<Data>(item.subcategories)).find((item) => String(item.id) === stage)?.categoryKey ?? categoryKey ?? "other"),
        subcategoryId: stage,
      };
    setWorking(next);
    const ok = await onMove({ ...chosen, expectedContextVersion: contextVersion, occurredAt: occurredAtIso(date), note: note.trim() || null, next });
    setWorking(null);
    if (ok !== false) setOpen(false);
  };

  return (
    <div className="contents" onClick={(event) => event.stopPropagation()}>
    <Modal.Root open={open} onOpenChange={(next) => { if (!working) setOpen(next); }}>
      {!controlled && <Modal.Trigger asChild>{trigger ?? <button type="button" disabled={disabled} className={cn(primaryButtonClass, "h-7 gap-1.5 whitespace-nowrap px-2.5 text-label-xs")}><RiArrowRightLine className="size-3.5" aria-hidden="true" />Move stage</button>}</Modal.Trigger>}
      <Modal.Content size="max-w-lg">
        <Modal.Header icon={RiArrowRightLine}>
          <Modal.Title>Move stage</Modal.Title>
          <Modal.Description>Something happened outside the conversation — record it and move this lead on.</Modal.Description>
        </Modal.Header>
        <Modal.Body className="space-y-3">
          <label className="block">
            <span className="mb-1.5 block text-label-xs text-text-sub-600">New stage</span>
            <Select.Root value={stage} disabled={Boolean(working)} onValueChange={(next) => setStage(next)}>
              <Select.Trigger aria-label="New stage" className="w-full">
                <Select.Value placeholder="Choose a stage…" />
              </Select.Trigger>
              <Select.Content>
                {groups.map((group) => (
                  <Select.Group key={group.key}>
                    <Select.GroupLabel>{humanize(group.key)}</Select.GroupLabel>
                    {currentValue !== `category:${group.key}` && <Select.Item value={`category:${group.key}`}>{humanize(group.key)} · no subcategory</Select.Item>}
                    {group.subcategories.map((item) => <Select.Item key={String(item.id)} value={String(item.id)}>{String(item.name)}</Select.Item>)}
                  </Select.Group>
                ))}
              </Select.Content>
            </Select.Root>
          </label>
          <label className="block">
            <span className="mb-1.5 block text-label-xs text-text-sub-600">When did it happen?</span>
            <input
              type="date"
              aria-label="When did it happen"
              value={date}
              max={todayLocalDate()}
              disabled={Boolean(working)}
              onChange={(event) => setDate(event.target.value)}
              className={fieldClass}
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-label-xs text-text-sub-600">What happened? (optional)</span>
            <textarea
              value={note}
              disabled={Boolean(working)}
              onChange={(event) => setNote(event.target.value)}
              placeholder="e.g. They want pricing for 50 seats; loop in their CTO"
              className={cn(fieldClass, "min-h-20 resize-y leading-6")}
            />
          </label>
          <p className="text-paragraph-xs text-text-soft-400">The AI&apos;s reading of the last reply stays as it was. <strong className="font-medium text-text-sub-600">Add to follow-ups</strong> treats the new stage&apos;s first reply as already handled and schedules its follow-ups; <strong className="font-medium text-text-sub-600">Draft a reply now</strong> writes that first reply for you to send. Either way, the drafts use this note.</p>
        </Modal.Body>
        <Modal.Footer>
          <Modal.Close asChild><button type="button" className={cn(secondaryButtonClass, "mr-auto")} disabled={Boolean(working)}>Cancel</button></Modal.Close>
          <button type="button" className={secondaryButtonClass} disabled={!ready} onClick={() => void submit("reply")}>
            <RiSparklingLine className="size-4" aria-hidden="true" />{working === "reply" ? "Moving…" : "Draft a reply now"}
          </button>
          <button type="button" className={primaryButtonClass} disabled={!ready} onClick={() => void submit("follow_up")}>
            <RiTimerLine className="size-4" aria-hidden="true" />{working === "follow_up" ? "Moving…" : "Add to follow-ups"}
          </button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
    </div>
  );
}

/**
 * Split send button: primary action sends immediately ("Send now"), while the
 * chevron opens a dropdown to queue the draft in the account's weekday working
 * window ("Queue in working hours").
 */
export function SendDraftButton({
  disabled,
  size = "md",
  label = "Send now",
  title,
  ariaLabel,
  onSendNow,
  onQueueInWorkingHours,
}: {
  disabled?: boolean;
  size?: "md" | "sm" | "xs";
  label?: string;
  title?: string;
  ariaLabel?: string;
  onSendNow: () => void;
  onQueueInWorkingHours: () => void;
}) {
  const heightClass = size === "xs" ? "h-7 text-label-xs" : size === "sm" ? "h-8 text-label-sm" : "h-9 text-label-sm";
  const mainPadClass = size === "xs" ? "gap-1.5 px-2.5" : "gap-2 px-3";
  const triggerPadClass = size === "xs" ? "px-1.5" : "px-2";
  const iconSizeClass = size === "xs" ? "size-3.5" : "size-4";
  const sharedInteractive =
    "inline-flex items-center justify-center bg-primary-base text-static-white transition hover:bg-primary-darker focus-visible:z-10 focus-visible:outline-none focus-visible:shadow-button-primary-focus disabled:pointer-events-none disabled:bg-bg-weak-50 disabled:text-text-disabled-300";

  return (
    <div className="inline-flex shrink-0 items-stretch" data-keep-preview onClick={(event) => event.stopPropagation()}>
      <button
        type="button"
        disabled={disabled}
        title={title ?? "Send immediately"}
        aria-label={ariaLabel}
        onClick={onSendNow}
        className={cn(sharedInteractive, heightClass, mainPadClass, "rounded-l-lg")}
      >
        <RiSendPlaneLine className={iconSizeClass} aria-hidden="true" />
        <span>{label}</span>
      </button>
      <Dropdown.Root>
        <Dropdown.Trigger asChild>
          <button
            type="button"
            disabled={disabled}
            data-keep-preview
            title="More send options"
            aria-label="Send options"
            className={cn(
              sharedInteractive,
              heightClass,
              triggerPadClass,
              "rounded-r-lg border-l border-white/25 disabled:border-stroke-soft-200",
            )}
          >
            <RiArrowDownSLine className={iconSizeClass} aria-hidden="true" />
          </button>
        </Dropdown.Trigger>
        <Dropdown.Content align="end" onClick={(event) => event.stopPropagation()}>
          <Dropdown.Item onSelect={onQueueInWorkingHours}>
            <Dropdown.ItemIcon as={RiTimerLine} className="text-text-sub-600" />
            <span>Queue in working hours</span>
          </Dropdown.Item>
        </Dropdown.Content>
      </Dropdown.Root>
    </div>
  );
}

/**
 * The reply composer, trimmed to what an inline row needs: the message being
 * answered on one side, the editable draft on the other, and the same
 * Send now / Save / Regenerate / Discard set the record page has.
 */
export function InlineDraftEditor({ action, onMutate, onClose, busy }: { action: Data; onMutate: RowMutation; onClose: () => void; busy: boolean }) {
  const record = asObject(action.record);
  const draft = asObject(action.draft);
  const inbound = asObject(action.latestInbound);
  const policy = asObject(action.contactPolicy);
  const channel = String(draft.channel ?? action.channel ?? "email");
  const initialBody = String(draft.editedBodyText ?? draft.aiBodyText ?? "");
  const initialSubject = String(draft.subject ?? "");
  const [body, setBody] = useState(initialBody);
  const [subject, setSubject] = useState(initialSubject);
  const [regenerateOpen, setRegenerateOpen] = useState(false);
  // A refresh after Save brings a new revision; the fields follow it so the
  // next send carries the revision the server knows about.
  useEffect(() => { setBody(initialBody); setSubject(initialSubject); }, [initialBody, initialSubject]);

  const draftId = String(draft.id ?? "");
  const revision = Number(draft.revision ?? 1);
  const stale = Number(draft.expectedContextVersion) !== Number(record.contextVersion);
  const dnc = Boolean(policy.doNotContact);
  const dirty = body !== initialBody || subject !== initialSubject;
  const ready = Boolean(draftId && body.trim() && (channel !== "email" || subject.trim()) && !dnc && !stale && !busy);
  const requestSubject = channel === "email" ? subject : null;
  const payload = { subject: requestSubject, body, revision };

  const inboundBody = String(inbound.bodyText ?? "").trim();
  const inboundSubject = String(inbound.subject ?? "").trim();

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]" onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
      <div className="min-w-0 rounded-xl bg-bg-weak-50 p-3.5 ring-1 ring-inset ring-stroke-soft-200">
        <div className="mb-2 flex items-baseline justify-between gap-3">
          <p className="text-label-xs uppercase tracking-wide text-text-soft-400">Their message</p>
          <p className="text-paragraph-xs text-text-soft-400">{formatDate(inbound.sentAt ?? record.lastInboundAt)}</p>
        </div>
        {inboundSubject && <p className="mb-1 text-label-sm text-text-strong-950">{inboundSubject}</p>}
        <p className="max-h-64 overflow-y-auto whitespace-pre-wrap text-paragraph-sm leading-6 text-text-sub-600">{inboundBody || "No message text available."}</p>
      </div>
      <div className="flex min-w-0 flex-col gap-3">
        {dnc && <Warning tone="danger" title="Sending is blocked" detail="This person is marked as Do Not Contact." />}
        {stale && !dnc && <Warning tone="warning" title="This draft may be out of date" detail="A newer reply changed the conversation. Regenerate, or open the record to review before sending." />}
        {channel === "email" && <input aria-label="Subject" className={fieldClass} value={subject} onChange={(event) => setSubject(event.target.value)} placeholder="Email subject" disabled={busy} />}
        <textarea
          aria-label="Reply"
          autoFocus
          className={cn(fieldClass, "min-h-36 resize-y leading-6")}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder={`Write a ${channel === "linkedin" ? "LinkedIn" : channel === "whatsapp" ? "WhatsApp" : "email"} reply…`}
          disabled={busy}
        />
        <div className="flex flex-wrap items-center gap-2">
          <SendDraftButton
            disabled={!ready}
            onSendNow={() => void onMutate(`/drafts/${draftId}/send`, payload, "POST", "Message sent")}
            onQueueInWorkingHours={() => void onMutate(`/drafts/${draftId}/send`, { ...payload, scheduleInWorkingHours: true }, "POST", "Queued for working hours")}
          />
          <button type="button" disabled={!draftId || !dirty || busy || !body.trim()} className={secondaryButtonClass} onClick={() => void onMutate(`/drafts/${draftId}`, payload, "PATCH", "Draft saved")}>
            <RiSaveLine className="size-4" aria-hidden="true" />Save
          </button>
          <button type="button" disabled={!draftId || busy} className={subtleButtonClass} onClick={() => setRegenerateOpen(true)}>
            <RiRefreshLine className="size-4" aria-hidden="true" />Regenerate
          </button>
          <RegenerateDraftDialog open={regenerateOpen} onOpenChange={setRegenerateOpen} busy={busy} onSubmit={(feedback) => onMutate(`/drafts/${draftId}/regenerate`, { feedback }, "POST", "Draft rewritten with your notes")} />
          <button type="button" disabled={!draftId || busy} className={dangerButtonClass} onClick={() => void onMutate(`/drafts/${draftId}/discard`, {}, "POST", "Draft discarded")}>
            <RiDeleteBinLine className="size-4" aria-hidden="true" />Discard
          </button>
          <button type="button" className={cn(subtleButtonClass, "ml-auto")} onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function Warning({ tone, title, detail }: { tone: "warning" | "danger"; title: string; detail: string }) {
  const danger = tone === "danger";
  return <div className={cn("flex gap-2 rounded-lg p-3 ring-1 ring-inset", danger ? "bg-error-lighter text-error-dark ring-error-light" : "bg-warning-lighter text-warning-dark ring-warning-light")}><RiErrorWarningLine className="mt-0.5 size-4 shrink-0" aria-hidden="true" /><div><p className="text-label-sm">{title}</p><p className="mt-0.5 text-paragraph-xs">{detail}</p></div></div>;
}
