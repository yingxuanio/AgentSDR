import type { NextRequest } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { companies, people } from "@/lib/leads/schema";
import { crmConversations, crmDrafts, crmRecords, type CrmDraftStatus } from "@/lib/crm/schema";
import { draftInOrg } from "@/lib/crm/records";
import { crmOperationErrorResponse, requireInteger } from "@/lib/crm/api";
import { parseOptionalText, parseRequiredText, readCrmJson } from "@/lib/crm/categories";
import { createOrGenerateInitialDraft, regenerateDraft, updateDraft } from "@/lib/crm/drafts";
import { requireCrmMutationContext } from "@/lib/crm/http";
import { requireOrgContext } from "@/lib/auth/context";
import { runInOrganization } from "@/lib/tenancy/scope";

type DraftListItem = {
  id: string;
  crmRecordId: string;
  revision: number;
  status: string;
  channel: string;
  subject: string | null;
  bodyText: string;
  bodyHtml: string | null;
  fromEmail: string | null;
  toEmail: string | null;
  gmailDraftId: string | null;
  person: {
    id: string;
    fullName: string | null;
    email: string | null;
    title: string | null;
  };
  company: {
    id: string;
    name: string | null;
    domain: string | null;
    code: string | null;
  } | null;
  updatedAt: string;
};

async function loadOrgDrafts(statusFilter = "awaiting_review"): Promise<DraftListItem[]> {
  const rows = await db
    .select({
      draft: crmDrafts,
      record: crmRecords,
      conversation: crmConversations,
      person: people,
      company: companies,
    })
    .from(crmDrafts)
    .innerJoin(crmRecords, eq(crmRecords.id, crmDrafts.crmRecordId))
    .leftJoin(crmConversations, eq(crmConversations.id, crmDrafts.conversationId))
    .innerJoin(people, eq(people.id, crmRecords.personId))
    .leftJoin(companies, eq(companies.id, people.companyId))
    .where(
      statusFilter === "all"
        ? draftInOrg()
        : and(draftInOrg(), eq(crmDrafts.status, statusFilter as CrmDraftStatus)),
    )
    .orderBy(desc(crmDrafts.updatedAt));

  return rows.map((row) => {
    const reqObj = (row.draft.request ?? {}) as Record<string, unknown>;
    const compCustom = (row.company?.custom ?? row.company?.raw ?? {}) as Record<string, unknown>;
    return {
      id: row.draft.id,
      crmRecordId: row.draft.crmRecordId,
      revision: row.draft.revision,
      status: row.draft.status,
      channel: row.draft.channel,
      subject: row.draft.subject,
      bodyText: row.draft.editedBodyText ?? row.draft.aiBodyText ?? "",
      bodyHtml: row.draft.editedBodyHtml ?? row.draft.aiBodyHtml ?? null,
      fromEmail:
        typeof reqObj.from === "string"
          ? reqObj.from
          : row.conversation?.accountRef ?? null,
      toEmail:
        typeof reqObj.to === "string"
          ? reqObj.to
          : row.person.email ?? null,
      gmailDraftId:
        typeof reqObj.gmailDraftId === "string"
          ? reqObj.gmailDraftId
          : row.conversation?.providerThreadId ?? null,
      person: {
        id: row.person.id,
        fullName: row.person.fullName,
        email: row.person.email,
        title: row.person.title,
      },
      company: row.company
        ? {
            id: row.company.id,
            name: row.company.name,
            domain: row.company.domain,
            code: typeof compCustom.x_code === "string" ? compCustom.x_code : null,
          }
        : null,
      updatedAt: row.draft.updatedAt.toISOString(),
    };
  });
}

export async function GET(request: NextRequest) {
  try {
    const ctx = await requireOrgContext(request);
    return await runInOrganization(ctx.organizationId, async () => {
      const status = request.nextUrl.searchParams.get("status")?.trim() || "awaiting_review";
      const drafts = await loadOrgDrafts(status);
      return Response.json({ count: drafts.length, drafts });
    });
  } catch (error) {
    return crmOperationErrorResponse(error);
  }
}

