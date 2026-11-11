import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { crmConversations, crmDrafts, crmRecords } from "@/lib/crm/schema";
import { mailboxes, type WorkingHours } from "@/lib/outreach/schema";
import { draftInOrg } from "@/lib/crm/records";
import { CrmNotFoundError, withCrmTransaction } from "@/lib/crm/repository";
import { appendCrmEvent } from "@/lib/crm/events";
import { crmOperationErrorResponse, requireInteger } from "@/lib/crm/api";
import { assertExactKeys, assertObject, parseOptionalText, parseRequiredText, parseUuid, readCrmJson } from "@/lib/crm/categories";
import { updateDraft } from "@/lib/crm/drafts";
import { CrmRequestError, requireCrmMutationContext } from "@/lib/crm/http";
import { parseExtraRecipients } from "@/lib/inbox/replyRequest";
import { sendDraft } from "@/lib/crm/send";
import { isWithinWorkingHours, mailboxHoursFromWeekly, nextWorkingWindowStart } from "@/lib/outreach/workingHours";
import { channelRules } from "@/lib/channels/rules.server";
import { inOrg, runInOrganization } from "@/lib/tenancy/scope";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireCrmMutationContext(request);
    return await runInOrganization(ctx.organizationId, async () => {
      const value = await readCrmJson(request);
      assertObject(value);
      assertExactKeys(value, [
        "revision",
        "subject",
        "body",
        "bodyText",
        "bodyHtml",
        "cc",
        "bcc",
        "idempotencyKey",
        "scheduleInWorkingHours",
      ]);
      const extra = parseExtraRecipients(value.cc, value.bcc);
      const draftId = parseUuid((await params).id, "draft id");

      const [draftScope] = await db
        .select({
          draft: crmDrafts,
          record: crmRecords,
          conversation: crmConversations,
        })
        .from(crmDrafts)
        .innerJoin(crmRecords, eq(crmRecords.id, crmDrafts.crmRecordId))
        .leftJoin(crmConversations, eq(crmConversations.id, crmDrafts.conversationId))
        .where(and(draftInOrg(), eq(crmDrafts.id, draftId)))
        .limit(1);
      if (!draftScope) throw new CrmNotFoundError("CRM draft", draftId);

      let originalRevision: number;
      if (value.revision !== undefined && value.revision !== null) {
        originalRevision = requireInteger(value.revision, "revision");
      } else {
        originalRevision = draftScope.draft.revision;
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

      const scheduleInWorkingHours = Boolean(value.scheduleInWorkingHours);
      if (scheduleInWorkingHours) {
        if (draftScope.draft.status !== "awaiting_review") {
          throw new CrmRequestError(
            `Only awaiting_review drafts can be queued (current status: ${draftScope.draft.status})`,
            409,
            "DRAFT_NOT_SENDABLE",
          );
        }
        if (draftScope.record.contextVersion !== (edited?.expectedContextVersion ?? draftScope.draft.expectedContextVersion)) {
          throw new CrmRequestError(
            "Draft context is out of date; regenerate or review before queuing",
            409,
            "STALE_DRAFT_CONTEXT",
          );
        }

        let mailboxHours: WorkingHours | null = null;
        if (draftScope.draft.channel === "email") {
          if (draftScope.conversation?.accountRef) {
            const [mailbox] = await db
              .select({ workingHours: mailboxes.workingHours })
              .from(mailboxes)
              .where(and(inOrg(mailboxes), eq(mailboxes.emailAddress, draftScope.conversation.accountRef)))
              .limit(1);
            if (mailbox?.workingHours) {
              mailboxHours = mailbox.workingHours;
            }
          }
          if (!mailboxHours) {
            const { sendingHours } = await channelRules("email");
            if (sendingHours) mailboxHours = mailboxHoursFromWeekly(sendingHours);
          }
        } else if (draftScope.draft.channel === "whatsapp") {
          const { sendingHours } = await channelRules("whatsapp");
          if (sendingHours) mailboxHours = mailboxHoursFromWeekly(sendingHours);
        } else if (draftScope.draft.channel === "linkedin") {
          const { workingHours } = await channelRules("linkedin");
          if (workingHours) mailboxHours = mailboxHoursFromWeekly(workingHours);
        }

        const now = new Date();
        const scheduledAt =
          mailboxHours && !isWithinWorkingHours(mailboxHours, now)
            ? nextWorkingWindowStart(mailboxHours, now)
            : now;

        await withCrmTransaction(async (tx) => {
          await tx
            .update(crmDrafts)
            .set({ autoSendAt: scheduledAt, updatedAt: now })
            .where(eq(crmDrafts.id, draftId));

          await tx
            .update(crmRecords)
            .set({ workflowState: "waiting", nextActionAt: null, updatedAt: now })
            .where(eq(crmRecords.id, draftScope.record.id));

          await appendCrmEvent(tx, {
            personId: draftScope.record.personId,
            crmRecordId: draftScope.record.id,
            pipelineId: draftScope.record.pipelineId,
            eventType: "draft.auto_send_queued",
            actorType: "authenticated_operator",
            actorRef: ctx.userName,
            toData: {
              draftId,
              autoSendAt: scheduledAt.toISOString(),
              workflowState: "waiting",
              reason: "scheduled_in_working_hours",
            },
            contextVersion: draftScope.record.contextVersion,
          });
        });

        return Response.json({
          scheduled: true,
          sent: false,
          scheduledAt: scheduledAt.toISOString(),
          draft: {
            id: draftId,
            revision: edited?.revision ?? originalRevision,
            status: "awaiting_review",
            autoSendAt: scheduledAt.toISOString(),
            workflowState: "waiting",
          },
        });
      }

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

      return Response.json({
        scheduled: false,
        sent: true,
        attempt,
      });
    });
  } catch (error) {
    return crmOperationErrorResponse(error);
  }
}
