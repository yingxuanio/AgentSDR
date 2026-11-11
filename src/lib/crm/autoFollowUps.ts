/**
 * Automatic CRM follow-ups.
 *
 * A sequence with "Send follow-ups automatically" on hands each follow-up
 * draft here instead of to a person (drafts.ts sets `auto_send_at`). Every
 * few minutes (scheduler job `crm-auto-follow-ups`) this sends at most one
 * per sending account — mailbox, LinkedIn account, WhatsApp number — oldest
 * first, and only when that account:
 *
 * - is connected and inside its sending hours,
 * - sent no automatic follow-up within the channel's `crmFollowUpGapMinutes`
 *   (Sending rules, default 30), and
 * - for a mailbox: is past its own send gap and under its daily limit, which
 *   campaigns share — the follow-up counts as one of the day's emails, and
 *   the campaign scheduler yields a mailbox's turn to a waiting follow-up.
 *
 * So follow-ups that fall due together (say overnight) go out spread over
 * the day instead of in one burst at 9am. Sending goes through `sendDraft`,
 * exactly as a person's Send does: threading, Do Not Contact, the WhatsApp
 * guardrails, the stale-context check (a new reply from the lead retires the
 * draft before it can go) and the delivery-uncertain handling all apply.
 *
 * Only follow-ups: the immediate reply always waits for a person. A draft
 * that cannot go within 48 hours, or whose record needs a person, is handed
 * to the Action required queue like any other draft.
 */
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, isNotNull, lte, or, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { channelRules } from "@/lib/channels/rules.server";
import { pickInRange } from "@/lib/channels/rules";
import { linkedInAccounts } from "@/lib/linkedin/schema";
import { isWithinWorkingHours as isWithinLinkedinHours, withOrganizationHours } from "@/lib/linkedin/workingHours";
import { isMigrationControlPaused, type MigrationControl } from "@/lib/migration/controls";
import { mailboxes } from "@/lib/outreach/schema";
import { isWithinWorkingHours, mailboxHoursFromWeekly } from "@/lib/outreach/workingHours";
import { isPlatformConnected } from "@/lib/platform/credentials";
import { inOrg, runInOrganization } from "@/lib/tenancy/scope";
import {
  deliverWhatsappFromCrm,
  WhatsappSendRefusedError,
  type DeliverWhatsappInput,
} from "@/lib/whatsapp/delivery";
import { whatsappAccounts } from "@/lib/whatsapp/schema";
import { withinCampaignSendingHours } from "@/lib/whatsapp/campaigns/engineRules";
import {
  autoFollowUpVerdict,
  followUpGapPassed,
  oldestPerAccount,
  type AutoFollowUpCandidate,
  type AutoFollowUpHandoffReason,
} from "./autoFollowUpRules";
import { appendCrmEvent, type CrmEventActor } from "./events";
import { draftInOrg, lockCrmRecord } from "./records";
import { CrmConflictError, type CrmTransaction, withCrmTransaction } from "./repository";
import {
  crmConversationMessages,
  crmConversations,
  crmDrafts,
  crmRecords,
  crmSendAttempts,
  crmSequenceRuns,
  crmSequenceStepRuns,
  crmSequenceSteps,
  crmSequences,
  type CrmChannel,
} from "./schema";
import { sendDraft, sendThroughCrmProvider, sendWhatsappThroughCrm, type CrmSendAdapter } from "./send";

const CHANNEL_PAUSE: Record<CrmChannel, MigrationControl> = {
  email: "emailOutbound",
  linkedin: "linkedinOutbound",
  whatsapp: "whatsappOutbound",
};

const PLATFORM: Record<CrmChannel, "google" | "unipile"> = {
  email: "google",
  linkedin: "unipile",
  whatsapp: "unipile",
};

export type AutoFollowUpRunSummary = {
  organizations: number;
  sent: number;
  failed: number;
  handedToRep: number;
  /** Accounts with a follow-up waiting that were not free this run. */
  accountsWaiting: number;
};

/**
 * Takes a draft off the automatic path: it becomes an ordinary draft in the
 * Action required queue. No-op when it is not (or no longer) automatic.
 */
