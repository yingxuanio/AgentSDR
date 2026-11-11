import type { AiUseCase } from "@/lib/grid/types";
import { ANTHROPIC_PROVIDER } from "./providers/anthropic";
import { OPENAI_PROVIDER } from "./providers/openai";
import { OPENROUTER_PROVIDER } from "./providers/openrouter";
import type { AiModelDefinition, AiProviderDefinition } from "./types";

export * from "./types";

/**
 * Client-safe registry of AI providers. Imported by the configuration UI, so
 * it must never pull in a server module — the provider call implementations
 * live under ./server and are reached through its registry.
 */
export const AI_PROVIDERS: AiProviderDefinition[] = [
  OPENAI_PROVIDER,
  ANTHROPIC_PROVIDER,
  OPENROUTER_PROVIDER,
];

export function getAiProvider(key: string): AiProviderDefinition | null {
  return AI_PROVIDERS.find((provider) => provider.key === key) ?? null;
}

export function getAiModel(
  providerKey: string,
  modelKey: string,
  useCase?: AiUseCase,
): AiModelDefinition | null {
  const staticModel = getAiProvider(providerKey)?.models.find((model) => model.key === modelKey) ?? null;
  if (staticModel) return staticModel;

  // Dynamic model IDs discovered from /v1/models or entered by the user for
  // OpenAI Responses, Anthropic Messages, or OpenRouter are persisted directly.
  if (
    modelKey.trim()
    && (providerKey === "openrouter" || providerKey === "openai" || providerKey === "anthropic")
  ) {
    const trimmed = modelKey.trim();
    const image = useCase === "image-generation" || /image|dall-e|flux/i.test(trimmed);
    const providerLabel =
      providerKey === "openai"
        ? "OpenAI Responses model"
        : providerKey === "anthropic"
        ? "Anthropic Messages model"
        : "OpenRouter model";
    return {
      key: trimmed,
      name: trimmed,
      description: providerLabel,
      modelId: trimmed,
      useCases: image ? ["image-generation"] : ["content", "web-research"],
      creditsPerRun: 1,
      producesImages: image,
      maxOutputTokens: 16000,
    };
  }
  return null;
}

export type AiModelChoice = { provider: AiProviderDefinition; model: AiModelDefinition };

/** Every model that can serve a use case, cheapest first — the picker's list. */
export function modelsForUseCase(useCase: AiUseCase): AiModelChoice[] {
  return AI_PROVIDERS.flatMap((provider) =>
    provider.models
      .filter((model) => model.useCases.includes(useCase))
      .map((model) => ({ provider, model })),
  ).sort((a, b) => a.model.creditsPerRun - b.model.creditsPerRun);
}

/**
 * Column keys a prompt reads.
 *
 * Shared by the DAG builder and the UI's column chips so both agree on what
 * counts as a reference. Mirrors the {{token}} syntax the HTTP and formula
 * columns already use rather than inventing a third.
 */
const TOKEN_RE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

export function promptColumnKeys(prompt: string | undefined | null): string[] {
  if (!prompt) return [];
  return [...new Set([...prompt.matchAll(TOKEN_RE)].map((match) => match[1]))];
}
