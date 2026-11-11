export type Campaign = { id: string; name: string; channel: "email" | "linkedin"; status?: string };

export type PersonCrmSummary = {
  recordId: string;
  categoryKey: string | null;
  subcategory: string | null;
  workflowState: string;
  activeChannel: string | null;
  activeSequence: string | null;
  currentStep: string | null;
  lastInboundAt: string | Date | null;
  lastOutboundAt: string | Date | null;
  lastInteractionAt: string | Date | null;
  nextActionAt: string | Date | null;
  unacknowledgedAiChange: boolean;
  dnc?: boolean;
  latestDraft?: {
    status: string;
    autoSendAt: string | Date | null;
    channel: string;
    subject?: string | null;
  } | null;
};

export type PersonRow = {
  person: { id: string; email: string | null; linkedinUrl: string | null; fullName: string | null; title: string | null; profilePictureUrl?: string | null; phone?: string | null; source: string; raw?: Record<string, unknown>; updatedAt: string | Date | null };
  company: { name: string | null; domain: string } | null;
  campaigns: Campaign[];
  crm: PersonCrmSummary | null;
};

export type CompanyRow = {
  company: { id: string; name: string | null; domain: string; linkedinUrl: string | null; source: string; updatedAt: string | Date };
  peopleCount: number;
  campaigns: Campaign[];
};

export type LeadsTab = "people" | "companies";
export type Direction = "asc" | "desc";

export type PeopleFilters = {
  campaignChannel: string;
  hasEmail: boolean;
  hasLinkedin: boolean;
  crmCategory: string;
  crmSubcategoryId: string;
  crmWorkflowState: string;
  crmAiChange: boolean;
};

export const EMPTY_FILTERS: PeopleFilters = { campaignChannel: "", hasEmail: false, hasLinkedin: false, crmCategory: "", crmSubcategoryId: "", crmWorkflowState: "", crmAiChange: false };

export function activeFilterCount(filters: PeopleFilters): number {
  return [filters.campaignChannel, filters.hasEmail, filters.hasLinkedin, filters.crmCategory, filters.crmSubcategoryId, filters.crmWorkflowState, filters.crmAiChange].filter(Boolean).length;
}

export const PAGE_SIZE = 25;

export const linkedInPersonHref = (value: string) => (value.startsWith("http") ? value : `https://www.linkedin.com/in/${value}`);
export const linkedInCompanyHref = (value: string) => (value.startsWith("http") ? value : `https://www.linkedin.com/company/${value}`);
export const initials = (value: string | null) => (value || "?").split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();
export const dateLabel = (value: string | Date | null | undefined) => (value
  ? new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(value))
  : "—");

/** "Oct 3" this year, "Oct 3, 2025" otherwise — for dates inside a table cell. */
export const shortDate = (value: string | Date | null | undefined) => {
  if (!value) return "—";
  const date = new Date(value);
  const sameYear = date.getUTCFullYear() === new Date().getUTCFullYear();
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }), timeZone: "UTC" }).format(date);
};

/** Whether a timestamp is still ahead of now. */
export const isFuture = (value: string | Date) => new Date(value).getTime() > Date.now();

/** Sort choices per tab, for the toolbar's sort menu (keys match the API). */
export const SORTS: Record<LeadsTab, Array<{ key: string; label: string }>> = {
  people: [
    { key: "updated", label: "Last updated" },
    { key: "created", label: "Date added" },
    { key: "name", label: "Name" },
    { key: "company", label: "Company" },
    { key: "title", label: "Title" },
    { key: "email", label: "Email" },
  ],
  companies: [
    { key: "updated", label: "Last updated" },
    { key: "name", label: "Name" },
    { key: "domain", label: "Domain" },
    { key: "people", label: "People" },
  ],
};

export type LeadCrmBadgeKind =
  | "customer"
  | "interested"
  | "not_interested"
  | "other"
  | "dnc"
  | "delivery_issue"
  | "replied"
  | "queued"
  | "draft_ready"
  | "contacted"
  | "closed"
  | "new_lead";

