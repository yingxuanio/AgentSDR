import { and, asc, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { inboxContacts, inboxMessages } from "@/lib/inbox/schema";
import { people } from "@/lib/leads/schema";
import { connections as linkedinConnections, messages as linkedinMessages } from "@/lib/linkedin/schema";
import { isPlatformConnected, isPlatformNotConnectedError } from "@/lib/platform/credentials";
import { sendEmail } from "@/lib/outreach/gmail";
import { mailboxes } from "@/lib/outreach/schema";
import { sendMessage as sendLinkedInMessage } from "@/services/unipile.service";
import {
  deliverWhatsappFromCrm,
  WhatsappSendRefusedError,
  type DeliverWhatsappInput,
  type DeliverWhatsappResult,
} from "@/lib/whatsapp/delivery";
import { whatsappMessages } from "@/lib/whatsapp/schema";
import { crmChannelSendProvider } from "./channels";
import { insertConversationMessageInTransaction } from "./conversations";
import { appendCrmEvent } from "./events";
import { isEmailDoNotContact, isPersonDoNotContact } from "./policies";
import { CrmConfigurationValidationError } from "./categories";
import { isSuppressed } from "@/lib/outreach/suppression";
import { dedupeAddresses, normalizeEmail, type EmailAddress } from "@/lib/email/recipients";
import {
  CrmConflictError,
  CrmNotFoundError,
  type CrmTransaction,
  withCrmTransaction,
} from "./repository";
import { draftInOrg, lockCrmRecord } from "./records";
import { inOrg } from "@/lib/tenancy/scope";
import {
  crmClassifications,
  crmConversationMessages,
  crmConversations,
  crmDrafts,
  crmRecords,
  crmSendAttempts,
  crmSequenceRuns,
  crmSequenceStepRuns,
  crmSequenceSteps,
  type CrmChannel,
  type CrmSendActorType,
} from "./schema";
import { assertCurrentCrmContext } from "./stateMachine";
import { adoptCurrentSequenceStepInTransaction, interruptActiveSequenceRunInTransaction } from "./sequences";
import { workflowStateAfterOffScriptSend } from "./manualOutbound";

export type NormalizedCrmSendResult = {
  provider: "gmail" | "unipile";
  providerMessageId: string | null;
  providerThreadId: string | null;
  rfcMessageId: string | null;
  response: Record<string, unknown>;
};

export type CrmSendAdapterInput = {
  channel: CrmChannel;
  accountRef: string;
  providerThreadId: string | null;
  providerContactId: string | null;
  recipientEmail: string | null;
  /** The Person's phone (people.phone, E.164) — WhatsApp's recipient when the conversation has no chat yet. */
  recipientPhone?: string | null;
  subject: string | null;
  bodyText: string;
  bodyHtml: string | null;
  inReplyTo: string | null;
  /** Email only: extra visible / hidden recipients, already de-duplicated and stripped of the lead and our mailbox. */
  ccEmails?: string[];
  bccEmails?: string[];
  /** Email only: the conversation's RFC Message-ID chain (oldest first), ending with inReplyTo. */
  references?: string[];
};

const RFC_MESSAGE_ID = /^<[^<>\s@]+@[^<>\s@]+>$/;

/** True for an RFC 5322 Message-ID such as `<abc@mail.example.com>`; false for a bare Gmail API id. */
export function isRfcMessageId(value: unknown): value is string {
  return typeof value === "string" && RFC_MESSAGE_ID.test(value.trim());
}

const MAX_REFERENCES = 20;

/**
 * The In-Reply-To / References for a reply: the RFC Message-IDs of the
 * conversation's email messages in send order (last 20, no repeats), always
 * ending with the message being answered.
 */
export function buildThreadHeaders(
  messages: ReadonlyArray<{ raw: unknown; providerMessageId: string | null }>,
): { inReplyTo: string | null; references: string[] } {
  // Outreach-history rows keep the RFC id only in providerMessageId; inbound
  // and rep-sent rows have it on raw.messageId.
  const rfcId = (message: { raw: unknown; providerMessageId: string | null } | undefined): string | null => {
    if (!message) return null;
    const raw = message.raw && typeof message.raw === "object" ? (message.raw as { messageId?: unknown }) : null;
    if (isRfcMessageId(raw?.messageId)) return raw.messageId.trim();
    return isRfcMessageId(message.providerMessageId) ? message.providerMessageId.trim() : null;
  };
  const chain = messages.map(rfcId).filter((id): id is string => Boolean(id));
  const inReplyTo = rfcId(messages[messages.length - 1]) ?? chain[chain.length - 1] ?? null;
  const unique: string[] = [];
  for (const id of chain) {
    const at = unique.indexOf(id);
    if (at >= 0) unique.splice(at, 1);
    unique.push(id);
  }
  return { inReplyTo, references: unique.slice(-MAX_REFERENCES) };
}

/** Cc/Bcc for the send: valid unique addresses minus the lead (the To) and our own mailbox. */
export function resolveExtraRecipients(
  input: { ccEmails?: readonly string[]; bccEmails?: readonly string[] },
  exclude: { recipient: string | null; mailbox: string | null },
): { cc: string[]; bcc: string[] } {
  const skip = [exclude.recipient, exclude.mailbox].filter((v): v is string => Boolean(v));
  const toList = (list: readonly string[] | undefined): EmailAddress[] =>
    (list ?? []).map((email) => ({ email: normalizeEmail(email), name: null }));
  const cc = dedupeAddresses(toList(input.ccEmails), skip).map((a) => a.email);
  const bcc = dedupeAddresses(toList(input.bccEmails), [...skip, ...cc]).map((a) => a.email);
  return { cc, bcc };
}

/** The addresses as actually sent, in the shape stored on message `raw`. */
export function sentRecipients(request: Pick<CrmSendAdapterInput, "recipientEmail" | "ccEmails" | "bccEmails">) {
  const address = (email: string): EmailAddress => ({ email, name: null });
  return {
    to: request.recipientEmail ? [address(request.recipientEmail)] : [],
    cc: (request.ccEmails ?? []).map(address),
    bcc: (request.bccEmails ?? []).map(address),
  };
}

export type CrmSendAdapter = (input: CrmSendAdapterInput) => Promise<NormalizedCrmSendResult>;

export class DefiniteCrmSendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DefiniteCrmSendError";
  }
}

