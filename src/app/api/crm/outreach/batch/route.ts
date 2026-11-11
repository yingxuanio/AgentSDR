import type { NextRequest } from "next/server";
import { crmOperationErrorResponse } from "@/lib/crm/api";
import { readCrmJson } from "@/lib/crm/categories";
import { requireCrmMutationContext } from "@/lib/crm/http";
import {
  processOutreachBatch,
  type OutreachDeliveryMode,
  type OutreachLeadInput,
} from "@/lib/crm/outreachBatch";
import { runInOrganization } from "@/lib/tenancy/scope";

const VALID_DELIVERY: ReadonlySet<string> = new Set([
  "draft_only",
  "queue_working_hours",
  "send_now",
  "send_paced",
]);

export async function POST(request: NextRequest) {
  try {
    const ctx = await requireCrmMutationContext(request);
    return await runInOrganization(ctx.organizationId, async () => {
      const body = (await readCrmJson(request)) as Record<string, unknown>;
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return Response.json({ error: "Request body must be a JSON object" }, { status: 400 });
      }
      const rawLeads = body.leads;
      if (!Array.isArray(rawLeads) || rawLeads.length === 0) {
        return Response.json({ error: "`leads` must be a non-empty array" }, { status: 400 });
      }
      if (rawLeads.length > 30) {
        return Response.json({ error: "`leads` cannot exceed 30 items per batch call" }, { status: 400 });
      }
      const deliveryRaw = typeof body.delivery === "string" ? body.delivery.trim() : "draft_only";
      if (!VALID_DELIVERY.has(deliveryRaw)) {
        return Response.json(
          { error: `Invalid delivery mode "${deliveryRaw}". Expected draft_only | queue_working_hours | send_now | send_paced` },
          { status: 400 },
        );
      }

      const summary = await processOutreachBatch(
        {
          leads: rawLeads as OutreachLeadInput[],
          delivery: deliveryRaw as OutreachDeliveryMode,
          paceMs: typeof body.paceMs === "number" ? body.paceMs : undefined,
        },
        ctx.userName,
      );
      return Response.json(summary);
    });
  } catch (error) {
    return crmOperationErrorResponse(error);
  }
}