export async function handAutoFollowUpToRepInTransaction(
  tx: CrmTransaction,
  input: { draftId: string; reason: AutoFollowUpHandoffReason | "person_took_over"; actorType: CrmEventActor; actorRef?: string | null },
): Promise<boolean> {
  const [draft] = await tx.select().from(crmDrafts)
    .where(and(draftInOrg(), eq(crmDrafts.id, input.draftId))).limit(1).for("update");
  if (!draft || draft.status !== "awaiting_review" || !draft.autoSendAt) return false;
  const record = await lockCrmRecord(tx, draft.crmRecordId);
  const now = new Date();
  await tx.update(crmDrafts).set({ autoSendAt: null, updatedAt: now }).where(eq(crmDrafts.id, draft.id));
  if (record.workflowState === "waiting" || record.workflowState === "action_required") {
    await tx.update(crmRecords).set({ workflowState: "action_required", nextActionAt: now, updatedAt: now })
      .where(eq(crmRecords.id, record.id));
  }
  await appendCrmEvent(tx, {
    personId: record.personId,
    crmRecordId: record.id,
    pipelineId: record.pipelineId,
    eventType: "draft.auto_send_stopped",
    actorType: input.actorType,
    actorRef: input.actorRef,
    fromData: { draftId: draft.id, autoSendAt: draft.autoSendAt.toISOString() },
    toData: { draftId: draft.id, workflowState: "action_required" },
    meta: { reason: input.reason },
    contextVersion: record.contextVersion,
  });
  return true;
}

/**
 * The opposite of a hand-off: puts a follow-up draft that is waiting in
 * Action required onto the automatic path, for when its sequence was
 * switched on after it was drafted. Only a follow-up of a sequence that
 * sends automatically, on a live run and the record's current context, and
 * only once the lead's latest reply was answered from the CRM (follow-ups
 * never chase an unanswered reply). Returns whether it was queued.
 */
export async function queueAutoFollowUpInTransaction(
  tx: CrmTransaction,
  input: { draftId: string; at: Date; actorType: CrmEventActor; actorRef?: string | null; reason: string },
): Promise<boolean> {
  const [scope] = await tx.select({ draft: crmDrafts, stepType: crmSequenceSteps.stepType, runStatus: crmSequenceRuns.status, stepStatus: crmSequenceStepRuns.status, autoSend: crmSequences.autoSendFollowUps })
    .from(crmDrafts)
    .innerJoin(crmSequenceStepRuns, eq(crmSequenceStepRuns.id, crmDrafts.sequenceStepRunId))
    .innerJoin(crmSequenceSteps, eq(crmSequenceSteps.id, crmSequenceStepRuns.sequenceStepId))
    .innerJoin(crmSequenceRuns, eq(crmSequenceRuns.id, crmSequenceStepRuns.sequenceRunId))
    .innerJoin(crmSequences, eq(crmSequences.id, crmSequenceRuns.sequenceId))
    .where(and(draftInOrg(), eq(crmDrafts.id, input.draftId)))
    .limit(1)
    .for("update", { of: crmDrafts });
  if (!scope) return false;
  const { draft } = scope;
  if (
    draft.status !== "awaiting_review" || draft.autoSendAt
    || scope.stepType !== "follow_up" || !scope.autoSend
    || scope.runStatus !== "active" || scope.stepStatus !== "awaiting_review"
  ) return false;
  const record = await lockCrmRecord(tx, draft.crmRecordId);
  if (record.contextVersion !== draft.expectedContextVersion) return false;
  if (record.workflowState !== "action_required" && record.workflowState !== "waiting") return false;
  if (!record.latestInboundMessageId) return false;
  const [latestInbound] = await tx.select({ sentAt: crmConversationMessages.sentAt }).from(crmConversationMessages)
    .where(eq(crmConversationMessages.id, record.latestInboundMessageId)).limit(1);
  const [answered] = latestInbound
    ? await tx.select({ id: crmConversationMessages.id }).from(crmConversationMessages)
      .innerJoin(crmConversations, eq(crmConversations.id, crmConversationMessages.conversationId))
      .where(and(
        eq(crmConversations.crmRecordId, record.id),
        eq(crmConversationMessages.direction, "outbound"),
        gte(crmConversationMessages.sentAt, latestInbound.sentAt),
      )).limit(1)
    : [];
  if (!answered) return false;
  const now = new Date();
  await tx.update(crmDrafts).set({ autoSendAt: input.at, updatedAt: now }).where(eq(crmDrafts.id, draft.id));
  await tx.update(crmRecords).set({ workflowState: "waiting", nextActionAt: null, updatedAt: now })
    .where(eq(crmRecords.id, record.id));
  await appendCrmEvent(tx, {
    personId: record.personId,
    crmRecordId: record.id,
    pipelineId: record.pipelineId,
    eventType: "draft.auto_send_queued",
    actorType: input.actorType,
    actorRef: input.actorRef,
    fromData: { draftId: draft.id, workflowState: record.workflowState },
    toData: { draftId: draft.id, autoSendAt: input.at.toISOString(), workflowState: "waiting" },
    meta: { reason: input.reason },
    contextVersion: record.contextVersion,
  });
  return true;
}

