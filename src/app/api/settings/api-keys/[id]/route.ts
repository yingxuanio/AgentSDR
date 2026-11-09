import { NextRequest, NextResponse } from "next/server";
import { revokeApiKey } from "@/lib/auth/api-keys";
import { authContextErrorResponse, requirePermission, withOrgContext } from "@/lib/auth/context";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    return await withOrgContext(request, async (ctx) => {
      requirePermission(ctx, { integrations: ["manage"] });
      const { id } = await params;
      const deleted = await revokeApiKey(id);
      if (!deleted) {
        return NextResponse.json({ error: "API key not found" }, { status: 404 });
      }
      return NextResponse.json({ revoked: true, id });
    });
  } catch (error) {
    const response = authContextErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
