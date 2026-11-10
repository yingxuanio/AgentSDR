import type { NextRequest } from "next/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { companies, people } from "@/lib/leads/schema";
import { crmConversations, crmDrafts, crmRecords, type CrmDraftStatus } from "@/lib/crm/schema";
import { draftInOrg } from "@/lib/crm/records";
import { crmOperationErrorResponse, requireInteger } from "@/lib/crm/api";
import { parseOptionalText, parseRequiredText, readCrmJson } from "@/lib/crm/categories";
import {
  createOrGenerateInitialDraft,
  rebindDraftSender,
  regenerateDraft,
  resolveCompanyCode,
  selectRegenerateTargetDrafts,
  updateDraft,
} from "@/lib/crm/drafts";
import { requireCrmMutationContext } from "@/lib/crm/http";
import { requireOrgContext } from "@/lib/auth/context";
import { runInOrganization } from "@/lib/tenancy/scope";

type DraftListItem = {
  id: string;
  crmRecordId: string;
  conversationId: string;
  revision: number;
  status: string;
  autoSendAt: string | null;
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

async function loadOrgDrafts(
  statusFilter: string | readonly CrmDraftStatus[] = "awaiting_review",
): Promise<DraftListItem[]> {
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
      Array.isArray(statusFilter)
        ? and(draftInOrg(), inArray(crmDrafts.status, [...statusFilter]))
        : statusFilter === "all"
          ? draftInOrg()
          : and(draftInOrg(), eq(crmDrafts.status, statusFilter as CrmDraftStatus)),
    )
    .orderBy(desc(crmDrafts.updatedAt));

  return rows.map((row) => {
    const reqObj = (row.draft.request ?? {}) as Record<string, unknown>;
    return {
      id: row.draft.id,
      crmRecordId: row.draft.crmRecordId,
      conversationId: row.draft.conversationId,
      revision: row.draft.revision,
      status: row.draft.status,
      autoSendAt: row.draft.autoSendAt ? row.draft.autoSendAt.toISOString() : null,
      channel: row.draft.channel,
      subject: row.draft.subject,
      bodyText: row.draft.editedBodyText ?? row.draft.aiBodyText ?? "",
      bodyHtml: row.draft.editedBodyHtml ?? row.draft.aiBodyHtml ?? null,
      fromEmail:
        row.conversation?.accountRef ??
        (typeof reqObj.from === "string" ? reqObj.from : null),
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
            code: resolveCompanyCode(row.company),
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

      const [[conversation], [recordPerson]] = await Promise.all([
        db
          .select({ accountRef: crmConversations.accountRef })
          .from(crmConversations)
          .where(eq(crmConversations.id, result.draft.conversationId))
          .limit(1),
        db
          .select({ email: people.email })
          .from(crmRecords)
          .innerJoin(people, eq(people.id, crmRecords.personId))
          .where(eq(crmRecords.id, result.draft.crmRecordId))
          .limit(1),
      ]);
      const reqObj = (result.draft.request ?? {}) as Record<string, unknown>;

      return Response.json(
        {
          created: result.created,
          draft: {
            id: result.draft.id,
            crmRecordId: result.draft.crmRecordId,
            conversationId: result.draft.conversationId,
            revision: result.draft.revision,
            status: result.draft.status,
            autoSendAt: result.draft.autoSendAt ? result.draft.autoSendAt.toISOString() : null,
            channel: result.draft.channel,
            fromEmail:
              conversation?.accountRef ??
              (typeof reqObj.from === "string" ? reqObj.from : null),
            toEmail:
              typeof reqObj.to === "string"
                ? reqObj.to
                : recordPerson?.email ?? null,
            subject: result.draft.subject,
            bodyText: result.draft.editedBodyText ?? result.draft.aiBodyText,
            bodyHtml: result.draft.editedBodyHtml ?? result.draft.aiBodyHtml,
            updatedAt: result.draft.updatedAt.toISOString(),
          },
        },
        { status: result.created ? 201 : 200 },
      );
    }

    // Mode 1: Batch AI regenerate by instruction (`{ action: "regenerate", feedback?: "...", draftIds?: [...], companyCodes?: [...] }`)
    if (body.action === "regenerate") {
      const feedback =
        typeof body.feedback === "string" && body.feedback.trim() === ""
          ? null
          : (parseOptionalText(body.feedback, "feedback", 4_000) ?? null);
      const recoverableDrafts = await loadOrgDrafts(["awaiting_review", "failed"]);
      const targets = selectRegenerateTargetDrafts(recoverableDrafts, body);

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

    // Mode 2: Direct update / sender rebind of one or multiple drafts
    // (`{ drafts: [...] }` or single `{ id | draftId | companyCode | toEmail, fromEmail?, subject?, bodyText?, bodyHtml?, revision? }`)
    const editableDrafts = await loadOrgDrafts(["awaiting_review", "failed"]);
    let fullOrgDrafts: DraftListItem[] | null = null;
    const items = Array.isArray(body.drafts) ? (body.drafts as Record<string, unknown>[]) : [body];
    const updatedDrafts = [];

    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const targetId = typeof item.id === "string" ? item.id.trim() : typeof item.draftId === "string" ? item.draftId.trim() : "";
      const targetCode = typeof item.companyCode === "string" ? item.companyCode.trim().toUpperCase() : "";
      const targetEmail = typeof item.toEmail === "string" ? item.toEmail.trim().toLowerCase() : "";

      const matchItem = (list: readonly DraftListItem[]) => {
        const candidates = list.filter((d) => {
          if (targetId && d.id === targetId) return true;
          if (targetCode && d.company?.code?.toUpperCase() === targetCode) return true;
          if (targetEmail && d.toEmail?.toLowerCase() === targetEmail) return true;
          return false;
        });
        return candidates.find((d) => d.status === "awaiting_review") ?? candidates[0];
      };

      let matched = matchItem(editableDrafts);
      if (!matched && (targetId || item.fromEmail !== undefined)) {
        fullOrgDrafts ??= await loadOrgDrafts("all");
        matched = matchItem(fullOrgDrafts);
      }

      if (!matched) {
        return Response.json(
          { error: `No awaiting_review draft matched ${targetId || targetCode || targetEmail || "item"}`, code: "NOT_FOUND" },
          { status: 404 },
        );
      }

      const revision =
        item.revision !== undefined && item.revision !== null
          ? requireInteger(item.revision, "revision")
          : null;
      const fromEmail =
        item.fromEmail !== undefined && item.fromEmail !== null
          ? parseRequiredText(item.fromEmail, "fromEmail", 320)
          : null;
      const rawBody = item.bodyText ?? item.body;

      if (
        fromEmail !== null &&
        (rawBody === undefined || rawBody === null) &&
        item.subject === undefined &&
        item.bodyHtml === undefined
      ) {
        const rebound = await rebindDraftSender({
          draftId: matched.id,
          fromEmail,
          revision,
          actorRef: ctx.userName,
        });
        updatedDrafts.push({
          id: rebound.draft.id,
          changed: rebound.changed,
          status: rebound.draft.status,
          autoSendAt: rebound.draft.autoSendAt ? rebound.draft.autoSendAt.toISOString() : null,
          companyCode: matched.company?.code ?? null,
          companyName: matched.company?.name ?? null,
          fromEmail: rebound.fromEmail,
          previousFromEmail: rebound.previousFromEmail,
          toEmail: rebound.toEmail ?? matched.toEmail,
          revision: rebound.draft.revision,
          subject: rebound.draft.subject,
          bodyText: rebound.draft.editedBodyText ?? rebound.draft.aiBodyText,
        });
        continue;
      }

      const updated = await updateDraft({
        draftId: matched.id,
        revision,
        fromEmail,
        subject: parseOptionalText(item.subject, "subject", 998),
        bodyText: parseRequiredText(rawBody, "bodyText", 100_000),
        bodyHtml: parseOptionalText(item.bodyHtml, "bodyHtml", 100_000),
        actorRef: ctx.userName,
      });

      const [conv] = await db
        .select({ accountRef: crmConversations.accountRef })
        .from(crmConversations)
        .where(eq(crmConversations.id, updated.conversationId))
        .limit(1);

      updatedDrafts.push({
        id: updated.id,
        changed: true,
        status: updated.status,
        autoSendAt: updated.autoSendAt ? updated.autoSendAt.toISOString() : null,
        companyCode: matched.company?.code ?? null,
        companyName: matched.company?.name ?? null,
        fromEmail: conv?.accountRef ?? matched.fromEmail,
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