/** "Review before sending": a person takes an automatic follow-up over. */
export function takeOverAutoFollowUp(input: { draftId: string; actorRef?: string | null }): Promise<boolean> {
  return withCrmTransaction((tx) => handAutoFollowUpToRepInTransaction(tx, {
    draftId: input.draftId,
    reason: "person_took_over",
    actorType: "authenticated_operator",
    actorRef: input.actorRef,
  }));
}

/** Every automatic follow-up still waiting in a sequence, handed to a person (the switch went off). */
export async function handSequenceAutoFollowUpsToRepInTransaction(
  tx: CrmTransaction,
  input: { sequenceId: string; actorRef?: string | null },
): Promise<number> {
  const waiting = await tx.select({ id: crmDrafts.id })
    .from(crmDrafts)
    .innerJoin(crmSequenceStepRuns, eq(crmSequenceStepRuns.id, crmDrafts.sequenceStepRunId))
    .innerJoin(crmSequenceRuns, eq(crmSequenceRuns.id, crmSequenceStepRuns.sequenceRunId))
    .where(and(
      draftInOrg(),
      eq(crmSequenceRuns.sequenceId, input.sequenceId),
      eq(crmDrafts.status, "awaiting_review"),
      isNotNull(crmDrafts.autoSendAt),
    ));
  let handed = 0;
  for (const draft of waiting) {
    if (await handAutoFollowUpToRepInTransaction(tx, {
      draftId: draft.id,
      reason: "sequence_auto_send_off",
      actorType: "authenticated_operator",
      actorRef: input.actorRef,
    })) handed += 1;
  }
  return handed;
}

/** Due automatic follow-ups of the current organization, oldest first. */
async function dueCandidates(now: Date, account?: { channel: CrmChannel; accountRef: string }): Promise<AutoFollowUpCandidate[]> {
  const rows = await db
    .select({
      draftId: crmDrafts.id,
      revision: crmDrafts.revision,
      expectedContextVersion: crmDrafts.expectedContextVersion,
      autoSendAt: crmDrafts.autoSendAt,
      channel: crmConversations.channel,
      accountRef: crmConversations.accountRef,
      workflowState: crmRecords.workflowState,
      contextVersion: crmRecords.contextVersion,
      runStatus: crmSequenceRuns.status,
      stepStatus: crmSequenceStepRuns.status,
      sequenceAutoSend: crmSequences.autoSendFollowUps,
      sequenceStepRunId: crmDrafts.sequenceStepRunId,
    })
    .from(crmDrafts)
    .innerJoin(crmRecords, eq(crmRecords.id, crmDrafts.crmRecordId))
    .innerJoin(crmConversations, eq(crmConversations.id, crmDrafts.conversationId))
    .leftJoin(crmSequenceStepRuns, eq(crmSequenceStepRuns.id, crmDrafts.sequenceStepRunId))
    .leftJoin(crmSequenceRuns, eq(crmSequenceRuns.id, crmSequenceStepRuns.sequenceRunId))
    .leftJoin(crmSequences, eq(crmSequences.id, crmSequenceRuns.sequenceId))
    .where(and(
      inOrg(crmRecords),
      eq(crmDrafts.status, "awaiting_review"),
      isNotNull(crmDrafts.autoSendAt),
      lte(crmDrafts.autoSendAt, now),
      ...(account ? [eq(crmConversations.channel, account.channel), eq(crmConversations.accountRef, account.accountRef)] : []),
    ))
    .orderBy(asc(crmDrafts.autoSendAt), asc(crmDrafts.createdAt))
    .limit(500);
  return rows.map((row) => ({
    draftId: row.draftId,
    revision: row.revision,
    channel: row.channel,
    accountRef: row.accountRef,
    autoSendAt: row.autoSendAt!,
    sequenceAutoSend: row.sequenceAutoSend ?? false,
    workflowState: row.workflowState,
    runActive: row.runStatus === "active",
    stepAwaitingReview: row.stepStatus === "awaiting_review",
    contextCurrent: row.contextVersion === row.expectedContextVersion,
    isScheduledDirectSend: row.sequenceStepRunId === null,
  }));
}

