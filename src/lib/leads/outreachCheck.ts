import { and, isNotNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { companies, people } from "./schema";
import { inOrg } from "@/lib/tenancy/scope";

export type CodePrefix = "HK" | "TW" | "MO" | "CN" | "INTL";

export function normalizeRootDomain(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== "string") return null;
  let value = raw.trim().toLowerCase();
  if (!value) return null;
  if (value.includes("@") && !value.includes("/")) {
    value = value.split("@").pop() ?? "";
  }
  value = value.replace(/^[a-z]+:\/\//i, "");
  value = value.split("/")[0]?.split("?")[0]?.split("#")[0]?.split(":")[0] ?? "";
  value = value.replace(/^www\./i, "").replace(/\.+$/, "").trim();
  if (!value || !value.includes(".")) return null;
  return value;
}

export function inferCodePrefix(input: {
  companyRegion?: string | null;
  companyDomain?: string | null;
  companyCode?: string | null;
}): CodePrefix {
  const code = input.companyCode?.trim().toUpperCase();
  if (code) {
    for (const p of ["INTL", "HK", "TW", "MO", "CN"] as const) {
      if (code.startsWith(p)) return p;
    }
  }
  const region = (input.companyRegion ?? "").toLowerCase();
  const domain = (input.companyDomain ?? "").toLowerCase();
  if (/香港|hong\s*kong|\bhk\b/.test(region) || domain.endsWith(".hk")) return "HK";
  if (/台湾|台灣|taiwan|\btw\b|台北|新北|台中|台南|高雄|桃園|桃园|新竹/.test(region) || domain.endsWith(".tw")) return "TW";
  if (/澳门|澳門|macau|macao|\bmo\b/.test(region) || domain.endsWith(".mo")) return "MO";
  if (/中国|中國|内地|大陆|深圳|广州|上海|北京|杭州|苏州|东莞|佛山/.test(region) || (domain.endsWith(".cn") && !domain.endsWith(".com.tw"))) return "CN";
  return "INTL";
}

const LEGACY_OUTLIER_CODES = new Set(["HK97", "HK98", "HK999", "TW999"]);

/**
 * Computes next sequential company code per prefix, ignoring seeded outlier test fixtures
 * (HK97, HK98, HK999, TW999) while never colliding with any used code.
 */
export function computeNextCodesFromExisting(codes: readonly string[]): Record<CodePrefix, string> {
  const buckets: Record<CodePrefix, Set<number>> = {
    HK: new Set(),
    TW: new Set(),
    MO: new Set(),
    CN: new Set(),
    INTL: new Set(),
  };
  const normalMaxByPrefix: Record<CodePrefix, number> = {
    HK: 0,
    TW: 0,
    MO: 0,
    CN: 0,
    INTL: 0,
  };

  for (const raw of codes) {
    const clean = raw.trim().toUpperCase();
    const match = /^(INTL|HK|TW|MO|CN)(\d+)$/.exec(clean);
    if (!match) continue;
    const prefix = match[1] as CodePrefix;
    const num = Number.parseInt(match[2]!, 10);
    if (Number.isFinite(num) && num > 0) {
      buckets[prefix].add(num);
      if (!LEGACY_OUTLIER_CODES.has(clean) && num > normalMaxByPrefix[prefix]) {
        normalMaxByPrefix[prefix] = num;
      }
    }
  }

  const result = {} as Record<CodePrefix, string>;
  for (const prefix of ["HK", "TW", "MO", "CN", "INTL"] as const) {
    const used = buckets[prefix];
    let candidate = normalMaxByPrefix[prefix] + 1;
    while (used.has(candidate)) {
      candidate += 1;
    }
    result[prefix] = `${prefix}${String(candidate).padStart(2, "0")}`;
  }
  return result;
}

export async function checkBatchLeads(input: {
  domains?: readonly string[];
  emails?: readonly string[];
  companies?: readonly string[];
}) {
  const normDomains = Array.from(
    new Set((input.domains ?? []).map(normalizeRootDomain).filter((v): v is string => Boolean(v))),
  );
  const normEmails = Array.from(
    new Set(
      (input.emails ?? [])
        .map((e) => (typeof e === "string" ? e.trim().toLowerCase() : ""))
        .filter((e) => e.includes("@")),
    ),
  );
  const normCompanies = Array.from(
    new Set(
      (input.companies ?? [])
        .map((c) => (typeof c === "string" ? c.trim().toLowerCase() : ""))
        .filter(Boolean),
    ),
  );

  const [existingCompanies, existingEmails] = await Promise.all([
    db
      .select({
        domain: companies.domain,
        name: companies.name,
        code: sql<string | null>`coalesce(${companies.custom}->>'x_code', ${companies.raw}->>'company_code', ${companies.raw}->>'x_code')`,
      })
      .from(companies)
      .where(inOrg(companies)),
    normEmails.length > 0
      ? db
          .select({ email: people.email })
          .from(people)
          .where(and(inOrg(people), isNotNull(people.email)))
      : Promise.resolve([]),
  ]);

  const dbDomainSet = new Set<string>();
  const dbCompanySet = new Set<string>();
  const existingCodes: string[] = [];

  for (const row of existingCompanies) {
    const d = normalizeRootDomain(row.domain);
    if (d) dbDomainSet.add(d);
    if (row.name?.trim()) dbCompanySet.add(row.name.trim().toLowerCase());
    if (row.code?.trim()) existingCodes.push(row.code.trim());
  }

  const dbEmailSet = new Set<string>();
  for (const row of existingEmails) {
    if (row.email?.trim()) dbEmailSet.add(row.email.trim().toLowerCase());
  }

  const matchedDomains = normDomains.filter((d) => {
    if (dbDomainSet.has(d)) return true;
    for (const existing of dbDomainSet) {
      if (d.endsWith(`.${existing}`) || existing.endsWith(`.${d}`)) return true;
    }
    return false;
  });
  const matchedSet = new Set(matchedDomains);
  const freeDomains = normDomains.filter((d) => !matchedSet.has(d));
  const matchedEmails = normEmails.filter((e) => dbEmailSet.has(e));
  const matchedCompanies = normCompanies.filter((c) => dbCompanySet.has(c));

  return {
    matchedDomains,
    freeDomains,
    matchedEmails,
    matchedCompanies,
    nextCodes: computeNextCodesFromExisting(existingCodes),
    existingCompanyCount: existingCompanies.length,
  };
}
