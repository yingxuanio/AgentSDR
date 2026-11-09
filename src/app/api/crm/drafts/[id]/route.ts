import type { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { companies, people } from "@/lib/leads/schema";
import { crmDrafts, crmRecords } from "@/lib/crm/schema";
import { draftInOrg } from "@/lib/crm/records";
import { crmOperationErrorResponse, requireInteger } from "@/lib/crm/api";
import { assertExactKeys, assertObject, parseOptionalText, parseRequiredText, parseUuid, readCrmJson } from "@/lib/crm/categories";
import { discardDraft, updateDraft } from "@/lib/crm/drafts";
import { CrmNotFoundError } from "@/lib/crm/repository";
import { requireCrmMutationContext } from "@/lib/crm/http";
import { requireOrgContext } from "@/lib/auth/context";
import { runInOrganization } from "@/lib/tenancy/scope";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireOrgContext(request);
    return await runInOrganization(ctx.organizationId, async () => {
      const draftId = parseUuid((await params).id, "draft id");
      const [row] = await db
        .select({
          draft: crmDrafts,
          record: crmRecords,
          person: people,
          company: companies,
        })
        .from(crmDrafts)
        .innerJoin(crmRecords, eq(crmRecords.id, crmDrafts.crmRecordId))
        .innerJoin(people, eq(people.id, crmRecords.personId))
        .leftJoin(companies, eq(companies.id, people.companyId))
        .where(and(draftInOrg(), eq(crmDrafts.id, draftId)))
        .limit(1);
      if (!row) throw new CrmNotFoundError("CRM draft", draftId);
      return Response.json({
        draft: row.draft,
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
              code:
                (row.company.custom as Record<string, unknown> | null)?.x_code ??
                (row.company.raw as Record<string, unknown> | null)?.x_code ??
                null,
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
    if (value.status === "discarded") {
      assertExactKeys(value, ["status", "revision"]);
      return { draft: await discardDraft({ draftId: parseUuid(id, "draft id"), actorRef: ctx.userName }) };
    }
    assertExactKeys(value, ["subject", "body", "bodyText", "bodyHtml", "revision"]);
    return {
      draft: await updateDraft({
        draftId: parseUuid(id, "draft id"),
        revision: value.revision !== undefined && value.revision !== null ? requireInteger(value.revision, "revision") : null,
        subject: parseOptionalText(value.subject, "subject", 998),
        bodyText: parseRequiredText(value.bodyText ?? value.body, "bodyText", 100_000),
        bodyHtml: parseOptionalText(value.bodyHtml, "bodyHtml", 100_000),
        actorRef: ctx.userName,
      }),
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
