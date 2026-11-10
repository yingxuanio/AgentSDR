import { and, eq, inArray } from "drizzle-orm";
import {
  crmClassifications,
  crmConversationMessages,
  crmConversations,
  crmDrafts,
  crmPipelines,
  crmRecords,
  crmSubcategories,
  type CrmCategoryKey,
  type CrmWorkflowState,
} from "./schema";
import { appendCrmEvent, type CrmEventActor } from "./events";
import {
  CrmConflictError,
  CrmNotFoundError,
  type CrmExecutor,
  type CrmTransaction,
  withCrmTransaction,
} from "./repository";
import {
  assertCurrentCrmContext,
  assertWorkflowTransition,
  replyClassificationDecision,
} from "./stateMachine";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import { ensureCrmDefaults } from "./defaults";
import { db } from "@/lib/db";

export type CrmRecord = typeof crmRecords.$inferSelect;
export type CrmClassification = typeof crmClassifications.$inferSelect;

const CATEGORY_KEYS = new Set<CrmCategoryKey>([
  "customer",
  "interested",
  "not_interested",
  "other",
]);

function assertCategoryKey(value: string): asserts value is CrmCategoryKey {
  if (!CATEGORY_KEYS.has(value as CrmCategoryKey)) {
    throw new Error(`Unknown CRM category key: ${value}`);
  }
}

/** Drafts inherit their organization from the CRM record they belong to. */
export function draftInOrg() {
  return inArray(crmDrafts.crmRecordId, db.select({ id: crmRecords.id }).from(crmRecords).where(inOrg(crmRecords)));
}

export async function getCrmRecord(
  executor: CrmExecutor,
  recordId: string,
): Promise<CrmRecord | null> {
  const [record] = await executor
    .select()
    .from(crmRecords)
    .where(and(inOrg(crmRecords), eq(crmRecords.id, recordId)))
    .limit(1);
  return record ?? null;
}

export async function lockCrmRecord(
  tx: CrmTransaction,
  recordId: string,
): Promise<CrmRecord> {
  const [record] = await tx
    .select()
    .from(crmRecords)
    .where(and(inOrg(crmRecords), eq(crmRecords.id, recordId)))
    .limit(1)
    .for("update");
  if (!record) throw new CrmNotFoundError("CRM record", recordId);
  return record;
}

/** The given pipeline (it must be active), else the active default one. */
export async function resolvePipelineId(
  tx: CrmExecutor,
  pipelineId: string | undefined,
): Promise<string> {
  if (pipelineId) {
    const [pipeline] = await tx
      .select({ id: crmPipelines.id, active: crmPipelines.active })
      .from(crmPipelines)
      .where(and(inOrg(crmPipelines), eq(crmPipelines.id, pipelineId)))
      .limit(1);
    if (!pipeline) throw new CrmNotFoundError("CRM pipeline", pipelineId);
    if (!pipeline.active) throw new CrmConflictError("Cannot create a CRM record in an inactive pipeline");
    return pipeline.id;
  }

  const findDefault = async () => {
    const [pipeline] = await tx
      .select({ id: crmPipelines.id, active: crmPipelines.active })
      .from(crmPipelines)
      .where(and(inOrg(crmPipelines), eq(crmPipelines.isDefault, true)))
      .limit(1);
    return pipeline;
  };
  let pipeline = await findDefault();
  if (!pipeline) {
    // A new organization's first record: it gets its default pipeline now.
    await ensureCrmDefaults();
    pipeline = await findDefault();
  }
  if (!pipeline?.active) throw new CrmConflictError("No active default CRM pipeline is configured");
  return pipeline.id;
}

/**
 * The required literal cause prevents import/general CRUD code from using the
 * only record-creation API. Manual imports create People, never CRM records.
 */
export async function getOrCreateCrmRecordForInbound(
  tx: CrmTransaction,
  input: {
    personId: string;
    pipelineId?: string;
    cause: "first_inbound_reply";
  },
): Promise<{ record: CrmRecord; created: boolean }> {
  return upsertCrmRecord(tx, input.personId, input.pipelineId);
}

