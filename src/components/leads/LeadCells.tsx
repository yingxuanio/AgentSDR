"use client";
/* eslint-disable @next/next/no-img-element -- remote company favicons are domain-derived and intentionally unoptimized */

import { useEffect, useRef, useState, type ComponentType, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { RiGlobalLine, RiLinkedinBoxFill, RiMailFill, RiPhoneFill, RiSparkling2Fill } from "@remixicon/react";
import * as Tooltip from "@/components/alignui/tooltip";
import { CHANNEL_META, HUE } from "@/components/analytics/theme";
import { LEAD_CRM_BADGE_STYLE } from "@/components/crm/crm-utils";
import { cn } from "@/utils/cn";
import { deriveLeadCrmDisplay, linkedInPersonHref, shortDate, type Campaign, type PersonRow } from "./leadTypes";

/** Stops a click on a control inside a clickable row from also opening the row. */
export const stop = (event: MouseEvent | KeyboardEvent) => event.stopPropagation();

/** The soft dash every empty cell shows. */
export const Empty = ({ label }: { label?: string }) => <span className="text-paragraph-sm text-text-soft-400" aria-label={label}>—</span>;

export function CompanyFavicon({ domain, className }: { domain: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return <span aria-hidden="true" className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg bg-bg-weak-50 text-text-soft-400 ring-1 ring-inset ring-stroke-soft-200", className)}><RiGlobalLine className="size-4" /></span>;
  }
  // Favicons are drawn for white pages, so the plate stays white in dark mode too.
  return <img src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`} alt="" onError={() => setFailed(true)} className={cn("size-8 shrink-0 rounded-lg bg-static-white p-1 ring-1 ring-inset ring-stroke-soft-200", className)} />;
}

/** Name over one muted line, both truncating; the shared first-column body. */
export function TwoLine({ primary, secondary, primaryTitle }: { primary: ReactNode; secondary?: string | null; primaryTitle?: string }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-label-sm text-text-strong-950" title={primaryTitle}>{primary}</div>
      {secondary && <div className="mt-0.5 truncate text-paragraph-xs text-text-sub-600" title={secondary}>{secondary}</div>}
    </div>
  );
}

// ------------------------------------------------------------ reachability

type Reach = { key: string; label: string; icon: ComponentType<{ className?: string }>; color: string; value: string | null; href?: string; copy?: boolean };

/**
 * One icon per channel, always in the same slot so they line up down the
 * column. Present: channel colour, tooltip with the value, click copies (email,
 * phone) or opens (LinkedIn). Absent: a faint icon that says so on hover.
 */
function ReachIcon({ item }: { item: Reach }) {
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const Icon = item.icon;
  const present = Boolean(item.value);
  const base = "flex size-7 items-center justify-center rounded-md outline-none transition focus-visible:ring-2 focus-visible:ring-stroke-strong-950";
  const tip = !present ? `No ${item.label.toLowerCase()}` : copied ? "Copied" : item.copy ? `${item.value} · click to copy` : `Open ${item.label} profile`;

  const trigger = !present ? (
    <span tabIndex={0} aria-label={tip} className={cn(base, "text-text-disabled-300")} onClick={stop}><Icon className="size-4" /></span>
  ) : item.href ? (
    <a href={item.href} target="_blank" rel="noreferrer" aria-label={`Open ${item.label} profile`} onClick={stop} onKeyDown={stop} className={cn(base, "hover:bg-bg-soft-200")} style={{ color: item.color }}>
      <Icon className="size-4" />
    </a>
  ) : (
    <button
      type="button"
      aria-label={`Copy ${item.label.toLowerCase()} ${item.value}`}
      onKeyDown={stop}
      onClick={(event) => {
        event.stopPropagation();
        // Keeps the tooltip open to show "Copied" instead of Radix closing it on click.
        event.preventDefault();
        void navigator.clipboard?.writeText(item.value as string).then(() => {
          setCopied(true); setOpen(true);
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => { setCopied(false); setOpen(false); }, 1200);
        }).catch(() => undefined);
      }}
      className={cn(base, "hover:bg-bg-soft-200")}
      style={{ color: item.color }}
    >
      <Icon className="size-4" />
    </button>
  );

  return (
    <Tooltip.Root open={open} onOpenChange={(next) => setOpen(next || copied)}>
      <Tooltip.Trigger asChild>{trigger}</Tooltip.Trigger>
      <Tooltip.Content size="xsmall" className="max-w-72 truncate">{tip}</Tooltip.Content>
    </Tooltip.Root>
  );
}

export function ReachIcons({ person }: { person: PersonRow["person"] }) {
  const items: Reach[] = [
    { key: "email", label: "Email", icon: RiMailFill, color: CHANNEL_META.email.color, value: person.email, copy: true },
    { key: "linkedin", label: "LinkedIn", icon: RiLinkedinBoxFill, color: CHANNEL_META.linkedin.color, value: person.linkedinUrl, href: person.linkedinUrl ? linkedInPersonHref(person.linkedinUrl) : undefined },
    // The number WhatsApp calls and messages go to, hence WhatsApp's colour.
    { key: "phone", label: "Phone", icon: RiPhoneFill, color: CHANNEL_META.whatsapp.color, value: person.phone ?? null, copy: true },
  ];
  return <div className="-ml-1.5 flex items-center gap-0.5">{items.map((item) => <ReachIcon key={item.key} item={item} />)}</div>;
}

/** Links for a company row: website and LinkedIn page, same slots as ReachIcons. */
export function LinkIcon({ href, label, icon: Icon, color }: { href: string | null; label: string; icon: ComponentType<{ className?: string; style?: React.CSSProperties }>; color?: string }) {
  const base = "flex size-7 items-center justify-center rounded-md outline-none transition focus-visible:ring-2 focus-visible:ring-stroke-strong-950";
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        {href
          ? <a href={href} target="_blank" rel="noreferrer" aria-label={`Open ${label}`} onClick={stop} onKeyDown={stop} className={cn(base, "text-text-sub-600 hover:bg-bg-soft-200 hover:text-text-strong-950")}><Icon className="size-4" style={color ? { color } : undefined} /></a>
          : <span tabIndex={0} aria-label={`No ${label}`} onClick={stop} className={cn(base, "text-text-disabled-300")}><Icon className="size-4" /></span>}
      </Tooltip.Trigger>
      <Tooltip.Content size="xsmall">{href ? `Open ${label}` : `No ${label}`}</Tooltip.Content>
    </Tooltip.Root>
  );
}

// ---------------------------------------------------------------- outreach

const isActive = (campaign: Campaign) => (campaign.status ?? "").toLowerCase() === "active";
const statusLabel = (status?: string) => (status ? status.charAt(0).toUpperCase() + status.slice(1).toLowerCase() : "");

/**
 * One line: the channel icon and one campaign's name (an active one when
 * there is one), plus "+N" for the rest. When not in a campaign, surfaces
 * direct CRM outreach activity (e.g., Direct email) so contacted/drafted
 * rows don't show an empty dash.
 */
export function CampaignSummary({ campaigns, crm }: { campaigns: Campaign[]; crm?: PersonRow["crm"] }) {
  if (!campaigns.length) {
    const draft = crm?.latestDraft ?? null;
    const hasDirectOutreach = Boolean(crm && (crm.lastOutboundAt || (draft && draft.status !== "discarded")));
    if (!hasDirectOutreach || !crm) return <Empty label="Not in a campaign" />;

    const rawChannel = (crm.activeChannel || draft?.channel || "email").toLowerCase();
    const channelKey = (rawChannel === "linkedin" || rawChannel === "whatsapp" ? rawChannel : "email") as keyof typeof CHANNEL_META;
    const ChannelIcon = CHANNEL_META[channelKey].icon;
    const label = channelKey === "linkedin" ? "Direct LinkedIn" : channelKey === "whatsapp" ? "Direct WhatsApp" : "Direct email";
    const statusDetail = crm.lastOutboundAt
      ? `Sent ${shortDate(crm.lastOutboundAt)}`
      : draft?.status === "awaiting_review" && draft.autoSendAt
        ? `Queued · ${shortDate(draft.autoSendAt)}`
        : draft?.status === "awaiting_review"
          ? "Draft ready"
          : draft?.status
            ? statusLabel(draft.status.replaceAll("_", " "))
            : "CRM outreach";

    return (
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <span tabIndex={0} className="flex min-w-0 max-w-full items-center gap-2 rounded outline-none focus-visible:ring-2 focus-visible:ring-stroke-strong-950">
            <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-bg-white-0 ring-1 ring-stroke-soft-200" style={{ color: CHANNEL_META[channelKey].color }}>
              <ChannelIcon className="size-3" />
            </span>
            <span className="truncate text-paragraph-sm text-text-sub-600">{label}</span>
          </span>
        </Tooltip.Trigger>
        <Tooltip.Content size="medium" variant="light" side="bottom" align="start" className="max-w-72 p-2.5">
          <p className="text-label-xs text-text-strong-950">{label} · {statusDetail}</p>
          {draft?.subject && <p className="mt-1 truncate text-paragraph-xs text-text-sub-600">{draft.subject}</p>}
        </Tooltip.Content>
      </Tooltip.Root>
    );
  }
  const lead = campaigns.find(isActive) ?? campaigns[0];
  const rest = campaigns.length - 1;
  const channels = [...new Set(campaigns.map((campaign) => campaign.channel))];
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <span tabIndex={0} className="flex min-w-0 max-w-full items-center gap-2 rounded outline-none focus-visible:ring-2 focus-visible:ring-stroke-strong-950">
          <span className="flex shrink-0 items-center -space-x-1">
            {channels.map((channel) => {
              const ChannelIcon = CHANNEL_META[channel].icon;
              return <span key={channel} className="flex size-5 items-center justify-center rounded-full bg-bg-white-0 ring-1 ring-stroke-soft-200" style={{ color: CHANNEL_META[channel].color }}><ChannelIcon className="size-3" /></span>;
            })}
          </span>
          <span className="truncate text-paragraph-sm text-text-strong-950">{lead.name}</span>
          {rest > 0 && <span className="shrink-0 rounded-md bg-bg-weak-50 px-1.5 py-px text-label-xs tabular-nums text-text-sub-600 ring-1 ring-inset ring-stroke-soft-200">+{rest}</span>}
        </span>
      </Tooltip.Trigger>
      <Tooltip.Content size="medium" variant="light" side="bottom" align="start" className="w-72 p-2">
        <p className="px-1.5 pb-1.5 text-label-xs text-text-sub-600">{campaigns.length === 1 ? "1 campaign" : `${campaigns.length} campaigns`}</p>
        <ul className="space-y-0.5">
          {campaigns.map((campaign) => {
            const ChannelIcon = CHANNEL_META[campaign.channel].icon;
            return (
              <li key={`${campaign.channel}:${campaign.id}`} className="flex items-center gap-2 rounded-md px-1.5 py-1">
                <span className="shrink-0" style={{ color: CHANNEL_META[campaign.channel].color }}><ChannelIcon className="size-4" /></span>
                <span className="min-w-0 flex-1 truncate text-paragraph-sm text-text-strong-950">{campaign.name}</span>
                {campaign.status && (
                  <span className={cn("flex shrink-0 items-center gap-1 text-paragraph-xs", isActive(campaign) ? "text-text-strong-950" : "text-text-soft-400")}>
                    {isActive(campaign) && <span aria-hidden="true" className="size-1.5 rounded-full" style={{ backgroundColor: HUE.green }} />}
                    {statusLabel(campaign.status)}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </Tooltip.Content>
    </Tooltip.Root>
  );
}

// --------------------------------------------------------------------- CRM

/**
 * One chip in the category or outbound lifecycle stage's colour, plus a
 * secondary muted line with send/schedule/due context.
 */
export function CrmSummary({ crm }: { crm: PersonRow["crm"] }) {
  if (!crm) return <Empty label="No CRM record" />;
  const display = deriveLeadCrmDisplay(crm);
  const style = LEAD_CRM_BADGE_STYLE[display.kind];
  const facts = display.secondary;
  return (
    <div className="min-w-0">
      <span title={display.chip} className={cn("inline-flex h-5 max-w-full items-center gap-1.5 rounded-md px-1.5 text-label-xs ring-1 ring-inset", style.tone)}>
        <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: style.dot }} />
        <span className="truncate">{display.chip}</span>
      </span>
      {(facts || crm.unacknowledgedAiChange) && (
        <p className="mt-1 flex min-w-0 items-center gap-1 text-paragraph-xs text-text-sub-600">
          {crm.unacknowledgedAiChange && (
            <span className="flex shrink-0 items-center gap-0.5 text-warning-base" title="The AI changed this classification; review it on the record">
              <RiSparkling2Fill className="size-3" aria-hidden="true" />AI change{facts ? " ·" : ""}
            </span>
          )}
          {facts && <span className="truncate">{facts}</span>}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- skeleton

export const Bar = ({ className }: { className?: string }) => <div className={cn("h-2.5 animate-pulse rounded-full bg-bg-soft-200", className)} />;
export const Blob = ({ className }: { className?: string }) => <div className={cn("shrink-0 animate-pulse bg-bg-soft-200", className)} />;