function providerErrorIsDefinite(error: unknown): boolean {
  // Nothing was submitted: the platform was never connected.
  if (error instanceof DefiniteCrmSendError || isPlatformNotConnectedError(error)) return true;
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: unknown; status?: unknown; responseCode?: unknown; message?: unknown; response?: { status?: unknown } };
  const smtpCode = Number(value.responseCode);
  if (Number.isInteger(smtpCode) && smtpCode >= 550 && smtpCode <= 554) return true;
  if (typeof value.message === "string" && /\b55[0-4]\s+RCPT\b|all recipients were rejected/i.test(value.message)) return true;
  const status = Number(value.status ?? value.response?.status ?? value.code);
  return Number.isInteger(status) && status >= 400 && status < 500 && ![408, 409, 425, 429].includes(status);
}

export const sendThroughCrmProvider: CrmSendAdapter = async (input) => {
  if (input.channel === "email") {
    if (!(await isPlatformConnected("google"))) throw new DefiniteCrmSendError("Google Workspace is not connected — connect it in Settings → Email → Connection");
    if (!input.recipientEmail) throw new DefiniteCrmSendError("The Person has no Email address");
    if (!input.subject) throw new DefiniteCrmSendError("Email subject is required");
    const [mailbox] = await db
      .select({ displayName: mailboxes.displayName })
      .from(mailboxes)
      .where(and(inOrg(mailboxes), eq(mailboxes.emailAddress, input.accountRef)))
      .limit(1);
    const result = await sendEmail({
      from: input.accountRef,
      fromName: mailbox?.displayName ?? null,
      to: [input.recipientEmail],
      cc: input.ccEmails?.length ? input.ccEmails : undefined,
      bcc: input.bccEmails?.length ? input.bccEmails : undefined,
      subject: input.subject,
      text: input.bodyText,
      html: input.bodyHtml ?? undefined,
      inReplyTo: input.inReplyTo ?? undefined,
      references: input.references?.length ? input.references : input.inReplyTo ? [input.inReplyTo] : undefined,
      threadId: input.providerThreadId ?? undefined,
    });
    return {
      provider: "gmail",
      providerMessageId: result.id,
      providerThreadId: result.threadId,
      rfcMessageId: result.messageId,
      response: result,
    };
  }
  if (input.channel === "whatsapp") return sendWhatsappThroughCrm(input);
  if (!input.providerThreadId) throw new DefiniteCrmSendError("LinkedIn conversation has no chat ID");
  const messageId = await sendLinkedInMessage(input.providerThreadId, input.bodyText);
  return {
    provider: "unipile",
    providerMessageId: messageId,
    providerThreadId: input.providerThreadId,
    rfcMessageId: null,
    response: { messageId, chatId: input.providerThreadId },
  };
};

/**
 * The WhatsApp branch of sendThroughCrmProvider, with the delivery injectable
 * for tests. Into the conversation's chat when it has one, else a new chat
 * with the Person's number. A guardrail refusal (warm-up, new-chat cap,
 * spacing, Do Not Contact) is definite: nothing reached WhatsApp, so the
 * draft fails rather than going delivery-uncertain.
 */
