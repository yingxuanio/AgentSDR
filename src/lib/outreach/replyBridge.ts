/** Stores Gmail mail in Master Inbox and routes known contacts into CRM. */
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { inboxContacts, inboxMessages } from "@/lib/inbox/schema";
import { type StepLogger } from "@/lib/debugLog";
import { htmlToPlainText, looksLikeHtml } from "@/lib/email/htmlToText";
import { mailboxes, outreachLeads } from "./schema";
import { suppressEmailOutreach } from "./suppression";
import type { InboundMessage } from "./gmail";
import { upsertPerson, withLeadTransaction } from "@/lib/leads/records";
import { people } from "@/lib/leads/schema";
import { crmConversations } from "@/lib/crm/schema";
import { gmailInboundEventKey } from "./inboundIdentity";
import { ingestInboundReply as ingestCrmInboundReply } from "@/lib/crm/conversations";
import { quarantineCrmIdentity } from "@/lib/crm/identity";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import { leadsInOrg } from "./orgScope";

/**
 * Who a delivery report comes from.
 *
 * Gmail relays its own failures as mailer-daemon@googlemail.com, but that is
 * only the synchronous case — the message never left. When the destination
 * server accepts a message and rejects it afterwards, the report comes back
 * from that domain's own postmaster (postmaster@prospect.example.com and friends),
 * which is why matching one literal address missed 68 hard-bounced addresses:
 * none were suppressed and 37 were still scheduled for follow-ups.
 */
const BOUNCE_LOCAL_PARTS = new Set(["mailer-daemon", "postmaster"]);

/**
 * Subjects mail systems use for a failure report. Checked only as a fallback
 * for senders outside the two local parts above, and never on its own: a
 * message is treated as a bounce only when a failed recipient can also be read
 * out of it, so a human writing "Undeliverable?" is not silently suppressed.
 */
const BOUNCE_SUBJECTS = [
  /^undeliverable\b/i,
  /^returned mail\b/i,
  /delivery status notification \(failure\)/i,
  /delivery (has failed|failure)/i,
  /mail delivery (failed|subsystem)/i,
];

/**
 * Gmail sends one of these per retry attempt while it keeps trying — "Gmail
 * will retry for N more hours" — before either delivering or giving up with a
 * final "(Failure)" report. Matched only as a delay when a failed recipient
 * was also readable, so it can be distinguished from the report that follows
 * it rather than acted on early: the address may still go through.
 */
const DELAY_SUBJECT = /\(delay\)/i;

function localPart(email: string): string {
  return email.slice(0, email.lastIndexOf("@")).toLowerCase();
}

/** True when a message looks like a delivery report rather than a reply. */
export function looksLikeBounceNotification(msg: Pick<InboundMessage, "fromEmail" | "subject">): boolean {
  const from = msg.fromEmail?.toLowerCase() ?? "";
  if (!from) return false;
  if (BOUNCE_LOCAL_PARTS.has(localPart(from))) return true;
  const subject = msg.subject ?? "";
  return BOUNCE_SUBJECTS.some((pattern) => pattern.test(subject));
}

/**
 * Smartlead inserts the workspace's custom warm-up identifier into generated
 * warm-up copy. The marker is the positive signal; being an unknown sender is
 * not, because legitimate first-time emails must remain visible in Master Inbox.
 * All historical warm-up messages in this workspace contain this identifier.
 */
const SMARTLEAD_WARMUP_IDENTIFIERS = ["takes-backs"] as const;

export function isSmartleadWarmupMessage(msg: Pick<InboundMessage, "subject" | "bodyText">): boolean {
  const content = `${msg.subject ?? ""}\n${msg.bodyText ?? ""}`.toLowerCase();
  return SMARTLEAD_WARMUP_IDENTIFIERS.some((identifier) => content.includes(identifier));
}

