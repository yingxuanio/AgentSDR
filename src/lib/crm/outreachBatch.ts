import { randomUUID } from "node:crypto";
import dns from "node:dns/promises";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { companies, people } from "@/lib/leads/schema";
import { upsertManualPerson, type ManualPersonInput } from "@/lib/leads/manualImport";
import {
  computeNextCodesFromExisting,
  inferCodePrefix,
  normalizeRootDomain,
  type CodePrefix,
} from "@/lib/leads/outreachCheck";
import { withLeadTransaction } from "@/lib/leads/records";
import { inOrg } from "@/lib/tenancy/scope";
import { channelRules } from "@/lib/channels/rules.server";
import { mailboxes } from "@/lib/outreach/schema";
import {
  isWithinWorkingHours,
  mailboxHoursFromWeekly,
  nextWorkingWindowStart,
} from "@/lib/outreach/workingHours";

type WorkingHours = ReturnType<typeof mailboxHoursFromWeekly>;
import { createOrGenerateInitialDraft, regenerateDraft } from "./drafts";
import { appendCrmEvent } from "./events";
import { withCrmTransaction } from "./repository";
import { crmConversations, crmDrafts, crmRecords } from "./schema";
import { sendDraft } from "./send";

export type OutreachDeliveryMode = "draft_only" | "queue_working_hours" | "send_now" | "send_paced";

export type OutreachLeadInput = {
  fullName: string;
  firstName?: string | null;
  lastName?: string | null;
  title: string;
  email: string;
  phone?: string | null;
  linkedinUrl?: string | null;
  companyName: string;
  companyDomain: string;
  companyLinkedinUrl?: string | null;
  companyCode?: string | null;
  companyRegion?: string | null;
  leadReason: string;
  verificationNote: string;
};

export type OutreachLeadResult = {
  ok: boolean;
  status: "sent" | "queued" | "awaiting_review" | "skipped_duplicate" | "rejected" | "failed";
  companyCode?: string | null;
  companyName?: string;
  companyDomain?: string | null;
  fullName?: string;
  email?: string;
  personId?: string;
  recordId?: string;
  draftId?: string;
  fromEmail?: string | null;
  subject?: string | null;
  error?: string;
  warnings?: string[];
};

const FORBIDDEN_EMAIL_PREFIX_RE =
  /^(support|cs|customerservice|customer-service|customer_service|help|helpdesk|hr|jobs|careers|recruit|recruitment|talent|ir|investor|investors|noreply|no-reply|donotreply|privacy|legal|abuse|postmaster|webmaster|billing|security)@/i;

const FAKE_PERSON_NAME_RE =
  /^(desk|team|admin|administrator|info|information|sales|office|general|inquiry|enquiry|customer\s*service|corporate\s*inquiry|product\s*desk|engineering\s*desk|it\s*department|hr\s*department|marketing|support|客服|前台|總機|总机|部門|部门|負責人|负责人|公司|秘書處|秘书处)$/i;

const TECH_VENDOR_COMPANY_RE =
  /\b(software|saas|artificial\s+intelligence|ai\s+lab|ai\s+solutions|ai\s+tech|it\s+solutions|it\s+consulting|system\s+integration|cyberport|hkstp|cloud\s+computing|blockchain|web3|martech|devops|robotics|app\s+development|digital\s+agency|tech\s+studio)\b|软件开发|軟件開發|人工智能|系统集成商|系統集成商|資訊科技解決方案|资讯科技解决方案|軟體開發|網路科技|數位行銷科技/i;

// Common Simplified-only characters that frequently leak into HK/TW Traditional Chinese drafts
const SIMPLIFIED_BLEED_CHARS = [
  "贵", "业", "务", "软", "开", "发", "团", "队", "沟", "产", "询", "盘", "系", "统", "联",
  "门", "订", "单", "质", "测", "试", "专", "码", "数", "据", "现", "阶", "欢", "迎", "简",
  "绍", "经", "验", "项", "进", "一步", "设", "备", "贸", "厂", "销", "户", "选",
];

// Exclude "一步" (same in both) — keep strict single Simplified-only chars
const STRICT_SIMPLIFIED_CHARS = SIMPLIFIED_BLEED_CHARS.filter((c) => c.length === 1 && c !== "选");