export async function sendWhatsappThroughCrm(
  input: CrmSendAdapterInput,
  deliver: (input: DeliverWhatsappInput) => Promise<DeliverWhatsappResult> = deliverWhatsappFromCrm,
): Promise<NormalizedCrmSendResult> {
  if (input.channel !== "whatsapp") throw new Error(`Not a WhatsApp send: ${input.channel}`);
  const phone = input.recipientPhone?.trim() || null;
  if (!input.providerThreadId && !phone) {
    throw new DefiniteCrmSendError("The Person has no phone number and the conversation has no WhatsApp chat");
  }
  let result: DeliverWhatsappResult;
  try {
    result = await deliver({
      unipileAccountId: input.accountRef,
      unipileChatId: input.providerThreadId,
      phone,
      text: input.bodyText,
    });
  } catch (error) {
    if (error instanceof WhatsappSendRefusedError) throw new DefiniteCrmSendError(error.message);
    throw error;
  }
  return {
    provider: "unipile",
    providerMessageId: result.unipileMessageId,
    providerThreadId: result.unipileChatId,
    rfcMessageId: null,
    response: {
      messageId: result.unipileMessageId,
      chatId: result.unipileChatId,
      whatsappMessageId: result.whatsappMessageId,
    },
  };
}

type PreparedSend = {
  attemptId: string;
  draftId: string;
  personId: string;
  request: CrmSendAdapterInput;
};

