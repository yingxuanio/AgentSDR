import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { crmDrafts } from "@/lib/crm/schema";
import { draftInOrg } from "@/lib/crm/records";
import { CrmNotFoundError } from "@/lib/crm/repository";
import { crmOperationErrorResponse, requireInteger } from "@/lib/crm/api";
import { assertExactKeys, assertObject, parseOptionalText, parseRequiredText, parseUuid, readCrmJson } from "@/lib/crm/categories";
import { updateDraft } from "@/lib/crm/drafts";
import { CrmRequestError, requireCrmMutationContext } from "@/lib/crm/http";
import { parseExtraRecipients } from "@/lib/inbox/replyRequest";
import { sendDraft } from "@/lib/crm/send";
import { runInOrganization } from "@/lib/tenancy/scope";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireCrmMutationContext(request);
    return await runInOrganization(ctx.organizationId, async () => {
      const value = await readCrmJson(request);
      assertObject(value);
      assertExactKeys(value, ["revision", "subject", "body", "bodyText", "bodyHtml", "cc", "bcc", "idempotencyKey"]);
      const extra = parseExtraRecipients(value.cc, value.bcc);
      const draftId = parseUuid((await params).id, "draft id");

      let originalRevision: number;
      if (value.revision !== undefined && value.revision !== null) {
        originalRevision = requireInteger(value.revision, "revision");
      } else {
        const [found] = await db
          .select({ revision: crmDrafts.revision })
          .from(crmDrafts)
          .where(and(draftInOrg(), eq(crmDrafts.id, draftId)))
          .limit(1);
        if (!found) throw new CrmNotFoundError("CRM draft", draftId);
        originalRevision = found.revision;
      }

      const hasEditedContent = value.body !== undefined || value.bodyText !== undefined || value.subject !== undefined || value.bodyHtml !== undefined;
      const edited = hasEditedContent ? await updateDraft({
        draftId,
        revision: originalRevision,
        subject: parseOptionalText(value.subject, "subject", 998),
        bodyText: parseRequiredText(value.bodyText ?? value.body, "bodyText", 100_000),
        bodyHtml: parseOptionalText(value.bodyHtml, "bodyHtml", 100_000),
        actorRef: ctx.userName,
      }) : null;

      const rawKey =
        (typeof value.idempotencyKey === "string" && value.idempotencyKey.trim())
          ? value.idempotencyKey.trim()
          : (request.headers.get("idempotency-key")?.trim() || request.headers.get("x-idempotency-key")?.trim());

      let idempotencyKey: string;
      if (rawKey) {
        if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/.test(rawKey)) {
          throw new CrmRequestError(
            "A valid idempotencyKey (or Idempotency-Key header) of 16-128 chars is required",
            400,
            "INVALID_IDEMPOTENCY_KEY",
          );
        }
        idempotencyKey = rawKey;
      } else {
        idempotencyKey = `send-${draftId}-${randomUUID()}`;
      }

      const attempt = await sendDraft({
        draftId,
        revision: edited?.revision ?? originalRevision,
        idempotencyKey,
        requestId: request.headers.get("x-request-id")?.trim() || randomUUID(),
        actorRef: ctx.userName,
        ccEmails: extra.cc,
        bccEmails: extra.bcc,
      });
      return Response.json({ attempt });
    });
  } catch (error) {
    return crmOperationErrorResponse(error);
  }
}
