import { and, asc, count, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
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
import { CrmConfigurationValidationError } from "./categories";
import { resolveOutboundEmailRouting, resolveRoutingCompanyCode } from "./brandRouting";
import {
  CrmConflictError,
  CrmNotFoundError,
  type CrmTransaction,
  withCrmTransaction,
} from "./repository";
import { draftInOrg, ensurePersonCrmRecord, lockCrmRecord } from "./records";
import { releaseStepRunDraftLinks } from "./sequences";
import { currentStageMoveInTransaction } from "./stageMove";
import { upsertConversationInTransaction } from "./conversations";
import { normalizeEmail } from "@/lib/leads/identity";
import { mailboxes } from "@/lib/outreach/schema";
import {
  crmClassifications,
  crmConversationMessages,
  crmConversations,
  crmDraftKnowledgeCitations,
  crmDrafts,
  crmRecords,
  crmSendAttempts,
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
    .select({ email: people.email, companyId: people.companyId })
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
        body = ${finalHtml},
        gmail_message_id = CASE WHEN gmail_message_id LIKE 'r%' THEN NULL ELSE gmail_message_id END,
        thread_id = CASE WHEN thread_id LIKE 'r%' THEN NULL ELSE thread_id END
    WHERE status = 'scheduled'
      AND lead_id IN (
        SELECT ol.id
        FROM outreach_leads ol
        INNER JOIN outreach_campaigns oc ON oc.id = ol.campaign_id
        WHERE oc.organization_id = ${record.organizationId}::uuid
          AND lower(ol.email) = lower(${email})
      )
  `);

  await tx.execute(sql`
    UPDATE outreach_leads
    SET custom_fields = COALESCE(custom_fields, '{}'::jsonb) - 'gmailDraftId'
    WHERE id IN (
      SELECT ol.id
      FROM outreach_leads ol
      INNER JOIN outreach_campaigns oc ON oc.id = ol.campaign_id
      WHERE oc.organization_id = ${record.organizationId}::uuid
        AND lower(ol.email) = lower(${email})
    )
  `);

  if (person?.companyId) {
    await tx.execute(sql`
      UPDATE companies
      SET custom = COALESCE(custom, '{}'::jsonb) - 'x_gmail_draft_id',
          raw = COALESCE(raw, '{}'::jsonb) - 'x_gmail_draft_id'
      WHERE id = ${person.companyId}::uuid
    `);
  }
}

async function purgeEmailDraftFromInboxAndOutreach(
  tx: CrmTransaction,
  record: { organizationId: string; personId: string },
): Promise<void> {
  const [person] = await tx
    .select({ email: people.email, companyId: people.companyId })
    .from(people)
    .where(and(eq(people.organizationId, record.organizationId), eq(people.id, record.personId)))
    .limit(1);
  const email = person?.email?.trim();
  if (!email) return;

  await tx.execute(sql`
    DELETE FROM crm_email_drafts
    WHERE lead_id IN (
      SELECT id FROM crm_leads
      WHERE organization_id = ${record.organizationId}::uuid
        AND lower(email) = lower(${email})
    )
  `);

  await tx.execute(sql`
    DELETE FROM crm_leads
    WHERE organization_id = ${record.organizationId}::uuid
      AND lower(email) = lower(${email})
      AND current_status_key = 'PENDING_FIRST_SEND'
      AND NOT EXISTS (
        SELECT 1 FROM crm_messages cm WHERE cm.lead_id = crm_leads.id
      )
  `);

  await tx.execute(sql`
    DELETE FROM outreach_emails
    WHERE status = 'scheduled'
      AND lead_id IN (
        SELECT ol.id
        FROM outreach_leads ol
        INNER JOIN outreach_campaigns oc ON oc.id = ol.campaign_id
        WHERE oc.organization_id = ${record.organizationId}::uuid
          AND lower(ol.email) = lower(${email})
      )
  `);

  await tx.execute(sql`
    DELETE FROM outreach_leads
    WHERE sequence_status = 'pending'
      AND id IN (
        SELECT ol.id
        FROM outreach_leads ol
        INNER JOIN outreach_campaigns oc ON oc.id = ol.campaign_id
        WHERE oc.organization_id = ${record.organizationId}::uuid
          AND lower(ol.email) = lower(${email})
      )
      AND NOT EXISTS (
        SELECT 1 FROM outreach_emails oe WHERE oe.lead_id = outreach_leads.id
      )
  `);

  if (person?.companyId) {
    await tx.execute(sql`
      UPDATE companies
      SET custom = COALESCE(custom, '{}'::jsonb) - 'x_gmail_draft_id',
          raw = COALESCE(raw, '{}'::jsonb) - 'x_gmail_draft_id'
      WHERE id = ${person.companyId}::uuid
    `);
  }
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

  const resolvedCompanyCode = resolveRoutingCompanyCode({
    company: profile.company,
    person: profile.person,
  });
  const personAttributes = scalarAttributes({
    ...(profile.person.raw ?? {}),
    ...(profile.person.custom ?? {}),
  });
  const companyAttributes = profile.company
    ? scalarAttributes({
        ...(profile.company.raw ?? {}),
        ...(profile.company.custom ?? {}),
        ...(resolvedCompanyCode
          ? { x_code: resolvedCompanyCode, company_code: resolvedCompanyCode }
          : {}),
      })
    : {};

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
      attributes: personAttributes,
    },
    company: profile.company ? {
      id: profile.company.id,
      name: profile.company.name,
      domain: profile.company.domain,
      linkedinUrl: profile.company.linkedinUrl,
      attributes: companyAttributes,
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
      autoSendAt: null,
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
  "Include a brief, credible overview of our AI-first engineering workflow and core team background grounded in the supplied knowledge and operator instructions, rather than generic outsourcing boilerplate.",
  "Prioritize Chinese for contacts in Chinese-speaking regions (Hong Kong, Taiwan, Macau -> Traditional Chinese; Mainland China -> Simplified Chinese) unless the contact is clearly a non-Chinese expatriate or bound to an English sender.",
  "Match the language, brand identity, sign-off, and verified reference links to the bound sender account and operator brand-routing instructions (for example, Traditional Chinese as 英选 for HK/TW/Macau leads and Simplified Chinese as 英选 for Mainland China leads when sending from a Yingxuan mailbox, or English as Linktion when sending from a Linktion mailbox).",
  "Use only facts present in the person/company attributes, knowledge excerpts, or previous draft — never invent product details, pricing, availability, names, dates or commitments.",
].join(" ");

const FALLBACK_DRAFT_STATUSES = ["generating", "awaiting_review", "failed"] as const;

async function cleanupOrphanedConversation(
  tx: CrmTransaction,
  conversationId: string | null | undefined,
): Promise<void> {
  if (!conversationId) return;
  const [[msgCount], [draftCount], [runCount]] = await Promise.all([
    tx
      .select({ total: count() })
      .from(crmConversationMessages)
      .where(eq(crmConversationMessages.conversationId, conversationId)),
    tx
      .select({ total: count() })
      .from(crmDrafts)
      .where(eq(crmDrafts.conversationId, conversationId)),
    tx
      .select({ total: count() })
      .from(crmSequenceRuns)
      .where(eq(crmSequenceRuns.conversationId, conversationId)),
  ]);
  if (
    Number(msgCount?.total ?? 0) === 0 &&
    Number(draftCount?.total ?? 0) === 0 &&
    Number(runCount?.total ?? 0) === 0
  ) {
    await tx
      .delete(crmConversations)
      .where(and(inOrg(crmConversations), eq(crmConversations.id, conversationId)));
  }
}

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
  targetDraftId?: string,
  targetConversationId?: string,
): Promise<PreparedDraft | null> {
  const record = await lockCrmRecord(tx, recordId);
  if (await isPersonDoNotContact(tx, record.personId)) return null;

  let existing: CrmDraft | undefined;
  if (targetDraftId) {
    [existing] = await tx
      .select()
      .from(crmDrafts)
      .where(and(
        eq(crmDrafts.id, targetDraftId),
        eq(crmDrafts.crmRecordId, record.id),
        isNull(crmDrafts.sequenceStepRunId),
        inArray(crmDrafts.status, [...FALLBACK_DRAFT_STATUSES]),
      ))
      .limit(1)
      .for("update");
  }
  if (!existing) {
    [existing] = await tx
      .select()
      .from(crmDrafts)
      .where(and(
        eq(crmDrafts.crmRecordId, record.id),
        isNull(crmDrafts.sequenceStepRunId),
        inArray(crmDrafts.status, [...FALLBACK_DRAFT_STATUSES]),
      ))
      .orderBy(desc(crmDrafts.updatedAt), desc(crmDrafts.createdAt))
      .limit(1)
      .for("update");
  }

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
  if (!conversationRow && targetConversationId) {
    const [found] = await tx
      .select()
      .from(crmConversations)
      .where(and(
        inOrg(crmConversations),
        eq(crmConversations.id, targetConversationId),
        eq(crmConversations.crmRecordId, record.id),
      ))
      .limit(1);
    conversationRow = found;
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
    const [found] = await tx
      .select()
      .from(crmConversations)
      .where(and(inOrg(crmConversations), eq(crmConversations.crmRecordId, record.id)))
      .orderBy(desc(crmConversations.createdAt))
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
    const previousConversationId = existing.conversationId;
    [draft] = await tx.update(crmDrafts).set({
      conversationId: conversationRow.id,
      replyForMessageId: record.latestInboundMessageId,
      expectedContextVersion: record.contextVersion,
      status: "generating",
      error: null,
      autoSendAt: null,
      revision: existing.revision + 1,
      updatedAt: now,
    }).where(eq(crmDrafts.id, existing.id)).returning();
    if (previousConversationId && previousConversationId !== conversationRow.id) {
      await cleanupOrphanedConversation(tx, previousConversationId);
    }
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
  options: { targetDraftId?: string; targetConversationId?: string; personRequested?: boolean } = {},
): Promise<CrmDraft | null> {
  const prepared = await withCrmTransaction((tx) =>
    loadFallbackDraftContext(tx, recordId, options.targetDraftId, options.targetConversationId),
  );
  if (!prepared) return null;
  try {
    const generated = await generateCrmDraft({ ...prepared.promptInput, revision }, dependencies);
    return await finishGeneratedDraft(prepared, generated, { personRequested: options.personRequested });
  } catch (error) {
    await failDraftGeneration(prepared.draft.id, error);
    throw error;
  }
}

export type InitialDraftInput = {
  recordId?: string;
  personId?: string;
  email?: string;
  companyCode?: string;
  fromEmail?: string;
  subject?: string;
  bodyText?: string;
  bodyHtml?: string;
  feedback?: string;
};

export function resolveCompanyCode(
  company: { custom?: Record<string, unknown> | null; raw?: Record<string, unknown> | null } | null | undefined,
): string | null {
  if (!company) return null;
  const custom = (company.custom ?? {}) as Record<string, unknown>;
  const raw = (company.raw ?? {}) as Record<string, unknown>;
  for (const candidate of [custom.x_code, custom.company_code, raw.x_code, raw.company_code]) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return null;
}

export function buildInitialDraftRevision(
  input: Pick<InitialDraftInput, "subject" | "bodyText" | "feedback">,
  existingDraft?: Pick<CrmDraft, "subject" | "editedBodyText" | "aiBodyText"> | null,
): DraftRevisionRequest | null {
  const reviewerFeedback = input.feedback?.trim() ?? "";
  if (!reviewerFeedback) return null;
  const previousBody = (
    input.bodyText?.trim() ||
    existingDraft?.editedBodyText?.trim() ||
    existingDraft?.aiBodyText?.trim() ||
    ""
  );
  const previousSubject = input.subject?.trim() || existingDraft?.subject?.trim() || null;
  return {
    previousDraft: previousBody || previousSubject
      ? { subject: previousSubject, bodyText: previousBody || null }
      : null,
    reviewerFeedback,
  };
}

export function buildRegenerateDraftRevision(
  draft: Pick<CrmDraft, "subject" | "editedBodyText" | "aiBodyText" | "sequenceStepRunId" | "replyForMessageId">,
  feedback?: string | null,
): DraftRevisionRequest | null {
  const previousBody = (draft.editedBodyText ?? draft.aiBodyText ?? "").trim();
  const effectiveFeedback =
    feedback?.trim() ||
    (!draft.sequenceStepRunId && !draft.replyForMessageId && previousBody
      ? "Refine and improve this outreach draft while preserving its core project scope, factual context, and link."
      : "");
  if (!effectiveFeedback) return null;
  const previousSubject = draft.subject?.trim() || null;
  return {
    previousDraft: previousBody || previousSubject
      ? { subject: previousSubject, bodyText: previousBody || null }
      : null,
    reviewerFeedback: effectiveFeedback,
  };
}

export type RegenerateDraftFilterInput = {
  draftIds?: unknown;
  draftId?: unknown;
  id?: unknown;
  companyCodes?: unknown;
  companyCode?: unknown;
  code?: unknown;
  personIds?: unknown;
  personId?: unknown;
  recordIds?: unknown;
  recordId?: unknown;
  emails?: unknown;
  email?: unknown;
  toEmail?: unknown;
};

function parseFilterSet(values: unknown[], transform?: (value: string) => string): Set<string> | null {
  const items: string[] = [];
  for (const raw of values) {
    if (Array.isArray(raw)) {
      for (const entry of raw) {
        const clean = String(entry ?? "").trim();
        if (clean) items.push(transform ? transform(clean) : clean);
      }
    } else if (typeof raw === "string" && raw.trim()) {
      const clean = raw.trim();
      items.push(transform ? transform(clean) : clean);
    }
  }
  return items.length > 0 ? new Set(items) : null;
}

export function selectRegenerateTargetDrafts<
  T extends {
    id: string;
    crmRecordId: string;
    status: string;
    toEmail: string | null;
    person: { id: string };
    company: { code: string | null } | null;
  },
>(drafts: readonly T[], filterInput: RegenerateDraftFilterInput): T[] {
  const idFilter = parseFilterSet([filterInput.draftIds, filterInput.draftId, filterInput.id]);
  const codeFilter = parseFilterSet(
    [filterInput.companyCodes, filterInput.companyCode, filterInput.code],
    (v) => v.toUpperCase(),
  );
  const personIdFilter = parseFilterSet([filterInput.personIds, filterInput.personId]);
  const recordIdFilter = parseFilterSet([filterInput.recordIds, filterInput.recordId]);
  const emailFilter = parseFilterSet(
    [filterInput.emails, filterInput.email, filterInput.toEmail],
    (v) => v.toLowerCase(),
  );

  const matched = drafts.filter((d) => {
    if (d.status !== "awaiting_review" && d.status !== "failed") return false;
    if (idFilter && !idFilter.has(d.id)) return false;
    if (codeFilter && (!d.company?.code || !codeFilter.has(d.company.code.toUpperCase()))) {
      return false;
    }
    if (personIdFilter && !personIdFilter.has(d.person.id)) {
      return false;
    }
    if (recordIdFilter && !recordIdFilter.has(d.crmRecordId)) {
      return false;
    }
    if (emailFilter && (!d.toEmail || !emailFilter.has(d.toEmail.toLowerCase()))) {
      return false;
    }
    return true;
  });

  if (idFilter) {
    return matched;
  }

  const byRecord = new Map<string, T>();
  for (const draft of matched) {
    const existing = byRecord.get(draft.crmRecordId);
    if (!existing) {
      byRecord.set(draft.crmRecordId, draft);
    } else if (existing.status !== "awaiting_review" && draft.status === "awaiting_review") {
      byRecord.set(draft.crmRecordId, draft);
    }
  }
  return [...byRecord.values()];
}

const BASIC_EMAIL_SYNTAX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function validateAndResolveFromEmail(
  tx: CrmTransaction,
  rawFromEmail: string,
): Promise<{ accountRef: string; mailboxId: string | null }> {
  const normalized = normalizeEmail(rawFromEmail);
  if (!normalized || !BASIC_EMAIL_SYNTAX.test(normalized)) {
    throw new CrmConfigurationValidationError("fromEmail must be a valid email address");
  }

  const connectedMailboxes = await tx
    .select({
      id: mailboxes.id,
      emailAddress: mailboxes.emailAddress,
      displayName: mailboxes.displayName,
    })
    .from(mailboxes)
    .where(and(inOrg(mailboxes), eq(mailboxes.status, "connected")))
    .orderBy(desc(mailboxes.createdAt), asc(mailboxes.emailAddress));

  if (connectedMailboxes.length > 0) {
    const matched = connectedMailboxes.find(
      (m) => normalizeEmail(m.emailAddress) === normalized,
    );
    if (!matched) {
      throw new CrmConfigurationValidationError(
        `fromEmail ${rawFromEmail.trim()} is not a connected mailbox in this organization`,
      );
    }
    return { accountRef: matched.emailAddress.trim(), mailboxId: matched.id };
  }

  return { accountRef: normalized, mailboxId: null };
}

async function assertDraftCanRebindSender(
  tx: CrmTransaction,
  draft: CrmDraft,
): Promise<void> {
  if (draft.status === "sent") {
    throw new CrmConflictError("Cannot change fromEmail on a sent draft");
  }
  if (draft.status === "sending" || draft.status === "delivery_uncertain") {
    throw new CrmConflictError(`Cannot change fromEmail on a ${draft.status} draft`);
  }
  if (draft.status !== "awaiting_review") {
    throw new CrmConflictError(
      `Only unsent awaiting_review drafts can change fromEmail (current status: ${draft.status})`,
    );
  }
  if (draft.autoSendAt !== null) {
    throw new CrmConflictError("Cannot change fromEmail on a queued auto-send draft");
  }

  const [existingAttempt] = await tx
    .select({ id: crmSendAttempts.id, status: crmSendAttempts.status })
    .from(crmSendAttempts)
    .where(and(
      eq(crmSendAttempts.draftId, draft.id),
      inArray(crmSendAttempts.status, [
        "prepared",
        "sending",
        "sent",
        "delivery_uncertain",
        "reconciled",
      ]),
    ))
    .limit(1);
  if (existingAttempt) {
    throw new CrmConflictError(
      "Cannot change fromEmail on a draft that has already been queued or sent",
    );
  }

  if (draft.channel !== "email") {
    throw new CrmConfigurationValidationError("fromEmail can only be set on email drafts");
  }
}

async function syncSenderAcrossInboxAndOutreach(
  tx: CrmTransaction,
  record: { organizationId: string; personId: string },
  person: { email: string | null; companyId: string | null } | undefined,
  accountRef: string,
  mailboxId: string | null,
): Promise<void> {
  const email = person?.email?.trim();
  if (email) {
    await tx.execute(sql`
      UPDATE crm_leads
      SET mailbox = ${accountRef},
          updated_at = now()
      WHERE organization_id = ${record.organizationId}::uuid
        AND lower(email) = lower(${email})
        AND NOT EXISTS (
          SELECT 1 FROM crm_messages cm WHERE cm.lead_id = crm_leads.id
        )
    `);

    await tx.execute(sql`
      UPDATE outreach_leads
      SET custom_fields = COALESCE(custom_fields, '{}'::jsonb) - 'gmailDraftId'
      WHERE id IN (
        SELECT ol.id
        FROM outreach_leads ol
        INNER JOIN outreach_campaigns oc ON oc.id = ol.campaign_id
        WHERE oc.organization_id = ${record.organizationId}::uuid
          AND lower(ol.email) = lower(${email})
      )
    `);

    if (mailboxId) {
      await tx.execute(sql`
        UPDATE outreach_leads
        SET mailbox_id = ${mailboxId}::uuid,
            updated_at = now()
        WHERE sequence_status = 'pending'
          AND id IN (
            SELECT ol.id
            FROM outreach_leads ol
            INNER JOIN outreach_campaigns oc ON oc.id = ol.campaign_id
            WHERE oc.organization_id = ${record.organizationId}::uuid
              AND lower(ol.email) = lower(${email})
          )
      `);

      await tx.execute(sql`
        UPDATE outreach_emails
        SET mailbox_id = ${mailboxId}::uuid,
            gmail_message_id = CASE WHEN gmail_message_id LIKE 'r%' THEN NULL ELSE gmail_message_id END,
            thread_id = CASE WHEN thread_id LIKE 'r%' THEN NULL ELSE thread_id END
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
  }

  if (person?.companyId) {
    await tx.execute(sql`
      UPDATE companies
      SET custom = COALESCE(custom, '{}'::jsonb) - 'x_gmail_draft_id',
          raw = COALESCE(raw, '{}'::jsonb) - 'x_gmail_draft_id'
      WHERE id = ${person.companyId}::uuid
    `);
  }
}