async function prepareSend(tx: CrmTransaction, input: {
  draftId: string;
  revision: number;
  idempotencyKey: string;
  requestId: string;
  actorType?: CrmSendActorType;
  actorRef?: string | null;
  ccEmails?: string[];
  bccEmails?: string[];
}): Promise<PreparedSend | { replay: true; attemptId: string }> {
  const [existingAttempt] = await tx.select().from(crmSendAttempts)
    .where(and(
      eq(crmSendAttempts.idempotencyKey, input.idempotencyKey),
      inArray(crmSendAttempts.draftId, db.select({ id: crmDrafts.id }).from(crmDrafts).where(draftInOrg())),
    )).limit(1).for("update");
  if (existingAttempt) {
    if (existingAttempt.draftId !== input.draftId) {
      throw new CrmConflictError("Idempotency key belongs to another CRM draft");
    }
    if (["sent", "reconciled"].includes(existingAttempt.status)) {
      return { replay: true, attemptId: existingAttempt.id };
    }
    if (["sending", "delivery_uncertain"].includes(existingAttempt.status)) {
      throw new CrmConflictError(`Send attempt is ${existingAttempt.status}; reconcile it before retrying`);
    }
  }

  const [draft] = await tx.select().from(crmDrafts)
    .where(and(draftInOrg(), eq(crmDrafts.id, input.draftId))).limit(1).for("update");
  if (!draft) throw new CrmNotFoundError("CRM draft", input.draftId);
  if (draft.status !== "awaiting_review") throw new CrmConflictError(`Cannot send a ${draft.status} draft`);
  if (draft.revision !== input.revision) throw new CrmConflictError("Draft revision is stale");
  const record = await lockCrmRecord(tx, draft.crmRecordId);
  assertCurrentCrmContext(record, { contextVersion: draft.expectedContextVersion });
  if (await isPersonDoNotContact(tx, record.personId)) {
    throw new CrmConflictError("This Person is globally marked Do Not Contact");
  }

  const [conversation] = await tx.select().from(crmConversations)
    .where(and(inOrg(crmConversations), eq(crmConversations.id, draft.conversationId), eq(crmConversations.crmRecordId, record.id)))
    .limit(1);
  if (!conversation || conversation.status !== "active") {
    throw new CrmConflictError("CRM conversation is unavailable for sending");
  }
  if (conversation.channel !== draft.channel) throw new CrmConflictError("Draft channel does not match its conversation");
  if (draft.sequenceStepRunId) {
    const [stepScope] = await tx.select({ stepRun: crmSequenceStepRuns, run: crmSequenceRuns })
      .from(crmSequenceStepRuns)
      .innerJoin(crmSequenceRuns, eq(crmSequenceRuns.id, crmSequenceStepRuns.sequenceRunId))
      .where(and(inOrg(crmSequenceRuns), eq(crmSequenceStepRuns.id, draft.sequenceStepRunId))).limit(1).for("update");
    if (!stepScope || stepScope.stepRun.status !== "awaiting_review" || stepScope.run.status !== "active") {
      throw new CrmConflictError("The sequence step is no longer awaiting review on an active run");
    }
  } else {
    // A hand-written draft on a record with a pending step *is* that step's
    // reply (or follow-up). Linking it here lets finishSuccessfulSend advance
    // the run instead of interrupting it; it re-reads the draft, so the link
    // only has to be persisted, not threaded through PreparedSend.
    await adoptCurrentSequenceStepInTransaction(tx, {
      recordId: record.id,
      draftId: draft.id,
      contextVersion: record.contextVersion,
    });
  }
  const [person] = await tx.select({ email: people.email, phone: people.phone }).from(people)
    .where(and(inOrg(people), eq(people.id, record.personId))).limit(1);
  if (!person) throw new CrmNotFoundError("Person", record.personId);
  const history = await tx.select({ raw: crmConversationMessages.raw, providerMessageId: crmConversationMessages.providerMessageId })
    .from(crmConversationMessages)
    .where(eq(crmConversationMessages.conversationId, conversation.id))
    .orderBy(asc(crmConversationMessages.sentAt), asc(crmConversationMessages.id));
  const thread = buildThreadHeaders(history);
  const requestedExtras = (input.ccEmails?.length ?? 0) + (input.bccEmails?.length ?? 0);
  if (draft.channel !== "email" && requestedExtras > 0) {
    throw new CrmConfigurationValidationError("cc and bcc are only supported on email conversations");
  }
  const extras = draft.channel === "email"
    ? resolveExtraRecipients(input, { recipient: person.email, mailbox: conversation.accountRef })
    : { cc: [], bcc: [] };
  for (const address of [...extras.cc, ...extras.bcc]) {
    if (await isSuppressed(address)) throw new CrmConflictError(`${address} is on the suppression list; remove it from Cc/Bcc to send`);
    if (await isEmailDoNotContact(tx, address)) throw new CrmConflictError(`${address} is marked Do Not Contact; remove it from Cc/Bcc to send`);
  }
  const bodyText = draft.editedBodyText?.trim() || draft.aiBodyText?.trim() || "";
  if (!bodyText) throw new CrmConflictError("Draft has no sendable body");
  const request: CrmSendAdapterInput = {
    channel: draft.channel,
    accountRef: conversation.accountRef,
    providerThreadId: conversation.providerThreadId,
    providerContactId: conversation.providerContactId,
    recipientEmail: person.email,
    recipientPhone: draft.channel === "whatsapp" ? person.phone : null,
    subject: draft.subject,
    bodyText,
    bodyHtml: draft.editedBodyHtml ?? draft.aiBodyHtml,
    inReplyTo: thread.inReplyTo,
    ...(draft.channel === "email" ? { ccEmails: extras.cc, bccEmails: extras.bcc, references: thread.references } : {}),
  };
  const provider = crmChannelSendProvider(draft.channel);
  const [attempt] = existingAttempt
    ? await tx.update(crmSendAttempts).set({
        status: "sending", requestId: input.requestId, provider, accountRef: conversation.accountRef,
        request, response: null, error: null, updatedAt: new Date(),
      }).where(eq(crmSendAttempts.id, existingAttempt.id)).returning()
    : await tx.insert(crmSendAttempts).values({
        draftId: draft.id,
        idempotencyKey: input.idempotencyKey,
        status: "sending",
        actorType: input.actorType ?? "authenticated_operator",
        requestId: input.requestId,
        provider,
        accountRef: conversation.accountRef,
        request,
      }).returning();
  if (!attempt) throw new Error("CRM send attempt write did not return a row");
  await tx.update(crmDrafts).set({ status: "sending", updatedAt: new Date() }).where(eq(crmDrafts.id, draft.id));
  await appendCrmEvent(tx, {
    personId: record.personId, crmRecordId: record.id, pipelineId: record.pipelineId,
    eventType: "message.sending", actorType: input.actorType ?? "authenticated_operator", actorRef: input.actorRef,
    toData: { draftId: draft.id, sendAttemptId: attempt.id },
    meta: { idempotencyKey: input.idempotencyKey, requestId: input.requestId },
    contextVersion: record.contextVersion,
  });
  return { attemptId: attempt.id, draftId: draft.id, personId: record.personId, request };
}

