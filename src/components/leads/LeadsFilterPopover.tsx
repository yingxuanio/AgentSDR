"use client";

import { RiFilter3Line } from "@remixicon/react";
import * as Badge from "@/components/alignui/badge";
import * as Button from "@/components/alignui/button";
import * as Checkbox from "@/components/alignui/checkbox";
import * as Popover from "@/components/alignui/popover";
import * as Select from "@/components/alignui/select";
import { activeFilterCount, type PeopleFilters } from "./leadTypes";

export type Subcategory = { id: string; name: string; categoryKey: string };

const STATES = ["unclassified", "classifying", "action_required", "waiting", "idle", "paused", "closed", "error"];

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="space-y-1.5"><span className="block text-label-xs text-text-sub-600">{label}</span>{children}</div>;
}

function Check({ id, label, checked, onChange }: { id: string; label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <label htmlFor={id} className="flex cursor-pointer items-center gap-2 text-paragraph-sm text-text-strong-950">
      <Checkbox.Root id={id} checked={checked} onCheckedChange={(value) => onChange(value === true)} />
      {label}
    </label>
  );
}

export function LeadsFilterPopover({ filters, subcategories, onChange, onClear }: {
  filters: PeopleFilters;
  subcategories: Subcategory[];
  onChange: (patch: Partial<PeopleFilters>) => void;
  onClear: () => void;
}) {
  const count = activeFilterCount(filters);
  const visibleSubcategories = subcategories.filter((item) => !filters.crmCategory || item.categoryKey === filters.crmCategory);
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <Button.Root variant="neutral" mode="stroke" size="small">
          <Button.Icon as={RiFilter3Line} />
          Filter
          {count > 0 && <Badge.Root size="medium" variant="filled" color="blue" square>{count}</Badge.Root>}
        </Button.Root>
      </Popover.Trigger>
      <Popover.Content align="end" showArrow={false} sideOffset={8} className="w-[min(22rem,calc(100vw-2rem))]">
        <div className="flex items-center justify-between">
          <h2 className="text-label-md text-text-strong-950">Filters</h2>
          <button type="button" onClick={onClear} disabled={!count} className="text-label-sm text-primary-base outline-none hover:underline focus-visible:underline disabled:pointer-events-none disabled:text-text-disabled-300">Clear all</button>
        </div>
        <div className="mt-4 space-y-4">
          <Field label="Campaign">
            <Select.Root size="small" value={filters.campaignChannel} onValueChange={(value) => onChange({ campaignChannel: value })}>
              <Select.Trigger aria-label="Campaign filter"><Select.Value placeholder="All campaigns" /></Select.Trigger>
              <Select.Content>
                <Select.Item value="">All campaigns</Select.Item>
                <Select.Item value="email">Email campaigns</Select.Item>
                <Select.Item value="linkedin">LinkedIn campaigns</Select.Item>
                <Select.Item value="unassigned">Not in campaign</Select.Item>
              </Select.Content>
            </Select.Root>
          </Field>
          <Field label="CRM stage / category">
            <Select.Root size="small" value={filters.crmCategory} onValueChange={(value) => onChange({ crmCategory: value, crmSubcategoryId: "" })}>
              <Select.Trigger aria-label="CRM category filter"><Select.Value placeholder="All CRM stages" /></Select.Trigger>
              <Select.Content>
                <Select.Item value="">All CRM stages</Select.Item>
                <Select.Item value="contacted">Contacted (awaiting reply)</Select.Item>
                <Select.Item value="draft_ready">Draft ready</Select.Item>
                <Select.Item value="queued">Queued to send</Select.Item>
                <Select.Item value="new_lead">New lead (uncontacted)</Select.Item>
                <Select.Item value="interested">Interested</Select.Item>
                <Select.Item value="customer">Customer</Select.Item>
                <Select.Item value="other">Other</Select.Item>
                <Select.Item value="not_interested">Not interested</Select.Item>
              </Select.Content>
            </Select.Root>
          </Field>
          <Field label="Subcategory">
            <Select.Root size="small" value={filters.crmSubcategoryId} onValueChange={(value) => onChange({ crmSubcategoryId: value })} disabled={!visibleSubcategories.length}>
              <Select.Trigger aria-label="CRM subcategory filter"><Select.Value placeholder="All subcategories" /></Select.Trigger>
              <Select.Content>
                <Select.Item value="">All subcategories</Select.Item>
                {visibleSubcategories.map((item) => <Select.Item key={item.id} value={item.id}>{item.name}</Select.Item>)}
              </Select.Content>
            </Select.Root>
          </Field>
          <Field label="CRM state">
            <Select.Root size="small" value={filters.crmWorkflowState} onValueChange={(value) => onChange({ crmWorkflowState: value })}>
              <Select.Trigger aria-label="CRM workflow filter"><Select.Value placeholder="All CRM states" /></Select.Trigger>
              <Select.Content>
                <Select.Item value="">All CRM states</Select.Item>
                {STATES.map((state) => <Select.Item key={state} value={state} className="capitalize">{state.replaceAll("_", " ")}</Select.Item>)}
              </Select.Content>
            </Select.Root>
          </Field>
          <div className="space-y-3 border-t border-stroke-soft-200 pt-4">
            <Check id="lead-filter-has-email" label="Has email" checked={filters.hasEmail} onChange={(hasEmail) => onChange({ hasEmail })} />
            <Check id="lead-filter-has-linkedin" label="Has LinkedIn" checked={filters.hasLinkedin} onChange={(hasLinkedin) => onChange({ hasLinkedin })} />
            <Check id="lead-filter-ai-change" label="AI changed" checked={filters.crmAiChange} onChange={(crmAiChange) => onChange({ crmAiChange })} />
          </div>
        </div>
      </Popover.Content>
    </Popover.Root>
  );
}