function resolveDraftRecipientEmail(
  draft: Pick<CrmDraft, "request">,
  person: { email: string | null } | undefined,
): string | null {
  const reqObj = draft.request && typeof draft.request === "object"
    ? (draft.request as Record<string, unknown>)
    : null;
  if (reqObj && typeof reqObj.to === "string" && reqObj.to.trim()) {
    return reqObj.to.trim();
  }
  return person?.email?.trim() || null;
}

export async function getOrCreateDefaultEmailConversation(
  tx: CrmTransaction,
  recordId: string,
  fromEmail?: string,
  options: { companyCode?: string } = {},
): Promise<typeof crmConversations.$inferSelect> {
  const [record] = await tx
    .select()
    .from(crmRecords)
    .where(and(inOrg(crmRecords), eq(crmRecords.id, recordId)))
    .limit(1);
  if (!record) throw new CrmNotFoundError("CRM record", recordId);

  if (fromEmail?.trim()) {
    const resolved = await validateAndResolveFromEmail(tx, fromEmail);
    const { conversation } = await upsertConversationInTransaction(tx, {
      crmRecordId: record.id,
      personId: record.personId,
      channel: "email",
      accountRef: resolved.accountRef,
    });
    return conversation;
  }

  const existingConversations = await tx
    .select()
    .from(crmConversations)
    .where(and(
      inOrg(crmConversations),
      eq(crmConversations.crmRecordId, record.id),
      eq(crmConversations.channel, "email"),
    ))
    .orderBy(desc(crmConversations.createdAt));

  for (const candidate of existingConversations) {
    const [[msgRow], [sentDraftRow], [activeRunRow]] = await Promise.all([
      tx
        .select({ total: count() })
        .from(crmConversationMessages)
        .where(eq(crmConversationMessages.conversationId, candidate.id)),
      tx
        .select({ total: count() })
        .from(crmDrafts)
        .where(and(
          eq(crmDrafts.conversationId, candidate.id),
          inArray(crmDrafts.status, ["sending", "sent", "delivery_uncertain"]),
        )),
      tx
        .select({ total: count() })
        .from(crmSequenceRuns)
        .where(and(
          eq(crmSequenceRuns.conversationId, candidate.id),
          inArray(crmSequenceRuns.status, ["active", "paused"]),
        )),
    ]);
    if (
      Number(msgRow?.total ?? 0) > 0 ||
      Number(sentDraftRow?.total ?? 0) > 0 ||
      Number(activeRunRow?.total ?? 0) > 0
    ) {
      return candidate;
    }
  }

  const [[profile], [settings], connectedMailboxes] = await Promise.all([
    tx
      .select({ person: people, company: companies })
      .from(people)
      .leftJoin(companies, eq(companies.id, people.companyId))
      .where(and(inOrg(people), eq(people.id, record.personId)))
      .limit(1),
    tx
      .select({ draftInstructions: crmSettings.draftInstructions })
      .from(crmSettings)
      .where(eq(crmSettings.pipelineId, record.pipelineId))
      .limit(1),
    tx
      .select({
        emailAddress: mailboxes.emailAddress,
        displayName: mailboxes.displayName,
      })
      .from(mailboxes)
      .where(and(inOrg(mailboxes), eq(mailboxes.status, "connected")))
      .orderBy(desc(mailboxes.createdAt), asc(mailboxes.emailAddress)),
  ]);

  const routing = resolveOutboundEmailRouting({
    companyCode: options.companyCode,
    company: profile?.company ?? null,
    person: profile?.person ?? null,
    draftInstructions: settings?.draftInstructions ?? null,
    connectedMailboxes,
  });

  const { conversation } = await upsertConversationInTransaction(tx, {
    crmRecordId: record.id,
    personId: record.personId,
    channel: "email",
    accountRef: routing.fromEmail,
  });
  return conversation;
}