export type LeadCrmDisplay = {
  kind: LeadCrmBadgeKind;
  chip: string;
  secondary: string | null;
};

const NOTABLE_STATE_LABELS: Record<string, string> = {
  action_required: "Action required",
  paused: "Paused",
  error: "Error",
  classifying: "Classifying",
  closed: "Closed",
};

function humanizeCategory(value: string): string {
  const text = value.replaceAll("_", " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Resolves a lead's CRM cell badge + secondary fact line.
 * When a lead has replied and received an intent classification (`categoryKey`),
 * shows that category/subcategory; before any reply (`categoryKey === null`),
 * surfaces the real outbound lifecycle stage (`New lead` → `Draft ready` →
 * `Queued` → `Contacted` / `Delivery issue` / `Replied` / `Closed`) instead of
 * labeling every pre-reply row "Unclassified".
 */
export function deriveLeadCrmDisplay(crm: PersonCrmSummary, nowMs = Date.now()): LeadCrmDisplay {
  if (crm.dnc) {
    return {
      kind: "dnc",
      chip: "Do not contact",
      secondary: crm.workflowState === "closed" ? "Closed" : null,
    };
  }

  const due = crm.nextActionAt ? new Date(crm.nextActionAt) : null;
  const dueFuture = due ? due.getTime() > nowMs : false;
  const draft = crm.latestDraft ?? null;

  if (crm.categoryKey) {
    const kind = (["customer", "interested", "not_interested", "other"].includes(crm.categoryKey)
      ? crm.categoryKey
      : "other") as LeadCrmBadgeKind;
    const category = humanizeCategory(crm.categoryKey);
    const chip = crm.subcategory ? `${category} · ${crm.subcategory}` : category;
    const state = NOTABLE_STATE_LABELS[crm.workflowState];
    const next = !due
      ? draft?.status === "awaiting_review" && draft.autoSendAt
        ? `Scheduled ${shortDate(draft.autoSendAt)}`
        : !state && crm.lastOutboundAt
          ? `Sent ${shortDate(crm.lastOutboundAt)}`
          : null
      : dueFuture
        ? `Next action ${shortDate(due)}`
        : state
          ? null
          : `Due ${shortDate(due)}`;
    const secondary = [state, next].filter(Boolean).join(" · ") || null;
    return { kind, chip, secondary };
  }

  if (crm.workflowState === "closed") {
    return {
      kind: "closed",
      chip: "Closed",
      secondary: crm.lastOutboundAt ? `Sent ${shortDate(crm.lastOutboundAt)}` : null,
    };
  }

  if (
    crm.workflowState === "error" ||
    draft?.status === "failed" ||
    draft?.status === "delivery_uncertain"
  ) {
    return {
      kind: "delivery_issue",
      chip: "Delivery issue",
      secondary: draft?.status === "delivery_uncertain" ? "Check recipient" : "Send failed",
    };
  }

  if (crm.workflowState === "classifying" || crm.lastInboundAt) {
    return {
      kind: "replied",
      chip: "Replied",
      secondary: crm.lastInboundAt ? `Classifying · ${shortDate(crm.lastInboundAt)}` : "Classifying",
    };
  }

  if (draft?.status === "awaiting_review" && draft.autoSendAt) {
    return {
      kind: "queued",
      chip: "Queued",
      secondary: `Scheduled ${shortDate(draft.autoSendAt)}`,
    };
  }

  if (draft?.status === "awaiting_review" || crm.workflowState === "action_required") {
    return {
      kind: "draft_ready",
      chip: "Draft ready",
      secondary: "Awaiting review",
    };
  }

  if (crm.lastOutboundAt) {
    const secondary =
      crm.workflowState === "paused"
        ? "Paused"
        : due
          ? dueFuture
            ? `Follow-up ${shortDate(due)}`
            : `Due ${shortDate(due)}`
          : `Sent ${shortDate(crm.lastOutboundAt)}`;
    return {
      kind: "contacted",
      chip: "Contacted",
      secondary,
    };
  }

  return {
    kind: "new_lead",
    chip: "New lead",
    secondary: crm.workflowState === "paused" ? "Paused" : null,
  };
}
