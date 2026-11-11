import type { NextRequest } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { people } from "@/lib/leads/schema";
import { normalizeEmail } from "@/lib/leads/identity";
import { crmOperationErrorResponse } from "@/lib/crm/api";
import { assertExactKeys, assertObject, parseRequiredText, readCrmJson } from "@/lib/crm/categories";
import { requireCrmMutationContext } from "@/lib/crm/http";
import { clearPersonDoNotContact, getPersonContactPolicy, setPersonDoNotContact } from "@/lib/crm/policies";
import { inOrg, runInOrganization } from "@/lib/tenancy/scope";

export async function GET(request: NextRequest) {
  try {
    const ctx = await requireCrmMutationContext(request);
    return await runInOrganization(ctx.organizationId, async () => {
      const email = request.nextUrl.searchParams.get("email");
      const personId = request.nextUrl.searchParams.get("personId");

      let resolvedPersonId = personId;
      if (!resolvedPersonId && email) {
        const normalized = normalizeEmail(email);
        if (normalized) {
          const [found] = await db
            .select({ id: people.id })
            .from(people)
            .where(and(inOrg(people), sql`lower(${people.email}) = ${normalized}`))
            .limit(1);
          resolvedPersonId = found?.id;
        }
      }

      if (!resolvedPersonId) {
        return Response.json({ error: "personId or matching email is required" }, { status: 404 });
      }

      const policy = await getPersonContactPolicy(db, resolvedPersonId);
      return Response.json({
        personId: resolvedPersonId,
        policy: policy ?? {
          personId: resolvedPersonId,
          doNotContact: false,
          reason: null,
          source: null,
          setAt: null,
          clearedAt: null,
          reviewAfter: null,
        },
      });
    });
  } catch (error) {
    return crmOperationErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const ctx = await requireCrmMutationContext(request);
    return await runInOrganization(ctx.organizationId, async () => {
      const value = await readCrmJson(request);
      assertObject(value);
      assertExactKeys(value, ["personId", "email", "enabled", "reason", "reviewAfter"]);
      if (typeof value.enabled !== "boolean") throw new Error("enabled must be boolean");

      let resolvedPersonId = typeof value.personId === "string" ? value.personId.trim() : null;
      if (!resolvedPersonId && typeof value.email === "string") {
        const normalized = normalizeEmail(value.email);
        if (normalized) {
          const [found] = await db
            .select({ id: people.id })
            .from(people)
            .where(and(inOrg(people), sql`lower(${people.email}) = ${normalized}`))
            .limit(1);
          resolvedPersonId = found?.id ?? null;
        }
      }

      if (!resolvedPersonId) {
        return Response.json({ error: "A valid personId or existing email is required" }, { status: 404 });
      }

      const reason = value.reason === undefined
        ? (value.enabled ? "Set by operator" : "Cleared by operator")
        : parseRequiredText(value.reason, "reason", 2_000);
      const reviewAfter = value.reviewAfter === null
        ? null
        : value.reviewAfter !== undefined
          ? new Date(String(value.reviewAfter))
          : undefined;
      if (reviewAfter && isNaN(reviewAfter.getTime())) {
        throw new Error("reviewAfter must be a valid date or ISO timestamp");
      }

      const policy = value.enabled
        ? await setPersonDoNotContact({ personId: resolvedPersonId, reason, source: "human", actorType: "authenticated_operator", reviewAfter })
        : await clearPersonDoNotContact({ personId: resolvedPersonId, reason, source: "human", actorType: "authenticated_operator" });
      return Response.json({ personId: resolvedPersonId, policy });
    });
  } catch (error) {
    return crmOperationErrorResponse(error);
  }
}
