/**
 * Gmail send/sync via our service account's domain-wide delegation — same
 * mechanism as AgentSDR-app's src/server/email/send-mails.ts: the service
 * account impersonates a mailbox (the `subject` claim) that a Workspace
 * admin has already authorized for our client ID, so no per-mailbox OAuth
 * consent or password is needed.
 */
import { google } from "googleapis";
import MailComposer from "nodemailer/lib/mail-composer";
import { encode } from "js-base64";
import { requirePlatformCredentials } from "@/lib/platform/credentials";
import { googleServiceAccount } from "@/lib/platform/clients";
import type { EmailAddress } from "@/lib/email/recipients";
import { parseAddressHeader } from "./addressHeader";
import {
  fetchImapMessageRecipients,
  fetchNewImapInboundMessages,
  resolveMailboxSmtpConfig,
  sendSmtpEmail,
  shouldUseSmtpImap,
  testSmtpImapMailbox,
} from "./smtpImap";

async function jwtFor(subject: string, scopes: string[]) {
  const key = googleServiceAccount(await requirePlatformCredentials("google"));
  return new google.auth.JWT({
    email: key.client_email,
    key: key.private_key,
    scopes,
    subject,
  });
}

export type MailboxConnectionTest =
  | { ok: true; profileEmail: string; historyId: string | null }
  | { ok: false; error: string };

/**
 * Verifies the service account can impersonate this mailbox by fetching its
 * Gmail profile — the cheapest read-only call that proves delegation is
 * actually authorized for this address, without sending anything.
 */