async function lastAutoSendAt(accountRef: string): Promise<Date | null> {
  const [last] = await db.select({ createdAt: crmSendAttempts.createdAt })
    .from(crmSendAttempts)
    .innerJoin(crmDrafts, eq(crmDrafts.id, crmSendAttempts.draftId))
    .where(and(draftInOrg(), eq(crmSendAttempts.actorType, "system"), eq(crmSendAttempts.accountRef, accountRef)))
    .orderBy(desc(crmSendAttempts.createdAt))
    .limit(1);
  return last?.createdAt ?? null;
}

async function gapPassed(channel: CrmChannel, accountRef: string, now: Date): Promise<boolean> {
  const { crmFollowUpGapMinutes } = await channelRules(channel);
  return followUpGapPassed(await lastAutoSendAt(accountRef), crmFollowUpGapMinutes, now);
}

/**
 * Whether the email scheduler should leave this mailbox's turn to a waiting
 * automatic follow-up: one is due and the mailbox's follow-up gap has passed.
 */
export async function mailboxHasAutoFollowUpWaiting(emailAddress: string, now: Date): Promise<boolean> {
  if (isMigrationControlPaused("crmAutoSend")) return false;
  const candidates = await dueCandidates(now, { channel: "email", accountRef: emailAddress });
  if (!candidates.some((candidate) => autoFollowUpVerdict(candidate, now).verdict === "send")) return false;
  return gapPassed("email", emailAddress, now);
}

type AccountSlot = { ok: false } | { ok: true; afterSend?: () => Promise<void> };

/** Whether the account may send one follow-up now; for a mailbox it also takes the mailbox's turn. */
async function takeAccountSlot(channel: CrmChannel, accountRef: string, now: Date): Promise<AccountSlot> {
  if (isMigrationControlPaused(CHANNEL_PAUSE[channel])) return { ok: false };
  if (!(await isPlatformConnected(PLATFORM[channel]))) return { ok: false };
  if (!(await gapPassed(channel, accountRef, now))) return { ok: false };

  if (channel === "email") {
    const [mailbox] = await db.select().from(mailboxes)
      .where(and(inOrg(mailboxes), eq(mailboxes.emailAddress, accountRef))).limit(1);
    if (!mailbox) {
      // A thread on an address that is not a sending mailbox here: only the
      // organization's default hours and the follow-up gap apply.
      const { sendingHours } = await channelRules("email");
      return isWithinWorkingHours(mailboxHoursFromWeekly(sendingHours), now) ? { ok: true } : { ok: false };
    }
    if (mailbox.status !== "connected") return { ok: false };
    if (!isWithinWorkingHours(mailbox.workingHours, now)) return { ok: false };
    if (mailbox.todayEmailsSent >= mailbox.dailySendLimit) return { ok: false };
    // Take the mailbox's turn before sending, so the campaign scheduler cannot
    // send in the same moment; the gap is the one campaigns use.
    const { sendGapMinutes } = await channelRules("email");
    const [taken] = await db.update(mailboxes)
      .set({ nextEmailTime: new Date(now.getTime() + pickInRange(sendGapMinutes) * 60_000) })
      .where(and(
        inOrg(mailboxes),
        eq(mailboxes.id, mailbox.id),
        or(isNull(mailboxes.nextEmailTime), lte(mailboxes.nextEmailTime, now)),
      ))
      .returning({ id: mailboxes.id });
    if (!taken) return { ok: false };
    return {
      ok: true,
      afterSend: async () => {
        await db.update(mailboxes)
          .set({ todayEmailsSent: sql`${mailboxes.todayEmailsSent} + 1` })
          .where(and(inOrg(mailboxes), eq(mailboxes.id, mailbox.id)));
      },
    };
  }

  if (channel === "linkedin") {
    const [account] = await db.select().from(linkedInAccounts)
      .where(and(inOrg(linkedInAccounts), eq(linkedInAccounts.linkedinId, accountRef))).limit(1);
    if (!account || account.status !== "CONNECTED") return { ok: false };
    const { workingHours } = await channelRules("linkedin");
    return isWithinLinkedinHours(withOrganizationHours(account, workingHours), now) ? { ok: true } : { ok: false };
  }

  const [number] = await db.select().from(whatsappAccounts)
    .where(and(inOrg(whatsappAccounts), eq(whatsappAccounts.unipileAccountId, accountRef))).limit(1);
  if (!number || number.status !== "connected") return { ok: false };
  const { sendingHours } = await channelRules("whatsapp");
  return withinCampaignSendingHours(sendingHours, now) ? { ok: true } : { ok: false };
}