async function finishSuccessfulSend(
  prepared: PreparedSend,
  result: NormalizedCrmSendResult,
  actorRef?: string | null,
  reconciliation?: { note: string } | null,
) {
  return withCrmTransaction(async (tx) => {
    const [attempt] = await tx.select().from(crmSendAttempts)
      .where(eq(crmSendAttempts.id, prepared.attemptId)).limit(1).for("update");
    if (!attempt) throw new CrmNotFoundError("CRM send attempt", prepared.attemptId);
    if (["sent", "reconciled"].includes(attempt.status)) return attempt;
    const expectedStatus = reconciliation ? "delivery_uncertain" : "sending";
    if (attempt.status !== expectedStatus) throw new CrmConflictError(`Cannot complete a ${attempt.status} send attempt`);
    const [draft] = await tx.select().from(crmDrafts)
      .where(and(draftInOrg(), eq(crmDrafts.id, prepared.draftId))).limit(1).for("update");
    if (!draft) throw new CrmNotFoundError("CRM draft", prepared.draftId);
    const record = await lockCrmRecord(tx, draft.crmRecordId);
    const [conversation] = await tx.select().from(crmConversations)
      .where(and(inOrg(crmConversations), eq(crmConversations.id, draft.conversationId))).limit(1);
    if (!conversation) throw new CrmNotFoundError("CRM conversation", draft.conversationId);
    const now = new Date();
    // A WhatsApp conversation without a chat yet gets the one the send opened,
    // so the lead's reply (keyed by chat) lands on this conversation. Skipped
    // when another conversation already holds that chat, rather than tripping
    // the (channel, account, thread) unique index inside this transaction.
    if (!conversation.providerThreadId && result.providerThreadId && conversation.channel === "whatsapp") {
      const [holder] = await tx.select({ id: crmConversations.id }).from(crmConversations)
        .where(and(
          inOrg(crmConversations),
          eq(crmConversations.channel, conversation.channel),
          eq(crmConversations.accountRef, conversation.accountRef),
          eq(crmConversations.providerThreadId, result.providerThreadId),
        )).limit(1);
      if (!holder) {
        await tx.update(crmConversations).set({ providerThreadId: result.providerThreadId, updatedAt: now })
          .where(eq(crmConversations.id, conversation.id));
      }
    }
    const { message } = await insertConversationMessageInTransaction(tx, {
      conversationId: conversation.id,
      personId: record.personId,
      channel: conversation.channel,
      accountRef: conversation.accountRef,
      direction: "outbound",
      idempotencyKey: `crm-send:${attempt.idempotencyKey}`,
      providerMessageId: result.providerMessageId ?? result.rfcMessageId,
      subject: draft.subject,
      bodyText: prepared.request.bodyText,
      bodyHtml: prepared.request.bodyHtml,
      raw: {
        provider: result.provider,
        providerThreadId: result.providerThreadId,
        messageId: result.rfcMessageId,
        response: result.response,
        ...(conversation.channel === "email" ? sentRecipients(prepared.request) : {}),
      },
      sentAt: now,
    });
    // During pilot/cutover the native LinkedIn inbox remains a read surface.
    // Mirror confirmed CRM sends into its canonical message store, while CRM
    // remains the sole workflow/state owner.
    if (conversation.channel === "linkedin" && conversation.providerThreadId) {
      const nativeStore = await tx.execute(sql<{ exists: boolean }>`select to_regclass('"Connection"') is not null as exists`);
      if (nativeStore[0]?.exists) {
        const [connection] = await tx.select({
          id: linkedinConnections.id,
          leadId: linkedinConnections.leadId,
          organizationId: linkedinConnections.organizationId,
        }).from(linkedinConnections).where(and(
          inOrg(linkedinConnections),
          eq(linkedinConnections.chatId, conversation.providerThreadId),
        )).limit(1);
        if (connection) {
          await tx.insert(linkedinMessages).values({
            organizationId: connection.organizationId,
            type: "CUSTOM_SENT",
            text: prepared.request.bodyText,
            linkedinMessageId: result.providerMessageId,
            connectionId: connection.id,
            leadId: connection.leadId,
            seen: true,
            createdAt: now,
          });
        }
      }
    }
    // The WhatsApp Messages tab already holds the message (delivery.ts stored
    // it); link it to its CRM twin so neither side records it twice — the
    // history backfill (outreachHistory.ts) skips linked rows.
    const whatsappMessageId = result.response.whatsappMessageId;
    if (conversation.channel === "whatsapp" && typeof whatsappMessageId === "string") {
      await tx.update(whatsappMessages).set({ crmConversationMessageId: message.id })
        .where(and(eq(whatsappMessages.id, whatsappMessageId), isNull(whatsappMessages.crmConversationMessageId)));
    }
    // The email Master Inbox is a read surface in the same way: it only ever
    // stored inbound Gmail traffic (replyBridge.ts), so a CRM send would
    // otherwise be missing from the thread the operator replied from. Mirror
    // it onto the contact keyed by the recipient's address; the key matches
    // the CRM message's, so a retried completion cannot write it twice.
    if (conversation.channel === "email" && prepared.request.recipientEmail) {
      const [contact] = await tx.select({ id: inboxContacts.id }).from(inboxContacts)
        .where(and(inOrg(inboxContacts), sql`lower(${inboxContacts.email}) = lower(${prepared.request.recipientEmail})`)).limit(1);
      if (contact) {
        await tx.insert(inboxMessages).values({
          contactId: contact.id,
          direction: "outbound",
          providerMessageKey: `crm-send:${attempt.idempotencyKey}`,
          subject: draft.subject,
          bodyText: prepared.request.bodyText,
          bodyHtml: prepared.request.bodyHtml ?? null,
          fromEmail: conversation.accountRef,
          toEmail: prepared.request.recipientEmail,
          sentAt: now,
          raw: {
            provider: result.provider,
            threadId: result.providerThreadId,
            messageId: result.rfcMessageId,
            crmConversationMessageId: message.id,
            ...sentRecipients(prepared.request),
          },
        }).onConflictDoNothing();
      }
    }
    await tx.update(crmSendAttempts).set({
      status: reconciliation ? "reconciled" : "sent",
      providerRequestId: result.rfcMessageId,
      providerMessageId: result.providerMessageId,
      response: result.response,
      reconciledAt: reconciliation ? now : null,
      reconciliationNote: reconciliation?.note ?? null,
      updatedAt: now,
    }).where(eq(crmSendAttempts.id, attempt.id));
    await tx.update(crmDrafts).set({ status: "sent", updatedAt: now }).where(eq(crmDrafts.id, draft.id));

    let nextActionAt: Date | null = null;
    let workflowState = record.workflowState;
    if (draft.sequenceStepRunId) {
      const [scope] = await tx.select({ stepRun: crmSequenceStepRuns, run: crmSequenceRuns, step: crmSequenceSteps })
        .from(crmSequenceStepRuns)
        .innerJoin(crmSequenceRuns, eq(crmSequenceRuns.id, crmSequenceStepRuns.sequenceRunId))
        .innerJoin(crmSequenceSteps, eq(crmSequenceSteps.id, crmSequenceStepRuns.sequenceStepId))
        .where(and(inOrg(crmSequenceRuns), eq(crmSequenceStepRuns.id, draft.sequenceStepRunId))).limit(1).for("update");
      if (scope) {
        await tx.update(crmSequenceStepRuns).set({ status: "sent", sentMessageId: message.id, updatedAt: now })
          .where(eq(crmSequenceStepRuns.id, scope.stepRun.id));
        const [next] = await tx.select({ stepRun: crmSequenceStepRuns, step: crmSequenceSteps })
          .from(crmSequenceStepRuns)
          .innerJoin(crmSequenceSteps, eq(crmSequenceSteps.id, crmSequenceStepRuns.sequenceStepId))
          .where(and(
            eq(crmSequenceStepRuns.sequenceRunId, scope.run.id),
            eq(crmSequenceStepRuns.status, "scheduled"),
            sql`${crmSequenceSteps.position} > ${scope.step.position}`,
          )).orderBy(asc(crmSequenceSteps.position)).limit(1);
        const stillCurrent = record.contextVersion === draft.expectedContextVersion && scope.run.status === "active";
        if (next && stillCurrent) {
          nextActionAt = new Date(now.getTime() + next.step.delayMinutes * 60_000);
          workflowState = "waiting";
          // The run moves on in the record's current context (stillCurrent),
          // so the next step is drafted in it — whatever version it was
          // given when the run started.
          await tx.update(crmSequenceStepRuns).set({ dueAt: nextActionAt, expectedContextVersion: record.contextVersion, updatedAt: now })
            .where(eq(crmSequenceStepRuns.id, next.stepRun.id));
          await tx.update(crmSequenceRuns).set({ currentStepPosition: next.step.position, updatedAt: now })
            .where(eq(crmSequenceRuns.id, scope.run.id));
        } else if (!next && stillCurrent) {
          workflowState = "idle";
          await tx.update(crmSequenceRuns).set({ status: "completed", updatedAt: now })
            .where(eq(crmSequenceRuns.id, scope.run.id));
        }
      }
    } else if (record.contextVersion === draft.expectedContextVersion) {
      const [classification] = record.latestInboundMessageId
        ? await tx.select({ status: crmClassifications.status }).from(crmClassifications)
          .where(and(
            eq(crmClassifications.crmRecordId, record.id),
            eq(crmClassifications.messageId, record.latestInboundMessageId),
          ))
          .orderBy(desc(crmClassifications.createdAt)).limit(1)
        : [];
      workflowState = workflowStateAfterOffScriptSend(classification?.status ?? null);
      await interruptActiveSequenceRunInTransaction(tx, {
        recordId: record.id,
        reason: "manual_outbound_send",
        contextVersion: record.contextVersion,
      });
      await tx.update(crmDrafts).set({ status: "stale", updatedAt: now }).where(and(
        eq(crmDrafts.crmRecordId, record.id),
        ne(crmDrafts.id, draft.id),
        inArray(crmDrafts.status, ["generating", "awaiting_review", "failed"]),
      ));
    }
    await tx.update(crmRecords).set({
      workflowState,
      lastOutboundAt: now,
      lastInteractionAt: now,
      nextActionAt,
      updatedAt: now,
    }).where(eq(crmRecords.id, record.id));
    if (!reconciliation && attempt.actorType !== "system" && prepared.request.channel === "email") {
      await tx.update(mailboxes)
        .set({ todayEmailsSent: sql`${mailboxes.todayEmailsSent} + 1`, updatedAt: now })
        .where(and(inOrg(mailboxes), eq(mailboxes.emailAddress, prepared.request.accountRef)));
    }
    await tx.update(crmClassifications).set({ acknowledgedAt: now, updatedAt: now })
      .where(and(
        eq(crmClassifications.crmRecordId, record.id),
        eq(crmClassifications.messageId, draft.replyForMessageId ?? record.latestInboundMessageId ?? "00000000-0000-0000-0000-000000000000"),
        inArray(crmClassifications.status, ["auto_applied", "accepted", "overridden"]),
      ));
    await appendCrmEvent(tx, {
      personId: record.personId, crmRecordId: record.id, pipelineId: record.pipelineId,
      eventType: "message.sent", actorType: reconciliation ? "authenticated_operator" : attempt.actorType, actorRef,
      fromData: { draftId: draft.id },
      toData: { messageId: message.id, sendAttemptId: attempt.id, workflowState, nextActionAt },
      meta: {
        provider: result.provider,
        providerMessageId: result.providerMessageId,
        ...(reconciliation ? { reconciliationNote: reconciliation.note } : {}),
      },
      contextVersion: record.contextVersion,
    });
    return {
      ...attempt,
      status: reconciliation ? "reconciled" as const : "sent" as const,
      providerMessageId: result.providerMessageId,
    };
  });
}

