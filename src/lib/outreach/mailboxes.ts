import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { mailboxes } from "./schema";
import { testMailboxConnection } from "./gmail";
import { channelRules } from "@/lib/channels/rules.server";
import { mailboxHoursFromWeekly } from "./workingHours";
import { currentOrganizationId, inOrg, runInOrganization } from "@/lib/tenancy/scope";
import {
  deleteMailboxSmtpCredentials,
  ensureImapIdleWatcher,
  resolveMailboxSmtpConfig,
  saveMailboxSmtpCredentials,
  stopImapIdleWatcher,
} from "./smtpImap";
import { syncMailboxInbox } from "./gmailSync";

export async function listMailboxes() {
  return db.select().from(mailboxes).where(inOrg(mailboxes)).orderBy(mailboxes.createdAt);
}

export async function getMailbox(id: string) {
  const [row] = await db.select().from(mailboxes).where(and(inOrg(mailboxes), eq(mailboxes.id, id))).limit(1);
  return row ?? null;
}

export type ConnectMailboxResult =
  | { ok: true; mailboxId: string; status: "connected" }
  | { ok: false; error: string };

/**
 * Adds (or re-tests) a mailbox: stores the row, verifies either SMTP/IMAP
 * credentials or Google Workspace delegation, then records the outcome.
 */
export async function connectMailbox(input: {
  emailAddress: string;
  displayName?: string | null;
  /** Undefined leaves any existing signature untouched (e.g. on a retest); pass "" to explicitly clear it. */
  signatureHtml?: string | null;
  /** Optional per-mailbox SMTP/IMAP password (or client-specific password). */
  password?: string | null;
  smtpHost?: string | null;
  smtpPort?: string | number | null;
  imapHost?: string | null;
  imapPort?: string | number | null;
}): Promise<ConnectMailboxResult> {
  const emailAddress = input.emailAddress.trim().toLowerCase();
  if (!emailAddress || !emailAddress.includes("@")) {
    return { ok: false, error: `invalid email: "${input.emailAddress}"` };
  }

  if (
    input.password ||
    input.smtpHost ||
    input.smtpPort !== undefined ||
    input.imapHost ||
    input.imapPort !== undefined
  ) {
    await saveMailboxSmtpCredentials({
      emailAddress,
      password: input.password ?? undefined,
      smtpHost: input.smtpHost ?? undefined,
      smtpPort: input.smtpPort ?? undefined,
      imapHost: input.imapHost ?? undefined,
      imapPort: input.imapPort ?? undefined,
    });
  }

  const [existing] = await db
    .select()
    .from(mailboxes)
    .where(and(inOrg(mailboxes), eq(mailboxes.emailAddress, emailAddress)))
    .limit(1);
  if (!existing) {
    // A Gmail mailbox belongs to exactly one organization (email_address is
    // globally unique), so one already connected elsewhere cannot be added.
    const [elsewhere] = await db
      .select({ id: mailboxes.id })
      .from(mailboxes)
      .where(eq(mailboxes.emailAddress, emailAddress))
      .limit(1);
    if (elsewhere) return { ok: false, error: `${emailAddress} is already connected to another organization` };
  }

  // A new mailbox starts from the organization's sending rules; after that its
  // own limit and hours are edited per mailbox.
  const rules = existing ? null : await channelRules("email");
  const mailboxId =
    existing?.id ??
    (
      await db
        .insert(mailboxes)
        .values({
          organizationId: currentOrganizationId(),
          emailAddress,
          displayName: input.displayName?.trim() || null,
          signatureHtml: input.signatureHtml?.trim() || null,
          status: "connecting",
          dailySendLimit: rules!.dailySendLimit,
          workingHours: mailboxHoursFromWeekly(rules!.sendingHours),
        })
        .returning({ id: mailboxes.id })
    )[0].id;

  const test = await testMailboxConnection(emailAddress);

  if (test.ok) {
    const nextHistoryId = existing?.lastHistoryId && existing.lastHistoryId !== "0"
      ? existing.lastHistoryId
      : test.historyId;
    await db
      .update(mailboxes)
      .set({
        status: "connected",
        lastError: null,
        lastTestedAt: new Date(),
        lastHistoryId: nextHistoryId,
        displayName: input.displayName?.trim() || existing?.displayName || null,
        ...(input.signatureHtml !== undefined ? { signatureHtml: input.signatureHtml?.trim() || null } : {}),
        updatedAt: new Date(),
      })
      .where(and(inOrg(mailboxes), eq(mailboxes.id, mailboxId)));

    const orgId = currentOrganizationId();
    const smtpConfig = await resolveMailboxSmtpConfig(emailAddress);
    if (smtpConfig) {
      ensureImapIdleWatcher({
        organizationId: orgId,
        mailboxId,
        config: smtpConfig,
        onNewMail: async (oId, mId) => {
          await runInOrganization(oId, () => syncMailboxInbox(mId));
        },
      });
    }

    return { ok: true, mailboxId, status: "connected" };
  }

  await db
    .update(mailboxes)
    .set({ status: "failed", lastError: test.error, lastTestedAt: new Date(), updatedAt: new Date() })
    .where(and(inOrg(mailboxes), eq(mailboxes.id, mailboxId)));
  return { ok: false, error: test.error };
}

/** Re-runs the connection test for an already-added mailbox. Leaves its signature untouched. */
export async function retestMailbox(id: string): Promise<ConnectMailboxResult> {
  const mailbox = await getMailbox(id);
  if (!mailbox) return { ok: false, error: "mailbox not found" };
  return connectMailbox({ emailAddress: mailbox.emailAddress, displayName: mailbox.displayName });
}

export async function deleteMailbox(id: string) {
  const mailbox = await getMailbox(id);
  stopImapIdleWatcher(currentOrganizationId(), id);
  if (mailbox) {
    await deleteMailboxSmtpCredentials(mailbox.emailAddress);
  }
  await db.delete(mailboxes).where(and(inOrg(mailboxes), eq(mailboxes.id, id)));
}
