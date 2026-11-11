"use client";

import { useMemo, useState } from "react";
import { RiErrorWarningLine, RiMailCheckLine, RiMailLine, RiMailSendLine, RiSpeedUpLine } from "@remixicon/react";

import { Frame, FramePanel } from "@/components/analytics/kit/Frame";
import { KpiCell, KpiStrip } from "@/components/analytics/kit/KpiStrip";
import { formatPercent } from "@/components/analytics/theme";
import { DocsLink } from "@/components/page/DocsLink";
import { EmptyState } from "@/components/page/EmptyState";
import { ACCOUNTS_PAGE_SIZE, AccountsFrame, AccountsNoMatch, AccountsPager, type AccountFilter } from "@/components/settings/AccountsOverview";
import AddMailboxButton from "./AddMailboxButton";
import MailboxTable from "./MailboxTable";
import type { mailboxes } from "@/lib/outreach/schema";

type Mailbox = typeof mailboxes.$inferSelect;

const healthy = (m: Mailbox) => m.status === "connected";

export default function MailboxesPageClient({ mailboxes }: { mailboxes: Mailbox[] }) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<AccountFilter>("all");
  const [page, setPage] = useState(0);

  const connected = mailboxes.filter(healthy).length;
  const attention = mailboxes.length - connected;
  const failed = mailboxes.filter((m) => m.status === "failed").length;
  const sentToday = mailboxes.reduce((sum, m) => sum + m.todayEmailsSent, 0);
  // Only a connected mailbox can send, so only its limit is capacity.
  const capacity = mailboxes.filter(healthy).reduce((sum, m) => sum + m.dailySendLimit, 0);
  const left = mailboxes.filter(healthy).reduce((sum, m) => sum + Math.max(m.dailySendLimit - m.todayEmailsSent, 0), 0);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return mailboxes
      .filter((m) => {
        if (filter === "healthy" && !healthy(m)) return false;
        if (filter === "attention" && healthy(m)) return false;
        if (!term) return true;
        return m.emailAddress.toLowerCase().includes(term) || (m.displayName ?? "").toLowerCase().includes(term);
      })
      // Mailboxes that need attention first, so a failure is never on page 5.
      .sort((a, b) => Number(healthy(a)) - Number(healthy(b)));
  }, [mailboxes, search, filter]);

  // A filter or search that shrinks the list can leave the page past its end.
  const pageCount = Math.max(1, Math.ceil(filtered.length / ACCOUNTS_PAGE_SIZE));
  const current = Math.min(page, pageCount - 1);
  const visible = filtered.slice(current * ACCOUNTS_PAGE_SIZE, (current + 1) * ACCOUNTS_PAGE_SIZE);

  if (mailboxes.length === 0) {
    return (
      <Frame>
        <FramePanel>
          <EmptyState
            icon={RiMailLine}
            title="No mailboxes yet"
            description="Add a Google Workspace address authorised for sending, and campaigns can start sending from it."
            action={
              <div className="flex flex-wrap items-center justify-center gap-2">
                <AddMailboxButton />
                <DocsLink page="email/connect#add-a-mailbox" />
              </div>
            }
          />
        </FramePanel>
      </Frame>
    );
  }

  return (
    <div>
      <KpiStrip columns={4}>
        <KpiCell icon={RiMailCheckLine} label="Connected" value={String(connected)} context={`of ${mailboxes.length} ${mailboxes.length === 1 ? "mailbox" : "mailboxes"}`} />
        <KpiCell
          icon={RiErrorWarningLine}
          label="Needs attention"
          value={String(attention)}
          context={attention === 0 ? "Every mailbox is sending" : failed > 0 ? `${failed} failed the connection test` : "Disabled or still connecting"}
          hint="Mailboxes that are not connected: a failed connection test, disabled, or still connecting. They send nothing until fixed."
        />
        <KpiCell icon={RiMailSendLine} label="Sent today" value={sentToday.toLocaleString("en-US")} context={capacity > 0 ? `${formatPercent(sentToday / capacity)} of today's capacity` : "No sending capacity"} />
        <KpiCell
          icon={RiSpeedUpLine}
          label="Left today"
          value={left.toLocaleString("en-US")}
          context={`of ${capacity.toLocaleString("en-US")} a day across connected mailboxes`}
          hint="The daily send limits of connected mailboxes, minus what they have sent today."
        />
      </KpiStrip>

      <AccountsFrame
        title="Mailboxes"
        description="Daily limits, sending hours and connection health."
        filter={filter}
        onFilterChange={(next) => {
          setFilter(next);
          setPage(0);
        }}
        counts={{ all: mailboxes.length, healthy: connected, attention }}
        search={search}
        onSearchChange={(value) => {
          setSearch(value);
          setPage(0);
        }}
        searchPlaceholder="Search mailboxes…"
        footer={<AccountsPager page={current} total={filtered.length} noun="mailboxes" onPage={setPage} />}
      >
        {filtered.length === 0 ? <AccountsNoMatch noun="mailboxes" /> : <MailboxTable mailboxes={visible} />}
      </AccountsFrame>
    </div>
  );
}
