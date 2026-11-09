import { and, asc, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { messageParticipants } from "./participants";
import { formatAiInstructions } from "./ai/instructions";
import { db } from "@/lib/db";
import { companies, people } from "@/lib/leads/schema";
import { generateCrmDraft, type DraftCompletion, type DraftRevisionRequest, type GenerateCrmDraftInput } from "./ai/draft";
import { loadCallContextMessages } from "./callHistory";
import { loadDraftNow, loadDraftSender } from "./draftSender";
import { appendCrmEvent } from "./events";
import { retrieveKnowledge } from "./knowledge";
import { isPersonDoNotContact } from "./policies";
import {
  CrmConflictError,
  CrmNotFoundError,
  type CrmTransaction,
  withCrmTransaction,
} from "./repository";
import { draftInOrg, lockCrmRecord } from "./records";
import { releaseStepRunDraftLinks } from "./sequences";
import { currentStageMoveInTransaction } from "./stageMove";
import {
  crmClassifications,
  crmConversationMessages,
  crmConversations,
  crmDraftKnowledgeCitations,
  crmDrafts,
  crmRecords,
  crmSequenceRuns,
  crmSequences,
  crmSequenceStepRuns,
  crmSequenceSteps,
  crmSettings,
  crmSubcategories,
} from "./schema";
import { assertCurrentCrmContext } from "./stateMachine";
import { inOrg } from "@/lib/tenancy/scope";

export type CrmDraft = typeof crmDrafts.$inferSelect;


type PreparedDraft = {
  draft: CrmDraft;
  promptInput: GenerateCrmDraftInput;
};

function textToParagraphHtml(bodyText: string): string {
  const escaped = bodyText
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<p>${escaped.replace(/\n\n/g, "</p><p>").replace(/\n/g, "<br/>")}</p>`;
}

async function syncEmailDraftAcrossInboxAndOutreach(
  tx: CrmTransaction,
  record: { organizationId: string; personId: string },
  subject: string | null | undefined,
  bodyText: string,
  bodyHtml: string | null | undefined,
): Promise<void> {
  const [person] = await tx
    .select({ email: people.email })
    .from(people)
    .where(and(eq(people.organizationId, record.organizationId), eq(people.id, record.personId)))
    .limit(1);
  const email = person?.email?.trim();
  if (!email) return;

  const finalHtml = bodyHtml?.trim() || textToParagraphHtml(bodyText);
  const finalSubject = subject?.trim() || null;

  await tx.execute(sql`
    UPDATE crm_email_drafts
    SET subject = COALESCE(${finalSubject}, subject),
        body_html = ${finalHtml}
    WHERE lead_id IN (
      SELECT id FROM crm_leads
      WHERE organization_id = ${record.organizationId}::uuid
        AND lower(email) = lower(${email})
    )
  `);

  await tx.execute(sql`
    UPDATE outreach_emails
    SET subject = COALESCE(${finalSubject}, subject),
        body = ${finalHtml}
    WHERE status = 'scheduled'
      AND lead_id IN (
        SELECT ol.id
        FROM outreach_leads ol
        INNER JOIN outreach_campaigns oc ON oc.id = ol.campaign_id
        WHERE oc.organization_id = ${record.organizationId}::uuid
          AND lower(ol.email) = lower(${email})
      )
  `);
}

function scalarAttributes(raw: Record<string, unknown> | null | undefined) {
  return Object.fromEntries(Object.entries(raw ?? {}).filter((entry): entry is [string, string | number | boolean | null] => {
    const value = entry[1];
    return value === null || ["string", "number", "boolean"].includes(typeof value);
  }));
}

/**
 * Everything a draft prompt needs that does not come from a sequence step.
 * Shared by the sequence path and the no-sequence fallback so both send the
 * model the same picture of the person and the thread.
 */
async function loadDraftSubject(
  tx: CrmTransaction,
  record: Awaited<ReturnType<typeof lockCrmRecord>>,
  conversationId: string,
  knowledge: { query: string; knowledgeTags: string[] },
) {
  const [profile] = await tx
    .select({ person: people, company: companies })
    .from(people)
    .leftJoin(companies, eq(companies.id, people.companyId))
    .where(and(inOrg(people), eq(people.id, record.personId)))
    .limit(1);
  if (!profile) throw new CrmNotFoundError("Person", record.personId);

  const messages = await tx
    .select()
    .from(crmConversationMessages)
    .where(eq(crmConversationMessages.conversationId, conversationId))
    .orderBy(asc(crmConversationMessages.sentAt), asc(crmConversationMessages.id));
  // A WhatsApp conversation also gets the lead's recent call summaries.
  const calls = messages[0]?.channel === "whatsapp"
    ? await loadCallContextMessages(tx, record.personId)
    : [];

  const [subcategory] = record.subcategoryId
    ? await tx.select().from(crmSubcategories).where(eq(crmSubcategories.id, record.subcategoryId)).limit(1)
    : [];
  const [classification] = await tx
    .select()
    .from(crmClassifications)
    .where(and(
      eq(crmClassifications.crmRecordId, record.id),
      inArray(crmClassifications.status, ["auto_applied", "accepted", "overridden"]),
    ))
    .orderBy(desc(crmClassifications.createdAt))
    .limit(1);

  const retrieved = await retrieveKnowledge(tx, knowledge);
  const stageMove = await currentStageMoveInTransaction(tx, record);
  const [conversation] = await tx
    .select({ channel: crmConversations.channel, accountRef: crmConversations.accountRef })
    .from(crmConversations)
    .where(eq(crmConversations.id, conversationId))
    .limit(1);
  const sender = conversation ? await loadDraftSender(tx, conversation) : null;
  const now = await loadDraftNow();
  const [settings] = await tx
    .select({ draftInstructions: crmSettings.draftInstructions })
    .from(crmSettings)
    .where(eq(crmSettings.pipelineId, record.pipelineId))
    .limit(1);

  return {
    knowledge: retrieved.entries,
    person: {
      id: profile.person.id,
      fullName: profile.person.fullName,
      firstName: profile.person.firstName,
      lastName: profile.person.lastName,
      email: profile.person.email,
      linkedinUrl: profile.person.linkedinUrl,
      title: profile.person.title,
      attributes: scalarAttributes(profile.person.raw),
    },
    company: profile.company ? {
      id: profile.company.id,
      name: profile.company.name,
      domain: profile.company.domain,
      linkedinUrl: profile.company.linkedinUrl,
      attributes: scalarAttributes(profile.company.raw),
    } : null,
    recentConversation: [
      ...messages.map((message) => ({
        id: message.id,
        channel: message.channel,
        direction: message.direction,
        sentAt: message.sentAt,
        subject: message.subject,
        bodyText: message.bodyText,
        participants: messageParticipants(message),
      })),
      ...calls,
    ],
    acceptedClassification: {
      categoryKey: record.categoryKey ?? "other",
      subcategoryKey: subcategory?.key ?? null,
      // After a stage move the classifier's reasoning describes the old
      // stage ("they asked for a meeting"); the move is what the brief is.
      reasoning: stageMove
        ? `A person moved this record to ${stageMove.stage}; see stageChange.`
        : classification?.reasoning?.trim() || "Human-approved CRM classification",
    },
    stageChange: stageMove,
    instructions: formatAiInstructions(settings?.draftInstructions),
    sender,
    now,
    mergeVariables: {
      first_name: profile.person.firstName,
      last_name: profile.person.lastName,
      full_name: profile.person.fullName,
      company_name: profile.company?.name ?? null,
    },
  };
}

// The worker drafts a step that is waiting for one; a reviewer may also redraft
// one whose draft is already ready (awaiting_review). The worker must never do
// the latter, or a retried job would overwrite a draft someone is reviewing.
const DRAFTABLE_STEP_STATUSES = ["scheduled", "drafting", "failed"];
const REDRAFTABLE_STEP_STATUSES = [...DRAFTABLE_STEP_STATUSES, "awaiting_review"];

async function loadDraftContext(
  tx: CrmTransaction,
  stepRunId: string,
  regenerating = false,
): Promise<PreparedDraft> {
  const [scope] = await tx
    .select({
      stepRun: crmSequenceStepRuns,
      step: crmSequenceSteps,
      run: crmSequenceRuns,
      conversation: crmConversations,
    })
    .from(crmSequenceStepRuns)
    .innerJoin(crmSequenceSteps, eq(crmSequenceSteps.id, crmSequenceStepRuns.sequenceStepId))
    .innerJoin(crmSequenceRuns, eq(crmSequenceRuns.id, crmSequenceStepRuns.sequenceRunId))
    .innerJoin(crmConversations, eq(crmConversations.id, crmSequenceRuns.conversationId))
    .where(and(inOrg(crmSequenceRuns), inOrg(crmConversations), eq(crmSequenceStepRuns.id, stepRunId)))
    .limit(1)
    .for("update");
  if (!scope) throw new CrmNotFoundError("CRM sequence step run", stepRunId);
  if (scope.run.status !== "active") throw new CrmConflictError("Sequence run is not active");
  if (!(regenerating ? REDRAFTABLE_STEP_STATUSES : DRAFTABLE_STEP_STATUSES).includes(scope.stepRun.status)) {
    throw new CrmConflictError(`Cannot generate a draft for a step that is ${scope.stepRun.status.replace(/_/g, " ")}`);
  }

  const record = await lockCrmRecord(tx, scope.run.crmRecordId);
  assertCurrentCrmContext(record, {
    contextVersion: scope.stepRun.expectedContextVersion,
    latestInboundMessageId: scope.run.triggerMessageId,
  });
  if (await isPersonDoNotContact(tx, record.personId)) {
    throw new CrmConflictError("This Person is globally marked Do Not Contact");
  }
  if (record.lastInboundAt && record.lastInboundAt > scope.run.lastInboundAtStart) {
    throw new CrmConflictError("A newer inbound reply interrupted this sequence step");
  }

  const subject = await loadDraftSubject(tx, record, scope.conversation.id, {
    query: [scope.step.name, scope.step.aiInstructions, scope.step.bodyTemplate].filter(Boolean).join(" "),
    knowledgeTags: scope.step.knowledgeTags,
  });
  const [{ totalSteps } = { totalSteps: 0 }] = await tx
    .select({ totalSteps: count() })
    .from(crmSequenceSteps)
    .where(eq(crmSequenceSteps.sequenceVersionId, scope.step.sequenceVersionId));

  let [draft] = scope.stepRun.draftId
    ? await tx.select().from(crmDrafts).where(eq(crmDrafts.id, scope.stepRun.draftId)).limit(1).for("update")
    : [];
  if (draft && regenerating && !["awaiting_review", "failed"].includes(draft.status)) {
    throw new CrmConflictError(`Cannot regenerate a ${draft.status} draft`);
  }
  const now = new Date();
  if (!draft) {
    await releaseStepRunDraftLinks(tx, scope.stepRun.id);
    [draft] = await tx.insert(crmDrafts).values({
      crmRecordId: record.id,
      conversationId: scope.conversation.id,
      replyForMessageId: scope.step.stepType === "reply" ? scope.run.triggerMessageId : null,
      sequenceStepRunId: scope.stepRun.id,
      expectedContextVersion: record.contextVersion,
      channel: scope.conversation.channel,
      status: "generating",
    }).returning();
    if (!draft) throw new Error("CRM draft insert did not return a row");
    await tx.update(crmSequenceStepRuns).set({
      status: "drafting",
      draftId: draft.id,
      attemptCount: scope.stepRun.attemptCount + 1,
      lastError: null,
      updatedAt: now,
    }).where(eq(crmSequenceStepRuns.id, scope.stepRun.id));
  } else {
    [draft] = await tx.update(crmDrafts).set({
      status: "generating",
      error: null,
      revision: draft.revision + 1,
      expectedContextVersion: record.contextVersion,
      updatedAt: now,
    }).where(eq(crmDrafts.id, draft.id)).returning();
    await tx.update(crmSequenceStepRuns).set({
      status: "drafting",
      attemptCount: scope.stepRun.attemptCount + 1,
      lastError: null,
      updatedAt: now,
    }).where(eq(crmSequenceStepRuns.id, scope.stepRun.id));
  }

  return {
    draft: draft!,
    promptInput: {
      channel: scope.conversation.channel,
      sequenceStep: {
        id: scope.step.id,
        name: scope.step.name,
        position: scope.step.position,
        stepType: scope.step.stepType,
        subjectTemplate: scope.step.subjectTemplate,
        bodyTemplate: scope.step.bodyTemplate,
        aiInstructions: scope.step.aiInstructions,
        knowledgeTags: scope.step.knowledgeTags,
      },
      ...subject,
      totalSteps: Number(totalSteps) || null,
    },
  };
}

async function finishGeneratedDraft(
  prepared: PreparedDraft,
  generated: Awaited<ReturnType<typeof generateCrmDraft>>,
  /** A person asked for this draft (Regenerate), so it waits for them. */
  options: { personRequested?: boolean } = {},
): Promise<CrmDraft> {
  return withCrmTransaction(async (tx) => {
    const [draft] = await tx.select().from(crmDrafts)
      .where(and(draftInOrg(), eq(crmDrafts.id, prepared.draft.id))).limit(1).for("update");
    if (!draft) throw new CrmNotFoundError("CRM draft", prepared.draft.id);
    const record = await lockCrmRecord(tx, draft.crmRecordId);
    if (draft.status !== "generating" || draft.revision !== prepared.draft.revision) {
      throw new CrmConflictError("Draft generation was superseded by a newer revision");
    }
    assertCurrentCrmContext(record, { contextVersion: draft.expectedContextVersion });

    const now = new Date();
    const [updated] = await tx.update(crmDrafts).set({
      subject: generated.subject,
      aiBodyText: generated.bodyText,
      aiBodyHtml: generated.bodyHtml,
      editedBodyText: null,
      editedBodyHtml: null,
      status: "awaiting_review",
      provider: generated.provider,
      model: generated.model,
      request: generated.request,
      response: generated.response && typeof generated.response === "object"
        ? generated.response as Record<string, unknown>
        : { value: generated.response },
      error: null,
      updatedAt: now,
    }).where(eq(crmDrafts.id, draft.id)).returning();
    if (!updated) throw new Error("Generated CRM draft update did not return a row");

    await tx.delete(crmDraftKnowledgeCitations).where(eq(crmDraftKnowledgeCitations.draftId, draft.id));
    const knowledge = generated.prompt.snapshot.knowledge;
    if (Array.isArray(knowledge) && knowledge.length) {
      const citations = knowledge.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const value = item as Record<string, unknown>;
        if (
          typeof value.documentVersionId !== "string"
          || typeof value.excerpt !== "string"
          || typeof value.excerptHash !== "string"
        ) return [];
        return [{
          draftId: draft.id,
          documentVersionId: value.documentVersionId,
          excerpt: value.excerpt,
          excerptHash: value.excerptHash,
          rank: String(typeof value.rank === "number" ? value.rank : 0),
        }];
      });
      if (citations.length) await tx.insert(crmDraftKnowledgeCitations).values(citations);
    }
    let autoSend = false;
    if (draft.sequenceStepRunId) {
      await tx.update(crmSequenceStepRuns).set({ status: "awaiting_review", lastError: null, updatedAt: now })
        .where(eq(crmSequenceStepRuns.id, draft.sequenceStepRunId));
      // A follow-up of a sequence that sends on its own goes to the sender,
      // not to a person — unless a person asked for this rewrite, in which
      // case they are reviewing it already.
      if (!options.personRequested) {
        const [scope] = await tx.select({ stepType: crmSequenceSteps.stepType, autoSend: crmSequences.autoSendFollowUps })
          .from(crmSequenceStepRuns)
          .innerJoin(crmSequenceSteps, eq(crmSequenceSteps.id, crmSequenceStepRuns.sequenceStepId))
          .innerJoin(crmSequenceRuns, eq(crmSequenceRuns.id, crmSequenceStepRuns.sequenceRunId))
          .innerJoin(crmSequences, eq(crmSequences.id, crmSequenceRuns.sequenceId))
          .where(eq(crmSequenceStepRuns.id, draft.sequenceStepRunId)).limit(1);
        autoSend = scope?.stepType === "follow_up" && scope.autoSend;
      }
    }
    if (autoSend) {
      // Off the person's desk: it waits for its account's turn
      // (autoFollowUps.ts), where "Review before sending" can still stop it.
      await tx.update(crmDrafts).set({ autoSendAt: now }).where(eq(crmDrafts.id, draft.id));
      await tx.update(crmRecords).set({ workflowState: "waiting", nextActionAt: null, updatedAt: now })
        .where(eq(crmRecords.id, record.id));
    } else {
      // The draft is what the person has to act on, so it is due now.
      await tx.update(crmRecords).set({ workflowState: "action_required", nextActionAt: now, updatedAt: now })
        .where(eq(crmRecords.id, record.id));
    }
    if (draft.channel === "email") {
      await syncEmailDraftAcrossInboxAndOutreach(tx, record, generated.subject, generated.bodyText, generated.bodyHtml);
    }
    await appendCrmEvent(tx, {
      personId: record.personId,
      crmRecordId: record.id,
      pipelineId: record.pipelineId,
      eventType: "draft.generated",
      actorType: "ai",
      toData: { draftId: draft.id, revision: updated.revision, sequenceStepRunId: draft.sequenceStepRunId },
      meta: {
        provider: generated.provider,
        model: generated.model,
        ...(prepared.promptInput.revision ? { reviewerFeedback: prepared.promptInput.revision.reviewerFeedback } : {}),
        ...(autoSend ? { autoSend: true } : {}),
      },
      contextVersion: record.contextVersion,
    });
    return autoSend ? { ...updated, autoSendAt: now } : updated;
  });
}

async function failDraftGeneration(draftId: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await withCrmTransaction(async (tx) => {
    const [draft] = await tx.select().from(crmDrafts)
      .where(and(draftInOrg(), eq(crmDrafts.id, draftId))).limit(1).for("update");
    if (!draft || draft.status !== "generating") return;
    const record = await lockCrmRecord(tx, draft.crmRecordId);
    const now = new Date();
    await tx.update(crmDrafts).set({ status: "failed", error: message, updatedAt: now }).where(eq(crmDrafts.id, draft.id));
    if (draft.sequenceStepRunId) {
      await tx.update(crmSequenceStepRuns).set({ status: "failed", lastError: message, updatedAt: now })
        .where(eq(crmSequenceStepRuns.id, draft.sequenceStepRunId));
    }
    await tx.update(crmRecords).set({ workflowState: "error", nextActionAt: null, updatedAt: now })
      .where(eq(crmRecords.id, record.id));
    await appendCrmEvent(tx, {
      personId: record.personId, crmRecordId: record.id, pipelineId: record.pipelineId,
      eventType: "draft.failed", actorType: "ai", toData: { draftId: draft.id },
      meta: { error: message }, contextVersion: record.contextVersion,
    });
  });
}

/**
 * What the model is told when no sequence covers the reply.
 *
 * Every inbound reply gets a draft now, including the ones the taxonomy has no
 * playbook for ("Ok", a thumbs-up, "I'm not the right person"). Without a step
 * to follow, the thread itself is the brief.
 */
const FALLBACK_STEP_INSTRUCTIONS = [
  "No reply playbook is configured for this conversation, so the thread is the brief.",
  "Read the whole conversation and write the reply the situation actually calls for:",
  "answer any question the person asked, acknowledge what they told us, and propose one",
  "sensible next step. Use only facts present in the conversation or the supplied",
  "knowledge — never invent product details, pricing, availability, names, dates or",
  "commitments. If the latest message is only an acknowledgement with no question, keep",
  "the reply short and low-pressure rather than manufacturing enthusiasm. If the person",
  "says they are not the right contact, thank them and ask who is.",
].join(" ");

const OUTBOUND_FALLBACK_STEP_INSTRUCTIONS = [
  "This is an initial outbound outreach draft (no inbound reply yet).",
  "Write or refine a concise, high-trust outreach message tailored to the person and company profile, knowledge excerpts, and any reviewer feedback or previous draft.",
  "Use only facts present in the person/company attributes, knowledge excerpts, or previous draft — never invent product details, pricing, availability, names, dates or commitments.",
].join(" ");

const FALLBACK_DRAFT_STATUSES = ["generating", "awaiting_review", "failed"] as const;

/**
 * Prepare a draft for a record that has no active sequence step.
 *
 * Mirrors loadDraftContext, minus everything that comes from a step: the draft
 * is written with a null sequence_step_run_id (the column has always allowed
 * it) and the prompt carries a synthesized position-1 reply step.
 */
async function loadFallbackDraftContext(
  tx: CrmTransaction,
  recordId: string,
): Promise<PreparedDraft | null> {
  const record = await lockCrmRecord(tx, recordId);
  if (await isPersonDoNotContact(tx, record.personId)) return null;

  const [existing] = await tx
    .select()
    .from(crmDrafts)
    .where(and(
      eq(crmDrafts.crmRecordId, record.id),
      isNull(crmDrafts.sequenceStepRunId),
      eq(crmDrafts.expectedContextVersion, record.contextVersion),
      inArray(crmDrafts.status, [...FALLBACK_DRAFT_STATUSES]),
    ))
    .orderBy(desc(crmDrafts.createdAt))
    .limit(1)
    .for("update");

  // Both of these are "nothing to draft", not failures — returning null keeps
  // the job from retrying three times over a record we deliberately skip.
  if (!record.latestInboundMessageId && !existing?.conversationId) return null;

  let conversationRow: typeof crmConversations.$inferSelect | undefined;
  if (record.latestInboundMessageId) {
    const [found] = await tx
      .select({ conversation: crmConversations })
      .from(crmConversationMessages)
      .innerJoin(crmConversations, eq(crmConversations.id, crmConversationMessages.conversationId))
      .where(eq(crmConversationMessages.id, record.latestInboundMessageId))
      .limit(1);
    conversationRow = found?.conversation;
  }
  if (!conversationRow && existing?.conversationId) {
    const [found] = await tx
      .select()
      .from(crmConversations)
      .where(eq(crmConversations.id, existing.conversationId))
      .limit(1);
    conversationRow = found;
  }
  if (!conversationRow) {
    if (record.latestInboundMessageId) {
      throw new CrmNotFoundError("CRM conversation for message", record.latestInboundMessageId);
    }
    return null;
  }

  const stepInstructions = record.latestInboundMessageId
    ? FALLBACK_STEP_INSTRUCTIONS
    : OUTBOUND_FALLBACK_STEP_INSTRUCTIONS;

  const subject = await loadDraftSubject(tx, record, conversationRow.id, {
    query: stepInstructions,
    knowledgeTags: [],
  });

  const now = new Date();
  let draft: CrmDraft | undefined;
  if (existing) {
    [draft] = await tx.update(crmDrafts).set({
      status: "generating",
      error: null,
      revision: existing.revision + 1,
      updatedAt: now,
    }).where(eq(crmDrafts.id, existing.id)).returning();
  } else {
    [draft] = await tx.insert(crmDrafts).values({
      crmRecordId: record.id,
      conversationId: conversationRow.id,
      replyForMessageId: record.latestInboundMessageId,
      sequenceStepRunId: null,
      expectedContextVersion: record.contextVersion,
      channel: conversationRow.channel,
      status: "generating",
    }).returning();
  }
  if (!draft) throw new Error("CRM fallback draft insert did not return a row");

  return {
    draft,
    promptInput: {
      channel: conversationRow.channel,
      sequenceStep: {
        id: null,
        name: record.latestInboundMessageId ? "Free-form reply" : "Initial outreach",
        position: 1,
        stepType: "reply",
        subjectTemplate: null,
        bodyTemplate: null,
        aiInstructions: stepInstructions,
        knowledgeTags: [],
      },
      ...subject,
    },
  };
}

/**
 * Draft a reply for a record no sequence covers. Same generation, review and
 * failure handling as the sequence path — only the brief differs.
 */
export async function generateFallbackDraft(
  recordId: string,
  dependencies: { complete?: DraftCompletion } = {},
  revision: DraftRevisionRequest | null = null,
): Promise<CrmDraft | null> {
  const prepared = await withCrmTransaction((tx) => loadFallbackDraftContext(tx, recordId));
  if (!prepared) return null;
  try {
    const generated = await generateCrmDraft({ ...prepared.promptInput, revision }, dependencies);
    return await finishGeneratedDraft(prepared, generated);
  } catch (error) {
    await failDraftGeneration(prepared.draft.id, error);
    throw error;
  }
}

export async function generateDraftForStep(
  stepRunId: string,
  dependencies: { complete?: DraftCompletion } = {},
  revision: DraftRevisionRequest | null = null,
  regenerating = false,
): Promise<CrmDraft> {
  const prepared = await withCrmTransaction((tx) => loadDraftContext(tx, stepRunId, regenerating));
  try {
    const generated = await generateCrmDraft({ ...prepared.promptInput, revision }, dependencies);
    return await finishGeneratedDraft(prepared, generated, { personRequested: regenerating });
  } catch (error) {
    await failDraftGeneration(prepared.draft.id, error);
    throw error;
  }
}

export async function updateDraft(input: {
  draftId: string;
  revision?: number | null;
  subject?: string | null;
  bodyText: string;
  bodyHtml?: string | null;
  actorRef?: string | null;
}): Promise<CrmDraft> {
  const bodyText = input.bodyText.trim();
  if (!bodyText) throw new Error("Draft body is required");
  return withCrmTransaction(async (tx) => {
    const [draft] = await tx.select().from(crmDrafts)
      .where(and(draftInOrg(), eq(crmDrafts.id, input.draftId))).limit(1).for("update");
    if (!draft) throw new CrmNotFoundError("CRM draft", input.draftId);
    if (draft.status !== "awaiting_review") throw new CrmConflictError("Only awaiting-review drafts can be edited");
    if (typeof input.revision === "number" && draft.revision !== input.revision) {
      throw new CrmConflictError("Draft revision is stale");
    }
    const record = await lockCrmRecord(tx, draft.crmRecordId);
    assertCurrentCrmContext(record, { contextVersion: draft.expectedContextVersion });
    const subject = draft.channel === "email" ? input.subject?.trim() || draft.subject : null;
    if (draft.channel === "email" && !subject) throw new Error("Email subject is required");
    const editedBodyHtml = input.bodyHtml?.trim() || textToParagraphHtml(bodyText);
    const [updated] = await tx.update(crmDrafts).set({
      subject,
      editedBodyText: bodyText,
      editedBodyHtml,
      revision: draft.revision + 1,
      updatedAt: new Date(),
    }).where(eq(crmDrafts.id, draft.id)).returning();
    if (draft.channel === "email") {
      await syncEmailDraftAcrossInboxAndOutreach(tx, record, subject, bodyText, editedBodyHtml);
    }
    await appendCrmEvent(tx, {
      personId: record.personId, crmRecordId: record.id, pipelineId: record.pipelineId,
      eventType: "draft.edited", actorType: "authenticated_operator", actorRef: input.actorRef,
      fromData: { draftId: draft.id, revision: draft.revision },
      toData: { draftId: draft.id, revision: updated!.revision }, contextVersion: record.contextVersion,
    });
    return updated!;
  });
}

/**
 * Rewrite a draft. `feedback` is what the reviewer wants changed; with it the
 * model also sees the draft it is replacing (edits included, since those show
 * the direction the reviewer was already taking). Without it the same prompt
 * simply runs again.
 */
export async function regenerateDraft(
  draftId: string,
  dependencies: { complete?: DraftCompletion } = {},
  feedback: string | null = null,
): Promise<CrmDraft> {
  const [draft] = await db.select().from(crmDrafts)
    .where(and(draftInOrg(), eq(crmDrafts.id, draftId))).limit(1);
  if (!draft) throw new CrmNotFoundError("CRM draft", draftId);
  if (!["awaiting_review", "failed"].includes(draft.status)) {
    throw new CrmConflictError(`Cannot regenerate a ${draft.status} draft`);
  }
  const previousBody = (draft.editedBodyText ?? draft.aiBodyText ?? "").trim();
  const effectiveFeedback =
    feedback?.trim() ||
    (!draft.sequenceStepRunId && !draft.replyForMessageId && previousBody
      ? "Refine and improve this outreach draft while preserving its core project scope, factual context, and link."
      : "");
  const revision: DraftRevisionRequest | null = effectiveFeedback && previousBody
    ? { previousDraft: { subject: draft.subject, bodyText: previousBody }, reviewerFeedback: effectiveFeedback }
    : null;
  if (draft.sequenceStepRunId) return generateDraftForStep(draft.sequenceStepRunId, dependencies, revision, true);
  // A step-less draft the AI wrote is a no-sequence fallback and can be redrafted;
  // one a human typed (createManualDraft) has no prompt to regenerate from.
  if (!draft.provider) throw new CrmConflictError("One-off manual drafts cannot be regenerated");
  const regenerated = await generateFallbackDraft(draft.crmRecordId, dependencies, revision);
  if (!regenerated) throw new CrmConflictError("This record can no longer be drafted for");
  return regenerated;
}

export async function discardDraft(input: { draftId: string; actorRef?: string | null }): Promise<CrmDraft> {
  return withCrmTransaction(async (tx) => {
    const [draft] = await tx.select().from(crmDrafts)
      .where(and(draftInOrg(), eq(crmDrafts.id, input.draftId))).limit(1).for("update");
    if (!draft) throw new CrmNotFoundError("CRM draft", input.draftId);
    if (!["awaiting_review", "failed"].includes(draft.status)) {
      throw new CrmConflictError(`Cannot discard a ${draft.status} draft`);
    }
    const record = await lockCrmRecord(tx, draft.crmRecordId);
    const [updated] = await tx.update(crmDrafts).set({ status: "discarded", updatedAt: new Date() })
      .where(eq(crmDrafts.id, draft.id)).returning();
    await appendCrmEvent(tx, {
      personId: record.personId, crmRecordId: record.id, pipelineId: record.pipelineId,
      eventType: "draft.discarded", actorType: "authenticated_operator", actorRef: input.actorRef,
      toData: { draftId: draft.id }, contextVersion: record.contextVersion,
    });
    return updated!;
  });
}
