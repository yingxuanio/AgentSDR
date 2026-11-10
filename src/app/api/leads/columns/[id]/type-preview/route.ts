import { NextRequest, NextResponse } from "next/server";
import { withOrgContext } from "@/lib/auth/context";
import { previewTypeChange } from "@/lib/leads/columns";
import { PG_TYPE_FOR_COLUMN_TYPE, type LeadColumnType } from "@/lib/leads/types";
import { columnErrorResponse } from "../../errors";

/**
 * GET /api/leads/columns/[id]/type-preview?type=number
 *
 * Counts what a type change could not convert without changing anything. The UI
 * must call this and show `incompatible` before offering to apply — a cast
 * that silently nulls a third of a column is only noticed weeks later.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const type = req.nextUrl.searchParams.get("type");

  if (!type || !(type in PG_TYPE_FOR_COLUMN_TYPE)) {
    return NextResponse.json({ error: `Unsupported column type: ${type}` }, { status: 400 });
  }

  try {
    return await withOrgContext(req, async () => NextResponse.json(await previewTypeChange(id, type as LeadColumnType)));
  } catch (err) {
    return columnErrorResponse(err);
  }
}
