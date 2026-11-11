/**
 * Syncs one mailbox's new inbound mail and feeds each message through the
 * reply bridge. Called either from the Pub/Sub push webhook (real-time,
 * pushHistoryId supplied) or as a periodic catch-up sweep.
 */
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { mailboxes } from "./schema";
import { inboundEvents } from "@/lib/inbox/schema";
import { fetchNewInboundMessages, isStaleHistoryCursorError, testMailboxConnection } from "./gmail";
import { isPlatformConnected } from "@/lib/platform/credentials";
import { ingestGmailReply } from "./replyBridge";
import { createStepLogger } from "@/lib/debugLog";
import { currentOrganizationId, inOrg, runInOrganization } from "@/lib/tenancy/scope";
import { ensureImapIdleWatcher, resolveMailboxSmtpConfig } from "./smtpImap";

const activeMailboxSyncs = new Set<string>();

type SyncMailboxOptions = {
  fetch?: typeof fetchNewInboundMessages;
  ingest?: typeof ingestGmailReply;
  testConnection?: typeof testMailboxConnection;
};

/**
 * Runs inside the mailbox's organization scope — the Pub/Sub webhook resolves
 * the mailbox to its organization and opens the scope before calling this.
 * A mailbox of another organization is simply not found.
 */
export async function syncMailboxInbox(mailboxId: string, options: SyncMailboxOptions = {}) {
  if (!options.fetch && !(await isPlatformConnected("google"))) {
    console.log("[outreach/gmailSync] Email integration is not connected; inbox sync skipped");
    return { synced: 0, fetched: 0 };
  }
  if (activeMailboxSyncs.has(mailboxId)) {
    return { synced: 0, fetched: 0 };
  }
  activeMailboxSyncs.add(mailboxId);
  try {
    return await syncMailboxInboxInner(mailboxId, options);
  } finally {
    activeMailboxSyncs.delete(mailboxId);
  }
}

async function syncMailboxInboxInner(mailboxId: string, options: SyncMailboxOptions = {}) {
  const [mailbox] = await db.select().from(mailboxes).where(and(inOrg(mailboxes), eq(mailboxes.id, mailboxId))).limit(1);
  if (!mailbox || mailbox.status !== "connected") return { synced: 0, fetched: 0 };
  const smtpConfig = !options.fetch ? await resolveMailboxSmtpConfig(mailbox.emailAddress) : null;
  const cursor = mailbox.lastHistoryId || (smtpConfig ? "0" : null);
  if (!cursor) return { synced: 0, fetched: 0 }; // nothing to diff against yet

  let syncResult;
  try {
    syncResult = await (options.fetch ?? fetchNewInboundMessages)(mailbox.emailAddress, cursor);
  } catch (err) {
    // A stale cursor (Gmail's history retention window passed, or the
    // stored id predates it) means every future push would fail identically
    // forever unless we re-bootstrap — jump the cursor to "now" so future
    // pushes resume working. This does mean any mail that arrived between
    // the last successful sync and now is missed; there's no way to recover
    // that once the cursor itself is gone (Gmail's own limitation).
    if (isStaleHistoryCursorError(err)) {
      const test = await (options.testConnection ?? testMailboxConnection)(mailbox.emailAddress);
      await db
        .update(mailboxes)
        .set({
          lastHistoryId: test.ok ? test.historyId : mailbox.lastHistoryId,
          lastError: "history cursor expired — re-bootstrapped to current inbox state; messages received during the gap were not synced",
        })
        .where(and(inOrg(mailboxes), eq(mailboxes.id, mailboxId)));
      return { synced: 0, error: "stale_cursor_rebootstrapped" };
    }

    const message = err instanceof Error ? err.message : String(err);
    await db.update(mailboxes).set({ lastError: `sync failed: ${message}` }).where(and(inOrg(mailboxes), eq(mailboxes.id, mailboxId)));
    throw err;
  }

  const { messages, newHistoryId } = syncResult;

  let synced = 0;
  const failures: string[] = [];
  for (const msg of messages) {
    const log = createStepLogger();
    log.info(`Gmail inbound message ${msg.gmailMessageId} — processing`);
    try {
      const result = await (options.ingest ?? ingestGmailReply)(mailbox.emailAddress, msg, log);
      log.finish(result.skipped ? "skipped" : "ok");
      await db.insert(inboundEvents).values({
        organizationId: currentOrganizationId(),
        source: "gmail",
        eventType: "inbound_message",
        title: msg.fromName || msg.fromEmail || null,
        status: log.status,
        steps: log.steps,
        payload: msg as unknown as object,
        processed: true,
      });
      if (!result.skipped) synced += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(message);
      log.finish("error");
      await db.insert(inboundEvents).values({
        organizationId: currentOrganizationId(),
        source: "gmail",
        eventType: "inbound_message",
        title: msg.fromName || msg.fromEmail || null,
        status: log.status,
        steps: log.steps,
        payload: msg as unknown as object,
        processed: false,
        error: message,
      });
      failures.push(`${msg.gmailMessageId}: ${message}`);
    }
  }

  if (failures.length > 0) {
    const message = `sync incomplete; ${failures.length} message(s) require retry: ${failures.join("; ")}`;
    await db.update(mailboxes).set({ lastError: message }).where(and(inOrg(mailboxes), eq(mailboxes.id, mailboxId)));
    throw new Error(message);
  }

  if (newHistoryId && newHistoryId !== mailbox.lastHistoryId) {
    await db.update(mailboxes).set({ lastHistoryId: newHistoryId, lastError: null }).where(and(inOrg(mailboxes), eq(mailboxes.id, mailboxId)));
  }

  return { synced, fetched: messages.length };
}

/**
 * Ensures real-time IMAP IDLE listeners are active and performs a 60-second
 * incremental UID catch-up sync across all connected SMTP/IMAP mailboxes.
 */
export async function syncAllImapMailboxes(): Promise<{ checked: number; synced: number }> {
  const connectedRows = await db
    .select({
      id: mailboxes.id,
      organizationId: mailboxes.organizationId,
      emailAddress: mailboxes.emailAddress,
    })
    .from(mailboxes)
    .where(eq(mailboxes.status, "connected"));

  let checked = 0;
  let totalSynced = 0;

  for (const row of connectedRows) {
    try {
      await runInOrganization(row.organizationId, async () => {
        const smtpConfig = await resolveMailboxSmtpConfig(row.emailAddress);
        if (!smtpConfig) return;
        checked += 1;

        ensureImapIdleWatcher({
          organizationId: row.organizationId,
          mailboxId: row.id,
          config: smtpConfig,
          onNewMail: async (orgId, mId) => {
            await runInOrganization(orgId, () => syncMailboxInbox(mId));
          },
        });

        const res = await syncMailboxInbox(row.id);
        totalSynced += res.synced;
      });
    } catch (err) {
      console.error(`[outreach/gmailSync] IMAP sync error for ${row.emailAddress}:`, err);
    }
  }

  return { checked, synced: totalSynced };
}