/**
 * The other way a person earns a CRM record: a rep spoke to them on a call
 * (src/lib/calls/leadStage.ts) — setting their stage by hand, or the call's
 * transcript classifying them. Unlike the inbound path, whose caller emits
 * `record.created` alongside its reply bookkeeping, this emits it here, since
 * a call has nothing else to record in the CRM. A record created this way has
 * no conversation and no inbound message, so the inbound-only operations
 * (moveRecordStage, applyHumanClassification) do not apply to it, and nothing
 * here starts a sequence: sequences run on a conversation, which a call-only
 * record gets from the lead's first reply (email, LinkedIn or WhatsApp).
 */
export async function getOrCreateCrmRecordForCall(
  tx: CrmTransaction,
  input: {
    personId: string;
    pipelineId?: string;
    cause: "first_call";
    actorType: CrmEventActor;
    actorRef?: string | null;
  },
): Promise<{ record: CrmRecord; created: boolean }> {
  const result = await upsertCrmRecord(tx, input.personId, input.pipelineId);
  if (result.created) {
    await appendCrmEvent(tx, {
      personId: result.record.personId,
      crmRecordId: result.record.id,
      pipelineId: result.record.pipelineId,
      eventType: "record.created",
      actorType: input.actorType,
      actorRef: input.actorRef,
      toData: { cause: input.cause },
      contextVersion: result.record.contextVersion,
    });
  }
  return result;
}

async function upsertCrmRecord(
  tx: CrmTransaction,
  personId: string,
  requestedPipelineId: string | undefined,
): Promise<{ record: CrmRecord; created: boolean }> {
  const pipelineId = await resolvePipelineId(tx, requestedPipelineId);
  const [created] = await tx
    .insert(crmRecords)
    .values({ organizationId: currentOrganizationId(), personId, pipelineId })
    .onConflictDoNothing({ target: [crmRecords.personId, crmRecords.pipelineId] })
    .returning();

  if (created) return { record: created, created: true };

  const [existing] = await tx
    .select()
    .from(crmRecords)
    .where(and(inOrg(crmRecords), eq(crmRecords.personId, personId), eq(crmRecords.pipelineId, pipelineId)))
    .limit(1);
  if (!existing) throw new Error("CRM record upsert completed without a readable row");
  return { record: existing, created: false };
}

export async function ensurePersonCrmRecord(
  tx: CrmTransaction,
  input: {
    personId: string;
    pipelineId?: string;
    workflowState?: CrmWorkflowState;
    categoryKey?: CrmCategoryKey;
    actorType?: CrmEventActor;
  },
): Promise<{ record: CrmRecord; created: boolean }> {
  const result = await upsertCrmRecord(tx, input.personId, input.pipelineId);
  if (result.created) {
    await appendCrmEvent(tx, {
      personId: result.record.personId,
      crmRecordId: result.record.id,
      pipelineId: result.record.pipelineId,
      eventType: "record.created",
      actorType: input.actorType ?? "integration",
      actorRef: null,
      toData: { cause: "lead_ingestion" },
      contextVersion: result.record.contextVersion,
    });
  }
  if (input.workflowState || input.categoryKey) {
    const updates: Partial<typeof crmRecords.$inferInsert> = {};
    if (input.workflowState && input.workflowState !== result.record.workflowState) {
      updates.workflowState = input.workflowState;
    }
    if (input.categoryKey && input.categoryKey !== result.record.categoryKey) {
      updates.categoryKey = input.categoryKey;
      updates.categorySource = input.actorType === "human" ? "human" : "integration";
    }
    if (Object.keys(updates).length > 0) {
      updates.updatedAt = new Date();
      const [updated] = await tx
        .update(crmRecords)
        .set(updates)
        .where(eq(crmRecords.id, result.record.id))
        .returning();
      if (updated) return { record: updated, created: result.created };
    }
  }
  return result;
}

async function validateSubcategory(
  tx: CrmTransaction,
  input: {
    pipelineId: string;
    categoryKey: CrmCategoryKey;
    subcategoryId: string | null;
    requireActive?: boolean;
  },
) {
  if (!input.subcategoryId) return null;
  const [subcategory] = await tx
    .select()
    .from(crmSubcategories)
    .where(and(
      eq(crmSubcategories.id, input.subcategoryId),
      eq(crmSubcategories.pipelineId, input.pipelineId),
      eq(crmSubcategories.categoryKey, input.categoryKey),
    ))
    .limit(1);
  if (!subcategory) {
    throw new CrmConflictError("Subcategory does not belong to the record pipeline and category");
  }
  if (input.requireActive !== false && !subcategory.active) {
    throw new CrmConflictError("Archived subcategories cannot be newly assigned");
  }
  return subcategory;
}

