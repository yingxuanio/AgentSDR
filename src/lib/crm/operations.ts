import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { isPersonDoNotContact } from "./policies";
import { appendCrmEvent } from "./events";
import {
  acknowledgeClassificationInTransaction,
  findClassificationInOrg,
  lockCrmRecord,
  setRecordClassificationInTransaction,
  type CrmRecord,
  transitionWorkflowInTransaction,
} from "./records";
import { CrmConflictError, CrmNotFoundError, type CrmTransaction, withCrmTransaction } from "./repository";
import {
  crmConversationMessages,
  crmConversations,
  crmClassifications,
  crmDrafts,
  crmJobs,
  crmRecords,
  crmSequenceRuns,
  type CrmCategoryKey,
} from "./schema";
import { inboundAnsweredFromCrm } from "./manualOutbound";
import {
  interruptActiveSequenceRunInTransaction,
  startFollowUpsInTransaction,
  startSequenceRunInTransaction,
} from "./sequences";
import { STAGE_MOVED_EVENT, type StageMoveNext } from "./stageMove";
import { inOrg } from "@/lib/tenancy/scope";

export async function applyHumanClassification(input: {
  recordId: string;
  categoryKey: CrmCategoryKey;
  subcategoryId: string | null;
  expectedContextVersion: number;
  classificationId?: string;
  reason?: string | null;
  actorRef?: string | null;
}) {
  return withCrmTransaction(async (tx) => {
    const before = await lockCrmRecord(tx, input.recordId);
    if (!before.latestInboundMessageId) {
      throw new CrmConflictError("CRM record has no inbound message to classify");
    }
    let classificationId = input.classificationId;
    if (!classificationId) {
      const [existing] = await tx.select().from(crmClassifications).where(and(
        eq(crmClassifications.crmRecordId, before.id),
        eq(crmClassifications.messageId, before.latestInboundMessageId),
        eq(crmClassifications.expectedContextVersion, input.expectedContextVersion),
      )).limit(1).for("update");
      if (existing) {
        const [classification] = await tx.update(crmClassifications).set({
          proposedCategoryKey: input.categoryKey,
          proposedSubcategoryId: input.subcategoryId,
          appliedCategoryKey: input.categoryKey,
          appliedSubcategoryId: input.subcategoryId,
          confidence: existing.confidence ?? "1",
          reasoning: input.reason?.trim() || existing.reasoning || "Classified by an authenticated operator",
          status: "accepted",
          error: null,
          acknowledgedAt: new Date(),
          updatedAt: new Date(),
        }).where(eq(crmClassifications.id, existing.id)).returning();
        classificationId = classification!.id;
      } else {
        const [classification] = await tx.insert(crmClassifications).values({
          crmRecordId: before.id,
          messageId: before.latestInboundMessageId,
          expectedContextVersion: input.expectedContextVersion,
          previousCategoryKey: before.categoryKey,
          previousSubcategoryId: before.subcategoryId,
          proposedCategoryKey: input.categoryKey,
          proposedSubcategoryId: input.subcategoryId,
          appliedCategoryKey: input.categoryKey,
          appliedSubcategoryId: input.subcategoryId,
          confidence: "1",
          reasoning: input.reason?.trim() || "Classified by an authenticated operator",
          status: "accepted",
          acknowledgedAt: new Date(),
        }).returning();
        if (!classification) throw new Error("Human classification insert did not return a row");
        classificationId = classification.id;
      }
    }
    const updated = await setRecordClassificationInTransaction(tx, {
      ...input,
      classificationId,
      source: "human",
      actorType: "authenticated_operator",
    });
    // Confirmed after the rep already replied from AgentSDR: that reply was
    // the immediate one, so the confirmed stage continues with its
    // follow-ups instead of drafting a second reply.
    const repliedFromCrm = await inboundAnsweredFromCrm(tx, before.id, before.latestInboundMessageId);
    // A re-applied classification keeps its id, and its draft job has
    // usually already succeeded for the previous run's step.
    return restartRecordWorkInTransaction(tx, updated, {
      draftJob: repliedFromCrm ? null : { entityId: classificationId, requeueCompleted: true },
      actorRef: input.actorRef,
    });
  });
}

/**
 * After a person sets a record's subcategory: retire the drafts written for
 * the old context, start the new subcategory's sequence, and queue its first
 * draft. Shared by a correction and a stage move — they differ in what they
 * record about the AI's classification, not in what happens next.
 *
 * With `draftJob: null` the reply step is skipped instead: the run starts at
 * its first follow-up, nothing is drafted now, and the record waits for that
 * follow-up to come due.
 */