async function handleBatchOrSingleMutate(request: NextRequest) {
  const ctx = await requireCrmMutationContext(request);
  return runInOrganization(ctx.organizationId, async () => {
    const body = (await readCrmJson(request)) as Record<string, unknown>;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return Response.json({ error: "Request body must be a JSON object" }, { status: 400 });
    }

    const allDrafts = await loadOrgDrafts("awaiting_review");

    // Mode 0: Initial draft generation / creation (`{ action: "generate" | "create", recordId?, personId?, email?, companyCode?, fromEmail?, subject?, bodyText?, feedback? }`)
    if (body.action === "generate" || body.action === "create") {
      const recordId = typeof body.recordId === "string" ? body.recordId.trim() : undefined;
      const personId = typeof body.personId === "string" ? body.personId.trim() : undefined;
      const email = typeof body.email === "string" ? body.email.trim() : typeof body.toEmail === "string" ? body.toEmail.trim() : undefined;
      const companyCode = typeof body.companyCode === "string" ? body.companyCode.trim() : typeof body.code === "string" ? body.code.trim() : undefined;
      const fromEmail = typeof body.fromEmail === "string" ? body.fromEmail.trim() : undefined;
      const subject = typeof body.subject === "string" ? body.subject.trim() : undefined;
      const bodyText = typeof body.bodyText === "string" ? body.bodyText.trim() : typeof body.body === "string" ? body.body.trim() : undefined;
      const bodyHtml = typeof body.bodyHtml === "string" ? body.bodyHtml.trim() : undefined;
      const feedback = typeof body.feedback === "string" ? body.feedback.trim() : undefined;

      const result = await createOrGenerateInitialDraft(
        {
          recordId,
          personId,
          email,
          companyCode,
          fromEmail,
          subject,
          bodyText,
          bodyHtml,
          feedback,
        },
        ctx.userName,
      );

      return Response.json(
        {
          created: result.created,
          draft: {
            id: result.draft.id,
            crmRecordId: result.draft.crmRecordId,
            conversationId: result.draft.conversationId,
            revision: result.draft.revision,
            status: result.draft.status,
            channel: result.draft.channel,
            subject: result.draft.subject,
            bodyText: result.draft.editedBodyText ?? result.draft.aiBodyText,
            bodyHtml: result.draft.editedBodyHtml ?? result.draft.aiBodyHtml,
            updatedAt: result.draft.updatedAt.toISOString(),
          },
        },
        { status: result.created ? 201 : 200 },
      );
    }

    // Mode 1: Batch AI regenerate by instruction (`{ action: "regenerate", feedback: "...", draftIds?: [...], companyCodes?: [...] }`)
    if (body.action === "regenerate") {
      const feedback = parseRequiredText(body.feedback, "feedback", 4_000);
      const idFilter = Array.isArray(body.draftIds)
        ? new Set(body.draftIds.map((v) => String(v).trim()))
        : null;
      const codeFilter = Array.isArray(body.companyCodes)
        ? new Set(body.companyCodes.map((v) => String(v).trim().toUpperCase()))
        : null;
      const personIdFilter = Array.isArray(body.personIds)
        ? new Set(body.personIds.map((v) => String(v).trim()))
        : null;
      const recordIdFilter = Array.isArray(body.recordIds)
        ? new Set(body.recordIds.map((v) => String(v).trim()))
        : null;
      const emailFilter = Array.isArray(body.emails)
        ? new Set(body.emails.map((v) => String(v).trim().toLowerCase()))
        : null;

      const targets = allDrafts.filter((d) => {
        if (idFilter && idFilter.size > 0 && !idFilter.has(d.id)) return false;
        if (codeFilter && codeFilter.size > 0 && (!d.company?.code || !codeFilter.has(d.company.code.toUpperCase()))) {
          return false;
        }
        if (personIdFilter && personIdFilter.size > 0 && !personIdFilter.has(d.person.id)) {
          return false;
        }
        if (recordIdFilter && recordIdFilter.size > 0 && !recordIdFilter.has(d.crmRecordId)) {
          return false;
        }
        if (emailFilter && emailFilter.size > 0 && (!d.toEmail || !emailFilter.has(d.toEmail.toLowerCase()))) {
          return false;
        }
        return true;
      });

      const results: Array<{ id: string; companyCode: string | null; status: "ok" | "error"; subject?: string | null; revision?: number; error?: string }> = [];
      for (const target of targets) {
        try {
          const updated = await regenerateDraft(target.id, {}, feedback);
          results.push({
            id: updated.id,
            companyCode: target.company?.code ?? null,
            status: "ok",
            subject: updated.subject,
            revision: updated.revision,
          });
        } catch (err) {
          results.push({
            id: target.id,
            companyCode: target.company?.code ?? null,
            status: "error",
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return Response.json({ updatedCount: results.filter((r) => r.status === "ok").length, results });
    }

    // Mode 2: Direct replacement of one or multiple drafts (`{ drafts: [...] }` or single `{ id | companyCode | toEmail, subject?, bodyText }`)
    const items = Array.isArray(body.drafts) ? (body.drafts as Record<string, unknown>[]) : [body];
    const updatedDrafts = [];

    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const targetId = typeof item.id === "string" ? item.id.trim() : typeof item.draftId === "string" ? item.draftId.trim() : "";
      const targetCode = typeof item.companyCode === "string" ? item.companyCode.trim().toUpperCase() : "";
      const targetEmail = typeof item.toEmail === "string" ? item.toEmail.trim().toLowerCase() : "";

      const matched = allDrafts.find((d) => {
        if (targetId && d.id === targetId) return true;
        if (targetCode && d.company?.code?.toUpperCase() === targetCode) return true;
        if (targetEmail && d.toEmail?.toLowerCase() === targetEmail) return true;
        return false;
      });

      if (!matched) {
        return Response.json(
          { error: `No awaiting_review draft matched ${targetId || targetCode || targetEmail || "item"}` },
          { status: 404 },
        );
      }

      const updated = await updateDraft({
        draftId: matched.id,
        revision: item.revision !== undefined && item.revision !== null ? requireInteger(item.revision, "revision") : null,
        subject: parseOptionalText(item.subject, "subject", 998),
        bodyText: parseRequiredText(item.bodyText ?? item.body, "bodyText", 100_000),
        bodyHtml: parseOptionalText(item.bodyHtml, "bodyHtml", 100_000),
        actorRef: ctx.userName,
      });

      updatedDrafts.push({
        id: updated.id,
        companyCode: matched.company?.code ?? null,
        companyName: matched.company?.name ?? null,
        toEmail: matched.toEmail,
        revision: updated.revision,
        subject: updated.subject,
        bodyText: updated.editedBodyText ?? updated.aiBodyText,
      });
    }

    return Response.json({
      updatedCount: updatedDrafts.length,
      drafts: updatedDrafts,
    });
  });
}

export async function PATCH(request: NextRequest) {
  try { return await handleBatchOrSingleMutate(request); }
  catch (error) { return crmOperationErrorResponse(error); }
}

export async function POST(request: NextRequest) {
  try { return await handleBatchOrSingleMutate(request); }
  catch (error) { return crmOperationErrorResponse(error); }
}