export type TransitionWorkflowInput = {
  recordId: string;
  to: CrmWorkflowState;
  actorType: CrmEventActor;
  actorRef?: string | null;
  reason?: string | null;
  expectedContextVersion?: number;
  nextActionAt?: Date | null;
  closedReason?: string | null;
};

export async function transitionWorkflowInTransaction(
  tx: CrmTransaction,
  input: TransitionWorkflowInput,
): Promise<CrmRecord> {
  const record = await lockCrmRecord(tx, input.recordId);
  if (input.expectedContextVersion !== undefined) {
    assertCurrentCrmContext(record, { contextVersion: input.expectedContextVersion });
  }
  assertWorkflowTransition(record.workflowState, input.to);
  if (input.to === "closed" && !input.closedReason?.trim()) {
    throw new Error("Closing a CRM record requires a reason");
  }

  if (record.workflowState === input.to) return record;
  const nextContextVersion = record.contextVersion + 1;
  const nextActionAt = input.nextActionAt !== undefined
    ? input.nextActionAt
    : (["action_required", "idle", "paused", "closed", "error"] as CrmWorkflowState[]).includes(input.to)
      ? null
      : record.nextActionAt;
  const [updated] = await tx
    .update(crmRecords)
    .set({
      workflowState: input.to,
      contextVersion: nextContextVersion,
      nextActionAt,
      closedReason: input.to === "closed" ? input.closedReason!.trim() : record.closedReason,
      updatedAt: new Date(),
    })
    .where(eq(crmRecords.id, record.id))
    .returning();
  if (!updated) throw new Error("CRM workflow update did not return a row");

  await appendCrmEvent(tx, {
    personId: record.personId,
    crmRecordId: record.id,
    pipelineId: record.pipelineId,
    eventType: "workflow.state_changed",
    actorType: input.actorType,
    actorRef: input.actorRef,
    fromData: { workflowState: record.workflowState, nextActionAt: record.nextActionAt },
    toData: { workflowState: updated.workflowState, nextActionAt: updated.nextActionAt },
    meta: input.reason ? { reason: input.reason } : null,
    contextVersion: nextContextVersion,
  });
  return updated;
}

export function transitionWorkflow(input: TransitionWorkflowInput): Promise<CrmRecord> {
  return withCrmTransaction((tx) => transitionWorkflowInTransaction(tx, input));
}

type ClassificationTarget = {
  categoryKey: CrmCategoryKey;
  subcategoryId: string | null;
};

export type SetRecordClassificationInput = ClassificationTarget & {
  recordId: string;
  source: "human" | "integration";
  actorType: "human" | "integration" | "authenticated_operator";
  actorRef?: string | null;
  expectedContextVersion: number;
  latestInboundMessageId?: string | null;
  reason?: string | null;
  classificationId?: string;
  /** Defaults to "classification.changed"; a stage move records "stage.moved". */
  eventType?: string;
  eventMeta?: Record<string, unknown>;
};

