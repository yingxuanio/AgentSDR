import { CRM_CATEGORY_COLOR } from "@/components/analytics/theme";

export type CrmCategory = "customer" | "interested" | "not_interested" | "other";
export type CrmChannel = "email" | "linkedin" | "whatsapp";

export const CATEGORY_LABELS: Record<CrmCategory, string> = {
  customer: "Customer",
  interested: "Interested",
  not_interested: "Not interested",
  other: "Other",
};

/**
 * One identity colour per CRM category, the same as the Analytics CRM cards
 * (`CRM_CATEGORY_COLOR` in the analytics theme), so a badge here and a slice
 * of the pipeline donut there read as one thing. `tone` is the badge tint in
 * theme tokens; `color` is the exact swatch (dots, bars). Unclassified is not
 * a category — it is the absence of one — so it stays gray.
 */
export const CATEGORY_COLOR: Record<CrmCategory | "unclassified", { color: string; tone: string }> = {
  interested: { color: CRM_CATEGORY_COLOR.interested, tone: "bg-success-lighter text-success-dark ring-success-light" },
  customer: { color: CRM_CATEGORY_COLOR.customer, tone: "bg-feature-lighter text-feature-dark ring-feature-light" },
  not_interested: { color: CRM_CATEGORY_COLOR.not_interested, tone: "bg-error-lighter text-error-dark ring-error-light" },
  other: { color: CRM_CATEGORY_COLOR.other, tone: "bg-warning-lighter text-warning-dark ring-warning-light" },
  unclassified: { color: CRM_CATEGORY_COLOR.unclassified, tone: "bg-bg-weak-50 text-text-sub-600 ring-stroke-soft-200" },
};

export function categoryColor(key: string | null | undefined) {
  return CATEGORY_COLOR[(key ?? "unclassified") as CrmCategory] ?? CATEGORY_COLOR.unclassified;
}

export function asList<T = Record<string, unknown>>(value: unknown, keys: string[] = []): T[] {
  if (Array.isArray(value)) return value as T[];
  if (!value || typeof value !== "object") return [];
  const object = value as Record<string, unknown>;
  for (const key of keys) if (Array.isArray(object[key])) return object[key] as T[];
  for (const key of ["data", "items", "results"]) if (Array.isArray(object[key])) return object[key] as T[];
  return [];
}

export function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

export function displayName(value: Record<string, unknown>): string {
  const person = asObject(value.person);
  const raw = asObject(value.raw);
  const personRaw = asObject(person.raw);
  const name = value.name || value.fullName || person.name || person.fullName
    || raw.name || raw.fullName || raw.full_name
    || personRaw.name || personRaw.fullName || personRaw.full_name;
  if (typeof name === "string" && name.trim()) return name;
  const first = value.firstName || value.first_name || person.firstName || person.first_name
    || raw.firstName || raw.first_name || personRaw.firstName || personRaw.first_name || "";
  const last = value.lastName || value.last_name || person.lastName || person.last_name
    || raw.lastName || raw.last_name || personRaw.lastName || personRaw.last_name || "";
  const fullName = `${String(first)} ${String(last)}`.trim();
  if (fullName) return fullName;
  const email = value.email || person.email || raw.email || personRaw.email;
  if (typeof email === "string" && email.trim()) return email.trim();
  const linkedin = value.linkedinUrl || value.linkedin_url || person.linkedinUrl || person.linkedin_url
    || raw.linkedinUrl || raw.linkedin_url || personRaw.linkedinUrl || personRaw.linkedin_url;
  if (typeof linkedin === "string" && linkedin.trim()) {
    const slug = linkedin.trim().replace(/\/+$/, "").split("/").pop() || linkedin.trim();
    return `LinkedIn · ${slug}`;
  }
  return "Unknown contact";
}

export function formatDate(value: unknown, fallback = "—"): string {
  if (!value) return fallback;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return fallback;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

/** Past-facing counterpart to relativeDate, for "when did this land" columns. */
export function timeAgo(value: unknown, fallback = "—"): string {
  if (!value) return fallback;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return fallback;
  const minutes = Math.round((Date.now() - date.getTime()) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return formatDate(value, fallback);
}

export function relativeDate(value: unknown): string {
  if (!value) return "—";
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return "—";
  const minutes = Math.round((date.getTime() - Date.now()) / 60000);
  if (Math.abs(minutes) < 60) return minutes < 0 ? `${Math.abs(minutes)}m overdue` : `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return hours < 0 ? `${Math.abs(hours)}h overdue` : `in ${hours}h`;
  const days = Math.round(hours / 24);
  return days < 0 ? `${Math.abs(days)}d overdue` : `in ${days}d`;
}

export async function crmFetch<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (init?.method && init.method !== "GET" && !headers.has("Idempotency-Key")) {
    headers.set("Idempotency-Key", crypto.randomUUID());
  }
  const response = await fetch(`/api/crm${path}`, { ...init, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof body?.error === "string" ? body.error : `Request failed (${response.status})`;
    throw new Error(message);
  }
  return body as T;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}

export function badgeClass(value: string): string {
  if (value === "customer" || value === "sent") return "bg-success-lighter text-success-dark";
  if (value === "interested" || value === "draft") return "bg-information-lighter text-information-dark";
  if (value === "not_interested" || value === "error") return "bg-error-lighter text-error-dark";
  return "bg-bg-weak-50 text-text-sub-600";
}

function cleanText(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

export function extractLeadContext(
  person: Record<string, unknown>,
  company: Record<string, unknown>,
) {
  const personCustom = asObject(person.custom);
  const companyCustom = asObject(company.custom);
  const companyRaw = asObject(company.raw);

  const companyCode = cleanText(companyCustom.x_code)
    || cleanText(companyCustom.company_code)
    || cleanText(companyRaw.x_code)
    || cleanText(companyRaw.company_code);
  const region = cleanText(companyCustom.x_region) || cleanText(companyRaw.x_region);

  const fallbackLegacyReason = [
    [cleanText(companyCustom.x_signal_date), cleanText(companyCustom.x_signal_type)].filter(Boolean).join(" · "),
    cleanText(companyCustom.x_tech_stack),
    cleanText(companyCustom.x_pitch_angle),
  ].filter(Boolean).join(" ｜ ");

  const leadReason = cleanText(companyCustom.x_lead_reason) || fallbackLegacyReason;
  const verificationNote = cleanText(personCustom.x_verification_note);

  return {
    companyCode,
    region,
    leadReason,
    verificationNote,
  };
}