const mxCache = new Map<string, boolean>();

async function hasValidMxRecord(email: string): Promise<boolean> {
  const domain = email.split("@")[1]?.trim().toLowerCase();
  if (!domain) return false;
  const cached = mxCache.get(domain);
  if (cached !== undefined) return cached;
  try {
    const records = await Promise.race([
      dns.resolveMx(domain),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("mx_timeout")), 3500)),
    ]);
    const ok = Array.isArray(records) && records.length > 0;
    mxCache.set(domain, ok);
    return ok;
  } catch {
    // Fallback to A record per RFC 5321 implicit MX if MX lookup fails or times out
    try {
      const aRecords = await Promise.race([
        dns.resolve4(domain),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("a_timeout")), 2500)),
      ]);
      const ok = Array.isArray(aRecords) && aRecords.length > 0;
      mxCache.set(domain, ok);
      return ok;
    } catch {
      mxCache.set(domain, false);
      return false;
    }
  }
}

export function splitPersonName(fullName: string, firstName?: string | null, lastName?: string | null) {
  const cleanFull = fullName.trim().replace(/\s+/g, " ");
  let first = firstName?.trim() || null;
  let last = lastName?.trim() || null;
  if (!first || !last) {
    if (/[\u4e00-\u9fff]/.test(cleanFull) && !cleanFull.includes(" ")) {
      // Chinese name e.g. 黎顯輝 or 歐陽禹
      last = last || cleanFull.slice(0, cleanFull.length >= 4 ? 2 : 1);
      first = first || cleanFull.slice(last.length) || cleanFull;
    } else {
      const parts = cleanFull.split(" ");
      first = first || parts[0] || cleanFull;
      last = last || (parts.length > 1 ? parts.slice(1).join(" ") : parts[0] || cleanFull);
    }
  }
  return { fullName: cleanFull, firstName: first, lastName: last };
}

export function validateProspectLeadStatic(lead: Partial<OutreachLeadInput>): { ok: true } | { ok: false; error: string } {
  const fullName = lead.fullName?.trim() ?? "";
  if (!fullName || fullName.length < 2) {
    return { ok: false, error: "fullName is required and must be a real person's name" };
  }
  if (FAKE_PERSON_NAME_RE.test(fullName) || /\b(desk|department|inquiry|enquiry|customer\s*service)\b/i.test(fullName)) {
    return { ok: false, error: `Rejected placeholder contact name: "${fullName}"` };
  }
  const title = lead.title?.trim() ?? "";
  if (!title || title.length < 2) {
    return { ok: false, error: "title is required (e.g. Director / Managing Director / 董事長 / 總經理)" };
  }
  const email = lead.email?.trim().toLowerCase() ?? "";
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, error: `Invalid email address: "${lead.email ?? ""}"` };
  }
  if (FORBIDDEN_EMAIL_PREFIX_RE.test(email)) {
    return { ok: false, error: `Forbidden non-business/support email prefix: "${email}"` };
  }
  const companyName = lead.companyName?.trim() ?? "";
  if (!companyName || companyName.length < 2) {
    return { ok: false, error: "companyName is required" };
  }
  if (TECH_VENDOR_COMPANY_RE.test(companyName)) {
    return { ok: false, error: `Excluded ICP (tech/software/AI vendor): "${companyName}"` };
  }
  const domain = normalizeRootDomain(lead.companyDomain);
  if (!domain) {
    return { ok: false, error: `Invalid companyDomain: "${lead.companyDomain ?? ""}"` };
  }
  const leadReason = lead.leadReason?.trim() ?? "";
  if (leadReason.length < 15) {
    return { ok: false, error: "leadReason must explain the non-tech core business and digital/engineering entry point (>=15 chars)" };
  }
  const verificationNote = lead.verificationNote?.trim() ?? "";
  if (verificationNote.length < 15 || !/https?:\/\//i.test(verificationNote)) {
    return { ok: false, error: "verificationNote must explain contact verification and include at least one http(s):// source URL" };
  }
  return { ok: true };
}

export function detectSimplifiedBleedInTraditionalDraft(text: string): string[] {
  const found = new Set<string>();
  for (const ch of STRICT_SIMPLIFIED_CHARS) {
    if (text.includes(ch)) found.add(ch);
  }
  return Array.from(found);
}

