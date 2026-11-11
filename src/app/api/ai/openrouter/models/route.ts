import { NextRequest, NextResponse } from "next/server";
import { listCustomProviderCatalog } from "@/lib/ai/server/custom-providers";
import { listOpenRouterByokCatalog, listOpenRouterByokCatalogCached } from "@/lib/ai/server/openrouter";
import { getByokSettings } from "@/lib/ai/byok";
import { getAiConnection, getAiCredentials, listAiConnections } from "@/lib/ai/connections";
import { authContextErrorResponse, withOrgContext } from "@/lib/auth/context";
import { isDemoMode } from "@/lib/demo/mode";
import { DEMO_OPENROUTER_CATALOG } from "@/lib/demo/openrouterCatalog";

export async function GET(request: NextRequest) {
  try {
    return await withOrgContext(request, async () => {
      try {
        const settings = await getByokSettings();
        const connectionId = request.nextUrl.searchParams.get("connectionId") ?? settings.connectionId;
        if (!connectionId) return NextResponse.json({ providers: [], models: [], settings });
        const connection = await getAiConnection(connectionId);
        const credentials = connection?.verified ? await getAiCredentials(connection.id) : null;
        if (!connection || !credentials?.apiKey) {
          return NextResponse.json({ error: "Reconnect your AI provider in AI Settings" }, { status: 409 });
        }

        let providers;
        const explicitConnectionId = request.nextUrl.searchParams.get("connectionId");
        if (connection.providerKey === "openai" || connection.providerKey === "anthropic") {
          if (!explicitConnectionId) {
            const allConns = (await listAiConnections()).filter(
              (c) => c.verified && (c.providerKey === "openai" || c.providerKey === "anthropic"),
            );
            const seenProviders = new Set<string>();
            const catalogParts = [];
            for (const c of [connection, ...allConns]) {
              if (seenProviders.has(c.providerKey)) continue;
              seenProviders.add(c.providerKey);
              const creds = c.id === connection.id ? credentials : await getAiCredentials(c.id);
              if (!creds?.apiKey) continue;
              const savedModels = settings.modelsByProvider[c.providerKey] ?? [];
              const part = await listCustomProviderCatalog(
                c.providerKey as "openai" | "anthropic",
                creds,
                savedModels,
              );
              catalogParts.push(...part);
            }
            providers = catalogParts;
          } else {
            const savedModels = settings.modelsByProvider[connection.providerKey] ?? [];
            providers = await listCustomProviderCatalog(connection.providerKey, credentials, savedModels);
          }
        } else if (connection.providerKey === "openrouter") {
          if (!credentials.managementKey) {
            return NextResponse.json({ error: "Reconnect OpenRouter in AI Settings" }, { status: 409 });
          }
          providers = isDemoMode()
            ? DEMO_OPENROUTER_CATALOG
            : request.nextUrl.searchParams.has("all")
            ? await listOpenRouterByokCatalog(credentials.managementKey)
            : await listOpenRouterByokCatalogCached(credentials.managementKey);
        } else {
          return NextResponse.json({ error: `Unsupported AI provider ${connection.providerKey}` }, { status: 400 });
        }

        const enabled = providers.flatMap((provider) => {
          const selected = new Set(settings.modelsByProvider[provider.slug] ?? []);
          return provider.models
            .filter((model) => settings.providers.includes(provider.slug) && selected.has(model.id))
            .map((model) => ({
              ...model,
              provider: provider.slug,
              providerName: provider.name,
              providerKey: connection.providerKey,
            }));
        });
        return NextResponse.json({ providers, models: enabled, settings, connection });
      } catch (error) {
        return NextResponse.json({ error: error instanceof Error ? error.message : "Could not fetch AI models" }, { status: 502 });
      }
    });
  } catch (error) {
    const response = authContextErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
