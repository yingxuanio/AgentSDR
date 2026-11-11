import { NextRequest, NextResponse } from "next/server";
import { getAiProvider } from "@/lib/ai/catalog";
import { createAiConnection, listAiConnections } from "@/lib/ai/connections";
import { authContextErrorResponse, requirePermission, withOrgContext } from "@/lib/auth/context";

// GET /api/grid/ai/providers/[providerKey]/connections
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ providerKey: string }> },
) {
  try {
    return await withOrgContext(_req, async () => {
      const { providerKey } = await params;
      if (providerKey === "all") {
        return NextResponse.json({ connections: await listAiConnections() });
      }
      if (!getAiProvider(providerKey)) {
        return NextResponse.json({ error: "unknown AI provider" }, { status: 404 });
      }
      return NextResponse.json({ connections: await listAiConnections(providerKey) });
    });
  } catch (error) {
    const response = authContextErrorResponse(error);
    if (response) return response;
    throw error;
  }
}

// POST /api/grid/ai/providers/[providerKey]/connections — { name?, credentials }
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ providerKey: string }> },
) {
  try {
    return await withOrgContext(req, async (ctx) => {
      requirePermission(ctx, { integrations: ["manage"] });
      const { providerKey } = await params;
      const provider = getAiProvider(providerKey);
      if (!provider) return NextResponse.json({ error: "unknown AI provider" }, { status: 404 });

      let body: { name?: string; credentials?: Record<string, string> };
      try {
        body = await req.json();
      } catch {
        return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
      }
      if (!body.credentials || typeof body.credentials !== "object") {
        return NextResponse.json({ error: "credentials are required" }, { status: 400 });
      }

      try {
        const connection = await createAiConnection({
          providerKey,
          name: body.name ?? `${provider.name} account`,
          credentials: body.credentials,
        });
        return NextResponse.json({ connection }, { status: 201 });
      } catch (cause) {
        // A rejected key is the user's input, not a server fault.
        return NextResponse.json(
          { error: cause instanceof Error ? cause.message : "Could not add that account" },
          { status: 400 },
        );
      }
    });
  } catch (error) {
    const response = authContextErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
