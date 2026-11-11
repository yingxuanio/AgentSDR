import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { crmOperationErrorResponse } from "@/lib/crm/api";
import { assertExactKeys, assertObject, parseRequiredText, parseUuid, readCrmJson } from "@/lib/crm/categories";
import { requireCrmMutationContext } from "@/lib/crm/http";
import { clearPersonDoNotContact, getPersonContactPolicy, setPersonDoNotContact } from "@/lib/crm/policies";
import { runInOrganization } from "@/lib/tenancy/scope";

export async function GET(request: NextRequest, { params }: { params: Promise<{ personId: string }> }) {
  try {
    const ctx = await requireCrmMutationContext(request);
    return await runInOrganization(ctx.organizationId, async () => {
      const personId = parseUuid((await params).personId, "person id");
      const policy = await getPersonContactPolicy(db, personId);
      return Response.json({
        personId,
        policy: policy ?? {
          personId,
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

export async function POST(request: NextRequest, { params }: { params: Promise<{ personId: string }> }) {
  try {
    const ctx = await requireCrmMutationContext(request);
    return await runInOrganization(ctx.organizationId, async () => {
      const personId = parseUuid((await params).personId, "person id");
      const value = await readCrmJson(request);
      assertObject(value);
      assertExactKeys(value, ["enabled", "reason", "reviewAfter"]);
      if (typeof value.enabled !== "boolean") throw new Error("enabled must be boolean");
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
        ? await setPersonDoNotContact({ personId, reason, source: "human", actorType: "authenticated_operator", reviewAfter })
        : await clearPersonDoNotContact({ personId, reason, source: "human", actorType: "authenticated_operator" });
      return Response.json({ policy });
    });
  } catch (error) {
    return crmOperationErrorResponse(error);
  }
}