export async function testMailboxConnection(emailAddress: string): Promise<MailboxConnectionTest> {
  try {
    const smtpConfig = await resolveMailboxSmtpConfig(emailAddress);
    if (smtpConfig) {
      return await testSmtpImapMailbox(smtpConfig);
    }
    if (await shouldUseSmtpImap(emailAddress)) {
      return {
        ok: false,
        error: `SMTP/IMAP password is required for ${emailAddress}. Edit the mailbox or set a default password in Settings → Email → Connection.`,
      };
    }

    const auth = await jwtFor(emailAddress, ["https://www.googleapis.com/auth/gmail.readonly"]);
    const gmail = google.gmail({ version: "v1", auth });
    const profile = await gmail.users.getProfile({ userId: "me" });
    return {
      ok: true,
      profileEmail: profile.data.emailAddress ?? emailAddress,
      historyId: profile.data.historyId ?? null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

export type SendEmailResult = {
  id: string | null;
  messageId: string | null;
  threadId: string | null;
};

export type SendEmailParams = {
  from: string;
  to: string[];
  subject: string;
  text: string;
  html?: string;
  inReplyTo?: string;
  references?: string[];
  threadId?: string;
  cc?: string[];
  bcc?: string[];
  /** Sender display name. Without it Gmail shows the address's local part —
   *  "pgarg" rather than "Pulkit Garg". */
  fromName?: string | null;
  /** Opt-out URL. Adds List-Unsubscribe headers — the signal Gmail and Outlook
   *  weight when scoring spam, and what renders their native "Unsubscribe"
   *  button next to the sender name. */
  unsubscribeUrl?: string;
};

/**
 * Builds the RFC 2822 message submitted to Gmail's `raw` field.
 *
 * Gmail derives every recipient from the To, Cc, and Bcc MIME headers. Mail
 * Composer normally removes Bcc before serializing for SMTP transports (where
 * Bcc recipients live in the separate envelope), so retain it here: the Gmail
 * API has no separate envelope field. Gmail handles hiding Bcc recipients from
 * the delivered copies.
 */
export async function buildRawEmailMessage(params: SendEmailParams): Promise<Buffer> {
  const { from, to, subject, text, html, inReplyTo, references, cc, bcc, unsubscribeUrl, fromName } = params;

  const mail = new MailComposer({
    // RFC 5322 display name. Quoted and with embedded quotes/backslashes
    // escaped, so a name containing a comma or quote can't break the header.
    from: fromName ? `"${fromName.replace(/["\\]/g, "\\$&")}" <${from}>` : from,
    to,
    cc,
    bcc,
    subject,
    text,
    html: html ?? text,
    headers: {
      ...(inReplyTo ? { "In-Reply-To": inReplyTo } : {}),
      ...(references && references.length ? { References: references.join(" ") } : {}),
      ...(unsubscribeUrl
        ? {
            "List-Unsubscribe": `<${unsubscribeUrl}>`,
            // RFC 8058 one-click. Requires the endpoint to accept POST.
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
          }
        : {}),
    },
  });

  const message = mail.compile();
  // MailComposer defaults to SMTP's behaviour of stripping Bcc from the
  // serialized message. Gmail's raw-message API instead uses that header to
  // identify Bcc recipients, so it must be retained until Gmail accepts it.
  message.keepBcc = true;

  return new Promise<Buffer>((resolve, reject) =>
    message.build((err, raw) => (err ? reject(err) : resolve(raw))),
  );
}

/**
 * Sends one email as `from`, returning Gmail's id/threadId and the RFC822
 * Message-Id (for threading later sends).
 *
 * `threadId` (if passed) is Gmail's own thread grouping — pass the prior
 * message's threadId when you want this send to land in the same Gmail
 * conversation. In-Reply-To/References headers alone are NOT reliable for
 * this on programmatic sends: verified live (2026-08-05) that Gmail can
 * assign a fresh threadId to a message with fully correct In-Reply-To/
 * References headers if it wasn't sent as part of a genuine two-party
 * reply exchange. Gmail's users.messages.send requestBody.threadId is the
 * documented, reliable way to force same-thread grouping for API sends.
 */
export async function sendEmail(params: SendEmailParams): Promise<SendEmailResult> {
  const { from, threadId } = params;

  const smtpConfig = await resolveMailboxSmtpConfig(from);
  if (smtpConfig) {
    return await sendSmtpEmail(smtpConfig, params);
  }
  if (await shouldUseSmtpImap(from)) {
    throw new Error(
      `SMTP password is not configured for ${from}. Add the mailbox password in Settings → Email → Accounts.`,
    );
  }

  const auth = await jwtFor(from, ["https://www.googleapis.com/auth/gmail.send"]);
  const gmail = google.gmail({ version: "v1", auth });

  const mimeMessage = await buildRawEmailMessage(params);

  const encoded = encode(mimeMessage.toString()).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  const res = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw: encoded, ...(threadId ? { threadId } : {}) },
  });

  // Gmail doesn't return the RFC822 Message-Id header on send; fetch it
  // right after so later replies in this thread can set In-Reply-To/References.
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const authReader = await jwtFor(from, ["https://www.googleapis.com/auth/gmail.readonly"]);
  const gmailReader = google.gmail({ version: "v1", auth: authReader });
  let messageId: string | null = null;
  try {
    const meta = await gmailReader.users.messages.get({
      userId: "me",
      id: res.data.id ?? "",
      format: "metadata",
      metadataHeaders: ["Message-Id"],
    });
    messageId = meta.data.payload?.headers?.find((h) => h.name === "Message-Id")?.value ?? null;
  } catch (err) {
    console.error("[outreach/gmail] failed to fetch Message-Id after send:", err);
  }

  return { id: res.data.id ?? null, messageId, threadId: res.data.threadId ?? null };
}

export type WatchResult = { ok: true; expiration: string | null; historyId: string | null } | { ok: false; error: string };

/**
 * Registers (or renews) Gmail Pub/Sub push notifications for this mailbox.
 * Expires after ~7 days per Gmail's own limit — call again periodically
 * (see /api/outreach/mailboxes/watch) to keep it alive.
 */