async function finishFailedSend(prepared: PreparedSend, error: unknown, definite: boolean, actorRef?: string | null) {
  const message = error instanceof Error ? error.message : String(error);
  return withCrmTransaction(async (tx) => {
    const [attempt] = await tx.select().from(crmSendAttempts)
      .where(eq(crmSendAttempts.id, prepared.attemptId)).limit(1).for("update");
    if (!attempt || attempt.status !== "sending") return attempt ?? null;
    const [draft] = await tx.select().from(crmDrafts)
      .where(and(draftInOrg(), eq(crmDrafts.id, prepared.draftId))).limit(1).for("update");
    if (!draft) throw new CrmNotFoundError("CRM draft", prepared.draftId);
    const record = await lockCrmRecord(tx, draft.crmRecordId);
    const attemptStatus = definite ? "failed" as const : "delivery_uncertain" as const;
    const draftStatus = definite ? "failed" as const : "delivery_uncertain" as const;
    const now = new Date();
    await tx.update(crmSendAttempts).set({ status: attemptStatus, error: message, updatedAt: now })
      .where(eq(crmSendAttempts.id, attempt.id));
    await tx.update(crmDrafts).set({ status: draftStatus, error: message, updatedAt: now })
      .where(eq(crmDrafts.id, draft.id));
    if (draft.sequenceStepRunId && definite) {
      await tx.update(crmSequenceStepRuns).set({ status: "failed", lastError: message, updatedAt: now })
        .where(eq(crmSequenceStepRuns.id, draft.sequenceStepRunId));
    }
    await tx.update(crmRecords).set({ workflowState: "error", nextActionAt: null, updatedAt: now })
      .where(eq(crmRecords.id, record.id));
    await appendCrmEvent(tx, {
      personId: record.personId, crmRecordId: record.id, pipelineId: record.pipelineId,
      eventType: definite ? "message.failed" : "message.delivery_uncertain",
      actorType: attempt.actorType, actorRef,
      toData: { draftId: draft.id, sendAttemptId: attempt.id, status: attemptStatus },
      meta: { error: message }, contextVersion: record.contextVersion,
    });
    return { ...attempt, status: attemptStatus, error: message };
  });
}