export async function setRecordClassificationInTransaction(
  tx: CrmTransaction,
  input: SetRecordClassificationInput,
): Promise<CrmRecord> {
  assertCategoryKey(input.categoryKey);
  const record = await lockCrmRecord(tx, input.recordId);
  assertCurrentCrmContext(record, {
    contextVersion: input.expectedContextVersion,
    latestInboundMessageId: input.latestInboundMessageId,
  });
  await validateSubcategory(tx, { ...input, pipelineId: record.pipelineId });

  const nextContextVersion = record.contextVersion + 1;
  const [updated] = await tx
    .update(crmRecords)
    .set({
      categoryKey: input.categoryKey,
      subcategoryId: input.subcategoryId,
      categorySource: input.source,
      categoryLocked: input.categoryKey === "customer",
      workflowState: "action_required",
      contextVersion: nextContextVersion,
      updatedAt: new Date(),
    })
    .where(eq(crmRecords.id, record.id))
    .returning();
  if (!updated) throw new Error("CRM classification update did not return a row");

  if (input.classificationId) {
    const [classification] = await tx
      .select()
      .from(crmClassifications)
      .where(and(
        eq(crmClassifications.id, input.classificationId),
        eq(crmClassifications.crmRecordId, record.id),
      ))
      .limit(1)
      .for("update");
    if (!classification) throw new CrmNotFoundError("CRM classification", input.classificationId);
    if (classification.messageId !== record.latestInboundMessageId) {
      throw new CrmConflictError("Cannot apply a classification for an older inbound message");
    }
    if (classification.status === "stale" || classification.status === "failed") {
      throw new CrmConflictError(`Cannot apply a ${classification.status} classification`);
    }
    await tx
      .update(crmClassifications)
      .set({
        appliedCategoryKey: input.categoryKey,
        appliedSubcategoryId: input.subcategoryId,
        status: classification.proposedCategoryKey === input.categoryKey
          && classification.proposedSubcategoryId === input.subcategoryId
          ? "accepted"
          : "overridden",
        acknowledgedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(crmClassifications.id, classification.id));
  }

  await appendCrmEvent(tx, {
    personId: record.personId,
    crmRecordId: record.id,
    pipelineId: record.pipelineId,
    eventType: input.eventType ?? "classification.changed",
    actorType: input.actorType,
    actorRef: input.actorRef,
    fromData: {
      categoryKey: record.categoryKey,
      subcategoryId: record.subcategoryId,
      categorySource: record.categorySource,
      categoryLocked: record.categoryLocked,
    },
    toData: {
      categoryKey: updated.categoryKey,
      subcategoryId: updated.subcategoryId,
      categorySource: updated.categorySource,
      categoryLocked: updated.categoryLocked,
    },
    meta: {
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.classificationId ? { classificationId: input.classificationId } : {}),
      ...input.eventMeta,
    },
    contextVersion: nextContextVersion,
  });
  return updated;
}

export function setRecordClassification(input: SetRecordClassificationInput): Promise<CrmRecord> {
  return withCrmTransaction((tx) => setRecordClassificationInTransaction(tx, input));
}

export type RecordAiClassificationInput = ClassificationTarget & {
  recordId: string;
  messageId: string;
  expectedContextVersion: number;
  confidence: number;
  reasoning?: string | null;
  provider?: string | null;
  model?: string | null;
  request?: Record<string, unknown> | null;
  response?: Record<string, unknown> | null;
};

