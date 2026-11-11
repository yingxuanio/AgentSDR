import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { companies, people } from "@/lib/leads/schema";
import { crmProjectionForPeople } from "@/lib/crm/queries";
import { getPersonContactPolicy } from "@/lib/crm/policies";
import { personProfile } from "@/lib/leads/variables";
import { authContextErrorResponse, withOrgContext } from "@/lib/auth/context";
import { inOrg } from "@/lib/tenancy/scope";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    return await withOrgContext(req, async () => {
      const { id } = await params;
      const [person] = await db
        .select()
        .from(people)
        .where(and(inOrg(people), eq(people.id, id)))
        .limit(1);

      if (!person) {
        return NextResponse.json({ error: "Person not found" }, { status: 404 });
      }

      const [company] = person.companyId
        ? await db.select().from(companies).where(and(inOrg(companies), eq(companies.id, person.companyId))).limit(1)
        : [null];

      const [crmMap, policy] = await Promise.all([
        crmProjectionForPeople([person.id]),
        getPersonContactPolicy(db, person.id),
      ]);

      const crm = crmMap.get(person.id) ?? null;
      const profile = personProfile(person, company ?? null);
      const dnc = Boolean(policy?.doNotContact);
      const closed = crm ? crm.workflowState === "closed" : false;

      return NextResponse.json({
        person: {
          ...person,
          fullName: profile.name,
          firstName: profile.firstName,
          lastName: profile.lastName,
          title: profile.headline,
        },
        company: company ?? null,
        crm,
        contactPolicy: policy ? {
          doNotContact: policy.doNotContact,
          reason: policy.reason,
          source: policy.source,
          reviewAfter: policy.reviewAfter,
          setAt: policy.setAt,
          clearedAt: policy.clearedAt,
        } : null,
        dnc,
        closed,
        lastOutboundAt: crm?.lastOutboundAt ?? null,
        lastInboundAt: crm?.lastInboundAt ?? null,
        lastInteractionAt: crm?.lastInteractionAt ?? null,
      });
    });
  } catch (error) {
    const auth = authContextErrorResponse(error);
    if (auth) return auth;
    throw error;
  }
}