export async function sendDraft(input: {
  draftId: string;
  revision: number;
  idempotencyKey: string;
  requestId: string;
  /** "system" only for the automatic follow-up sender; a person's send is the default. */
  actorType?: CrmSendActorType;
  actorRef?: string | null;
  ccEmails?: string[];
  bccEmails?: string[];
}, dependencies: { send?: CrmSendAdapter } = {}) {
  const prepared = await withCrmTransaction((tx) => prepareSend(tx, input));
  if ("replay" in prepared) {
    const [attempt] = await db.select().from(crmSendAttempts).where(eq(crmSendAttempts.id, prepared.attemptId)).limit(1);
    return attempt!;
  }
  try {
    // This deliberately happens after the durable attempt is recorded and immediately
    // before the provider call. DNC is Person-global across every CRM channel.
    if (await isPersonDoNotContact(db, prepared.personId)) {
      throw new DefiniteCrmSendError("This Person was marked Do Not Contact before provider submission");
    }
    const result = await (dependencies.send ?? sendThroughCrmProvider)(prepared.request);
    return await finishSuccessfulSend(prepared, result, input.actorRef);
  } catch (error) {
    const definite = providerErrorIsDefinite(error);
    await finishFailedSend(prepared, error, definite, input.actorRef);
    throw error;
  }
}

