import { and, asc, count, desc, eq, getTableColumns, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { inboxContacts, inboxMessages } from "@/lib/inbox/schema";
import { companies, people } from "@/lib/leads/schema";
import { linkedInAccounts, leads as linkedinLeads, messages as linkedinMessages } from "@/lib/linkedin/schema";
import { outreachEmails, outreachLeads } from "@/lib/outreach/schema";
import { whatsappAccounts } from "@/lib/whatsapp/schema";
import {
  crmClassifications,
  crmConversationMessages,
  crmConversations,
  crmDraftKnowledgeCitations,
  crmDrafts,
  crmEvents,
  crmPersonContactPolicies,
  crmPipelines,
  crmRecords,
  crmSendAttempts,
  crmSequenceRuns,
  crmSequenceStepRuns,
  crmSequenceSteps,
  crmSequences,
  crmSubcategories,
  type CrmCategoryKey,
  type CrmRecordChannel,
  type CrmWorkflowState,
} from "./schema";
import { emailOutreachRowToMessageInput } from "./outreachHistory";
import { CrmNotFoundError } from "./repository";
import { crmDueState } from "./stateMachine";
import type { CrmActionGroup } from "./actionGroups";
import { crmActionableSql, crmActionGroupSql } from "./actionGroups.server";
import { inOrg } from "@/lib/tenancy/scope";

/**
 * LinkedIn outreach predates the CRM: the invitation note, the acceptance
 * message and every follow-up live in the LinkedIn "Message" table and were
 * never copied into crm_conversation_messages, which only ever received the
 * inbound reply that opened the record plus whatever the CRM sent back. The
 * record timeline merges both at read time rather than backfilling, so the
 * LinkedIn tables stay the hand-maintained ones CLAUDE.md describes.
 */
const LINKEDIN_OUTBOUND_TYPES = new Set(["INVITATION", "ACCEPTANCE", "FOLLOW_UP_1", "FOLLOW_UP_2", "FOLLOW_UP_3", "CUSTOM_SENT"]);

const LINKEDIN_TYPE_LABELS: Record<string, string> = {
  INVITATION: "Invitation",
  ACCEPTANCE: "Acceptance",
  FOLLOW_UP_1: "Follow-up 1",
  FOLLOW_UP_2: "Follow-up 2",
  FOLLOW_UP_3: "Follow-up 3",
  CUSTOM_SENT: "Sent",
  RECEIVED: "Received",
};

/**
 * Column sets for list reads. The classifier and drafter store their full LLM
 * request/response on every row for auditing, and a person's `raw` import
 * blob runs to several KB; none of it is shown in a table, but selected
 * whole it made 30 rows weigh 2 MB over a link that already costs ~170 ms a
 * round trip. Trim at the query, not the response, so the database is not
 * shipping it either.
 */
function omit<T extends Record<string, unknown>, K extends keyof T>(columns: T, keys: K[]): Omit<T, K> {
  const copy: Record<string, unknown> = { ...columns };
  for (const key of keys) delete copy[key as string];
  return copy as Omit<T, K>;
}
const classificationListColumns = omit(getTableColumns(crmClassifications), ["request", "response"]);
const draftListColumns = omit(getTableColumns(crmDrafts), ["request", "response", "aiBodyHtml", "editedBodyHtml"]);
const messageListColumns = omit(getTableColumns(crmConversationMessages), ["raw", "bodyHtml"]);
// `displayName` falls back to a handful of keys inside `raw` when the typed
// name columns are empty, so keep exactly those and drop the rest.
const personListColumns = {
  ...omit(getTableColumns(people), ["raw"]),
  raw: sql<Record<string, unknown> | null>`jsonb_strip_nulls(jsonb_build_object(
    'name', ${people.raw}->'name', 'fullName', ${people.raw}->'fullName', 'full_name', ${people.raw}->'full_name',
    'firstName', ${people.raw}->'firstName', 'first_name', ${people.raw}->'first_name',
    'lastName', ${people.raw}->'lastName', 'last_name', ${people.raw}->'last_name',
    'email', ${people.raw}->'email', 'linkedinUrl', ${people.raw}->'linkedinUrl', 'linkedin_url', ${people.raw}->'linkedin_url'))`.as("raw"),
};

/** "Follow-up 2 · Nudge", or just "Follow-up 2" when that is already the step's name. */
function followUpStepLabel(position: number, name: string): string {
  const generic = `Follow-up ${position - 1}`;
  return name.trim().toLowerCase() === generic.toLowerCase() ? generic : `${generic} · ${name}`;
}

/**
 * Where an open record sits once the Action required queue is no longer the
 * whole story: someone we replied to yesterday with a follow-up due tomorrow
 * has left that queue but is still very much in play.
 */
export type CrmPipelineStage = "needs_action" | "waiting" | "exhausted";

export const CRM_PIPELINE_STAGES: readonly CrmPipelineStage[] = ["needs_action", "waiting", "exhausted"];

const actionableCondition = crmActionableSql(crmRecords);
const actionGroup = crmActionGroupSql(crmRecords);
// Idle alone is ambiguous — a hand-sent reply also lands there. Only a record
// whose newest sequence run ran to its last step has used up its follow-ups.
const exhaustedCondition = sql`(${crmRecords.workflowState} = 'idle' and (
  select last_run.status from crm_sequence_runs last_run
   where last_run.crm_record_id = ${crmRecords.id}
   order by last_run.created_at desc limit 1
) = 'completed')`;
const pipelineStage = sql<CrmPipelineStage>`case when ${actionableCondition} then 'needs_action'
  when ${exhaustedCondition} then 'exhausted' else 'waiting' end`;

export type CrmActionFilters = {
  /** One record only — how the Action required table refreshes a single row after an inline edit. */
  recordId?: string;
  /**
   * `actions` (the default) is the Action required queue. `pipeline` is every
   * open record — the queue plus those waiting on the lead or a scheduled
   * follow-up, and those whose follow-ups have all gone out.
   */
  scope?: "actions" | "pipeline";
  /** Pipeline only: narrow to one stage. */
  stage?: CrmPipelineStage;
  /** Leave out Not interested records; unclassified and Other stay in. */
  potentialOnly?: boolean;
  categoryKey?: CrmCategoryKey;
  subcategoryId?: string;
  channel?: CrmRecordChannel;
  workflowState?: CrmWorkflowState;
  classificationReview?: boolean;
  sequenceId?: string;
  /** One of the queue's action groups; filtered in SQL, so the total stays exact. */
  actionGroup?: CrmActionGroup;
  error?: boolean;
  overdue?: boolean;
  dueAfter?: Date;
  dueBefore?: Date;
  limit?: number;
  offset?: number;
};

export async function listCrmActions(input: CrmActionFilters = {}) {
  const limit = Math.max(1, Math.min(200, Math.floor(input.limit ?? 50)));
  const offset = Math.max(0, Math.floor(input.offset ?? 0));
  const pipeline = input.scope === "pipeline";
  // Everything except the stage, so the stage tabs can count against the same
  // filters the list is under.
  const baseConditions = [
    inOrg(crmRecords),
    input.error === true
      ? eq(crmRecords.workflowState, "error")
      : input.workflowState
      ? eq(crmRecords.workflowState, input.workflowState)
      : pipeline
      ? sql`${crmRecords.workflowState} <> 'closed'`
      : actionableCondition,
    input.recordId ? eq(crmRecords.id, input.recordId) : undefined,
    input.potentialOnly ? sql`${crmRecords.categoryKey} is distinct from 'not_interested'` : undefined,
    input.categoryKey ? eq(crmRecords.categoryKey, input.categoryKey) : undefined,
    input.subcategoryId ? eq(crmRecords.subcategoryId, input.subcategoryId) : undefined,
    input.channel ? eq(crmRecords.activeChannel, input.channel) : undefined,
    input.actionGroup ? sql`${actionGroup} = ${input.actionGroup}` : undefined,
    input.overdue ? sql`${crmRecords.nextActionAt} <= now()` : undefined,
    input.dueAfter ? sql`${crmRecords.nextActionAt} >= ${input.dueAfter}` : undefined,
    input.dueBefore ? sql`${crmRecords.nextActionAt} <= ${input.dueBefore}` : undefined,
    input.sequenceId ? sql`exists (
      select 1 from crm_sequence_runs action_run
       where action_run.crm_record_id = ${crmRecords.id}
         and action_run.sequence_id = ${input.sequenceId}
         and action_run.status in ('active', 'paused')
    )` : undefined,
  ];
  // Filter on the same CASE the tab counts group by. Negating the two
  // conditions instead drops rows where they are NULL — no next_action_at,
  // or no sequence run at all — which the CASE sends to Waiting.
  const stageCondition = pipeline && input.stage ? sql`${pipelineStage} = ${input.stage}` : undefined;
  const where = and(...baseConditions, stageCondition);
  // Newest activity first. nextActionAt used to lead this sort ascending,
  // which put the stalest item on top and — because Postgres sorts NULLs
  // last in ASC — buried every record without a due date below all 38 that
  // had one. lastInboundAt is nullable too, so coalesce to createdAt rather
  // than let DESC float those NULLs to the top; id keeps paging stable.
  // The pipeline counts our own sends as activity too (greatest() skips
  // NULLs), so a lead replied to this morning sits above one from last week.
  const lastActivity = pipeline
    ? sql`coalesce(greatest(${crmRecords.lastInboundAt}, ${crmRecords.lastOutboundAt}), ${crmRecords.createdAt})`
    : sql`coalesce(${crmRecords.lastInboundAt}, ${crmRecords.createdAt})`;
  const orderBy = [desc(lastActivity), asc(crmRecords.id)] as const;
  // The child reads scope themselves to this page with the same subquery the
  // page itself runs, so the whole list is a single round trip rather than a
  // page read followed by a batch keyed on its ids. Each child asks for only
  // the newest row per record (DISTINCT ON), which is all the table shows.
  const pageRecordIds = db.select({ id: crmRecords.id }).from(crmRecords)
    .innerJoin(people, eq(people.id, crmRecords.personId))
    .where(where).orderBy(...orderBy).limit(limit).offset(offset);
  const pagePersonIds = db.select({ personId: crmRecords.personId }).from(crmRecords)
    .innerJoin(people, eq(people.id, crmRecords.personId))
    .where(where).orderBy(...orderBy).limit(limit).offset(offset);
  const [rows, totals, messages, classifications, runs, drafts, policies, stageCounts, lastRuns] = await Promise.all([
    db.select({ record: crmRecords, person: personListColumns, company: companies, subcategory: crmSubcategories, stage: pipelineStage })
      .from(crmRecords)
      .innerJoin(people, eq(people.id, crmRecords.personId))
      .leftJoin(companies, eq(companies.id, people.companyId))
      .leftJoin(crmSubcategories, eq(crmSubcategories.id, crmRecords.subcategoryId))
      .where(where)
      .orderBy(...orderBy)
      .limit(limit).offset(offset),
    db.select({ total: count() }).from(crmRecords).where(where),
    db.selectDistinctOn([crmConversations.crmRecordId], { recordId: crmConversations.crmRecordId, message: messageListColumns })
      .from(crmConversationMessages)
      .innerJoin(crmConversations, eq(crmConversations.id, crmConversationMessages.conversationId))
      .where(and(inArray(crmConversations.crmRecordId, pageRecordIds), eq(crmConversationMessages.direction, "inbound")))
      .orderBy(crmConversations.crmRecordId, desc(crmConversationMessages.sentAt)),
    db.selectDistinctOn([crmClassifications.crmRecordId], classificationListColumns).from(crmClassifications)
      .where(inArray(crmClassifications.crmRecordId, pageRecordIds))
      .orderBy(crmClassifications.crmRecordId, desc(crmClassifications.createdAt)),
    db.select({ run: crmSequenceRuns, sequence: crmSequences, step: crmSequenceSteps })
      .from(crmSequenceRuns)
      .innerJoin(crmSequences, eq(crmSequences.id, crmSequenceRuns.sequenceId))
      .leftJoin(crmSequenceSteps, and(
        eq(crmSequenceSteps.sequenceVersionId, crmSequenceRuns.sequenceVersionId),
        eq(crmSequenceSteps.position, crmSequenceRuns.currentStepPosition),
      ))
      .where(and(inArray(crmSequenceRuns.crmRecordId, pageRecordIds), inArray(crmSequenceRuns.status, ["active", "paused"]))),
    db.selectDistinctOn([crmDrafts.crmRecordId], draftListColumns).from(crmDrafts).where(and(
      inArray(crmDrafts.crmRecordId, pageRecordIds),
      inArray(crmDrafts.status, ["awaiting_review", "failed", "delivery_uncertain"]),
    )).orderBy(crmDrafts.crmRecordId, desc(crmDrafts.updatedAt)),
    db.select().from(crmPersonContactPolicies)
      .where(inArray(crmPersonContactPolicies.personId, pagePersonIds)),
    // A single-row refresh does not need the tab counts.
    pipeline && !input.recordId
      ? db.select({ stage: pipelineStage, total: count() }).from(crmRecords)
        .innerJoin(people, eq(people.id, crmRecords.personId))
        .where(and(...baseConditions)).groupBy(pipelineStage)
      : Promise.resolve([]),
    // The sequence an exhausted record finished, which the active-run read
    // above cannot supply once the run is completed.
    pipeline
      ? db.selectDistinctOn([crmSequenceRuns.crmRecordId], { recordId: crmSequenceRuns.crmRecordId, status: crmSequenceRuns.status, sequenceName: crmSequences.name })
        .from(crmSequenceRuns)
        .innerJoin(crmSequences, eq(crmSequences.id, crmSequenceRuns.sequenceId))
        .where(inArray(crmSequenceRuns.crmRecordId, pageRecordIds))
        .orderBy(crmSequenceRuns.crmRecordId, desc(crmSequenceRuns.createdAt))
      : Promise.resolve([]),
  ]);
  // Which step each open draft was written for: a follow-up on someone's desk
  // is not an immediate reply, and the row has to say so.
  const draftStepRunIds = drafts.flatMap((draft) => draft.sequenceStepRunId ? [draft.sequenceStepRunId] : []);
  const draftSteps = draftStepRunIds.length
    ? await db.select({ stepRunId: crmSequenceStepRuns.id, stepType: crmSequenceSteps.stepType, position: crmSequenceSteps.position, name: crmSequenceSteps.name })
      .from(crmSequenceStepRuns)
      .innerJoin(crmSequenceSteps, eq(crmSequenceSteps.id, crmSequenceStepRuns.sequenceStepId))
      .where(inArray(crmSequenceStepRuns.id, draftStepRunIds))
    : [];
  const draftStepByRunId = new Map(draftSteps.map((row) => [row.stepRunId, row]));
  const latestInbound = new Map(messages.map((row) => [row.recordId, row.message]));
  const latestClassification = new Map(classifications.map((row) => [row.crmRecordId, row]));
  const activeRun = new Map(runs.map((row) => [row.run.crmRecordId, row]));
  const currentDraft = new Map(drafts.map((draft) => [draft.crmRecordId, draft]));
  const policyByPerson = new Map(policies.map((policy) => [policy.personId, policy]));
  const lastRunByRecord = new Map(lastRuns.map((row) => [row.recordId, row]));
  const actions = rows.map((row) => {
    const classification = latestClassification.get(row.record.id) ?? null;
    const run = activeRun.get(row.record.id) ?? null;
    const draft = currentDraft.get(row.record.id) ?? null;
    const draftStep = draft?.sequenceStepRunId ? draftStepByRunId.get(draft.sequenceStepRunId) ?? null : null;
    const aiChanged = Boolean(classification && !classification.acknowledgedAt);
    // Off the queue there is no action to name, so say what the record is
    // waiting on instead of falling through to "Human review".
    const actionType = row.stage === "exhausted"
      ? "All follow-ups sent"
      : row.stage === "waiting"
      ? row.record.workflowState === "classifying" || row.record.workflowState === "unclassified"
        ? "Classifying reply"
        : row.record.workflowState === "paused"
        ? "Paused"
        : draft?.status === "awaiting_review" && draft.autoSendAt
        ? "Queued to send"
        : row.record.nextActionAt
        ? "Follow-up scheduled"
        : row.record.lastOutboundAt
        ? "Awaiting their reply"
        : "Outreach not sent yet"
      : row.record.workflowState === "error"
      ? "Processing error"
      : classification?.status === "proposed"
        ? "Classification review"
        : draft?.status === "delivery_uncertain"
          ? "Delivery reconciliation"
          : draft?.status === "awaiting_review"
            ? draftStep?.stepType === "follow_up"
              ? "Follow-up review"
              : row.record.lastInboundAt
                ? "Reply review"
                : "Outreach review"
            : row.record.nextActionAt && row.record.nextActionAt <= new Date()
              // Due from WhatsApp Calling (calls/crmFollowUp.ts) — a call-only
              // record, with no reply on it: the rep calls or messages them;
              // there is no draft to review. A WhatsApp reply makes the record
              // inbound-driven, and it is labelled like any other from then on.
              ? row.record.activeChannel === "whatsapp" && !row.record.latestInboundMessageId
                ? "WhatsApp follow-up"
                : "Due follow-up"
              : !run
                ? "No sequence assigned"
                : "Human review";
    return {
      ...row,
      id: row.record.id,
      recordId: row.record.id,
      // NULL is genuinely "not classified yet", which is not the same thing as
      // the Other category — collapsing them is what hid 61 held records.
      category: row.record.categoryKey,
      dueState: crmDueState({
        workflowState: row.record.workflowState,
        nextActionAt: row.record.nextActionAt,
        draftStatus: draft?.status ?? null,
        draftStepType: draftStep?.stepType ?? null,
        draftAutoSend: Boolean(draft?.autoSendAt),
        classificationStatus: classification?.status ?? null,
        hasActiveRun: Boolean(run),
      }),
      channel: row.record.activeChannel,
      dueAt: row.record.nextActionAt,
      actionType,
      /** e.g. "Follow-up 2 · Share Information" for the draft on the row; null for a hand-written or reply draft. */
      draftStepLabel: draftStep && draftStep.stepType === "follow_up" ? followUpStepLabel(draftStep.position, draftStep.name) : null,
      latestInbound: latestInbound.get(row.record.id) ?? null,
      latestInboundExcerpt: latestInbound.get(row.record.id)?.bodyText.slice(0, 240) ?? "",
      classification,
      aiChanged,
      activeRun: run,
      draft,
      contactPolicy: policyByPerson.get(row.record.personId) ?? null,
      lastRun: lastRunByRecord.get(row.record.id) ?? null,
    };
  }).filter((row) => input.classificationReview === undefined
    || (input.classificationReview
      ? Boolean(row.classification && !row.classification.acknowledgedAt)
      : !row.classification || Boolean(row.classification.acknowledgedAt)));
  const postFiltered = input.classificationReview !== undefined;
  // Paging advances by rows read from the database, not by rows surviving the
  // post-filters above — otherwise a filtered page would rewind the offset and
  // serve the same records again. A short read means the table is exhausted.
  return {
    actions,
    total: postFiltered ? actions.length : Number(totals[0]?.total ?? 0),
    limit,
    offset,
    nextOffset: offset + rows.length,
    hasMore: rows.length === limit,
    ...(pipeline && !input.recordId ? { stageCounts: Object.fromEntries(CRM_PIPELINE_STAGES.map((stage) => [stage, Number(stageCounts.find((row) => row.stage === stage)?.total ?? 0)])) } : {}),
  };
}

export async function getCrmRecordWorkspace(recordId: string) {
  // Every read here depends on the record id alone — the child tables are
  // reached by joining through crm_conversations / crm_drafts / crm_sequence_runs
  // rather than by ids from an earlier result — so the whole workspace is one
  // batch instead of a six-deep waterfall. At ~170 ms a round trip that is the
  // difference between the page appearing and the page being waited for.
  const personIdOfRecord = db.select({ personId: crmRecords.personId }).from(crmRecords).where(and(inOrg(crmRecords), eq(crmRecords.id, recordId)));
  const personEmailOfRecord = db.select({ email: sql<string>`lower(${people.email})` }).from(crmRecords)
    .innerJoin(people, eq(people.id, crmRecords.personId)).where(and(inOrg(crmRecords), eq(crmRecords.id, recordId)));
  const [headers, conversations, messages, classifications, events, runs, drafts, stepRuns, citations, attempts, linkedinHistory, linkedinAccounts, emailOutreach, inboxHistory] = await Promise.all([
    db.select({ record: crmRecords, person: people, company: companies, subcategory: crmSubcategories, policy: crmPersonContactPolicies })
      .from(crmRecords)
      .innerJoin(people, eq(people.id, crmRecords.personId))
      .leftJoin(companies, eq(companies.id, people.companyId))
      .leftJoin(crmSubcategories, eq(crmSubcategories.id, crmRecords.subcategoryId))
      .leftJoin(crmPersonContactPolicies, eq(crmPersonContactPolicies.personId, people.id))
      .where(and(inOrg(crmRecords), eq(crmRecords.id, recordId))).limit(1),
    db.select().from(crmConversations)
      .where(and(inOrg(crmConversations), eq(crmConversations.crmRecordId, recordId))).orderBy(asc(crmConversations.createdAt)),
    db.select({ message: crmConversationMessages }).from(crmConversationMessages)
      .innerJoin(crmConversations, eq(crmConversations.id, crmConversationMessages.conversationId))
      .where(and(inOrg(crmConversations), eq(crmConversations.crmRecordId, recordId)))
      .orderBy(asc(crmConversationMessages.sentAt), asc(crmConversationMessages.id))
      .then((rows) => rows.map((row) => row.message)),
    db.select(classificationListColumns).from(crmClassifications).where(eq(crmClassifications.crmRecordId, recordId))
      .orderBy(desc(crmClassifications.createdAt)),
    db.select().from(crmEvents).where(and(inOrg(crmEvents), eq(crmEvents.crmRecordId, recordId)))
      .orderBy(desc(crmEvents.createdAt)),
    db.select({ run: crmSequenceRuns, sequence: crmSequences })
      .from(crmSequenceRuns).innerJoin(crmSequences, eq(crmSequences.id, crmSequenceRuns.sequenceId))
      .where(and(inOrg(crmSequenceRuns), eq(crmSequenceRuns.crmRecordId, recordId))).orderBy(desc(crmSequenceRuns.createdAt)),
    db.select(omit(getTableColumns(crmDrafts), ["request", "response"])).from(crmDrafts)
      .where(eq(crmDrafts.crmRecordId, recordId)).orderBy(desc(crmDrafts.createdAt)),
    db.select({ stepRun: crmSequenceStepRuns, step: crmSequenceSteps })
      .from(crmSequenceStepRuns)
      .innerJoin(crmSequenceSteps, eq(crmSequenceSteps.id, crmSequenceStepRuns.sequenceStepId))
      .innerJoin(crmSequenceRuns, eq(crmSequenceRuns.id, crmSequenceStepRuns.sequenceRunId))
      .where(and(inOrg(crmSequenceRuns), eq(crmSequenceRuns.crmRecordId, recordId))).orderBy(asc(crmSequenceSteps.position)),
    db.select({ citation: crmDraftKnowledgeCitations }).from(crmDraftKnowledgeCitations)
      .innerJoin(crmDrafts, eq(crmDrafts.id, crmDraftKnowledgeCitations.draftId))
      .where(eq(crmDrafts.crmRecordId, recordId))
      .then((rows) => rows.map((row) => row.citation)),
    db.select({ attempt: crmSendAttempts }).from(crmSendAttempts)
      .innerJoin(crmDrafts, eq(crmDrafts.id, crmSendAttempts.draftId))
      .where(eq(crmDrafts.crmRecordId, recordId)).orderBy(desc(crmSendAttempts.createdAt))
      .then((rows) => rows.map((row) => row.attempt)),
    db.select({ message: linkedinMessages })
      .from(linkedinMessages)
      .innerJoin(linkedinLeads, eq(linkedinLeads.id, linkedinMessages.leadId))
      .where(and(
        inOrg(linkedinLeads),
        eq(linkedinLeads.personId, personIdOfRecord),
        isNull(linkedinMessages.duplicateOfMessageId),
      ))
      .orderBy(asc(linkedinMessages.createdAt)),
    // accountRef is the address for email but a Unipile account id for
    // LinkedIn, which is unreadable in a "send through" picker. Resolve those
    // ids to the sending profile so both channels name the account the way a
    // person would.
    db.selectDistinct({ linkedinId: linkedInAccounts.linkedinId, username: linkedInAccounts.username, name: linkedInAccounts.name, profilePictureUrl: linkedInAccounts.profilePictureUrl })
      .from(linkedInAccounts)
      .innerJoin(crmConversations, and(eq(crmConversations.accountRef, linkedInAccounts.linkedinId), eq(crmConversations.channel, "linkedin")))
      .where(and(inOrg(linkedInAccounts), inOrg(crmConversations), eq(crmConversations.crmRecordId, recordId))),
    // Email has the same split LinkedIn does: campaign sends live in
    // outreach_emails and Master Inbox traffic in crm_messages, and only what
    // arrived after the CRM started backfilling made it into
    // crm_conversation_messages. Read both here so the thread is the whole
    // relationship, then drop whatever the CRM already holds.
    db.select({
      id: outreachEmails.id, subject: outreachEmails.subject, body: outreachEmails.body, messageId: outreachEmails.messageId,
      sentAt: outreachEmails.sentAt, stepNumber: outreachEmails.stepNumber, campaignId: outreachLeads.campaignId, mailboxId: outreachEmails.mailboxId,
    })
      .from(outreachEmails)
      .innerJoin(outreachLeads, eq(outreachLeads.id, outreachEmails.leadId))
      .where(and(eq(outreachLeads.personId, personIdOfRecord), eq(outreachEmails.status, "sent")))
      .orderBy(asc(outreachEmails.sentAt)),
    db.select({
      id: inboxMessages.id, direction: inboxMessages.direction, providerMessageKey: inboxMessages.providerMessageKey, subject: inboxMessages.subject,
      bodyText: inboxMessages.bodyText, bodyHtml: inboxMessages.bodyHtml, fromEmail: inboxMessages.fromEmail, toEmail: inboxMessages.toEmail,
      sentAt: inboxMessages.sentAt, createdAt: inboxMessages.createdAt,
      raw: sql<Record<string, unknown> | null>`jsonb_build_object('messageId', ${inboxMessages.raw}->'messageId', 'crmConversationMessageId', ${inboxMessages.raw}->'crmConversationMessageId', 'to', ${inboxMessages.raw}->'to', 'cc', ${inboxMessages.raw}->'cc', 'bcc', ${inboxMessages.raw}->'bcc', 'toEmail', ${inboxMessages.raw}->'toEmail', 'ccEmails', ${inboxMessages.raw}->'ccEmails')`,
    })
      .from(inboxMessages)
      .innerJoin(inboxContacts, eq(inboxContacts.id, inboxMessages.contactId))
      .where(and(inOrg(inboxContacts), sql`lower(${inboxContacts.email}) in (${personEmailOfRecord})`))
      .orderBy(asc(inboxMessages.sentAt)),
  ]);
  const header = headers[0];
  if (!header) throw new CrmNotFoundError("CRM record", recordId);

  const latestClassification = classifications[0] ?? null;
  const currentDraft = drafts.find((draft) => ["awaiting_review", "failed", "delivery_uncertain"].includes(draft.status)) ?? null;
  const linkedinAccountByRef = new Map(linkedinAccounts.map((account) => [account.linkedinId, account]));
  // WhatsApp's accountRef is a Unipile account id too; name it by the rep's
  // number. Only read when the record has a WhatsApp conversation.
  const whatsappRefs = [...new Set(conversations.filter((conversation) => conversation.channel === "whatsapp").map((conversation) => conversation.accountRef))];
  const whatsappAccountRows = whatsappRefs.length
    ? await db.select({ unipileAccountId: whatsappAccounts.unipileAccountId, name: whatsappAccounts.name, phone: whatsappAccounts.phone })
      .from(whatsappAccounts).where(and(inOrg(whatsappAccounts), inArray(whatsappAccounts.unipileAccountId, whatsappRefs)))
    : [];
  const whatsappAccountByRef = new Map(whatsappAccountRows.map((account) => [account.unipileAccountId, account]));
  const conversationAccount = (conversation: (typeof conversations)[number]) => {
    switch (conversation.channel) {
      case "email":
        return { label: conversation.accountRef, name: conversation.accountRef, avatarUrl: null };
      case "linkedin": {
        const account = linkedinAccountByRef.get(conversation.accountRef);
        return {
          label: account
            ? [account.name, account.username && `@${account.username}`].filter(Boolean).join(" · ")
            : "Unknown LinkedIn account",
          name: account?.name ?? account?.username ?? null,
          avatarUrl: account?.profilePictureUrl ?? null,
        };
      }
      case "whatsapp": {
        const account = whatsappAccountByRef.get(conversation.accountRef);
        return {
          label: account
            ? [account.name, account.phone].filter(Boolean).join(" · ") || "WhatsApp number"
            : "Unknown WhatsApp number",
          name: account?.name ?? account?.phone ?? null,
          avatarUrl: null,
        };
      }
    }
  };
  const conversationsWithMessages = conversations.map((conversation) => {
    const account = conversationAccount(conversation);
    return {
      ...conversation,
      accountLabel: account.label,
      // The sender as the reply footer shows it: who, not which provider id.
      accountName: account.name,
      accountAvatarUrl: account.avatarUrl,
      messages: messages.filter((message) => message.conversationId === conversation.id).map((message) => ({
        ...message,
        body: message.bodyText,
      })),
    };
  });
  // Every CRM LinkedIn row carries the provider id of its "Message" twin, so
  // keying on it drops the duplicates without losing anything either side holds
  // alone.
  const storedProviderMessageIds = new Set(messages
    .filter((message) => message.channel === "linkedin" && message.providerMessageId)
    .map((message) => message.providerMessageId));
  // Every id the CRM rows already carry, so a message reachable from two
  // stores shows once. Inbox inbound rows share the CRM message's
  // idempotency key; CRM-sent mail is mirrored into the inbox with the CRM
  // message id in `raw`; campaign sends were backfilled with their
  // Message-ID as providerMessageId and their row id in `raw.id`.
  const knownIds = new Set<string>();
  for (const message of messages) {
    knownIds.add(message.id);
    knownIds.add(message.idempotencyKey);
    if (message.providerMessageId) knownIds.add(message.providerMessageId);
    const raw = message.raw as Record<string, unknown> | null;
    if (raw && typeof raw.id === "string" && raw.source === "outreach_emails") knownIds.add(`outreach-email:${raw.id}`);
  }
  const emptyEmailMessage = { conversationId: null, personId: header.record.personId, channel: "email" as const, bodyHtml: null as string | null };
  const timeline = [
    ...messages.map((message) => ({
      ...message,
      body: message.bodyText,
      source: "crm" as const,
      label: null as string | null,
    })),
    ...emailOutreach.flatMap((row) => {
      if ((row.messageId && knownIds.has(row.messageId)) || knownIds.has(`outreach-email:${row.id}`)) return [];
      const message = emailOutreachRowToMessageInput(row);
      if (!message) return [];
      return [{
        ...emptyEmailMessage,
        id: `outreach-email:${row.id}`,
        direction: "outbound" as const,
        subject: message.subject ?? null,
        body: message.bodyText,
        bodyText: message.bodyText,
        bodyHtml: message.bodyHtml ?? null,
        providerMessageId: row.messageId,
        sentAt: row.sentAt!,
        createdAt: row.sentAt!,
        source: "outreach" as const,
        label: `Campaign step ${row.stepNumber}`,
      }];
    }),
    ...inboxHistory.flatMap((row) => {
      const raw = row.raw ?? {};
      if (row.providerMessageKey && knownIds.has(row.providerMessageKey)) return [];
      if (typeof raw.crmConversationMessageId === "string" && knownIds.has(raw.crmConversationMessageId)) return [];
      if (typeof raw.messageId === "string" && knownIds.has(raw.messageId)) return [];
      const bodyText = (row.bodyText ?? "").trim();
      if (!bodyText) return [];
      return [{
        ...emptyEmailMessage,
        id: `inbox-message:${row.id}`,
        direction: row.direction,
        subject: row.subject,
        body: bodyText,
        bodyText,
        bodyHtml: row.bodyHtml,
        providerMessageId: typeof raw.messageId === "string" ? raw.messageId : row.providerMessageKey,
        sentAt: row.sentAt ?? row.createdAt ?? new Date(0),
        createdAt: row.createdAt ?? row.sentAt ?? new Date(0),
        source: "inbox" as const,
        label: "Inbox",
      }];
    }),
    ...linkedinHistory
      .filter(({ message }) => !message.linkedinMessageId || !storedProviderMessageIds.has(message.linkedinMessageId))
      .map(({ message }) => ({
        id: `linkedin-message:${message.id}`,
        conversationId: null,
        personId: header.record.personId,
        channel: "linkedin" as const,
        direction: LINKEDIN_OUTBOUND_TYPES.has(message.type) ? "outbound" as const : "inbound" as const,
        subject: null,
        body: message.text,
        bodyText: message.text,
        bodyHtml: null,
        providerMessageId: message.linkedinMessageId,
        sentAt: message.createdAt,
        createdAt: message.createdAt,
        source: "linkedin" as const,
        label: LINKEDIN_TYPE_LABELS[message.type] ?? null,
      })),
  ].sort((a, b) => new Date(a.sentAt ?? a.createdAt).getTime() - new Date(b.sentAt ?? b.createdAt).getTime());
  return {
    ...header.record,
    person: { ...header.person, company: header.company?.name ?? null },
    company: header.company,
    subcategory: header.subcategory?.name ?? null,
    dnc: header.policy?.doNotContact ?? false,
    contactPolicy: header.policy,
    classification: latestClassification ? {
      ...latestClassification,
      category: latestClassification.appliedCategoryKey ?? latestClassification.proposedCategoryKey,
      subcategory: header.subcategory?.name ?? null,
      reason: latestClassification.reasoning,
      requiresReview: latestClassification.status === "proposed",
    } : null,
    aiChanged: Boolean(latestClassification && !latestClassification.acknowledgedAt),
    conversations: conversationsWithMessages,
    messages,
    timeline,
    events,
    runs,
    stepRuns,
    draft: currentDraft ? {
      ...currentDraft,
      body: currentDraft.editedBodyText ?? currentDraft.aiBodyText,
      bodyHtml: currentDraft.editedBodyHtml ?? currentDraft.aiBodyHtml,
    } : null,
    drafts,
    citations,
    sendAttempts: attempts,
  };
}

export async function getCrmOverview() {
  const [states, categories, subcategories, channels, total, actionRequired, queue] = await Promise.all([
    db.select({ key: crmRecords.workflowState, count: count() }).from(crmRecords).where(inOrg(crmRecords)).groupBy(crmRecords.workflowState),
    db.select({ key: crmRecords.categoryKey, count: count() }).from(crmRecords).where(inOrg(crmRecords)).groupBy(crmRecords.categoryKey),
    db.select({ id: crmSubcategories.id, name: crmSubcategories.name, count: count(crmRecords.id) })
      .from(crmSubcategories).leftJoin(crmRecords, and(inOrg(crmRecords), eq(crmRecords.subcategoryId, crmSubcategories.id)))
      .where(inArray(crmSubcategories.pipelineId, db.select({ id: crmPipelines.id }).from(crmPipelines).where(inOrg(crmPipelines))))
      .groupBy(crmSubcategories.id, crmSubcategories.name),
    db.select({ key: crmRecords.activeChannel, count: count() }).from(crmRecords).where(inOrg(crmRecords)).groupBy(crmRecords.activeChannel),
    db.select({ count: count() }).from(crmRecords).where(inOrg(crmRecords)),
    db.select({ count: count() }).from(crmRecords).where(and(inOrg(crmRecords), eq(crmRecords.workflowState, "action_required"))),
    // The queue and its follow-ups in one pass, with the group the queue's
    // filter uses, so the strip and a filtered list cannot disagree.
    db.select({ queue: count(), followUpsDue: sql<number>`count(*) filter (where ${actionGroup} = 'follow_up')`.mapWith(Number) })
      .from(crmRecords).where(and(inOrg(crmRecords), actionableCondition)),
  ]);
  const totalCount = Number(total[0]?.count ?? 0);
  const customerCount = Number(categories.find((row) => row.key === "customer")?.count ?? 0);
  return {
    total: totalCount,
    actionRequired: Number(actionRequired[0]?.count ?? 0),
    /** Every record in the Action required queue. */
    queue: Number(queue[0]?.queue ?? 0),
    /** Follow-up drafts awaiting approval plus follow-ups past their time, in the queue. */
    followUpsDue: Number(queue[0]?.followUpsDue ?? 0),
    byWorkflowState: Object.fromEntries(states.map((row) => [row.key, Number(row.count)])),
    byCategory: Object.fromEntries(categories.map((row) => [row.key ?? "unclassified", Number(row.count)])),
    bySubcategory: subcategories.map((row) => ({ id: row.id, name: row.name, count: Number(row.count) })),
    byChannel: Object.fromEntries(channels.map((row) => [row.key ?? "none", Number(row.count)])),
    customerConversionRate: totalCount ? customerCount / totalCount : 0,
  };
}

export type CrmPeopleProjection = {
  recordId: string;
  categoryKey: string | null;
  subcategory: string | null;
  workflowState: string;
  closed: boolean;
  closedReason: string | null;
  activeChannel: string | null;
  activeSequence: string | null;
  currentStep: string | null;
  lastInboundAt: Date | null;
  lastOutboundAt: Date | null;
  lastInteractionAt: Date | null;
  nextActionAt: Date | null;
  unacknowledgedAiChange: boolean;
  dnc: boolean;
  latestDraft: {
    status: string;
    autoSendAt: Date | null;
    channel: string;
    subject: string | null;
  } | null;
  contactPolicy: {
    doNotContact: boolean;
    reason: string | null;
    source: string | null;
    reviewAfter: Date | null;
    setAt: Date | null;
    clearedAt: Date | null;
  } | null;
};

export async function crmProjectionForPeople(personIds: string[]): Promise<Map<string, CrmPeopleProjection>> {
  if (!personIds.length) return new Map<string, CrmPeopleProjection>();
  const [records, policies] = await Promise.all([
    db.select({ record: crmRecords, subcategory: crmSubcategories })
      .from(crmRecords).leftJoin(crmSubcategories, eq(crmSubcategories.id, crmRecords.subcategoryId))
      .where(and(inOrg(crmRecords), inArray(crmRecords.personId, personIds))),
    db.select().from(crmPersonContactPolicies).where(inArray(crmPersonContactPolicies.personId, personIds)),
  ]);
  const policyByPerson = new Map(policies.map((p) => [p.personId, p]));
  const recordIds = records.map((row) => row.record.id);
  const [runs, classifications, drafts] = recordIds.length ? await Promise.all([
    db.select({ run: crmSequenceRuns, sequence: crmSequences, step: crmSequenceSteps })
      .from(crmSequenceRuns).innerJoin(crmSequences, eq(crmSequences.id, crmSequenceRuns.sequenceId))
      .leftJoin(crmSequenceSteps, and(eq(crmSequenceSteps.sequenceVersionId, crmSequenceRuns.sequenceVersionId), eq(crmSequenceSteps.position, crmSequenceRuns.currentStepPosition)))
      .where(and(inArray(crmSequenceRuns.crmRecordId, recordIds), inArray(crmSequenceRuns.status, ["active", "paused"]))),
    db.select().from(crmClassifications).where(inArray(crmClassifications.crmRecordId, recordIds)).orderBy(desc(crmClassifications.createdAt)),
    db.select({
      crmRecordId: crmDrafts.crmRecordId,
      status: crmDrafts.status,
      autoSendAt: crmDrafts.autoSendAt,
      channel: crmDrafts.channel,
      subject: crmDrafts.subject,
    }).from(crmDrafts).where(inArray(crmDrafts.crmRecordId, recordIds)).orderBy(desc(crmDrafts.updatedAt)),
  ]) : [[], [], []];
  const runByRecord = new Map(runs.map((row) => [row.run.crmRecordId, row]));
  const classificationByRecord = new Map<string, (typeof classifications)[number]>();
  for (const item of classifications) if (!classificationByRecord.has(item.crmRecordId)) classificationByRecord.set(item.crmRecordId, item);
  const draftByRecord = new Map<string, (typeof drafts)[number]>();
  for (const item of drafts) {
    const prev = draftByRecord.get(item.crmRecordId);
    if (!prev || (prev.status === "discarded" && item.status !== "discarded")) {
      draftByRecord.set(item.crmRecordId, item);
    }
  }
  return new Map<string, CrmPeopleProjection>(records.map(({ record, subcategory }) => {
    const run = runByRecord.get(record.id);
    const classification = classificationByRecord.get(record.id);
    const policy = policyByPerson.get(record.personId);
    const draft = draftByRecord.get(record.id) ?? null;
    return [record.personId, {
      recordId: record.id,
      categoryKey: record.categoryKey,
      subcategory: subcategory?.name ?? null,
      workflowState: record.workflowState,
      closed: record.workflowState === "closed",
      closedReason: record.closedReason ?? null,
      activeChannel: record.activeChannel,
      activeSequence: run?.sequence.name ?? null,
      currentStep: run?.step?.name ?? null,
      lastInboundAt: record.lastInboundAt,
      lastOutboundAt: record.lastOutboundAt,
      lastInteractionAt: record.lastInteractionAt,
      nextActionAt: record.nextActionAt,
      unacknowledgedAiChange: Boolean(classification && !classification.acknowledgedAt),
      dnc: Boolean(policy?.doNotContact),
      latestDraft: draft ? {
        status: draft.status,
        autoSendAt: draft.autoSendAt,
        channel: draft.channel,
        subject: draft.subject,
      } : null,
      contactPolicy: policy ? {
        doNotContact: policy.doNotContact,
        reason: policy.reason,
        source: policy.source,
        reviewAfter: policy.reviewAfter,
        setAt: policy.setAt,
        clearedAt: policy.clearedAt,
      } : null,
    }];
  }));
}