/**
 * Extracts the failed recipient from a delivery report body.
 *
 * Each mail system words this differently and only one form appears in any
 * given report, so all of them are tried:
 *  - Gmail (verified against a real failure, 2026-08-05):
 *    "Your message wasn't delivered to foo@bar.com because..."
 *  - Gmail's other phrasing (verified against a Google Workspace mailbox's
 *    backlog, 2026-09-16 — the "wasn't delivered to" form above never
 *    matched these, which is why 161 reports piled up unparsed): both the
 *    "(Delay)" retry notice and the final "(Failure)" one read "There was a
 *    temporary/permanent problem delivering your message to foo@bar.com.",
 *    and a policy block reads "Your message to foo@bar.com has been
 *    blocked."
 *  - Microsoft 365: "Your message to foo@bar.com couldn't be delivered",
 *    with "Recipient Address: foo@bar.com" repeated under Original Message
 *    Details — note "Sender Address:" sits directly above it, so the label is
 *    matched exactly rather than by proximity.
 *  - Gmail's older list template (a live example from a "mailbox is full"
 *    report, 2026-09-16): "The following address(es) failed:" followed by
 *    the address alone on the next line, then the reason indented under it.
 *  - GoDaddy/secureserver.net (verified 2026-09-16, a GoDaddy-hosted mailbox's
 *    backlog): "Delivery to the following recipients failed permanently:"
 *    followed by "   * foo@bar.com" on its own line.
 *  - RFC 3464 machine-readable part: "Final-Recipient: rfc822; foo@bar.com".
 */
