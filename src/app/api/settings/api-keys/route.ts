import { NextRequest, NextResponse } from "next/server";
import { createApiKey, listApiKeys } from "@/lib/auth/api-keys";
import { authContextErrorResponse, requirePermission, withOrgContext } from "@/lib/auth/context";

export async function GET(request: NextRequest) {
  try {
    return await withOrgContext(request, async () => {
      const keys = await listApiKeys();
      return NextResponse.json({ apiKeys: keys });
    });
  } catch (error) {
    const response = authContextErrorResponse(error);
    if (response) return response;
    throw error;
  }
}

export async function POST(request: NextRequest) {
  try {
    return await withOrgContext(request, async (ctx) => {
      requirePermission(ctx, { integrations: ["manage"] });
      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
      const name = typeof body?.name === "string" ? body.name.trim() : "";
      if (!name) {
        return NextResponse.json({ error: "API key name is required" }, { status: 400 });
      }
      const created = await createApiKey({
        name,
        createdByUserId: ctx.userId,
        createdByEmail: ctx.userEmail,
      });
      return NextResponse.json(created, { status: 201 });
    });
  } catch (error) {
    const response = authContextErrorResponse(error);
    if (response) return response;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not create API key" },
      { status: 400 },
    );
  }
}