export function auditDraftContent(input: {
  subject: string | null;
  bodyText: string | null;
  fromEmail: string | null;
  companyCode: string | null;
}): { ok: boolean; simplifiedChars: string[]; issues: string[] } {
  const issues: string[] = [];
  const subject = input.subject?.trim() ?? "";
  const body = input.bodyText?.trim() ?? "";
  if (subject.length < 4) issues.push("Subject is empty or too short");
  if (body.length < 100) issues.push("Body text is too short (<100 chars)");
  if (/\{\{|\}\}|\[(?:Company|Name|Your|Insert|TODO|待填|公司名|收件人)/i.test(`${subject}\n${body}`)) {
    issues.push("Draft contains unresolved template placeholders");
  }
  const isYingxuan = input.fromEmail === "ivan@yingxuan.io";
  if (isYingxuan && !body.includes("yingxuan.io")) {
    issues.push("Missing yingxuan.io reference link in Chinese outreach draft");
  }
  const prefix = input.companyCode?.trim().toUpperCase() ?? "";
  const expectsTraditional = isYingxuan && (prefix.startsWith("HK") || prefix.startsWith("TW") || prefix.startsWith("MO"));
  const simplifiedChars = expectsTraditional ? detectSimplifiedBleedInTraditionalDraft(`${subject}\n${body}`) : [];
  if (simplifiedChars.length > 0) {
    issues.push(`Traditional Chinese draft contains Simplified characters: ${simplifiedChars.join(", ")}`);
  }
  return {
    ok: issues.length === 0,
    simplifiedChars,
    issues,
  };
}

// Global in-process mutex for paced outbound sending so concurrent worker batches never burst Gmail simultaneously.
let sendQueueChain: Promise<void> = Promise.resolve();
let lastPacedSendFinishedAt = 0;

async function runWithPacedSendLock<T>(paceMs: number, fn: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const prev = sendQueueChain;
  sendQueueChain = new Promise<void>((resolve) => {
    release = resolve;
  });
  await prev;
  try {
    const elapsed = Date.now() - lastPacedSendFinishedAt;
    if (lastPacedSendFinishedAt > 0 && elapsed < paceMs) {
      await new Promise((r) => setTimeout(r, paceMs - elapsed));
    }
    const res = await fn();
    lastPacedSendFinishedAt = Date.now();
    return res;
  } finally {
    release();
  }
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) break;
      results[idx] = await worker(items[idx]!, idx);
    }
  });
  await Promise.all(runners);
  return results;
}

async function importSingleProspectAtomically(lead: OutreachLeadInput): Promise<
  | { kind: "duplicate"; reason: string; domain: string }
  | { kind: "imported"; personId: string; recordId: string; companyCode: string; domain: string; email: string }