export function parseBouncedRecipient(bodyText: string | null): string | null {
  if (!bodyText) return null;
  const patterns = [
    /wasn't delivered to\s+([^\s]+@[^\s]+?)(?:\s+because|\s*$)/i,
    /delivering your message to\s+([^\s]+@[^\s]+?)\.\s/i,
    /Your message to\s+([^\s]+@[^\s]+?)\s+(?:couldn't be delivered|has been blocked)/i,
    /^\s*Recipient Address:\s*([^\s]+@[^\s]+)/im,
    /address\(es\) failed:\s*\n+\s*([^\s]+@[^\s]+)/i,
    /recipients failed permanently:\s*\n+\s*\*?\s*([^\s]+@[^\s]+)/i,
    /Final-Recipient:\s*rfc822;\s*([^\s]+@[^\s]+)/i,
  ];
  for (const pattern of patterns) {
    const match = bodyText.match(pattern);
    if (match) {
      const address = match[1].trim().toLowerCase().replace(/^[<]+|[>.,;]+$/g, "");
      if (address.includes("@")) return address;
    }
  }
  return null;
}

/**
 * Handles a Gmail bounce notification: marks the failed recipient's
 * outreach_leads row as bounced (halting its sequence) and suppresses the
 * address so no future campaign emails it again. Does not create a
 * inbox contact for mailer-daemon itself — a bounce is not a reply.
 */
export async function handleBounce(
  mailboxAddress: string,
  msg: InboundMessage,
  log: StepLogger,
  suppress: typeof suppressEmailOutreach,
) {
  const failedEmail = parseBouncedRecipient(msg.bodyText);
  if (!failedEmail) {
    // Falls through to normal storage rather than being dropped: an
    // unreadable report is still something a human may want to see.
    log.warn("Delivery report received but couldn't parse the failed recipient — keeping the message");
    return null;
  }
  if (failedEmail === mailboxAddress.toLowerCase()) {
    log.warn(`Delivery report names the sending mailbox ${mailboxAddress} as the failure — not suppressing`);
    return null;
  }
  // A delivery report never comes from the address that failed. When it does,
  // this is a person forwarding one on ("your mail to me bounced"), and their
  // own message must not suppress them.
  if (failedEmail === msg.fromEmail?.toLowerCase()) {
    log.warn(`${failedEmail} sent a message naming itself as the failed recipient — treating it as a reply`);
    return null;
  }

  if (DELAY_SUBJECT.test(msg.subject ?? "")) {
    log.info(`Delivery to ${failedEmail} is still retrying (mailbox ${mailboxAddress}) — not suppressing yet`);
    return { leadId: null, skipped: true as const };
  }

  log.info(`Bounce detected for ${failedEmail} (mailbox ${mailboxAddress})`);

  await suppress(failedEmail, "bounced", `Bounced from ${mailboxAddress}`, "bounced");
  log.info(`${failedEmail} marked bounced and added to suppression list`);

  return { leadId: null, skipped: false as const };
}

function splitName(name: string | null): { first: string | null; last: string | null } {
  if (!name) return { first: null, last: null };
  const parts = name.trim().split(/\s+/);
  return { first: parts[0] ?? null, last: parts.slice(1).join(" ") || null };
}

function domainFromEmail(email: string): string | null {
  const at = email.lastIndexOf("@");
  return at === -1 ? null : email.slice(at + 1).toLowerCase();
}

type MasterInboxStoreResult = { leadId: string; created: boolean };

/** Whose Master Inbox contact a message is filed under, when not its sender. */
type MasterInboxContact = { email: string; firstName?: string | null; lastName?: string | null };

/** The CRM conversation a Gmail thread already belongs to. */
type ThreadConversation = { personId: string; providerContactId: string | null; personEmail: string | null };

/**
 * Master Inbox intentionally has a storage boundary separate from People CRM,
 * so unknown senders remain visible without creating CRM work. `contact`
 * files the message under another address (a colleague replying on a lead's
 * thread) while the message keeps its real `fromEmail`.
 */
async function storeGmailMessageInMasterInbox(
  mailboxAddress: string,
  msg: InboundMessage & { fromEmail: string },
  bodyText: string | null,
  durableMessageKey: string,
  contact?: MasterInboxContact,
): Promise<MasterInboxStoreResult> {
  const { first, last } = contact
    ? { first: contact.firstName ?? null, last: contact.lastName ?? null }
    : splitName(msg.fromName);
  const contactEmail = contact?.email ?? msg.fromEmail;
  const repliedAt = msg.internalDate ?? new Date();
  return db.transaction(async (tx) => {
    const [lead] = await tx
      .insert(inboxContacts)
      .values({
        organizationId: currentOrganizationId(),
        email: contactEmail,
        firstName: first,
        lastName: last,
        domain: domainFromEmail(contactEmail),
        mailbox: mailboxAddress,
        lastReplyAt: repliedAt,
      })
      .onConflictDoUpdate({
        target: [inboxContacts.organizationId, inboxContacts.email],
        set: {
          ...(first ? { firstName: first } : {}),
          ...(last ? { lastName: last } : {}),
          mailbox: mailboxAddress,
          lastReplyAt: repliedAt,
          updatedAt: new Date(),
        },
      })
      .returning({ id: inboxContacts.id });
    if (!lead) throw new Error("Master Inbox contact upsert did not return a row");

    if (msg.messageId?.trim()) {
      const [existing] = await tx
        .select({ id: inboxMessages.id, contactId: inboxMessages.contactId })
        .from(inboxMessages)
        .innerJoin(inboxContacts, eq(inboxContacts.id, inboxMessages.contactId))
        .where(
          and(
            inOrg(inboxContacts),
            sql`${inboxMessages.raw}->>'messageId' = ${msg.messageId.trim()}`,
          ),
        )
        .limit(1);
      if (existing) {
        return { leadId: existing.contactId, created: false };
      }
    }

    const [message] = await tx
      .insert(inboxMessages)
      .values({
        contactId: lead.id,
        direction: "inbound",
        providerMessageKey: durableMessageKey,
        subject: msg.subject,
        bodyText,
        fromEmail: msg.fromEmail,
        toEmail: msg.toEmail || mailboxAddress,
        sentAt: repliedAt,
        raw: msg as unknown as object,
      })
      .onConflictDoNothing()
      .returning({ id: inboxMessages.id });
    return { leadId: lead.id, created: Boolean(message) };
  });
}

async function findThreadConversationInDb(mailboxAddress: string, threadId: string): Promise<ThreadConversation | null> {
  const [row] = await db
    .select({
      personId: crmConversations.personId,
      providerContactId: crmConversations.providerContactId,
      personEmail: people.email,
    })
    .from(crmConversations)
    .leftJoin(people, and(eq(people.id, crmConversations.personId), inOrg(people)))
    .where(and(
      inOrg(crmConversations),
      eq(crmConversations.channel, "email"),
      eq(crmConversations.accountRef, mailboxAddress),
      eq(crmConversations.providerThreadId, threadId),
    ))
    .limit(1);
  return row ?? null;
}

/**
 * A sender who is not an outreach recipient wrote on a thread that already
 * belongs to a lead (a manager looped in, a reply-all). The message joins that
 * lead's conversation and Master Inbox contact; no Person is created for the
 * colleague.
 */
async function attachToThreadConversation(
  mailboxAddress: string,
  msg: InboundMessage & { fromEmail: string },
  bodyText: string | null,
  durableMessageKey: string,
  conversation: ThreadConversation,
  log: StepLogger,
  storeInMasterInbox: typeof storeGmailMessageInMasterInbox = storeGmailMessageInMasterInbox,
  ingest: typeof ingestCrmInboundReply = ingestCrmInboundReply,
) {
  const leadEmail = conversation.personEmail ?? conversation.providerContactId;
  if (!leadEmail) throw new Error("CRM conversation has no lead email to file the reply under");
  const inbox = await storeInMasterInbox(mailboxAddress, msg, bodyText, durableMessageKey, { email: leadEmail });
  log.info(inbox.created ? "Message stored in Master Inbox" : "Message already exists in Master Inbox");
  if (!inbox.created) {
    log.info(`Message ${msg.messageId ?? msg.gmailMessageId} is already stored in Master Inbox — skipping thread conversation attach`);
    return { leadId: conversation.personId, skipped: true as const };
  }
  if (!bodyText?.trim()) throw new Error("CRM cannot ingest an empty Gmail reply");
  const result = await ingest({
    personId: conversation.personId,
    channel: "email",
    accountRef: mailboxAddress,
    providerThreadId: msg.threadId,
    providerContactId: conversation.providerContactId,
    idempotencyKey: durableMessageKey,
    providerMessageId: msg.messageId ?? msg.gmailMessageId,
    subject: msg.subject,
    bodyText,
    raw: msg as unknown as Record<string, unknown>,
    sentAt: msg.internalDate ?? new Date(),
    actorRef: "gmail",
  });
  log.info(`${msg.fromEmail} replied on ${leadEmail}'s thread — attached to that conversation`);
  log.info(result.duplicate ? "CRM already stored this Gmail reply" : "Gmail reply routed to CRM");
  return { leadId: result.record.id, skipped: result.duplicate };
}

/**
 * Stores one inbound Gmail message in Master Inbox. Known outreach recipients
 * are also routed into the canonical People CRM workflow; unknown senders stay
 * inbox-only and do not create CRM records.
 */
export async function ingestGmailReply(
  mailboxAddress: string,
  msg: InboundMessage,
  log: StepLogger,
  options: {
    isKnownOutreachRecipient?: (email: string) => Promise<boolean>;
    isOtherOrgMailbox?: (email: string) => Promise<boolean>;
    storeInMasterInbox?: typeof storeGmailMessageInMasterInbox;
    suppress?: typeof suppressEmailOutreach;
    findThreadConversation?: (mailboxAddress: string, threadId: string) => Promise<ThreadConversation | null>;
    ingestCrm?: typeof ingestCrmInboundReply;
  } = {},
) {
  if (!msg.fromEmail) {
    log.warn("Message has no resolvable From address — skipping");
    return { leadId: null, skipped: true as const };
  }
  if (looksLikeBounceNotification(msg)) {
    const handled = await handleBounce(mailboxAddress, msg, log, options.suppress ?? suppressEmailOutreach);
    if (handled) return handled;
  }
  // Skip messages we sent ourselves (shouldn't normally show up under
  // INBOX/messageAdded, but the From-is-us case is cheap to guard anyway).
  if (msg.fromEmail === mailboxAddress.toLowerCase()) {
    log.info("Message is from this mailbox itself — skipping");
    return { leadId: null, skipped: true as const };
  }

  // If the message is explicitly addressed to another active mailbox in the same
  // organization (e.g. multi-domain aliases or forwards on the same IMAP account),
  // skip it here so the targeted mailbox handles it natively without duplicating.
  const targetEmail = (msg.toEmail ?? "").trim().toLowerCase();
  const mailboxLower = mailboxAddress.trim().toLowerCase();
  if (targetEmail && targetEmail !== mailboxLower) {
    const isOtherMailbox = options.isOtherOrgMailbox ?? (async (email: string) => {
      const [other] = await db
        .select({ id: mailboxes.id })
        .from(mailboxes)
        .where(and(inOrg(mailboxes), eq(mailboxes.emailAddress, email), eq(mailboxes.status, "connected")))
        .limit(1);
      return Boolean(other);
    });
    if (await isOtherMailbox(targetEmail)) {
      log.info(`Message recipient ${targetEmail} belongs to another configured mailbox in this org — skipping sync under ${mailboxAddress}`);
      return { leadId: null, skipped: true as const };
    }
  }

  // Gmail's INBOX also receives Smartlead warm-up-pool exchanges. Ignore only
  // the provider's positive custom identifier; an unknown sender alone is not
  // warm-up evidence and still belongs in Master Inbox.
  if (isSmartleadWarmupMessage(msg)) {
    log.info("Smartlead warm-up identifier detected — ignoring message");
    return { leadId: null, skipped: true as const };
  }

  const bodyText = msg.bodyText && looksLikeHtml(msg.bodyText) ? htmlToPlainText(msg.bodyText) : msg.bodyText;
  const durableMessageKey = gmailInboundEventKey(mailboxAddress, msg.gmailMessageId);
  const isKnownOutreachRecipient = options.isKnownOutreachRecipient ?? (async (email: string) => {
    const [recipient] = await db
      .select({ id: outreachLeads.id })
      .from(outreachLeads)
      .innerJoin(people, eq(outreachLeads.personId, people.id))
      .where(and(leadsInOrg(), inOrg(people), eq(people.email, email)))
      .limit(1);
    return Boolean(recipient);
  });
  const knownOutreachRecipient = await isKnownOutreachRecipient(msg.fromEmail);

  // The thread decides whose conversation this is, not the sender: a manager
  // looped in, a reply-all, or another emailed lead at the same company all
  // belong on the lead's existing thread. (A second lead's own conversation
  // would also collide with this thread id and be refused by the CRM.)
  if (msg.threadId) {
    const conversation = await (options.findThreadConversation ?? findThreadConversationInDb)(mailboxAddress, msg.threadId);
    if (conversation && conversation.personEmail?.toLowerCase() !== msg.fromEmail.toLowerCase()) {
      return attachToThreadConversation(
        mailboxAddress,
        msg as InboundMessage & { fromEmail: string },
        bodyText,
        durableMessageKey,
        conversation,
        log,
        options.storeInMasterInbox,
        options.ingestCrm,
      );
    }
  }

  if (!knownOutreachRecipient) {
    const inbox = await (options.storeInMasterInbox ?? storeGmailMessageInMasterInbox)(
      mailboxAddress,
      msg as InboundMessage & { fromEmail: string },
      bodyText,
      durableMessageKey,
    );
    log.info(inbox.created ? "Message stored in Master Inbox" : "Message already exists in Master Inbox");
    log.info(`${msg.fromEmail} is not an outreach recipient — kept in Master Inbox without creating CRM work`);
    return { leadId: inbox.leadId, skipped: !inbox.created };
  }

  const email = msg.fromEmail;
  const { first, last } = splitName(msg.fromName);
  const repliedAt = msg.internalDate ?? new Date();

  const inbox = await (options.storeInMasterInbox ?? storeGmailMessageInMasterInbox)(
    mailboxAddress,
    msg as InboundMessage & { fromEmail: string },
    bodyText,
    durableMessageKey,
  );
  log.info(inbox.created ? "Message stored in Master Inbox" : "Message already exists in Master Inbox");
  if (!inbox.created) {
    log.info(`Message ${msg.messageId ?? msg.gmailMessageId} is already stored in Master Inbox — skipping duplicate CRM work`);
    return { leadId: inbox.leadId, skipped: true as const };
  }

  const [resolvedPerson] = await db
    .select({ id: people.id })
    .from(people)
    .where(and(inOrg(people), eq(people.email, email)))
    .limit(1);
  if (!resolvedPerson) {
    await quarantineCrmIdentity({
      channel: "email",
      accountRef: mailboxAddress,
      sourceEventKey: durableMessageKey,
      identityValue: email,
      reason: "Inbound email has no canonical Person/outreach identity",
      payload: msg as unknown as Record<string, unknown>,
    });
    log.warn(`${email} has no canonical Person/outreach identity — quarantined for review`);
    return { leadId: null, skipped: true as const };
  }
  if (!bodyText?.trim()) throw new Error("CRM cannot ingest an empty Gmail reply");
  const person = await withLeadTransaction((tx) => upsertPerson(tx, {
    email,
    firstName: first,
    lastName: last,
    fullName: msg.fromName,
    source: "crm:gmail-inbound",
  }));
  const result = await ingestCrmInboundReply({
    personId: person.id,
    channel: "email",
    accountRef: mailboxAddress,
    providerThreadId: msg.threadId,
    providerContactId: email,
    idempotencyKey: durableMessageKey,
    providerMessageId: msg.messageId ?? msg.gmailMessageId,
    subject: msg.subject,
    bodyText,
    raw: msg as unknown as Record<string, unknown>,
    sentAt: repliedAt,
    actorRef: "gmail",
  });
  log.info(result.duplicate ? "CRM already stored this Gmail reply" : "Gmail reply routed to CRM");
  return { leadId: result.record.id, skipped: result.duplicate };
}