export async function recordAiClassificationInTransaction(
  tx: CrmTransaction,
  input: RecordAiClassificationInput,
): Promise<{ classification: CrmClassification; record: CrmRecord; applied: boolean; stale: boolean }> {
  assertCategoryKey(input.categoryKey);
  if (input.confidence < 0 || input.confidence > 1) {
    throw new Error("Classification confidence must be between 0 and 1");
  }

  const record = await lockCrmRecord(tx, input.recordId);
  const [triggerMessage] = await tx
    .select({
      personId: crmConversationMessages.personId,
      direction: crmConversationMessages.direction,
      crmRecordId: crmConversations.crmRecordId,
    })
    .from(crmConversationMessages)
    .innerJoin(crmConversations, eq(crmConversations.id, crmConversationMessages.conversationId))
    .where(eq(crmConversationMessages.id, input.messageId))
    .limit(1);
  if (
    !triggerMessage
    || triggerMessage.crmRecordId !== record.id
    || triggerMessage.personId !== record.personId
    || triggerMessage.direction !== "inbound"
  ) {
    throw new CrmConflictError("Classification trigger is not an inbound message on this CRM record");
  }
  const [duplicate] = await tx
    .select()
    .from(crmClassifications)
    .where(and(
      eq(crmClassifications.messageId, input.messageId),
      eq(crmClassifications.expectedContextVersion, input.expectedContextVersion),
    ))
    .limit(1);
  if (duplicate) {
    if (duplicate.crmRecordId !== record.id) {
      throw new CrmConflictError("Classification idempotency key belongs to another CRM record");
    }
    // A failed AI attempt owns this message/context identity, but it is not a
    // completed result. Durable job retries replace that visible failure in
    // place; all non-failed outcomes remain strictly idempotent.
    if (duplicate.status !== "failed") {
      return {
        classification: duplicate,
        record,
        applied: duplicate.status === "auto_applied",
        stale: duplicate.status === "stale",
      };
    }
  }

  const stale = record.contextVersion !== input.expectedContextVersion
    || record.latestInboundMessageId !== input.messageId;
  if (stale) {
    await validateSubcategory(tx, {
      ...input,
      pipelineId: record.pipelineId,
      requireActive: false,
    });
    const values: typeof crmClassifications.$inferInsert = {
        crmRecordId: record.id,
        messageId: input.messageId,
        expectedContextVersion: input.expectedContextVersion,
        previousCategoryKey: record.categoryKey,
        previousSubcategoryId: record.subcategoryId,
        proposedCategoryKey: input.categoryKey,
        proposedSubcategoryId: input.subcategoryId,
        confidence: String(input.confidence),
        reasoning: input.reasoning,
        status: "stale",
        provider: input.provider,
        model: input.model,
        request: input.request,
        response: input.response,
        error: null,
        updatedAt: new Date(),
      };
    const [classification] = duplicate
      ? await tx.update(crmClassifications).set(values)
        .where(eq(crmClassifications.id, duplicate.id)).returning()
      : await tx.insert(crmClassifications).values(values).returning();
    if (!classification) throw new Error("Stale classification insert did not return a row");
    await appendCrmEvent(tx, {
      personId: record.personId,
      crmRecordId: record.id,
      pipelineId: record.pipelineId,
      eventType: "classification.stale",
      actorType: "ai",
      fromData: null,
      toData: { classificationId: classification.id },
      meta: {
        messageId: input.messageId,
        expectedContextVersion: input.expectedContextVersion,
        currentContextVersion: record.contextVersion,
      },
      contextVersion: record.contextVersion,
    });
    return { classification, record, applied: false, stale: true };
  }

  const subcategory = await validateSubcategory(tx, { ...input, pipelineId: record.pipelineId });
  const [currentSubcategory] = record.subcategoryId
    ? await tx.select({ stageRank: crmSubcategories.stageRank }).from(crmSubcategories)
      .where(eq(crmSubcategories.id, record.subcategoryId)).limit(1)
    : [];
  const decision = replyClassificationDecision({
    currentCategoryKey: record.categoryKey as CrmCategoryKey | null,
    currentCategoryLocked: record.categoryLocked,
    proposedCategoryKey: input.categoryKey,
    subcategoryReviewRequired: subcategory?.reviewRequired ?? false,
    currentStageRank: currentSubcategory?.stageRank ?? null,
    proposedStageRank: subcategory?.stageRank ?? null,
  });
  // keep_current takes effect like an applied reading — the reply is drafted
  // straight away — with the record's own stage as the applied one.
  const moved = decision === "auto_apply";
  const applied = moved || decision === "keep_current";
  const appliedCategoryKey = moved ? input.categoryKey : applied ? record.categoryKey as CrmCategoryKey | null : null;
  const appliedSubcategoryId = moved ? input.subcategoryId : applied ? record.subcategoryId : null;

  const values: typeof crmClassifications.$inferInsert = {
      crmRecordId: record.id,
      messageId: input.messageId,
      expectedContextVersion: input.expectedContextVersion,
      previousCategoryKey: record.categoryKey,
      previousSubcategoryId: record.subcategoryId,
      proposedCategoryKey: input.categoryKey,
      proposedSubcategoryId: input.subcategoryId,
      appliedCategoryKey,
      appliedSubcategoryId,
      confidence: String(input.confidence),
      reasoning: input.reasoning,
      status: applied ? "auto_applied" : "proposed",
      provider: input.provider,
      model: input.model,
      request: input.request,
      response: input.response,
      error: null,
      updatedAt: new Date(),
    };
  const [classification] = duplicate
    ? await tx.update(crmClassifications).set(values)
      .where(eq(crmClassifications.id, duplicate.id)).returning()
    : await tx.insert(crmClassifications).values(values).returning();
  if (!classification) throw new Error("Classification insert did not return a row");

  const nextContextVersion = record.contextVersion + 1;
  const [updated] = await tx
    .update(crmRecords)
    .set({
      ...(moved ? {
        categoryKey: input.categoryKey,
        subcategoryId: input.subcategoryId,
        categorySource: "ai" as const,
        categoryLocked: false,
      } : {}),
      // An applied classification hands straight off to the draft job, so the
      // record is waiting on us, not on a person. Only a classification a human
      // still has to decide belongs in the action queue; the draft moves the
      // record back to action_required the moment it is ready to review.
      workflowState: applied ? ("waiting" as const) : ("action_required" as const),
      nextActionAt: applied ? new Date() : null,
      contextVersion: nextContextVersion,
      updatedAt: new Date(),
    })
    .where(eq(crmRecords.id, record.id))
    .returning();
  if (!updated) throw new Error("CRM record update did not return a row");

  await appendCrmEvent(tx, {
    personId: record.personId,
    crmRecordId: record.id,
    pipelineId: record.pipelineId,
    eventType: applied ? "classification.auto_applied" : "classification.proposed",
    actorType: "ai",
    fromData: { categoryKey: record.categoryKey, subcategoryId: record.subcategoryId },
    toData: {
      classificationId: classification.id,
      categoryKey: moved ? input.categoryKey : record.categoryKey,
      subcategoryId: moved ? input.subcategoryId : record.subcategoryId,
    },
    meta: { decision, confidence: input.confidence, reasoning: input.reasoning ?? null },
    contextVersion: nextContextVersion,
  });
  return { classification, record: updated, applied, stale: false };
}

