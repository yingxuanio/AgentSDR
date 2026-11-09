import "server-only";

import { getByokSettings } from "../byok";
import { getAiConnection, getAiCredentials, listAiConnections, type AiConnection } from "../connections";
import { strictProviderRouting, type OpenRouterModelSelection } from "../openrouter-types";
import { normalizeAnthropicBaseUrl, normalizeOpenAiBaseUrl } from "./custom-providers";
import { createOpenRouterClient } from "./openrouter";

export type StrictOpenRouterRouting = {
  only: string[];
  order: string[];
  allow_fallbacks: false;
  require_parameters: true;
};

export type ActiveAiRuntime =
  | {
      kind: "openrouter";
      client: ReturnType<typeof createOpenRouterClient>;
      apiKey: string;
      connection: AiConnection;
      selection: OpenRouterModelSelection;
      provider: StrictOpenRouterRouting;
      credentials: Record<string, string>;
    }
  | {
      kind: "openai" | "anthropic";
      apiKey: string;
      baseUrl: string;
      connection: AiConnection;
      selection: OpenRouterModelSelection;
      credentials: Record<string, string>;
    };

export async function getActiveAiRuntime(
  requested?: OpenRouterModelSelection,
  timeout = 60_000,
): Promise<ActiveAiRuntime> {
  const settings = await getByokSettings();
  if (!settings.connectionId) throw new Error("Connect an AI provider in AI Settings");

  let connection = await getAiConnection(settings.connectionId);
  if (!connection?.verified) {
    throw new Error("The AI connection in AI Settings is unavailable");
  }

  const selection = requested ?? settings.defaultModel;
  if (!selection) throw new Error("Choose a default AI model in AI Settings");
  if (!settings.providers.includes(selection.provider)) {
    throw new Error(`AI provider ${selection.provider} is not enabled in AI Settings`);
  }
  if (!settings.modelsByProvider[selection.provider]?.includes(selection.modelId)) {
    throw new Error(`Model ${selection.modelId} is not enabled for ${selection.provider} in AI Settings`);
  }

  // If the requested model belongs to a different direct provider (e.g. "openai" vs "anthropic")
  // than the primary connectionId, resolve that provider's verified connection automatically.
  if (
    connection.providerKey !== "openrouter" &&
    (selection.provider === "openai" || selection.provider === "anthropic") &&
    connection.providerKey !== selection.provider
  ) {
    const providerConns = await listAiConnections(selection.provider);
    const matched = providerConns.find((c) => c.verified);
    if (matched) {
      connection = matched;
    }
  }

  const credentials = await getAiCredentials(connection.id);
  if (!credentials?.apiKey) throw new Error("Reconnect your AI provider in AI Settings");

  if (connection.providerKey === "openai" || connection.providerKey === "anthropic") {
    const baseUrl =
      connection.providerKey === "openai"
        ? normalizeOpenAiBaseUrl(credentials.baseUrl)
        : normalizeAnthropicBaseUrl(credentials.baseUrl);
    return {
      kind: connection.providerKey,
      apiKey: credentials.apiKey,
      baseUrl,
      connection,
      selection,
      credentials,
    };
  }

  if (connection.providerKey !== "openrouter") {
    throw new Error(`Unsupported AI provider ${connection.providerKey}`);
  }
  if (!settings.byokOnlyConfirmed) {
    throw new Error("OpenRouter BYOK-only routing is not confirmed in AI Settings");
  }

  const provider: StrictOpenRouterRouting = strictProviderRouting(selection.provider);
  return {
    kind: "openrouter",
    client: createOpenRouterClient(credentials.apiKey, timeout),
    apiKey: credentials.apiKey,
    connection,
    selection,
    provider,
    credentials,
  };
}

export async function getOpenRouterRuntime(
  requested?: OpenRouterModelSelection,
  timeout = 60_000,
) {
  const settings = await getByokSettings();
  if (!settings.connectionId) throw new Error("Connect an AI provider in AI Settings");

  const connection = await getAiConnection(settings.connectionId);
  if (!connection?.verified) {
    throw new Error("The AI connection in AI Settings is unavailable");
  }
  const credentials = await getAiCredentials(connection.id);
  if (!credentials?.apiKey) throw new Error("Reconnect your AI provider in AI Settings");

  const selection = requested ?? settings.defaultModel;
  if (!selection) throw new Error("Choose a default model in AI Settings");
  if (!settings.providers.includes(selection.provider)) {
    throw new Error(`Provider ${selection.provider} is not enabled in AI Settings`);
  }
  if (!settings.modelsByProvider[selection.provider]?.includes(selection.modelId)) {
    throw new Error(`Model ${selection.modelId} is not enabled for ${selection.provider} in AI Settings`);
  }

  if (connection.providerKey === "openrouter" && !settings.byokOnlyConfirmed) {
    throw new Error("OpenRouter BYOK-only routing is not confirmed in AI Settings");
  }

  const provider: StrictOpenRouterRouting = strictProviderRouting(selection.provider);
  return {
    client: createOpenRouterClient(credentials.apiKey, timeout),
    apiKey: credentials.apiKey,
    connection,
    selection,
    provider,
  };
}