export async function createOrGenerateInitialDraft(
  input: InitialDraftInput,
  actorRef?: string | null,
  dependencies: { complete?: DraftCompletion } = {},
): Promise<{ draft: CrmDraft; created: boolean }> {
  type SetupResult =
    | { kind: "existing"; draft: CrmDraft }
    | { kind: "manual"; draft: CrmDraft; created: boolean }
    | {
        kind: "need_ai";
        recordId: string;
        targetConversationId: string;
        existingDraft: CrmDraft | null;
      };

  const setup: SetupResult = await withCrmTransaction(async (tx): Promise<SetupResult> => {
    let recordId = input.recordId?.trim();
    let personId = input.personId?.trim();

    if (!recordId && !personId && input.email?.trim()) {
      const normalized = normalizeEmail(input.email.trim());
      if (normalized) {
        const [found] = await tx
          .select({ id: people.id })
          .from(people)
          .where(and(inOrg(people), sql`lower(${people.email}) = ${normalized}`))
          .limit(1);
        personId = found?.id;
      }
    }
    if (!recordId && !personId && input.companyCode?.trim()) {
      const targetCode = input.companyCode.trim().toUpperCase();
      const [foundComp] = await tx
        .select({ id: companies.id })
        .from(companies)
        .where(and(
          inOrg(companies),
          or(
            sql`upper(${companies.custom}->>'x_code') = ${targetCode}`,
            sql`upper(${companies.custom}->>'company_code') = ${targetCode}`,
            sql`upper(${companies.raw}->>'company_code') = ${targetCode}`,
            sql`upper(${companies.raw}->>'x_code') = ${targetCode}`,
          ),
        ))
        .limit(1);
      if (foundComp) {
        const [foundPerson] = await tx
          .select({ id: people.id })
          .from(people)
          .where(and(inOrg(people), eq(people.companyId, foundComp.id)))
          .limit(1);
        personId = foundPerson?.id;
      }
    }

    if (!recordId && personId) {
      const crmRes = await ensurePersonCrmRecord(tx, { personId });
      recordId = crmRes.record.id;
    }

    if (!recordId) {
      throw new Error("Could not resolve recordId, personId, email, or companyCode to an existing CRM entity");
    }

    const record = await lockCrmRecord(tx, recordId);
    if (await isPersonDoNotContact(tx, record.personId)) {
      throw new CrmConflictError("This person is marked Do Not Contact");
    }

    const [existingAwaiting] = await tx
      .select()
      .from(crmDrafts)
      .where(and(
        eq(crmDrafts.crmRecordId, record.id),
        eq(crmDrafts.status, "awaiting_review"),
      ))
      .orderBy(desc(crmDrafts.updatedAt), desc(crmDrafts.createdAt))
      .limit(1);

    if (existingAwaiting) {
      return { kind: "existing", draft: existingAwaiting };
    }

    const [existingRecoverable] = await tx
      .select()
      .from(crmDrafts)
      .where(and(
        eq(crmDrafts.crmRecordId, record.id),
        isNull(crmDrafts.sequenceStepRunId),
        inArray(crmDrafts.status, ["failed", "generating"]),
      ))
      .orderBy(desc(crmDrafts.updatedAt), desc(crmDrafts.createdAt))
      .limit(1)
      .for("update");

    const conversation = await getOrCreateDefaultEmailConversation(
      tx,
      record.id,
      input.fromEmail,
      { companyCode: input.companyCode },
    );

    if (input.bodyText?.trim()) {
      const now = new Date();
      const bodyText = input.bodyText.trim();
      const bodyHtml = input.bodyHtml?.trim() || textToParagraphHtml(bodyText);
      const subject = input.subject?.trim() || existingRecoverable?.subject || null;
      const previousConversationId = existingRecoverable?.conversationId ?? null;
      const [manualDraft] = existingRecoverable
        ? await tx
            .update(crmDrafts)
            .set({
              conversationId: conversation.id,
              replyForMessageId: null,
              sequenceStepRunId: null,
              expectedContextVersion: record.contextVersion,
              channel: "email",
              subject,
              editedBodyText: bodyText,
              editedBodyHtml: bodyHtml,
              status: "awaiting_review",
              error: null,
              autoSendAt: null,
              revision: existingRecoverable.revision + 1,
              updatedAt: now,
            })
            .where(eq(crmDrafts.id, existingRecoverable.id))
            .returning()
        : await tx
            .insert(crmDrafts)
            .values({
              crmRecordId: record.id,
              conversationId: conversation.id,
              replyForMessageId: null,
              sequenceStepRunId: null,
              expectedContextVersion: record.contextVersion,
              channel: "email",
              subject,
              editedBodyText: bodyText,
              editedBodyHtml: bodyHtml,
              status: "awaiting_review",
            })
            .returning();

      if (!manualDraft) throw new Error("Draft insertion did not return a row");
      if (previousConversationId && previousConversationId !== conversation.id) {
        await cleanupOrphanedConversation(tx, previousConversationId);
      }

      await tx.update(crmRecords).set({
        workflowState: "action_required",
        nextActionAt: null,
        updatedAt: now,
      }).where(eq(crmRecords.id, record.id));

      await appendCrmEvent(tx, {
        personId: record.personId,
        crmRecordId: record.id,
        pipelineId: record.pipelineId,
        eventType: "draft.created",
        actorType: "authenticated_operator",
        actorRef: actorRef ?? null,
        toData: { draftId: manualDraft.id, channel: "email", status: "awaiting_review" },
        contextVersion: record.contextVersion,
      });

      return { kind: "manual", draft: manualDraft, created: !existingRecoverable };
    }

    return {
      kind: "need_ai",
      recordId: record.id,
      targetConversationId: conversation.id,
      existingDraft: existingRecoverable ?? null,
    };
  });

  if (setup.kind === "existing") {
    return { draft: setup.draft, created: false };
  }
  if (setup.kind === "manual") {
    return { draft: setup.draft, created: setup.created };
  }

  const revision = buildInitialDraftRevision(input, setup.existingDraft);
  const draft = await generateFallbackDraft(
    setup.recordId,
    dependencies,
    revision,
    {
      targetDraftId: setup.existingDraft?.id,
      targetConversationId: setup.targetConversationId,
      personRequested: true,
    },
  );
  if (!draft) throw new Error("Draft generation returned null (check DNC or conversation setup)");
  return { draft, created: !setup.existingDraft };
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

export type RebindDraftSenderResult = {
  draft: CrmDraft;
  fromEmail: string;
  previousFromEmail: string | null;
  toEmail: string | null;
  changed: boolean;
};

/**
 * Safely rebind the sender mailbox (`fromEmail`) on an unsent `awaiting_review`
 * email draft without altering its body/subject, without creating a duplicate
 * draft, and without sending or queuing it.
 *
 * Rejects `sent`, `sending`, `delivery_uncertain`, queued (`autoSendAt !== null`),
 * and any draft with existing send attempts with `CrmConflictError` (HTTP 409).
 * Repeated calls with the already-bound `fromEmail` are idempotent no-ops.
 */
export async function rebindDraftSender(input: {
  draftId: string;
  fromEmail: string;
  revision?: number | null;
  actorRef?: string | null;
}): Promise<RebindDraftSenderResult> {
  const normalizedInput = normalizeEmail(input.fromEmail);
  if (!normalizedInput || !BASIC_EMAIL_SYNTAX.test(normalizedInput)) {
    throw new CrmConfigurationValidationError("fromEmail must be a valid email address");
  }

  return withCrmTransaction(async (tx) => {
    const [draft] = await tx
      .select()
      .from(crmDrafts)
      .where(and(draftInOrg(), eq(crmDrafts.id, input.draftId)))
      .limit(1)
      .for("update");
    if (!draft) throw new CrmNotFoundError("CRM draft", input.draftId);

    await assertDraftCanRebindSender(tx, draft);

    if (typeof input.revision === "number" && draft.revision !== input.revision) {
      throw new CrmConflictError("Draft revision is stale");
    }

    const record = await lockCrmRecord(tx, draft.crmRecordId);
    assertCurrentCrmContext(record, { contextVersion: draft.expectedContextVersion });

    const resolved = await validateAndResolveFromEmail(tx, input.fromEmail);

    const [[currentConversation], [personRow]] = await Promise.all([
      tx
        .select()
        .from(crmConversations)
        .where(eq(crmConversations.id, draft.conversationId))
        .limit(1),
      tx
        .select({ email: people.email, companyId: people.companyId })
        .from(people)
        .where(and(eq(people.organizationId, record.organizationId), eq(people.id, record.personId)))
        .limit(1),
    ]);

    const previousFromEmail = currentConversation?.accountRef?.trim() || null;
    const reqObj =
      draft.request && typeof draft.request === "object"
        ? (draft.request as Record<string, unknown>)
        : null;
    const hasStaleRequestFrom = Boolean(
      reqObj &&
        typeof reqObj.from === "string" &&
        normalizeEmail(reqObj.from) !== normalizeEmail(resolved.accountRef),
    );

    if (
      currentConversation &&
      normalizeEmail(previousFromEmail) === normalizeEmail(resolved.accountRef) &&
      !hasStaleRequestFrom
    ) {
      return {
        draft,
        fromEmail: currentConversation.accountRef,
        previousFromEmail: currentConversation.accountRef,
        toEmail: resolveDraftRecipientEmail(draft, personRow),
        changed: false,
      };
    }

    if (
      (draft.replyForMessageId !== null || draft.sequenceStepRunId !== null) &&
      normalizeEmail(previousFromEmail) !== normalizeEmail(resolved.accountRef)
    ) {
      throw new CrmConflictError(
        "Cannot rebind fromEmail on a draft linked to an existing reply message or sequence step",
      );
    }

    const { conversation: targetConversation } = await upsertConversationInTransaction(tx, {
      crmRecordId: record.id,
      personId: record.personId,
      channel: "email",
      accountRef: resolved.accountRef,
    });

    const cleanedRequest = reqObj
      ? Object.fromEntries(
          Object.entries(reqObj).filter(([k]) => k !== "gmailDraftId" && k !== "from"),
        )
      : draft.request;

    const now = new Date();
    const previousConversationId = draft.conversationId;
    const [updated] = await tx
      .update(crmDrafts)
      .set({
        conversationId: targetConversation.id,
        status: "awaiting_review",
        autoSendAt: null,
        request: cleanedRequest,
        revision: draft.revision + 1,
        updatedAt: now,
      })
      .where(eq(crmDrafts.id, draft.id))
      .returning();
    if (!updated) throw new Error("CRM draft sender rebind did not return a row");

    await tx.execute(sql`
      UPDATE crm_conversations
      SET provider_thread_id = NULL
      WHERE id = ${targetConversation.id}::uuid
        AND provider_thread_id LIKE 'r%'
    `);

    if (previousConversationId && previousConversationId !== targetConversation.id) {
      await cleanupOrphanedConversation(tx, previousConversationId);
    }

    await syncSenderAcrossInboxAndOutreach(
      tx,
      record,
      personRow,
      targetConversation.accountRef,
      resolved.mailboxId,
    );

    await appendCrmEvent(tx, {
      personId: record.personId,
      crmRecordId: record.id,
      pipelineId: record.pipelineId,
      eventType: "draft.sender_rebound",
      actorType: "authenticated_operator",
      actorRef: input.actorRef ?? null,
      fromData: {
        draftId: draft.id,
        revision: draft.revision,
        conversationId: previousConversationId,
        fromEmail: previousFromEmail,
      },
      toData: {
        draftId: draft.id,
        revision: updated.revision,
        conversationId: targetConversation.id,
        fromEmail: targetConversation.accountRef,
      },
      contextVersion: record.contextVersion,
    });

    return {
      draft: updated,
      fromEmail: targetConversation.accountRef,
      previousFromEmail,
      toEmail: resolveDraftRecipientEmail(updated, personRow),
      changed: true,
    };
  });
}

export async function updateDraft(input: {
  draftId: string;
  revision?: number | null;
  fromEmail?: string | null;
  subject?: string | null;
  bodyText: string;
  bodyHtml?: string | null;
  actorRef?: string | null;
}): Promise<CrmDraft> {
  const bodyText = input.bodyText.trim();
  if (!bodyText) throw new Error("Draft body is required");
  const requestedFromEmail = input.fromEmail?.trim() || null;
  if (requestedFromEmail) {
    const normalizedInput = normalizeEmail(requestedFromEmail);
    if (!normalizedInput || !BASIC_EMAIL_SYNTAX.test(normalizedInput)) {
      throw new CrmConfigurationValidationError("fromEmail must be a valid email address");
    }
  }
  return withCrmTransaction(async (tx) => {
    const [draft] = await tx.select().from(crmDrafts)
      .where(and(draftInOrg(), eq(crmDrafts.id, input.draftId))).limit(1).for("update");
    if (!draft) throw new CrmNotFoundError("CRM draft", input.draftId);
    if (requestedFromEmail) {
      await assertDraftCanRebindSender(tx, draft);
    } else if (!["awaiting_review", "failed"].includes(draft.status)) {
      throw new CrmConflictError("Only awaiting-review or failed drafts can be edited");
    }
    if (typeof input.revision === "number" && draft.revision !== input.revision) {
      throw new CrmConflictError("Draft revision is stale");
    }
    const record = await lockCrmRecord(tx, draft.crmRecordId);
    assertCurrentCrmContext(record, { contextVersion: draft.expectedContextVersion });

    let targetConversationId = draft.conversationId;
    let resolvedSender: { accountRef: string; mailboxId: string | null } | null = null;
    if (requestedFromEmail) {
      resolvedSender = await validateAndResolveFromEmail(tx, requestedFromEmail);
      const [currentConv] = await tx
        .select()
        .from(crmConversations)
        .where(eq(crmConversations.id, draft.conversationId))
        .limit(1);
      if (normalizeEmail(currentConv?.accountRef) !== normalizeEmail(resolvedSender.accountRef)) {
        if (draft.replyForMessageId !== null || draft.sequenceStepRunId !== null) {
          throw new CrmConflictError(
            "Cannot rebind fromEmail on a draft linked to an existing reply message or sequence step",
          );
        }
        const { conversation: targetConversation } = await upsertConversationInTransaction(tx, {
          crmRecordId: record.id,
          personId: record.personId,
          channel: "email",
          accountRef: resolvedSender.accountRef,
        });
        targetConversationId = targetConversation.id;
      }
    }

    const subject = draft.channel === "email" ? input.subject?.trim() || draft.subject : null;
    if (draft.channel === "email" && !subject) throw new Error("Email subject is required");
    const editedBodyHtml = input.bodyHtml?.trim() || textToParagraphHtml(bodyText);
    const cleanedRequest = draft.request && typeof draft.request === "object"
      ? Object.fromEntries(
          Object.entries(draft.request as Record<string, unknown>).filter(
            ([k]) => k !== "gmailDraftId" && (!requestedFromEmail || k !== "from"),
          ),
        )
      : draft.request;
    const now = new Date();
    const previousConversationId = draft.conversationId;
    const [updated] = await tx.update(crmDrafts).set({
      conversationId: targetConversationId,
      subject,
      editedBodyText: bodyText,
      editedBodyHtml,
      status: "awaiting_review",
      error: null,
      autoSendAt: null,
      request: cleanedRequest,
      revision: draft.revision + 1,
      updatedAt: now,
    }).where(eq(crmDrafts.id, draft.id)).returning();
    if (draft.status === "failed" || record.workflowState === "error") {
      await tx.update(crmRecords).set({
        workflowState: "action_required",
        nextActionAt: now,
        updatedAt: now,
      }).where(eq(crmRecords.id, record.id));
    }
    if (targetConversationId) {
      await tx.execute(sql`
        UPDATE crm_conversations
        SET provider_thread_id = NULL
        WHERE id = ${targetConversationId}::uuid
          AND provider_thread_id LIKE 'r%'
      `);
    }
    if (previousConversationId && previousConversationId !== targetConversationId) {
      await cleanupOrphanedConversation(tx, previousConversationId);
    }
    if (draft.channel === "email") {
      await syncEmailDraftAcrossInboxAndOutreach(tx, record, subject, bodyText, editedBodyHtml);
      if (resolvedSender) {
        const [personRow] = await tx
          .select({ email: people.email, companyId: people.companyId })
          .from(people)
          .where(and(eq(people.organizationId, record.organizationId), eq(people.id, record.personId)))
          .limit(1);
        await syncSenderAcrossInboxAndOutreach(
          tx,
          record,
          personRow,
          resolvedSender.accountRef,
          resolvedSender.mailboxId,
        );
      }
    }
    await appendCrmEvent(tx, {
      personId: record.personId, crmRecordId: record.id, pipelineId: record.pipelineId,
      eventType: "draft.edited", actorType: "authenticated_operator", actorRef: input.actorRef,
      fromData: {
        draftId: draft.id,
        revision: draft.revision,
        ...(requestedFromEmail ? { conversationId: previousConversationId } : {}),
      },
      toData: {
        draftId: draft.id,
        revision: updated!.revision,
        ...(resolvedSender ? { conversationId: targetConversationId, fromEmail: resolvedSender.accountRef } : {}),
      },
      contextVersion: record.contextVersion,
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
  const revision = buildRegenerateDraftRevision(draft, feedback);
  if (draft.sequenceStepRunId) return generateDraftForStep(draft.sequenceStepRunId, dependencies, revision, true);
  const regenerated = await generateFallbackDraft(
    draft.crmRecordId,
    dependencies,
    revision,
    { targetDraftId: draft.id, personRequested: true },
  );
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
    const now = new Date();
    const cleanedRequest = draft.request && typeof draft.request === "object"
      ? Object.fromEntries(Object.entries(draft.request as Record<string, unknown>).filter(([k]) => k !== "gmailDraftId"))
      : draft.request;
    const [updated] = await tx.update(crmDrafts).set({
      status: "discarded",
      request: cleanedRequest,
      updatedAt: now,
    }).where(eq(crmDrafts.id, draft.id)).returning();

    if (draft.conversationId) {
      await tx.execute(sql`
        UPDATE crm_conversations
        SET provider_thread_id = NULL
        WHERE id = ${draft.conversationId}::uuid
          AND provider_thread_id LIKE 'r%'
      `);
    }
    if (draft.channel === "email") {
      await purgeEmailDraftFromInboxAndOutreach(tx, record);
    }

    const [remainingReviewDraft] = await tx.select({ id: crmDrafts.id }).from(crmDrafts)
      .where(and(eq(crmDrafts.crmRecordId, record.id), eq(crmDrafts.status, "awaiting_review")))
      .limit(1);
    if (!remainingReviewDraft && (record.workflowState === "action_required" || record.workflowState === "error")) {
      await tx.update(crmRecords).set({
        workflowState: "waiting",
        nextActionAt: null,
        updatedAt: now,
      }).where(eq(crmRecords.id, record.id));
    }

    await appendCrmEvent(tx, {
      personId: record.personId, crmRecordId: record.id, pipelineId: record.pipelineId,
      eventType: "draft.discarded", actorType: "authenticated_operator", actorRef: input.actorRef,
      toData: { draftId: draft.id }, contextVersion: record.contextVersion,
    });
    return updated!;
  });
}