export async function registerWatch(emailAddress: string, topicName: string): Promise<WatchResult> {
  try {
    const smtpConfig = await resolveMailboxSmtpConfig(emailAddress);
    if (smtpConfig || (await shouldUseSmtpImap(emailAddress))) {
      // SMTP/IMAP mailboxes use IMAP IDLE + UID polling rather than Gmail Pub/Sub watch.
      return {
        ok: true,
        expiration: String(Date.now() + 7 * 24 * 60 * 60 * 1000),
        historyId: null,
      };
    }

    const auth = await jwtFor(emailAddress, ["https://www.googleapis.com/auth/gmail.readonly"]);
    const gmail = google.gmail({ version: "v1", auth });
    const res = await gmail.users.watch({
      userId: "me",
      requestBody: { topicName, labelIds: ["INBOX"] },
    });
    return { ok: true, expiration: res.data.expiration ?? null, historyId: res.data.historyId ?? null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

export type InboundMessage = {
  gmailMessageId: string;
  threadId: string | null;
  fromEmail: string | null;
  fromName: string | null;
  /** First To address; kept for rows and readers that predate `to`. */
  toEmail: string | null;
  to: EmailAddress[];
  cc: EmailAddress[];
  replyTo: EmailAddress[];
  /** Cc addresses as plain strings; kept for compatibility with `cc`. */
  ccEmails: string[];
  subject: string | null;
  bodyText: string | null;
  messageId: string | null;
  inReplyTo: string | null;
  internalDate: Date | null;
  /** True when RFC 3834 / auto-responder headers indicate a machine / OOO auto-reply. */
  isAutoReply?: boolean;
};

/** Detects RFC 3834 / standard auto-responder headers (excluding Exchange X-Auto-Response-Suppress). */
export function hasAutoReplyHeaders(header: (name: string) => string | null | undefined): boolean {
  const autoSubmitted = (header("Auto-Submitted") ?? "").trim().toLowerCase();
  if (autoSubmitted && autoSubmitted !== "no") return true;
  const xAutoreply = (header("X-Autoreply") ?? "").trim().toLowerCase();
  if (xAutoreply === "yes" || xAutoreply === "true" || xAutoreply === "1") return true;
  const xAutorespond = (header("X-Autorespond") ?? "").trim();
  if (xAutorespond) return true;
  const precedence = (header("Precedence") ?? "").trim().toLowerCase();
  if (precedence === "auto_reply" || precedence === "junk") return true;
  return false;
}

/** Best-effort plain-text body from a Gmail message payload (prefers text/plain, falls back to stripped text/html). */
function extractBodyText(payload: import("googleapis").gmail_v1.Schema$MessagePart | undefined): string | null {
  if (!payload) return null;
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return Buffer.from(payload.body.data, "base64").toString("utf-8");
  }
  if (payload.parts) {
    const plain = payload.parts.find((p) => p.mimeType === "text/plain");
    if (plain?.body?.data) return Buffer.from(plain.body.data, "base64").toString("utf-8");
    for (const part of payload.parts) {
      const nested = extractBodyText(part);
      if (nested) return nested;
    }
  }
  if (payload.mimeType === "text/html" && payload.body?.data) {
    return Buffer.from(payload.body.data, "base64").toString("utf-8");
  }
  return null;
}

/** True if a Gmail API error is a 404 from an expired/invalid history cursor (retention window passed, or the id predates the mailbox's history). */
export function isStaleHistoryCursorError(err: unknown): boolean {
  const code = (err as { code?: number | string } | null)?.code;
  const status = (err as { response?: { status?: number } } | null)?.response?.status;
  return code === 404 || code === "404" || status === 404;
}

/**
 * Fetches messages new since `startHistoryId` (Gmail History API, incremental
 * sync). Returns only messages added to INBOX (i.e. inbound mail, not our
 * own sends) along with the new history cursor to store for next time.
 * Throws on a stale cursor (see isStaleHistoryCursorError) — callers should
 * catch that and re-bootstrap from the current profile historyId.
 */
export async function fetchNewInboundMessages(
  emailAddress: string,
  startHistoryId: string,
): Promise<{ messages: InboundMessage[]; newHistoryId: string | null }> {
  const smtpConfig = await resolveMailboxSmtpConfig(emailAddress);
  if (smtpConfig) {
    return await fetchNewImapInboundMessages(smtpConfig, startHistoryId);
  }
  if (await shouldUseSmtpImap(emailAddress)) {
    throw new Error(`IMAP password is not configured for ${emailAddress}.`);
  }

  const auth = await jwtFor(emailAddress, ["https://www.googleapis.com/auth/gmail.readonly"]);
  const gmail = google.gmail({ version: "v1", auth });

  const messageIds = new Set<string>();
  let newHistoryId: string | null = startHistoryId;
  let pageToken: string | undefined;

  do {
    const res = await gmail.users.history.list({
      userId: "me",
      startHistoryId,
      historyTypes: ["messageAdded"],
      labelId: "INBOX",
      pageToken,
    });
    for (const h of res.data.history ?? []) {
      for (const added of h.messagesAdded ?? []) {
        if (added.message?.id) messageIds.add(added.message.id);
      }
    }
    if (res.data.historyId) newHistoryId = res.data.historyId;
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  const messages: InboundMessage[] = [];
  for (const id of messageIds) {
    // Fail the whole batch if even one message cannot be fetched. Returning a
    // newer history cursor with a missing message would make that loss
    // permanent; throwing keeps the old cursor available for retry.
    const msg = await gmail.users.messages.get({ userId: "me", id, format: "full" });
    const headers = msg.data.payload?.headers ?? [];
    const header = (name: string) => headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? null;
    const from = parseAddressHeader(header("From"))[0];
    const to = parseAddressHeader(header("To"));
    const cc = parseAddressHeader(header("Cc"));

    messages.push({
      gmailMessageId: id,
      threadId: msg.data.threadId ?? null,
      fromEmail: from?.email ?? null,
      fromName: from?.name ?? null,
      toEmail: to[0]?.email ?? null,
      to,
      cc,
      replyTo: parseAddressHeader(header("Reply-To")),
      ccEmails: cc.map((a) => a.email),
      subject: header("Subject"),
      bodyText: extractBodyText(msg.data.payload ?? undefined),
      messageId: header("Message-Id"),
      inReplyTo: header("In-Reply-To"),
      internalDate: msg.data.internalDate ? new Date(Number(msg.data.internalDate)) : null,
      isAutoReply: hasAutoReplyHeaders(header),
    });
  }

  return { messages, newHistoryId };
}

/**
 * Re-reads one message's To/Cc/Reply-To headers. Used to repair rows stored
 * before inbound parsing kept every recipient (it kept only the first To).
 * Returns null when the message no longer exists in the mailbox.
 */
export async function fetchMessageRecipients(
  emailAddress: string,
  gmailMessageId: string,
): Promise<{ to: EmailAddress[]; cc: EmailAddress[]; replyTo: EmailAddress[] } | null> {
  const smtpConfig = await resolveMailboxSmtpConfig(emailAddress);
  if (smtpConfig) {
    return await fetchImapMessageRecipients(smtpConfig, gmailMessageId);
  }
  if (await shouldUseSmtpImap(emailAddress)) {
    return null;
  }

  const auth = await jwtFor(emailAddress, ["https://www.googleapis.com/auth/gmail.readonly"]);
  const gmail = google.gmail({ version: "v1", auth });
  try {
    const msg = await gmail.users.messages.get({
      userId: "me",
      id: gmailMessageId,
      format: "metadata",
      metadataHeaders: ["To", "Cc", "Reply-To"],
    });
    const headers = msg.data.payload?.headers ?? [];
    const header = (name: string) => headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? null;
    return {
      to: parseAddressHeader(header("To")),
      cc: parseAddressHeader(header("Cc")),
      replyTo: parseAddressHeader(header("Reply-To")),
    };
  } catch (err) {
    if (isStaleHistoryCursorError(err)) return null; // 404: deleted or purged
    throw err;
  }
}
