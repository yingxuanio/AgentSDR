import type { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { companies, people } from "@/lib/leads/schema";
import { crmConversations, crmDrafts, crmRecords } from "@/lib/crm/schema";
import { draftInOrg } from "@/lib/crm/records";
import { crmOperationErrorResponse, requireInteger } from "@/lib/crm/api";
import { assertExactKeys, assertObject, parseOptionalText, parseRequiredText, parseUuid, readCrmJson } from "@/lib/crm/categories";
import { discardDraft, rebindDraftSender, resolveCompanyCode, updateDraft, type CrmDraft } from "@/lib/crm/drafts";
import { CrmNotFoundError } from "@/lib/crm/repository";
import { requireCrmMutationContext } from "@/lib/crm/http";
import { requireOrgContext } from "@/lib/auth/context";
import { runInOrganization } from "@/lib/tenancy/scope";

function serializeDraftWithAddressing(
  draft: CrmDraft,
  conversation: { accountRef: string } | null | undefined,
  person: { email: string | null } | null | undefined,
) {
  const reqObj = (draft.request ?? {}) as Record<string, unknown>;
  return {
    ...draft,
    bodyText: draft.editedBodyText ?? draft.aiBodyText ?? "",
    bodyHtml: draft.editedBodyHtml ?? draft.aiBodyHtml ?? null,
    fromEmail:
      conversation?.accountRef ??
      (typeof reqObj.from === "string" ? reqObj.from : null),
    toEmail:
      typeof reqObj.to === "string"
        ? reqObj.to
        : person?.email ?? null,
  };
}

async function loadSerializedDraft(draft: CrmDraft) {
  const [[conversation], [recordPerson]] = await Promise.all([
    db
      .select({ accountRef: crmConversations.accountRef })
      .from(crmConversations)
      .where(eq(crmConversations.id, draft.conversationId))
      .limit(1),
    db
      .select({ email: people.email })
      .from(crmRecords)
      .innerJoin(people, eq(people.id, crmRecords.personId))
      .where(eq(crmRecords.id, draft.crmRecordId))
      .limit(1),
  ]);
  return serializeDraftWithAddressing(draft, conversation, recordPerson);
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireOrgContext(request);
    return await runInOrganization(ctx.organizationId, async () => {
      const draftId = parseUuid((await params).id, "draft id");
      const [row] = await db
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
        .where(and(draftInOrg(), eq(crmDrafts.id, draftId)))
        .limit(1);
      if (!row) throw new CrmNotFoundError("CRM draft", draftId);
      return Response.json({
        draft: serializeDraftWithAddressing(row.draft, row.conversation, row.person),
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
      });
    });
  } catch (error) {
    return crmOperationErrorResponse(error);
  }
}

async function mutate(request: NextRequest, id: string) {
  const ctx = await requireCrmMutationContext(request);
  return runInOrganization(ctx.organizationId, async () => {
    const value = await readCrmJson(request);
    assertObject(value);
    const draftId = parseUuid(id, "draft id");
    if (value.status === "discarded") {
      assertExactKeys(value, ["status", "revision"]);
      const discarded = await discardDraft({ draftId, actorRef: ctx.userName });
      return { draft: await loadSerializedDraft(discarded) };
    }
    assertExactKeys(value, ["fromEmail", "subject", "body", "bodyText", "bodyHtml", "revision"]);
    const revision =
      value.revision !== undefined && value.revision !== null
        ? requireInteger(value.revision, "revision")
        : null;
    const fromEmail =
      value.fromEmail !== undefined && value.fromEmail !== null
        ? parseRequiredText(value.fromEmail, "fromEmail", 320)
        : null;
    const rawBody = value.bodyText ?? value.body;

    if (
      fromEmail !== null &&
      (rawBody === undefined || rawBody === null) &&
      value.subject === undefined &&
      value.bodyHtml === undefined
    ) {
      const rebound = await rebindDraftSender({
        draftId,
        fromEmail,
        revision,
        actorRef: ctx.userName,
      });
      return {
        changed: rebound.changed,
        previousFromEmail: rebound.previousFromEmail,
        draft: serializeDraftWithAddressing(
          rebound.draft,
          { accountRef: rebound.fromEmail },
          { email: rebound.toEmail },
        ),
      };
    }

    const updated = await updateDraft({
      draftId,
      revision,
      fromEmail,
      subject: parseOptionalText(value.subject, "subject", 998),
      bodyText: parseRequiredText(rawBody, "bodyText", 100_000),
      bodyHtml: parseOptionalText(value.bodyHtml, "bodyHtml", 100_000),
      actorRef: ctx.userName,
    });
    return {
      changed: true,
      draft: await loadSerializedDraft(updated),
    };
  });
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { return Response.json(await mutate(request, (await params).id)); }
  catch (error) { return crmOperationErrorResponse(error); }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { return Response.json(await mutate(request, (await params).id)); }
  catch (error) { return crmOperationErrorResponse(error); }
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { return Response.json(await mutate(request, (await params).id)); }
  catch (error) { return crmOperationErrorResponse(error); }
}