export async function reconcileDeliveryUncertain(input: {
  attemptId: string;
  delivered: boolean;
  providerMessageId?: string | null;
  note: string;
  actorRef?: string | null;
}) {
  const note = input.note.trim();
  if (!note) throw new Error("Reconciliation note is required");
  if (input.delivered) {
    const [scope] = await db.select({ attempt: crmSendAttempts, draft: crmDrafts, record: crmRecords })
      .from(crmSendAttempts)
      .innerJoin(crmDrafts, eq(crmDrafts.id, crmSendAttempts.draftId))
      .innerJoin(crmRecords, eq(crmRecords.id, crmDrafts.crmRecordId))
      .where(and(inOrg(crmRecords), eq(crmSendAttempts.id, input.attemptId))).limit(1);
    if (!scope) throw new CrmNotFoundError("CRM send attempt", input.attemptId);
    if (scope.attempt.status !== "delivery_uncertain") {
      throw new CrmConflictError("Only uncertain deliveries can be reconciled");
    }
    const request = scope.attempt.request as CrmSendAdapterInput | null;
    if (!request) throw new CrmConflictError("The uncertain send attempt has no persisted provider request");
    return finishSuccessfulSend({
      attemptId: scope.attempt.id,
      draftId: scope.draft.id,
      personId: scope.record.personId,
      request,
    }, {
      provider: scope.attempt.provider as "gmail" | "unipile",
      providerMessageId: input.providerMessageId ?? scope.attempt.providerMessageId,
      providerThreadId: request.providerThreadId,
      rfcMessageId: scope.attempt.providerRequestId,
      response: {
        ...(scope.attempt.response ?? {}),
        manuallyReconciled: true,
        note,
      },
    }, input.actorRef, { note });
  }
  return withCrmTransaction(async (tx) => {
    const [attempt] = await tx.select().from(crmSendAttempts)
      .where(and(
        eq(crmSendAttempts.id, input.attemptId),
        inArray(crmSendAttempts.draftId, db.select({ id: crmDrafts.id }).from(crmDrafts).where(draftInOrg())),
      )).limit(1).for("update");
    if (!attempt) throw new CrmNotFoundError("CRM send attempt", input.attemptId);
    if (attempt.status !== "delivery_uncertain") throw new CrmConflictError("Only uncertain deliveries can be reconciled");
    const [draft] = await tx.select().from(crmDrafts)
      .where(and(draftInOrg(), eq(crmDrafts.id, attempt.draftId))).limit(1).for("update");
    if (!draft) throw new CrmNotFoundError("CRM draft", attempt.draftId);
    const record = await lockCrmRecord(tx, draft.crmRecordId);
    const now = new Date();
    const [updated] = await tx.update(crmSendAttempts).set({
      status: "reconciled",
      providerMessageId: input.providerMessageId ?? attempt.providerMessageId,
      reconciledAt: now,
      reconciliationNote: note,
      updatedAt: now,
    }).where(eq(crmSendAttempts.id, attempt.id)).returning();
    await tx.update(crmDrafts).set({ status: "failed", updatedAt: now })
      .where(eq(crmDrafts.id, draft.id));
    if (draft.sequenceStepRunId) {
      await tx.update(crmSequenceStepRuns).set({
        status: "failed",
        lastError: `Delivery reconciled as not delivered: ${note}`,
        updatedAt: now,
      }).where(eq(crmSequenceStepRuns.id, draft.sequenceStepRunId));
    }
    await tx.update(crmRecords).set({ workflowState: "error", nextActionAt: null, updatedAt: now })
      .where(eq(crmRecords.id, record.id));
    await appendCrmEvent(tx, {
      personId: record.personId, crmRecordId: record.id, pipelineId: record.pipelineId,
      eventType: "message.delivery_reconciled", actorType: "authenticated_operator", actorRef: input.actorRef,
      fromData: { status: "delivery_uncertain" }, toData: { delivered: false },
      meta: { note }, contextVersion: record.contextVersion,
    });
    return updated!;
  });
}
