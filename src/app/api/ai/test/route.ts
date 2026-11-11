import { NextRequest, NextResponse } from "next/server";
import { getAiConnection, getAiCredentials } from "@/lib/ai/connections";
import {
  fetchRemoteModelList,
  invokeAnthropicMessages,
  invokeOpenAiResponses,
  normalizeAnthropicBaseUrl,
  normalizeOpenAiBaseUrl,
} from "@/lib/ai/server/custom-providers";
import { createOpenRouterClient, OPENROUTER_BASE_URL } from "@/lib/ai/server/openrouter";
import { authContextErrorResponse, requirePermission, withOrgContext } from "@/lib/auth/context";

const PREFERRED_TEST_MODELS: Record<"openai" | "anthropic", string[]> = {
  openai: [
    "gpt-6-luna",
    "gpt-5.6",
    "gpt-6",
    "gpt-5.4-mini",
    "gpt-5.4",
    "gpt-5.2",
    "gpt-4.1-mini",
    "gpt-4.1",
    "gpt-4o-mini",
    "gpt-4o",
    "codex-auto-review",
  ],
  anthropic: [
    "claude-sonnet-5-5",
    "claude-opus-5-5",
    "gemini-2.5-flash",
    "claude-sonnet-4-6",
    "claude-sonnet-4-5",
    "claude-haiku-4-5",
    "claude-3-7-sonnet-latest",
  ],
};

function pickPreferredTestModel(
  providerKey: "openai" | "anthropic",
  discoveredIds: string[],
): string {
  if (discoveredIds.length > 0) {
    const idSet = new Set(discoveredIds);
    for (const candidate of PREFERRED_TEST_MODELS[providerKey]) {
      if (idSet.has(candidate)) return candidate;
    }
    return discoveredIds[0];
  }
  return providerKey === "openai" ? "gpt-6-luna" : "claude-sonnet-5-5";
}

type TestCallBody = {
  connectionId?: string;
  providerKey?: "openai" | "anthropic" | "openrouter";
  credentials?: {
    baseUrl?: string;
    apiKey?: string;
    organization?: string;
    managementKey?: string;
  };
  modelId?: string;
  prompt?: string;
};

export async function POST(request: NextRequest) {
  try {
    return await withOrgContext(request, async (ctx) => {
      requirePermission(ctx, { integrations: ["manage"] });
      const body = (await request.json().catch(() => null)) as TestCallBody | null;
      if (!body || typeof body !== "object") {
        return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
      }

      let providerKey = body.providerKey;
      let credentials: Record<string, string> | null = null;

      if (body.connectionId?.trim()) {
        const connection = await getAiConnection(body.connectionId.trim());
        if (!connection) {
          return NextResponse.json({ error: "AI connection not found" }, { status: 404 });
        }
        providerKey = connection.providerKey as "openai" | "anthropic" | "openrouter";
        credentials = await getAiCredentials(connection.id);
      } else if (body.credentials && typeof body.credentials === "object") {
        credentials = {
          baseUrl: String(body.credentials.baseUrl ?? "").trim(),
          apiKey: String(body.credentials.apiKey ?? "").trim(),
          organization: String(body.credentials.organization ?? "").trim(),
          managementKey: String(body.credentials.managementKey ?? "").trim(),
        };
      }

      if (!providerKey || !["openai", "anthropic", "openrouter"].includes(providerKey)) {
        return NextResponse.json({ error: "Valid providerKey (openai, anthropic, or openrouter) is required" }, { status: 400 });
      }
      if (!credentials?.apiKey?.trim()) {
        return NextResponse.json({ error: "API key is required for test call" }, { status: 400 });
      }

      const prompt = body.prompt?.trim() || "Reply with one short sentence confirming the API connection is working and state your model name.";
      let modelId = body.modelId?.trim() || "";
      const started = Date.now();

      try {
        if (providerKey === "openai" || providerKey === "anthropic") {
          const discovery = await fetchRemoteModelList(providerKey, credentials, 12_000).catch(() => ({
            models: [],
            endpoint: "",
            liveDiscovered: false,
          }));
          if (!modelId) {
            modelId = pickPreferredTestModel(
              providerKey,
              discovery.models.map((m) => m.id),
            );
          }

          if (providerKey === "openai") {
            const baseUrl = normalizeOpenAiBaseUrl(credentials.baseUrl);
            const { result } = await invokeOpenAiResponses({
              credentials,
              model: modelId,
              instructions: "You are a connectivity diagnostic assistant. Keep your answer concise.",
              input: prompt,
              maxOutputTokens: 128,
              timeoutMs: 25_000,
            });
            return NextResponse.json({
              ok: true,
              providerKey: "openai",
              apiFormat: "OpenAI Responses (/v1/responses)",
              baseUrl,
              endpoint: result.endpoint,
              modelId: result.model || modelId,
              latencyMs: Date.now() - started,
              replyText: result.text || "(Empty text response)",
              usage: result.usage,
              discoveredModelCount: discovery.models.length,
              discoveredModels: discovery.models.slice(0, 50).map((m) => m.id),
            });
          }

          const baseUrl = normalizeAnthropicBaseUrl(credentials.baseUrl);
          const { result } = await invokeAnthropicMessages({
            credentials,
            model: modelId,
            system: "You are a connectivity diagnostic assistant. Keep your answer concise.",
            messages: [{ role: "user", content: prompt }],
            maxTokens: 128,
            timeoutMs: 25_000,
          });
          return NextResponse.json({
            ok: true,
            providerKey: "anthropic",
            apiFormat: "Anthropic Messages (/v1/messages)",
            baseUrl,
            endpoint: result.endpoint,
            modelId: result.model || modelId,
            latencyMs: Date.now() - started,
            replyText: result.text || "(Empty text response)",
            usage: result.usage,
            discoveredModelCount: discovery.models.length,
            discoveredModels: discovery.models.slice(0, 50).map((m) => m.id),
          });
        }

        // OpenRouter test call
        const targetModel = modelId || "openai/gpt-4o-mini";
        const client = createOpenRouterClient(credentials.apiKey, 25_000);
        const response = await client.chat.completions.create({
          model: targetModel,
          messages: [{ role: "user", content: prompt }],
          max_tokens: 128,
        });
        return NextResponse.json({
          ok: true,
          providerKey: "openrouter",
          apiFormat: "OpenRouter Chat Completions (/api/v1/chat/completions)",
          baseUrl: OPENROUTER_BASE_URL,
          endpoint: `${OPENROUTER_BASE_URL}/chat/completions`,
          modelId: response.model || targetModel,
          latencyMs: Date.now() - started,
          replyText: response.choices?.[0]?.message?.content?.trim() || "(Empty text response)",
          usage: {
            inputTokens: response.usage?.prompt_tokens,
            outputTokens: response.usage?.completion_tokens,
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Test call failed";
        return NextResponse.json(
          {
            ok: false,
            providerKey,
            modelId,
            latencyMs: Date.now() - started,
            error: message,
          },
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
