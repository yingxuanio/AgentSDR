import "server-only";

import { AI_PROVIDERS } from "../catalog";
import { runAnthropic } from "./anthropic";
import { runOpenAi, runOpenAiImage } from "./openai";
import { runOpenRouter, runOpenRouterImage } from "./openrouter-runner";
import type { AiRunner } from "./types";

/**
 * Provider key -> the function that calls it.
 *
 * Split by whether the model produces images, because that is a different
 * endpoint on every provider, not a parameter on the text one.
 */
const RUNNERS: Record<string, { text?: AiRunner; image?: AiRunner }> = {
  openai: { text: runOpenAi, image: runOpenAiImage },
  anthropic: { text: runAnthropic },
  openrouter: { text: runOpenRouter, image: runOpenRouterImage },
};

// Fails at startup rather than on a user's first run, the same guard
// integrations/server/registry.ts applies to action handlers.
for (const provider of AI_PROVIDERS) {
  const registered = RUNNERS[provider.key];
  if (!registered) {
    throw new Error(`AI provider ${provider.key} is in the catalog but has no server runner`);
  }
  for (const model of provider.models) {
    const needed = model.producesImages ? registered.image : registered.text;
    if (!needed) {
      throw new Error(
        `AI model ${provider.key}/${model.key} needs a ${model.producesImages ? "image" : "text"} runner that is not registered`,
      );
    }
  }
}

export function getAiRunner(providerKey: string, producesImages: boolean): AiRunner | null {
  const entry = RUNNERS[providerKey];
  if (!entry) return null;
  return (producesImages ? entry.image : entry.text) ?? null;
}