async function restartRecordWorkInTransaction(
  tx: CrmTransaction,
  updated: CrmRecord,
  input: {
    draftJob: { entityId: string; requeueCompleted: boolean } | null;
    actorRef?: string | null;
  },
) {
  // The context just moved on, so every open draft — including hand-written
  // ones, which no sequence run owns — was written for a reply brief that no
  // longer applies. Inbound replies do the same; without it the old draft
  // stays "awaiting review" and fails with a stale-context error on send.
  await tx.update(crmDrafts).set({ status: "stale", updatedAt: new Date() }).where(and(
    eq(crmDrafts.crmRecordId, updated.id),
    inArray(crmDrafts.status, ["generating", "awaiting_review", "failed"]),
    ne(crmDrafts.expectedContextVersion, updated.contextVersion),
  ));
  if (!updated.latestInboundMessageId || await isPersonDoNotContact(tx, updated.personId)) {
    return { record: updated, sequenceRun: null };
  }
  const [conversation] = await tx.select({ id: crmConversations.id })
    .from(crmConversationMessages)
    .innerJoin(crmConversations, eq(crmConversations.id, crmConversationMessages.conversationId))
    .where(and(
      eq(crmConversationMessages.id, updated.latestInboundMessageId),
      eq(crmConversations.crmRecordId, updated.id),
    )).limit(1);
  if (!conversation) throw new CrmConflictError("Latest inbound conversation was not found");
  const runInput = {
    recordId: updated.id,
    conversationId: conversation.id,
    triggerMessageId: updated.latestInboundMessageId,
    expectedContextVersion: updated.contextVersion,
    actorType: "authenticated_operator" as const,
    actorRef: input.actorRef,
  };
  // Nothing is on anyone's desk until the first follow-up comes due; with
  // no follow-ups there is nothing left to do at this stage.
  if (!input.draftJob) return startFollowUpsInTransaction(tx, runInput);
  const started = await startSequenceRunInTransaction(tx, runInput);
  // Same rule as the AI path: a classified reply always gets a draft. When
  // no sequence covers the subcategory the draft comes from the thread.
  const { enqueueCrmJobInTransaction } = await import("./queue");
  const payload = started?.stepRuns[0]
    ? { stepRunId: started.stepRuns[0].id }
    : { recordId: updated.id };
  const { job, created } = await enqueueCrmJobInTransaction(tx, {
    kind: "initial_draft",
    entityId: input.draftJob.entityId,
    payload,
    requeueCompleted: input.draftJob.requeueCompleted,
  });
  // A job still queued from the previous change points at a step run that
  // was just cancelled; aim it at the new one instead.
  if (!created && job.status === "queued") {
    await tx.update(crmJobs).set({ payload, updatedAt: new Date() }).where(and(inOrg(crmJobs), eq(crmJobs.id, job.id), eq(crmJobs.status, "queued")));
  }
  return { record: updated, sequenceRun: started };
}

export type MoveRecordStageInput = {
  recordId: string;
  categoryKey: CrmCategoryKey;
  subcategoryId: string | null;
  expectedContextVersion: number;
  /** When it happened; defaults to now. */
  occurredAt?: Date | null;
  note?: string | null;
  /**
   * What happens next. "follow_up" — the usual case — takes the new stage's
   * immediate reply as already handled and schedules its follow-ups;
   * "reply" drafts that reply now.
   */
  next: StageMoveNext;
  actorRef?: string | null;
};

/**
 * Move a record to another stage because something happened outside the
 * thread — a meeting took place, a trial started. Unlike a correction, the
 * AI's reading of the latest reply was right and stays accepted; what changed
 * is where the deal is. The new stage's sequence starts as it would for a
 * correction, and its drafts are told what happened (see loadDraftSubject).
 */
export function moveRecordStage(input: MoveRecordStageInput) {
  return withCrmTransaction((tx) => moveRecordStageInTransaction(tx, input));
}

