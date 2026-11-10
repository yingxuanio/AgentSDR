import { and, eq, or, sql } from "drizzle-orm";
import { companies, people } from "./schema";
import { normalizeEmail, normalizeLinkedinSlug } from "./identity";
import { inOrg } from "@/lib/tenancy/scope";
import { personProfile } from "./variables";
import { upsertPerson, withLeadTransaction } from "./records";
import { normalizePhone } from "@/lib/calls/phone";
import { organizationPhoneCountry } from "@/lib/calls/phone.server";
import { ensurePersonCrmRecord } from "@/lib/crm/records";
import { crmRecords, type CrmCategoryKey, type CrmWorkflowState } from "@/lib/crm/schema";
import { getPersonContactPolicy, setPersonDoNotContactInTransaction } from "@/lib/crm/policies";

export type ManualPersonInput = {
  idempotencyKey?: string | null;
  email?: string | null;
  linkedinUrl?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  fullName?: string | null;
  title?: string | null;
  companyName?: string | null;
  companyDomain?: string | null;
  notes?: string | null;
  /** Free-form ("+91 98765 43210", "0091…"). Invalid input is dropped, not rejected — see normalizeManualPersonInput. */
  phone?: string | null;
  workflowState?: CrmWorkflowState;
  categoryKey?: CrmCategoryKey;
  createCrmRecord?: boolean;
  dnc?: boolean;
  dncReason?: string | null;
  reviewAfter?: Date | string | null;
};

const clean = (value: string | null | undefined) => value?.trim() || null;

/** `phoneCountry`: assumed for a number typed without a + (the organization's default phone country). */
export function normalizeManualPersonInput(input: ManualPersonInput, phoneCountry?: string) {
  const email = normalizeEmail(input.email);
  const linkedinUrl = normalizeLinkedinSlug(input.linkedinUrl);
  if (input.email && !email) throw new Error(`Invalid email address: ${input.email}`);
  if (input.linkedinUrl && !linkedinUrl) throw new Error(`Invalid LinkedIn profile URL: ${input.linkedinUrl}`);
  if (!email && !linkedinUrl) throw new Error("An Email or LinkedIn URL is required");
  const idempotencyKey = clean(input.idempotencyKey);
  if (idempotencyKey && !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(idempotencyKey)) {
    throw new Error("Invalid idempotency key format: must be 8-128 chars alphanumeric, dot, underscore, colon, hyphen");
  }
  return {
    idempotencyKey,
    email,
    linkedinUrl,
    firstName: clean(input.firstName),
    lastName: clean(input.lastName),
    fullName: clean(input.fullName),
    title: clean(input.title),
    companyName: clean(input.companyName),
    companyDomain: clean(input.companyDomain),
    notes: clean(input.notes),
    phone: input.phone ? normalizePhone(input.phone, phoneCountry) : null,
    workflowState: input.workflowState,
    categoryKey: input.categoryKey,
    createCrmRecord: input.createCrmRecord !== false,
    dnc: input.dnc === true,
    dncReason: clean(input.dncReason) ?? "Set during ingestion",
    reviewAfter: input.reviewAfter ? new Date(input.reviewAfter) : null,
  };
}

export async function upsertManualPerson(input: ManualPersonInput) {
  const normalized = normalizeManualPersonInput(input, await organizationPhoneCountry());
  return withLeadTransaction(async (tx) => {
    // 1. Check idempotency key if provided
    if (normalized.idempotencyKey) {
      const [existingByKey] = await tx
        .select()
        .from(people)
        .where(and(
          inOrg(people),
          sql`${people.raw}->>'idempotencyKey' = ${normalized.idempotencyKey}`,
        ))
        .limit(1);

      if (existingByKey) {
        const [company] = existingByKey.companyId
          ? await tx.select().from(companies).where(and(inOrg(companies), eq(companies.id, existingByKey.companyId))).limit(1)
          : [null];
        const [crmRecord] = await tx.select().from(crmRecords).where(and(inOrg(crmRecords), eq(crmRecords.personId, existingByKey.id))).limit(1);
        const policy = await getPersonContactPolicy(tx, existingByKey.id);
        const profile = personProfile(existingByKey, company ?? null);
        return {
          personId: existingByKey.id,
          created: false,
          person: { ...existingByKey, fullName: profile.name, firstName: profile.firstName, lastName: profile.lastName, title: profile.headline },
          company: company ?? null,
          crmRecord: crmRecord ?? null,
          contactPolicy: policy ?? null,
        };
      }
    }

    // 2. Check if person exists by email or LinkedIn
    const [existingByIdentity] = await tx
      .select({ id: people.id })
      .from(people)
      .where(and(inOrg(people), or(
        normalized.email ? sql`lower(${people.email}) = ${normalized.email}` : undefined,
        normalized.linkedinUrl ? eq(people.linkedinUrl, normalized.linkedinUrl) : undefined,
      )))
      .limit(1);

    const isNew = !existingByIdentity;
    const rawData: Record<string, unknown> = {};
    if (normalized.notes) rawData.notes = normalized.notes;
    if (normalized.idempotencyKey) rawData.idempotencyKey = normalized.idempotencyKey;

    const person = await upsertPerson(tx, {
      email: normalized.email,
      linkedinUrl: normalized.linkedinUrl,
      firstName: normalized.firstName,
      lastName: normalized.lastName,
      fullName: normalized.fullName,
      title: normalized.title,
      phone: normalized.phone,
      company: normalized.companyName || normalized.companyDomain ? {
        name: normalized.companyName,
        domain: normalized.companyDomain,
      } : null,
      raw: Object.keys(rawData).length ? rawData : undefined,
      source: "manual-people-import",
    });

    const [company] = person.companyId
      ? await tx.select().from(companies).where(and(inOrg(companies), eq(companies.id, person.companyId))).limit(1)
      : [null];

    let crmRecord: typeof crmRecords.$inferSelect | null = null;
    if (normalized.createCrmRecord) {
      const crmResult = await ensurePersonCrmRecord(tx, {
        personId: person.id,
        workflowState: normalized.workflowState,
        categoryKey: normalized.categoryKey,
        actorType: "integration",
      });
      crmRecord = crmResult.record;
    }

    let policy = await getPersonContactPolicy(tx, person.id);
    if (normalized.dnc && !policy?.doNotContact) {
      policy = await setPersonDoNotContactInTransaction(tx, {
        personId: person.id,
        reason: normalized.dncReason,
        source: "integration",
        actorType: "integration",
        reviewAfter: normalized.reviewAfter,
      });
    }

    const profile = personProfile(person, company ?? null);
    return {
      personId: person.id,
      created: isNew,
      person: { ...person, fullName: profile.name, firstName: profile.firstName, lastName: profile.lastName, title: profile.headline },
      company: company ?? null,
      crmRecord,
      contactPolicy: policy ?? null,
    };
  });
}
