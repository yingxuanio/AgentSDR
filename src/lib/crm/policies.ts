import { and, eq, inArray, sql } from "drizzle-orm";
import { appendCrmEvent, type CrmEventActor } from "./events";
import { crmDrafts, crmPersonContactPolicies, crmRecords, crmSequenceRuns, crmSequenceStepRuns } from "./schema";
import { people } from "@/lib/leads/schema";
import { normalizeEmail } from "@/lib/leads/identity";
import {
  CrmConflictError,
  CrmNotFoundError,
  type CrmExecutor,
  type CrmTransaction,
  withCrmTransaction,
} from "./repository";
import { assertWorkflowTransition } from "./stateMachine";
import { inOrg } from "@/lib/tenancy/scope";

export type CrmContactPolicy = typeof crmPersonContactPolicies.$inferSelect;

function requiredReason(reason: string): string {
  const clean = reason.trim();
  if (!clean) throw new Error("A reason is required when changing DNC");
  return clean;
}

/** Serializes set/clear/check-with-lock for one Person across all pipelines. */
export async function lockPersonContactPolicyScope(
  tx: CrmTransaction,
  personId: string,
): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`crm-dnc:${personId}`}, 0))`);
}

/** The person, if they belong to the organization in scope; the policy table inherits scope through it. */
function personInOrg(executor: CrmExecutor, personId: string) {
  return executor.select({ id: people.id }).from(people).where(and(inOrg(people), eq(people.id, personId)));
}

async function assertPersonInOrg(executor: CrmExecutor, personId: string): Promise<void> {
  const [person] = await personInOrg(executor, personId).limit(1);
  if (!person) throw new CrmNotFoundError("Person", personId);
}

export async function getPersonContactPolicy(
  executor: CrmExecutor,
  personId: string,
): Promise<CrmContactPolicy | null> {
  const [policy] = await executor
    .select()
    .from(crmPersonContactPolicies)
    .where(and(
      eq(crmPersonContactPolicies.personId, personId),
      inArray(crmPersonContactPolicies.personId, personInOrg(executor, personId)),
    ))
    .limit(1);
  return policy ?? null;
}

export async function isPersonDoNotContact(
  executor: CrmExecutor,
  personId: string,
): Promise<boolean> {
  return (await getPersonContactPolicy(executor, personId))?.doNotContact ?? false;
}

/** Compatibility guard for Email rows that predate a person_id FK. */
export async function isEmailDoNotContact(
  executor: CrmExecutor,
  email: string,
): Promise<boolean> {
  const normalized = normalizeEmail(email);
  if (!normalized) return false;
  const [policy] = await executor.select({ doNotContact: crmPersonContactPolicies.doNotContact })
    .from(people)
    .innerJoin(crmPersonContactPolicies, eq(crmPersonContactPolicies.personId, people.id))
    .where(and(inOrg(people), sql`lower(${people.email}) = ${normalized}`))
    .limit(1);
  return policy?.doNotContact ?? false;
}

type ContactPolicyActor = {
  actorType: CrmEventActor;
  actorRef?: string | null;
};

export type SetPersonDoNotContactInput = ContactPolicyActor & {
  personId: string;
  reason: string;
  source: "human" | "integration" | "inbound_request";
  reviewAfter?: Date | string | null;
};

export async function setPersonDoNotContactInTransaction(
  tx: CrmTransaction,
  input: SetPersonDoNotContactInput,
): Promise<CrmContactPolicy> {
  const reason = requiredReason(input.reason);
  await assertPersonInOrg(tx, input.personId);
  await lockPersonContactPolicyScope(tx, input.personId);
  const previous = await getPersonContactPolicy(tx, input.personId);
  const now = new Date();
  const reviewAfter = input.reviewAfter !== undefined
    ? (input.reviewAfter ? new Date(input.reviewAfter) : null)
    : (previous?.reviewAfter ?? null);

  if (previous?.doNotContact) {
    const isSameReason = previous.reason === reason;
    const isSameReview = (previous.reviewAfter?.getTime() ?? null) === (reviewAfter?.getTime() ?? null);
    if (isSameReason && isSameReview) return previous;

    const [updated] = await tx
      .update(crmPersonContactPolicies)
      .set({
        reason,
        reviewAfter,
        updatedAt: now,
      })
      .where(eq(crmPersonContactPolicies.personId, input.personId))
      .returning();
    return updated ?? previous;
  }

  const [policy] = await tx
    .insert(crmPersonContactPolicies)
    .values({
      personId: input.personId,
      doNotContact: true,
      reason,
      source: input.source,
      setAt: now,
      clearedAt: null,
      reviewAfter,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: crmPersonContactPolicies.personId,
      set: {
        doNotContact: true,
        reason,
        source: input.source,
        setAt: now,
        clearedAt: null,
        reviewAfter,
        updatedAt: now,
      },
    })
    .returning();
  if (!policy) throw new Error("DNC update did not return a row");

  const records = await tx
    .select()
    .from(crmRecords)
    .where(and(inOrg(crmRecords), eq(crmRecords.personId, input.personId)))
    .for("update");
  for (const record of records) {
    assertWorkflowTransition(record.workflowState, "action_required");
    const contextVersion = record.contextVersion + 1;
    const [updated] = await tx
      .update(crmRecords)
      .set({
        workflowState: "action_required",
        contextVersion,
        nextActionAt: null,
        updatedAt: now,
      })
      .where(eq(crmRecords.id, record.id))
      .returning();
    if (!updated) throw new Error("DNC record update did not return a row");
    const activeRuns = await tx.select({ id: crmSequenceRuns.id }).from(crmSequenceRuns)
      .where(and(eq(crmSequenceRuns.crmRecordId, record.id), eq(crmSequenceRuns.status, "active")));
    if (activeRuns.length) {
      const runIds = activeRuns.map((run) => run.id);
      await tx.update(crmSequenceRuns).set({ status: "interrupted", updatedAt: now })
        .where(inArray(crmSequenceRuns.id, runIds));
      await tx.update(crmSequenceStepRuns).set({ status: "cancelled", updatedAt: now })
        .where(and(
          inArray(crmSequenceStepRuns.sequenceRunId, runIds),
          inArray(crmSequenceStepRuns.status, ["scheduled", "drafting", "awaiting_review", "failed"]),
        ));
    }
    await tx.update(crmDrafts).set({ status: "stale", updatedAt: now })
      .where(and(
        eq(crmDrafts.crmRecordId, record.id),
        inArray(crmDrafts.status, ["generating", "awaiting_review", "failed"]),
      ));
    await appendCrmEvent(tx, {
      personId: record.personId,
      crmRecordId: record.id,
      pipelineId: record.pipelineId,
      eventType: "contact_policy.enforced",
      actorType: input.actorType,
      actorRef: input.actorRef,
      fromData: { workflowState: record.workflowState, nextActionAt: record.nextActionAt },
      toData: { workflowState: updated.workflowState, nextActionAt: null },
      meta: { policy: "do_not_contact", reason },
      contextVersion,
    });
  }

  await appendCrmEvent(tx, {
    personId: input.personId,
    eventType: "contact_policy.dnc_set",
    actorType: input.actorType,
    actorRef: input.actorRef,
    fromData: previous ? {
      doNotContact: previous.doNotContact,
      reason: previous.reason,
      source: previous.source,
      setAt: previous.setAt,
      clearedAt: previous.clearedAt,
    } : null,
    toData: { doNotContact: true, reason, source: input.source, setAt: now, reviewAfter },
  });
  return policy;
}

export function setPersonDoNotContact(
  input: SetPersonDoNotContactInput,
): Promise<CrmContactPolicy> {
  return withCrmTransaction((tx) => setPersonDoNotContactInTransaction(tx, input));
}

export type ClearPersonDoNotContactInput = ContactPolicyActor & {
  personId: string;
  reason: string;
  source: "human" | "integration";
};

export async function clearPersonDoNotContactInTransaction(
  tx: CrmTransaction,
  input: ClearPersonDoNotContactInput,
): Promise<CrmContactPolicy> {
  const reason = requiredReason(input.reason);
  await assertPersonInOrg(tx, input.personId);
  await lockPersonContactPolicyScope(tx, input.personId);
  const previous = await getPersonContactPolicy(tx, input.personId);
  if (!previous?.doNotContact) {
    throw new CrmConflictError("This Person is not currently marked DNC");
  }

  const now = new Date();
  const [policy] = await tx
    .update(crmPersonContactPolicies)
    .set({
      doNotContact: false,
      reason,
      source: input.source,
      clearedAt: now,
      reviewAfter: null,
      updatedAt: now,
    })
    .where(eq(crmPersonContactPolicies.personId, input.personId))
    .returning();
  if (!policy) throw new Error("DNC clear did not return a row");

  const records = await tx
    .select()
    .from(crmRecords)
    .where(and(inOrg(crmRecords), eq(crmRecords.personId, input.personId)))
    .for("update");
  for (const record of records) {
    const contextVersion = record.contextVersion + 1;
    await tx
      .update(crmRecords)
      .set({ contextVersion, updatedAt: now })
      .where(eq(crmRecords.id, record.id));
    await appendCrmEvent(tx, {
      personId: record.personId,
      crmRecordId: record.id,
      pipelineId: record.pipelineId,
      eventType: "contact_policy.cleared",
      actorType: input.actorType,
      actorRef: input.actorRef,
      fromData: { doNotContact: true },
      toData: { doNotContact: false },
      meta: { reason },
      contextVersion,
    });
  }

  await appendCrmEvent(tx, {
    personId: input.personId,
    eventType: "contact_policy.dnc_cleared",
    actorType: input.actorType,
    actorRef: input.actorRef,
    fromData: {
      doNotContact: true,
      reason: previous.reason,
      source: previous.source,
      setAt: previous.setAt,
    },
    toData: { doNotContact: false, reason, source: input.source, clearedAt: now },
  });
  return policy;
}

export function clearPersonDoNotContact(
  input: ClearPersonDoNotContactInput,
): Promise<CrmContactPolicy> {
  return withCrmTransaction((tx) => clearPersonDoNotContactInTransaction(tx, input));
}
