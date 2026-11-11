import "server-only";

import { fetchRemoteModelList, normalizeAnthropicBaseUrl, normalizeOpenAiBaseUrl } from "./custom-providers";
import { listOpenRouterByokCredentials, verifyOpenRouterInferenceKey } from "./openrouter";
import { getAiProvider } from "../catalog";

/**
 * Confirms a key works before it is stored.
 *
 * Each check is the cheapest call that still proves the credential is live:
 * listing models costs nothing and fails clearly on a bad key, whereas a
 * generation request would bill the user just to validate a form.
 */
export async function verifyAiCredentials(
  providerKey: string,
  credentials: Record<string, string>,
): Promise<void> {
  const provider = getAiProvider(providerKey);
  if (!provider) throw new Error("Unknown AI provider");

  const apiKey = credentials.apiKey?.trim();
  if (!apiKey) throw new Error("API key is required");

  try {
    if (providerKey === "openai") {
      normalizeOpenAiBaseUrl(credentials.baseUrl);
      await fetchRemoteModelList("openai", credentials);
      return;
    }
    if (providerKey === "anthropic") {
      normalizeAnthropicBaseUrl(credentials.baseUrl);
      await fetchRemoteModelList("anthropic", credentials);
      return;
    }
    if (providerKey === "openrouter") {
      const managementKey = credentials.managementKey?.trim();
      if (!managementKey) throw new Error("OpenRouter management key is required");
      const [, byokCredentials] = await Promise.all([
        verifyOpenRouterInferenceKey(apiKey),
        listOpenRouterByokCredentials(managementKey),
      ]);
      if (!byokCredentials.some((credential) => !credential.disabled && !credential.is_fallback)) {
        throw new Error("No active prioritized BYOK credentials were found in this OpenRouter workspace");
      }
      return;
    }
    throw new Error(`No verifier is registered for ${provider.name}`);
  } catch (cause) {
    throw new Error(
      cause instanceof Error ? cause.message : `Could not verify this ${provider.name} key`,
    );
  }
}