export function recordAiClassification(input: RecordAiClassificationInput) {
  return withCrmTransaction((tx) => recordAiClassificationInTransaction(tx, input));
}

/**
 * A classification by id, only when its record belongs to the organization
 * in scope. crm_classifications inherits its organization from crm_records,
 * so a lookup by a caller-supplied classification id must go through the
 * record: another organization's classification reads as not found, and
 * nothing about it (its record's id included) reaches the caller.
 */
export async function findClassificationInOrg(
  tx: CrmTransaction,
  classificationId: string,
): Promise<CrmClassification | null> {
  const [row] = await tx
    .select({ classification: crmClassifications })
    .from(crmClassifications)
    .innerJoin(crmRecords, eq(crmRecords.id, crmClassifications.crmRecordId))
    .where(and(inOrg(crmRecords), eq(crmClassifications.id, classificationId)))
    .limit(1);
  return row?.classification ?? null;
}

export async function acknowledgeClassificationInTransaction(
  tx: CrmTransaction,
  input: {
    classificationId: string;
    actorType: "human" | "authenticated_operator";
    actorRef?: string | null;
  },
): Promise<CrmClassification> {
  const candidate = await findClassificationInOrg(tx, input.classificationId);
  if (!candidate) throw new CrmNotFoundError("CRM classification", input.classificationId);

  // Record-before-classification is the lock order used by every mutation.
  const record = await lockCrmRecord(tx, candidate.crmRecordId);
  const [classification] = await tx
    .select()
    .from(crmClassifications)
    .where(eq(crmClassifications.id, candidate.id))
    .limit(1)
    .for("update");
  if (!classification) throw new CrmNotFoundError("CRM classification", input.classificationId);
  if (classification.acknowledgedAt) return classification;
  const acknowledgedAt = new Date();
  const [updated] = await tx
    .update(crmClassifications)
    .set({ acknowledgedAt, updatedAt: acknowledgedAt })
    .where(eq(crmClassifications.id, classification.id))
    .returning();
  if (!updated) throw new Error("Classification acknowledgment did not return a row");

  await appendCrmEvent(tx, {
    personId: record.personId,
    crmRecordId: record.id,
    pipelineId: record.pipelineId,
    eventType: "classification.acknowledged",
    actorType: input.actorType,
    actorRef: input.actorRef,
    fromData: { acknowledgedAt: null },
    toData: { acknowledgedAt: acknowledgedAt.toISOString() },
    meta: { classificationId: classification.id },
    contextVersion: record.contextVersion,
  });
  return updated;
}

export function acknowledgeClassification(
  input: Parameters<typeof acknowledgeClassificationInTransaction>[1],
) {
  return withCrmTransaction((tx) => acknowledgeClassificationInTransaction(tx, input));
}
