import { NextRequest, NextResponse } from "next/server";
import { getByokSettings, saveByokSettings } from "@/lib/ai/byok";
import { normalizeByokSettings } from "@/lib/ai/openrouter-types";
import { getAiConnection, getAiCredentials } from "@/lib/ai/connections";
import { listOpenRouterByokCatalog } from "@/lib/ai/server/openrouter";
import { authContextErrorResponse, requirePermission, withOrgContext } from "@/lib/auth/context";

export async function GET(request: NextRequest) {
  try {
    return await withOrgContext(request, async () => {
      return NextResponse.json(await getByokSettings());
    });
  } catch (error) {
    const response = authContextErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
export async function PUT(req: NextRequest) {
  try {
    return await withOrgContext(req, async (ctx) => {
      requirePermission(ctx, { integrations: ["manage"] });
      const body = await req.json().catch(() => null);
      if (!body || typeof body !== "object") {
        return NextResponse.json({ error: "Invalid settings" }, { status: 400 });
      }
      const settings = normalizeByokSettings(body);
      if (settings.providers.length && !settings.connectionId) {
        return NextResponse.json({ error: "Connect an AI provider before selecting models" }, { status: 400 });
      }
      if (settings.connectionId) {
        const connection = await getAiConnection(settings.connectionId);
        if (!connection?.verified) {
          return NextResponse.json({ error: "Select a verified AI connection" }, { status: 400 });
        }
        if (connection.providerKey === "openai" || connection.providerKey === "anthropic") {
          const credentials = await getAiCredentials(connection.id);
          if (!credentials?.apiKey) {
            return NextResponse.json({ error: "Reconnect your AI provider before saving" }, { status: 400 });
          }
          // Direct OpenAI Responses / Anthropic Messages connections always use the user's own API key directly.
          settings.byokOnlyConfirmed = true;
        } else if (connection.providerKey === "openrouter") {
          if (settings.providers.length && !settings.byokOnlyConfirmed) {
            return NextResponse.json({ error: "Confirm BYOK-only routing before saving" }, { status: 400 });
          }
          if (settings.providers.length) {
            const credentials = await getAiCredentials(connection.id);
            if (!credentials?.apiKey || !credentials.managementKey) {
              return NextResponse.json({ error: "Reconnect OpenRouter before saving" }, { status: 400 });
            }
            try {
              const catalog = await listOpenRouterByokCatalog(credentials.managementKey);
              const available = new Map(catalog.map((provider) => [provider.slug, new Set(provider.models.map((model) => model.id))]));
              for (const provider of settings.providers) {
                const models = available.get(provider);
                if (!models) return NextResponse.json({ error: `${provider} has no active BYOK credential` }, { status: 400 });
                if (settings.modelsByProvider[provider].some((model) => !models.has(model))) {
                  return NextResponse.json({ error: `One or more selected ${provider} models are no longer available through BYOK` }, { status: 400 });
                }
              }
              if (settings.defaultModel) {
                const defaultProvider = catalog.find((provider) => provider.slug === settings.defaultModel?.provider);
                const defaultModel = defaultProvider?.models.find((model) => model.id === settings.defaultModel?.modelId);
                if (
                  !defaultModel?.outputModalities?.includes("text")
                  || !defaultModel.supportedParameters?.includes("tools")
                ) {
                  return NextResponse.json({ error: "The default model must support function calling" }, { status: 400 });
                }
              }
            } catch (error) {
              return NextResponse.json({ error: error instanceof Error ? error.message : "Could not validate OpenRouter BYOK settings" }, { status: 502 });
            }
          }
        } else {
          return NextResponse.json({ error: `Unsupported AI provider ${connection.providerKey}` }, { status: 400 });
        }
      }
      if (settings.providers.some((provider) => !(settings.modelsByProvider[provider]?.length))) {
        return NextResponse.json({ error: "Select at least one model for every enabled provider" }, { status: 400 });
      }
      if (settings.providers.length && !settings.defaultModel) {
        return NextResponse.json({ error: "Choose a default model" }, { status: 400 });
      }
      return NextResponse.json(await saveByokSettings(settings));
    });
  } catch (error) {
    const response = authContextErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