/**
 * WhatsApp's 10-second gap is shared with campaigns and a person's sends: if
 * one went out moments ago, wait it out and try once more rather than fail
 * the follow-up. Nothing reached WhatsApp on a refusal, so the retry is safe.
 */
async function deliverAfterSendGap(input: DeliverWhatsappInput) {
  try {
    return await deliverWhatsappFromCrm(input);
  } catch (error) {
    if (!(error instanceof WhatsappSendRefusedError) || error.reason !== "send_gap") throw error;
    const waitSeconds = Math.min(30, Math.max(1, error.retryAfterSeconds ?? 10));
    await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
    return deliverWhatsappFromCrm(input);
  }
}

const sendAutomatically: CrmSendAdapter = (input) => input.channel === "whatsapp"
  ? sendWhatsappThroughCrm(input, deliverAfterSendGap)
  : sendThroughCrmProvider(input);

async function runOrganization(summary: AutoFollowUpRunSummary, now: Date, send: CrmSendAdapter): Promise<void> {
  const sendable: AutoFollowUpCandidate[] = [];
  for (const candidate of await dueCandidates(now)) {
    const decision = autoFollowUpVerdict(candidate, now);
    if (decision.verdict === "send") sendable.push(candidate);
    if (decision.verdict !== "hand_to_rep") continue;
    const handed = await withCrmTransaction((tx) => handAutoFollowUpToRepInTransaction(tx, {
      draftId: candidate.draftId,
      reason: decision.reason,
      actorType: "system",
    }));
    if (handed) summary.handedToRep += 1;
  }

  for (const candidate of oldestPerAccount(sendable)) {
    const slot = await takeAccountSlot(candidate.channel, candidate.accountRef, now);
    if (!slot.ok) {
      summary.accountsWaiting += 1;
      continue;
    }
    try {
      await sendDraft({
        draftId: candidate.draftId,
        revision: candidate.revision,
        // One key per draft revision: a retry of the same text replays, never resends.
        idempotencyKey: `crm-auto-follow-up:${candidate.draftId}:${candidate.revision}`,
        requestId: randomUUID(),
        actorType: "system",
      }, { send });
      await slot.afterSend?.();
      summary.sent += 1;
    } catch (error) {
      summary.failed += 1;
      console.error(`[crm/autoFollowUps] Draft ${candidate.draftId} was not sent:`, error instanceof Error ? error.message : error);
      // A definite failure has already put the record in Problems, and an
      // uncertain one asks a person to reconcile. A refusal before sending
      // (Do Not Contact, the draft just went stale) changed nothing, so the
      // draft would be retried every run: give it to a person instead.
      if (error instanceof CrmConflictError) {
        await withCrmTransaction((tx) => handAutoFollowUpToRepInTransaction(tx, {
          draftId: candidate.draftId,
          reason: "send_refused",
          actorType: "system",
        })).catch(() => undefined);
      }
    }
  }
}

/** One pass over every organization with an automatic follow-up due. */
export async function runCrmAutoFollowUps(options: { now?: Date; send?: CrmSendAdapter } = {}): Promise<AutoFollowUpRunSummary> {
  const summary: AutoFollowUpRunSummary = { organizations: 0, sent: 0, failed: 0, handedToRep: 0, accountsWaiting: 0 };
  if (isMigrationControlPaused("crmAutoSend")) return summary;
  const now = options.now ?? new Date();
  // Platform-wide on purpose: this is how the job finds which organizations to visit.
  const organizations = await db
    .selectDistinct({ organizationId: crmRecords.organizationId })
    .from(crmDrafts)
    .innerJoin(crmRecords, eq(crmRecords.id, crmDrafts.crmRecordId))
    .where(and(
      eq(crmDrafts.status, "awaiting_review"),
      isNotNull(crmDrafts.autoSendAt),
      lte(crmDrafts.autoSendAt, now),
    ));
  for (const { organizationId } of organizations) {
    summary.organizations += 1;
    try {
      await runInOrganization(organizationId, () => runOrganization(summary, now, options.send ?? sendAutomatically));
    } catch (error) {
      console.error(`[crm/autoFollowUps] Organization ${organizationId} failed:`, error instanceof Error ? error.message : error);
    }
  }
  return summary;
}