> {
  const domain = normalizeRootDomain(lead.companyDomain)!;
  const email = lead.email.trim().toLowerCase();
  const names = splitPersonName(lead.fullName, lead.firstName, lead.lastName);

  // Serialize code allocation + domain/email dedupe across concurrent workers via advisory xact lock
  const lockedCheck = await withLeadTransaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(20261111)`);

    const existingCompanies = await tx
      .select({
        id: companies.id,
        domain: companies.domain,
        name: companies.name,
        code: sql<string | null>`coalesce(${companies.custom}->>'x_code', ${companies.raw}->>'company_code', ${companies.raw}->>'x_code')`,
      })
      .from(companies)
      .where(inOrg(companies));

    for (const row of existingCompanies) {
      const d = normalizeRootDomain(row.domain);
      if (d && (d === domain || d.endsWith(`.${domain}`) || domain.endsWith(`.${d}`))) {
        return { duplicate: `Domain already in CRM (${row.code ?? row.name ?? d})` } as const;
      }
      if (row.name?.trim().toLowerCase() === lead.companyName.trim().toLowerCase()) {
        return { duplicate: `Company name already in CRM (${row.code ?? row.name})` } as const;
      }
    }

    const [existingEmail] = await tx
      .select({ id: people.id })
      .from(people)
      .where(and(inOrg(people), isNotNull(people.email), sql`lower(${people.email}) = ${email}`))
      .limit(1);

    if (existingEmail) {
      return { duplicate: `Email already in CRM (${email})` } as const;
    }

    let assignedCode = lead.companyCode?.trim().toUpperCase() || null;
    const existingCodes = existingCompanies.map((r) => r.code).filter((c): c is string => Boolean(c));
    const usedUpper = new Set(existingCodes.map((c) => c.trim().toUpperCase()));
    if (!assignedCode || assignedCode === "AUTO" || usedUpper.has(assignedCode)) {
      const prefix: CodePrefix = inferCodePrefix({
        companyRegion: lead.companyRegion,
        companyDomain: domain,
        companyCode: assignedCode === "AUTO" ? null : assignedCode,
      });
      assignedCode = computeNextCodesFromExisting(existingCodes)[prefix];
    }

    return { duplicate: null, assignedCode } as const;
  });

  if (lockedCheck.duplicate) {
    return { kind: "duplicate", reason: lockedCheck.duplicate, domain };
  }

  const companyCode = lockedCheck.assignedCode;
  const safeIdemDomain = domain.replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 80);
  const manualInput: ManualPersonInput = {
    idempotencyKey: `outreach-batch-${companyCode}-${safeIdemDomain}`.slice(0, 120),
    email,
    linkedinUrl: lead.linkedinUrl?.includes("linkedin.com/in/") ? lead.linkedinUrl.trim() : null,
    fullName: names.fullName,
    firstName: names.firstName,
    lastName: names.lastName,
    title: lead.title.trim(),
    phone: lead.phone?.trim() || null,
    companyName: lead.companyName.trim(),
    companyDomain: domain,
    companyLinkedinUrl: lead.companyLinkedinUrl?.trim() || null,
    companyCode,
    companyRegion: lead.companyRegion?.trim() || null,
    leadReason: lead.leadReason.trim(),
    verificationNote: lead.verificationNote.trim(),
    workflowState: "idle",
  };

  const imported = await upsertManualPerson(manualInput);
  if (!imported.crmRecord) {
    throw new Error("CRM record was not created during manual import");
  }

  return {
    kind: "imported",
    personId: imported.personId,
    recordId: imported.crmRecord.id,
    companyCode,
    domain,
    email,
  };
}

export async function processOutreachBatch(
  input: {
    leads: OutreachLeadInput[];
    delivery?: OutreachDeliveryMode;
    paceMs?: number;
  },
  actorRef: string,
): Promise<{
  total: number;
  sent: number;
  queued: number;
  awaitingReview: number;
  skippedDuplicate: number;
  rejected: number;
  failed: number;
  results: OutreachLeadResult[];
}> {
  const delivery: OutreachDeliveryMode = input.delivery ?? "draft_only";
  const paceMs = Math.max(0, Math.min(120_000, Number(input.paceMs ?? (delivery === "send_paced" ? 10_000 : 0))));

  // Step 1: Validate all leads (static + MX lookup in parallel) and deduplicate within the request payload itself
  const seenDomains = new Set<string>();
  const seenEmails = new Set<string>();

  const precheck = await Promise.all(
    input.leads.map(async (lead): Promise<{ lead: OutreachLeadInput; rejectError?: string }> => {
      const staticVerdict = validateProspectLeadStatic(lead);
      if (!staticVerdict.ok) return { lead, rejectError: staticVerdict.error };
      const domain = normalizeRootDomain(lead.companyDomain)!;
      const email = lead.email.trim().toLowerCase();
      if (seenDomains.has(domain)) {
        return { lead, rejectError: `Duplicate domain within same batch payload: ${domain}` };
      }
      if (seenEmails.has(email)) {
        return { lead, rejectError: `Duplicate email within same batch payload: ${email}` };
      }
      seenDomains.add(domain);
      seenEmails.add(email);

      const mxOk = await hasValidMxRecord(email);
      if (!mxOk) {
        return { lead, rejectError: `Recipient email domain failed DNS MX/A check: ${email}` };
      }
      return { lead };
    }),
  );

  // Step 2: Import valid leads sequentially (fast, ~30ms each, preserves clean code ordering)
  type ImportedEntry = {
    index: number;
    lead: OutreachLeadInput;
    personId: string;
    recordId: string;
    companyCode: string;
    domain: string;
    email: string;
  };
  const results: OutreachLeadResult[] = new Array(input.leads.length);
  const importedEntries: ImportedEntry[] = [];

  for (let i = 0; i < precheck.length; i++) {
    const item = precheck[i]!;
    if (item.rejectError) {
      results[i] = {
        ok: false,
        status: "rejected",
        companyName: item.lead.companyName,
        companyDomain: item.lead.companyDomain,
        fullName: item.lead.fullName,
        email: item.lead.email,
        error: item.rejectError,
      };
      continue;
    }
    try {
      const outcome = await importSingleProspectAtomically(item.lead);
      if (outcome.kind === "duplicate") {
        results[i] = {
          ok: false,
          status: "skipped_duplicate",
          companyName: item.lead.companyName,
          companyDomain: outcome.domain,
          fullName: item.lead.fullName,
          email: item.lead.email,
          error: outcome.reason,
        };
      } else {
        importedEntries.push({
          index: i,
          lead: item.lead,
          personId: outcome.personId,
          recordId: outcome.recordId,
          companyCode: outcome.companyCode,
          domain: outcome.domain,
          email: outcome.email,
        });
      }
    } catch (error) {
      results[i] = {
        ok: false,
        status: "failed",
        companyName: item.lead.companyName,
        companyDomain: item.lead.companyDomain,
        fullName: item.lead.fullName,
        email: item.lead.email,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // Step 3: Generate + audit + deliver in controlled concurrency (4 concurrent LLM draft generations; paced serial sends)
  await mapWithConcurrency(importedEntries, 4, async (entry) => {
    const warnings: string[] = [];
    try {
      let { draft } = await createOrGenerateInitialDraft({ personId: entry.personId }, actorRef);
      const [conv] = await db
        .select({ accountRef: crmConversations.accountRef })
        .from(crmConversations)
        .where(eq(crmConversations.id, draft.conversationId))
        .limit(1);
      const fromEmail = conv?.accountRef ?? null;

      let audit = auditDraftContent({
        subject: draft.subject,
        bodyText: draft.editedBodyText ?? draft.aiBodyText,
        fromEmail,
        companyCode: entry.companyCode,
      });

      // Auto-repair once if Simplified characters leaked into a Traditional Chinese draft or minor quality issue occurred
      if (!audit.ok) {
        const repairFeedback =
          audit.simplifiedChars.length > 0
            ? `草稿中混入了簡體字（${audit.simplifiedChars.join("、")}），請將主旨與正文全部嚴格轉為地道香港/台灣繁體中文，保留 AI 研發與 ClackyAI 團隊背景概要及英選官網/手冊連結。`
            : `請修復以下問題並重新生成完整開發信：${audit.issues.join("；")}`;
        warnings.push(`Auto-regenerated once: ${audit.issues.join("; ")}`);
        draft = await regenerateDraft(draft.id, {}, repairFeedback);
        audit = auditDraftContent({
          subject: draft.subject,
          bodyText: draft.editedBodyText ?? draft.aiBodyText,
          fromEmail,
          companyCode: entry.companyCode,
        });
      }

      if (!audit.ok) {
        results[entry.index] = {
          ok: false,
          status: "awaiting_review",
          companyCode: entry.companyCode,
          companyName: entry.lead.companyName,
          companyDomain: entry.domain,
          fullName: entry.lead.fullName,
          email: entry.email,
          personId: entry.personId,
          recordId: entry.recordId,
          draftId: draft.id,
          fromEmail,
          subject: draft.subject,
          error: `Left in awaiting_review due to quality gate: ${audit.issues.join("; ")}`,
          warnings,
        };
        return;
      }

      if (delivery === "draft_only") {
        results[entry.index] = {
          ok: true,
          status: "awaiting_review",
          companyCode: entry.companyCode,
          companyName: entry.lead.companyName,
          companyDomain: entry.domain,
          fullName: entry.lead.fullName,
          email: entry.email,
          personId: entry.personId,
          recordId: entry.recordId,
          draftId: draft.id,
          fromEmail,
          subject: draft.subject,
          warnings: warnings.length ? warnings : undefined,
        };
        return;
      }

      if (delivery === "queue_working_hours") {
        let mailboxHours: WorkingHours | null = null;
        if (fromEmail) {
          const [mb] = await db
            .select({ workingHours: mailboxes.workingHours })
            .from(mailboxes)
            .where(and(inOrg(mailboxes), eq(mailboxes.emailAddress, fromEmail)))
            .limit(1);
          if (mb?.workingHours) mailboxHours = mb.workingHours;
        }
        if (!mailboxHours) {
          const { sendingHours } = await channelRules("email");
          if (sendingHours) mailboxHours = mailboxHoursFromWeekly(sendingHours);
        }
        const now = new Date();
        const scheduledAt =
          mailboxHours && !isWithinWorkingHours(mailboxHours, now)
            ? nextWorkingWindowStart(mailboxHours, now)
            : now;

        await withCrmTransaction(async (tx) => {
          await tx.update(crmDrafts).set({ autoSendAt: scheduledAt, updatedAt: now }).where(eq(crmDrafts.id, draft.id));
          await tx
            .update(crmRecords)
            .set({ workflowState: "waiting", nextActionAt: null, updatedAt: now })
            .where(eq(crmRecords.id, entry.recordId));
          const [rec] = await tx.select().from(crmRecords).where(eq(crmRecords.id, entry.recordId)).limit(1);
          if (rec) {
            await appendCrmEvent(tx, {
              personId: rec.personId,
              crmRecordId: rec.id,
              pipelineId: rec.pipelineId,
              eventType: "draft.auto_send_queued",
              actorType: "authenticated_operator",
              actorRef,
              toData: {
                draftId: draft.id,
                autoSendAt: scheduledAt.toISOString(),
                workflowState: "waiting",
                scheduledDirectSend: true,
              },
              contextVersion: rec.contextVersion,
            });
          }
        });

        results[entry.index] = {
          ok: true,
          status: "queued",
          companyCode: entry.companyCode,
          companyName: entry.lead.companyName,
          companyDomain: entry.domain,
          fullName: entry.lead.fullName,
          email: entry.email,
          personId: entry.personId,
          recordId: entry.recordId,
          draftId: draft.id,
          fromEmail,
          subject: draft.subject,
          warnings: warnings.length ? warnings : undefined,
        };
        return;
      }

      // delivery === "send_now" || delivery === "send_paced"
      const effectivePace = delivery === "send_paced" ? paceMs : 0;
      await runWithPacedSendLock(effectivePace, async () => {
        await sendDraft({
          draftId: draft.id,
          revision: draft.revision,
          idempotencyKey: `outreach-batch-send:${draft.id}:${draft.revision}`,
          requestId: randomUUID(),
          actorRef,
        });
      });

      results[entry.index] = {
        ok: true,
        status: "sent",
        companyCode: entry.companyCode,
        companyName: entry.lead.companyName,
        companyDomain: entry.domain,
        fullName: entry.lead.fullName,
        email: entry.email,
        personId: entry.personId,
        recordId: entry.recordId,
        draftId: draft.id,
        fromEmail,
        subject: draft.subject,
        warnings: warnings.length ? warnings : undefined,
      };
    } catch (error) {
      results[entry.index] = {
        ok: false,
        status: "failed",
        companyCode: entry.companyCode,
        companyName: entry.lead.companyName,
        companyDomain: entry.domain,
        fullName: entry.lead.fullName,
        email: entry.email,
        personId: entry.personId,
        recordId: entry.recordId,
        error: error instanceof Error ? error.message : String(error),
        warnings: warnings.length ? warnings : undefined,
      };
    }
  });

  const sent = results.filter((r) => r?.status === "sent").length;
  const queued = results.filter((r) => r?.status === "queued").length;
  const awaitingReview = results.filter((r) => r?.status === "awaiting_review").length;
  const skippedDuplicate = results.filter((r) => r?.status === "skipped_duplicate").length;
  const rejected = results.filter((r) => r?.status === "rejected").length;
  const failed = results.filter((r) => r?.status === "failed").length;

  return {
    total: results.length,
    sent,
    queued,
    awaitingReview,
    skippedDuplicate,
    rejected,
    failed,
    results,
  };
}
