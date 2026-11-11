"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { RiExternalLinkLine, RiFileCopyLine, RiMore2Line, RiPhoneLine, RiUserSearchLine } from "@remixicon/react";
import * as Button from "@/components/alignui/button";
import * as Dropdown from "@/components/alignui/dropdown";
import * as Table from "@/components/alignui/table";
import * as Tooltip from "@/components/alignui/tooltip";
import { ContactAvatar } from "@/components/crm/ContactAvatar";
import { cn } from "@/utils/cn";
import { Bar, Blob, CampaignSummary, CompanyFavicon, CrmSummary, Empty, ReachIcons, stop, TwoLine } from "./LeadCells";
import { cellClass, fixedTableStyle, SortableHead } from "./SortableHead";
import { initials, linkedInPersonHref, type Direction, type PersonRow } from "./leadTypes";

const rowCell = cn(cellClass, "h-14");

function SkeletonRow({ index }: { index: number }) {
  // Varied widths so the placeholder reads as rows of text, not a grid of bars.
  const wide = ["w-28", "w-24", "w-32", "w-20"][index % 4];
  const narrow = ["w-16", "w-20", "w-14", "w-24"][index % 4];
  return (
    <Table.Row aria-hidden="true">
      <Table.Cell className={rowCell}><div className="flex items-center gap-3"><Blob className="size-8 rounded-full" /><div className="space-y-2"><Bar className={wide} /><Bar className={cn("h-2", narrow)} /></div></div></Table.Cell>
      <Table.Cell className={rowCell}><div className="flex items-center gap-3"><Blob className="size-7 rounded-lg" /><div className="space-y-2"><Bar className={narrow} /><Bar className="h-2 w-20" /></div></div></Table.Cell>
      <Table.Cell className={rowCell}><div className="flex gap-2.5">{[0, 1, 2].map((dot) => <Blob key={dot} className="size-4 rounded" />)}</div></Table.Cell>
      <Table.Cell className={rowCell}><div className="flex items-center gap-2"><Blob className="size-5 rounded-full" /><Bar className={wide} /></div></Table.Cell>
      <Table.Cell className={rowCell}><Blob className={cn("h-5 rounded-md", narrow)} /></Table.Cell>
      <Table.Cell className={rowCell} />
    </Table.Row>
  );
}

function PersonTableRow({ row }: { row: PersonRow }) {
  const router = useRouter();
  const { person, company, campaigns, crm } = row;
  const href = crm ? `/crm/records/${crm.recordId}` : null;
  const name = person.fullName || "Unnamed person";
  const companyName = company ? company.name || company.domain : null;
  return (
    <Table.Row
      tabIndex={href ? 0 : undefined}
      aria-label={href ? `Open ${name}` : undefined}
      onClick={href ? () => router.push(href) : undefined}
      onKeyDown={href ? (event) => { if (event.target === event.currentTarget && event.key === "Enter") router.push(href); } : undefined}
      className={cn("outline-none focus-visible:[&>td]:bg-bg-weak-50", href && "cursor-pointer")}
    >
      <Table.Cell className={rowCell}>
        <div className="flex min-w-0 items-center gap-3">
          <ContactAvatar src={person.profilePictureUrl} fallback={initials(person.fullName)} className="size-8 bg-bg-weak-50 text-label-xs text-text-sub-600 ring-1 ring-inset ring-stroke-soft-200" />
          <TwoLine
            primaryTitle={name}
            primary={href ? <Link href={href} onClick={stop} tabIndex={-1} className="hover:underline hover:decoration-stroke-sub-300 hover:underline-offset-2">{name}</Link> : name}
            secondary={person.title}
          />
        </div>
      </Table.Cell>
      <Table.Cell className={rowCell}>
        {company ? (
          <div className="flex min-w-0 items-center gap-2.5">
            <CompanyFavicon domain={company.domain} className="size-7" />
            <TwoLine primary={companyName} primaryTitle={companyName ?? undefined} secondary={company.name && company.name !== company.domain ? company.domain : null} />
          </div>
        ) : <Empty label="No company" />}
      </Table.Cell>
      <Table.Cell className={rowCell}><ReachIcons person={person} /></Table.Cell>
      <Table.Cell className={rowCell}><CampaignSummary campaigns={campaigns} crm={crm} /></Table.Cell>
      <Table.Cell className={rowCell}><CrmSummary crm={crm} /></Table.Cell>
      <Table.Cell className={cn(rowCell, "pl-0 pr-2")} onClick={stop} onKeyDown={stop}>
        <div className="flex justify-end">
          <Dropdown.Root>
            <Dropdown.Trigger asChild>
              <Button.Root variant="neutral" mode="ghost" size="xsmall" aria-label={`More actions for ${name}`}><Button.Icon as={RiMore2Line} /></Button.Root>
            </Dropdown.Trigger>
            <Dropdown.Content>
              {href && <Dropdown.Item onSelect={() => router.push(href)}><Dropdown.ItemIcon as={RiUserSearchLine} />Open CRM record</Dropdown.Item>}
              {person.linkedinUrl && <Dropdown.Item onSelect={() => window.open(linkedInPersonHref(person.linkedinUrl as string), "_blank", "noopener,noreferrer")}><Dropdown.ItemIcon as={RiExternalLinkLine} />Open LinkedIn profile</Dropdown.Item>}
              {person.email && <Dropdown.Item onSelect={() => void navigator.clipboard?.writeText(person.email as string)}><Dropdown.ItemIcon as={RiFileCopyLine} />Copy email</Dropdown.Item>}
              {person.phone && <Dropdown.Item onSelect={() => void navigator.clipboard?.writeText(person.phone as string)}><Dropdown.ItemIcon as={RiPhoneLine} />Copy phone</Dropdown.Item>}
              {!href && !person.linkedinUrl && !person.email && !person.phone && <div className="p-2 text-paragraph-sm text-text-soft-400">No actions available</div>}
            </Dropdown.Content>
          </Dropdown.Root>
        </div>
      </Table.Cell>
    </Table.Row>
  );
}

export function PeopleTable({ rows, sort, direction, onSort, loading }: {
  rows: PersonRow[] | null;
  sort: string;
  direction: Direction;
  onSort: (key: string) => void;
  loading: boolean;
}) {
  const head = { activeSort: sort, direction, onSort };
  return (
    <Tooltip.Provider delayDuration={250} skipDelayDuration={300} disableHoverableContent>
      <Table.Root style={fixedTableStyle}>
        <Table.Header>
          <tr>
            <SortableHead label="Name" sortKey="name" className="w-[21%]" {...head} />
            <SortableHead label="Company" sortKey="company" className="w-[18%]" {...head} />
            <SortableHead label="Reach" className="w-28" />
            <SortableHead label="Outreach" className="w-[18%]" />
            <SortableHead label="CRM" />
            <SortableHead label={<span className="sr-only">Actions</span>} className="w-12" />
          </tr>
        </Table.Header>
        <Table.Body spacing={4} className={cn("transition-opacity", loading && rows && "opacity-60")} aria-busy={loading}>
          {rows === null ? Array.from({ length: 10 }, (_, index) => <SkeletonRow key={index} index={index} />) : rows.map((row) => <PersonTableRow key={row.person.id} row={row} />)}
        </Table.Body>
      </Table.Root>
    </Tooltip.Provider>
  );
}