export async function moveRecordStageInTransaction(tx: CrmTransaction, input: MoveRecordStageInput) {
  const before = await lockCrmRecord(tx, input.recordId);
  if (!before.latestInboundMessageId) {
    throw new CrmConflictError("CRM record has no inbound message to continue from");
  }
  if (before.categoryKey === input.categoryKey && before.subcategoryId === input.subcategoryId) {
    throw new CrmConflictError("The record is already at this stage");
  }
  const occurredAt = input.occurredAt ?? new Date();
  if (occurredAt.getTime() > Date.now() + 60_000) {
    throw new CrmConflictError("A stage move cannot happen in the future");
  }
  const note = input.note?.trim() || null;
  const updated = await setRecordClassificationInTransaction(tx, {
    recordId: input.recordId,
    categoryKey: input.categoryKey,
    subcategoryId: input.subcategoryId,
    expectedContextVersion: input.expectedContextVersion,
    source: "human",
    actorType: "authenticated_operator",
    actorRef: input.actorRef,
    eventType: STAGE_MOVED_EVENT,
    eventMeta: { occurredAt: occurredAt.toISOString(), note, next: input.next },
  });
  // The draft job is keyed to a classification (a trigger enforces it), so it
  // hangs off the AI's reading of the latest reply — the row this move leaves
  // as it was.
  const [classification] = await tx.select({ id: crmClassifications.id }).from(crmClassifications).where(and(
    eq(crmClassifications.crmRecordId, updated.id),
    eq(crmClassifications.messageId, before.latestInboundMessageId),
  )).orderBy(desc(crmClassifications.createdAt)).limit(1);
  if (!classification) throw new CrmConflictError("Classify the latest reply before moving this record's stage");
  return restartRecordWorkInTransaction(tx, updated, {
    draftJob: input.next === "reply" ? { entityId: classification.id, requeueCompleted: true } : null,
    actorRef: input.actorRef,
  });
}

export async function acknowledgeClassification(input: {
  classificationId: string;
  actorRef?: string | null;
}) {
  return withCrmTransaction((tx) => acknowledgeClassificationInTransaction(tx, {
    classificationId: input.classificationId,
    actorType: "authenticated_operator",
    actorRef: input.actorRef,
  }));
}

export async function undoClassification(input: {
  classificationId: string;
  actorRef?: string | null;
}) {
  return withCrmTransaction(async (tx) => {
    const candidate = await findClassificationInOrg(tx, input.classificationId);
    if (!candidate) throw new CrmNotFoundError("CRM classification", input.classificationId);
    const record = await lockCrmRecord(tx, candidate.crmRecordId);
    const [classification] = await tx.select().from(crmClassifications)
      .where(eq(crmClassifications.id, candidate.id)).limit(1).for("update");
    if (!classification) throw new CrmNotFoundError("CRM classification", input.classificationId);
    if (classification.messageId !== record.latestInboundMessageId) {
      throw new CrmConflictError("Only the latest inbound classification can be undone");
    }
    if (!classification.appliedCategoryKey || classification.status === "rejected") {
      throw new CrmConflictError("This classification has no applied change to undo");
    }
    await interruptActiveSequenceRunInTransaction(tx, {
      recordId: record.id,
      reason: "classification_undone",
      contextVersion: record.contextVersion,
    });
    const now = new Date();
    const nextContextVersion = record.contextVersion + 1;
    const [updated] = await tx.update(crmRecords).set({
      categoryKey: classification.previousCategoryKey,
      subcategoryId: classification.previousSubcategoryId,
      categorySource: classification.previousCategoryKey ? "human" : null,
      categoryLocked: classification.previousCategoryKey === "customer",
      workflowState: "action_required",
      nextActionAt: null,
      contextVersion: nextContextVersion,
      updatedAt: now,
    }).where(eq(crmRecords.id, record.id)).returning();
    await tx.update(crmClassifications).set({
      status: "rejected",
      acknowledgedAt: now,
      updatedAt: now,
    }).where(eq(crmClassifications.id, classification.id));
    await appendCrmEvent(tx, {
      personId: record.personId,
      crmRecordId: record.id,
      pipelineId: record.pipelineId,
      eventType: "classification.undone",
      actorType: "authenticated_operator",
      actorRef: input.actorRef,
      fromData: { categoryKey: record.categoryKey, subcategoryId: record.subcategoryId },
      toData: {
        categoryKey: classification.previousCategoryKey,
        subcategoryId: classification.previousSubcategoryId,
        classificationId: classification.id,
      },
      contextVersion: nextContextVersion,
    });
    return updated!;
  });
}

export async function assignSequenceToRecord(input: {
  recordId: string;
  sequenceId: string;
  conversationId: string;
  expectedContextVersion: number;
  startStepPosition?: number;
  actorRef?: string | null;
}) {
  return withCrmTransaction(async (tx) => {
    const record = await lockCrmRecord(tx, input.recordId);
    if (!record.latestInboundMessageId) throw new CrmConflictError("CRM record has no inbound message");
    const started = await startSequenceRunInTransaction(tx, {
      ...input,
      triggerMessageId: record.latestInboundMessageId,
      actorType: "authenticated_operator",
    });
    if (!started) throw new CrmConflictError("CRM record requires a subcategory before assigning a sequence");
    return started;
  });
}

export async function closeCrmRecord(input: {
  recordId: string;
  reason: string;
  actorRef?: string | null;
}) {
  return withCrmTransaction(async (tx) => {
    const record = await lockCrmRecord(tx, input.recordId);
    const now = new Date();
    await interruptActiveSequenceRunInTransaction(tx, {
      recordId: record.id,
      reason: "record_closed",
      contextVersion: record.contextVersion,
    });
    await tx.update(crmSequenceRuns).set({ status: "cancelled", updatedAt: now })
      .where(and(eq(crmSequenceRuns.crmRecordId, record.id), eq(crmSequenceRuns.status, "interrupted")));
    const discardedDrafts = await tx.update(crmDrafts)
      .set({ status: "discarded", autoSendAt: null, updatedAt: now })
      .where(and(eq(crmDrafts.crmRecordId, record.id), inArray(crmDrafts.status, ["generating", "awaiting_review", "failed"])))
      .returning({ id: crmDrafts.id });
    for (const draft of discardedDrafts) {
      await appendCrmEvent(tx, {
        personId: record.personId,
        crmRecordId: record.id,
        pipelineId: record.pipelineId,
        eventType: "draft.discarded",
        actorType: "authenticated_operator",
        actorRef: input.actorRef,
        fromData: { draftId: draft.id },
        toData: { status: "discarded", reason: "record_closed" },
        contextVersion: record.contextVersion,
      });
    }
    return transitionWorkflowInTransaction(tx, {
      recordId: record.id,
      to: "closed",
      actorType: "authenticated_operator",
      actorRef: input.actorRef,
      reason: "human_close",
      closedReason: input.reason,
    });
  });
}

export async function reopenCrmRecord(input: { recordId: string; actorRef?: string | null }) {
  return withCrmTransaction(async (tx) => {
    const record = await lockCrmRecord(tx, input.recordId);
    if (record.workflowState !== "closed") throw new CrmConflictError("Only closed CRM records can be reopened");
    return transitionWorkflowInTransaction(tx, {
      recordId: record.id,
      to: record.latestInboundMessageId ? "action_required" : "idle",
      actorType: "authenticated_operator",
      actorRef: input.actorRef,
      reason: "human_reopen",
    });
  });
}

export async function createManualDraft(input: {
  recordId: string;
  conversationId: string;
  subject?: string | null;
  bodyText: string;
  bodyHtml?: string | null;
}) {
  const bodyText = input.bodyText.trim();
  if (!bodyText) throw new Error("Draft body is required");
  return withCrmTransaction(async (tx) => {
    const record = await lockCrmRecord(tx, input.recordId);
    if (await isPersonDoNotContact(tx, record.personId)) throw new CrmConflictError("This Person is globally marked Do Not Contact");
    const [conversation] = await tx.select().from(crmConversations)
      .where(and(eq(crmConversations.id, input.conversationId), eq(crmConversations.crmRecordId, record.id))).limit(1);
    if (!conversation) throw new CrmNotFoundError("CRM conversation", input.conversationId);
    if (conversation.channel === "email" && !input.subject?.trim()) throw new Error("Email subject is required");
    const [draft] = await tx.insert(crmDrafts).values({
      crmRecordId: record.id,
      conversationId: conversation.id,
      replyForMessageId: record.latestInboundMessageId,
      expectedContextVersion: record.contextVersion,
      channel: conversation.channel,
      subject: conversation.channel === "email" ? input.subject!.trim() : null,
      editedBodyText: bodyText,
      editedBodyHtml: input.bodyHtml?.trim() || null,
      status: "awaiting_review",
    }).returning();
    if (!draft) throw new Error("Manual CRM draft insert did not return a row");
    await tx.update(crmRecords).set({ workflowState: "action_required", nextActionAt: null, updatedAt: new Date() })
      .where(eq(crmRecords.id, record.id));
    return draft;
  });
}
