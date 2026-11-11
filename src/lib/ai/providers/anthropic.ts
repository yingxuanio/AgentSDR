import type { AiProviderDefinition } from "../types";

/**
 * Model ids are the exact strings the Messages API accepts and are complete
 * as written — never append a date suffix to them.
 *
 * Credits below are a relative display unit, scaled from Anthropic's public
 * per-million-token pricing so the picker can rank models honestly; they are
 * not what the user is billed. Billing happens on their own API key.
 */
export const ANTHROPIC_PROVIDER: AiProviderDefinition = {
  key: "anthropic",
  name: "Anthropic Messages",
  description: "Anthropic Messages API (/v1/messages) — official Claude or custom BaseURL compatible endpoints.",
  websiteUrl: "https://www.anthropic.com",
  iconText: "A",
  iconBackground: "#D97757",
  auth: {
    fields: [
      {
        key: "baseUrl",
        label: "Base URL",
        placeholder: "https://api.anthropic.com",
        inputType: "text",
        required: false,
      },
      {
        key: "apiKey",
        label: "API key",
        placeholder: "sk-ant-...",
        inputType: "password",
        required: true,
      },
    ],
    helpUrl: "https://console.anthropic.com/settings/keys",
  },
  models: [
    {
      key: "claude-sonnet-5-5",
      name: "Claude Sonnet 5.5",
      description: "Balanced speed and frontier intelligence via Anthropic Messages API.",
      modelId: "claude-sonnet-5-5",
      useCases: ["web-research", "content"],
      creditsPerRun: 2,
      supportsWebSearch: true,
      maxOutputTokens: 16000,
    },
    {
      key: "claude-opus-5-5",
      name: "Claude Opus 5.5",
      description: "Anthropic's flagship reasoning and agent model via Messages API.",
      modelId: "claude-opus-5-5",
      useCases: ["web-research", "content"],
      creditsPerRun: 5,
      supportsWebSearch: true,
      maxOutputTokens: 16000,
    },
    {
      key: "claude-sonnet-4-5",
      name: "Claude Sonnet 4.5",
      description: "Balanced speed and frontier intelligence for SDR classification and drafting.",
      modelId: "claude-sonnet-4-5",
      useCases: ["web-research", "content"],
      creditsPerRun: 2,
      supportsWebSearch: true,
      maxOutputTokens: 16000,
    },
    {
      key: "claude-opus-4-5",
      name: "Claude Opus 4.5",
      description: "Anthropic's flagship reasoning model via Messages API.",
      modelId: "claude-opus-4-5",
      useCases: ["web-research", "content"],
      creditsPerRun: 5,
      supportsWebSearch: true,
      maxOutputTokens: 16000,
    },
    {
      key: "claude-haiku-4-5",
      name: "Claude Haiku 4.5",
      description: "Fastest and cheapest Claude. Best for simple extraction over many rows.",
      modelId: "claude-haiku-4-5",
      useCases: ["content"],
      creditsPerRun: 1,
      maxOutputTokens: 8000,
    },
    {
      key: "claude-3-7-sonnet-latest",
      name: "Claude 3.7 Sonnet",
      description: "Hybrid reasoning Claude Sonnet model.",
      modelId: "claude-3-7-sonnet-latest",
      useCases: ["web-research", "content"],
      creditsPerRun: 2,
      supportsWebSearch: true,
      maxOutputTokens: 16000,
    },
    {
      key: "claude-3-5-sonnet-latest",
      name: "Claude 3.5 Sonnet",
      description: "High-reliability model for structured tool calls and copywriting.",
      modelId: "claude-3-5-sonnet-latest",
      useCases: ["web-research", "content"],
      creditsPerRun: 2,
      supportsWebSearch: true,
      maxOutputTokens: 8192,
    },
    {
      key: "claude-opus-5",
      name: "Claude Opus 5",
      description: "Anthropic's most intelligent model for building agents and coding.",
      modelId: "claude-opus-5",
      useCases: ["web-research", "content"],
      creditsPerRun: 5,
      supportsWebSearch: true,
      maxOutputTokens: 16000,
    },
    {
      key: "claude-opus-4-8",
      name: "Claude Opus 4.8",
      description: "Previous Opus generation. Same price, slightly different tuning.",
      modelId: "claude-opus-4-8",
      useCases: ["web-research", "content"],
      creditsPerRun: 5,
      supportsWebSearch: true,
      maxOutputTokens: 16000,
    },
    {
      key: "claude-sonnet-5",
      name: "Claude Sonnet 5",
      description: "Balanced speed and intelligence. A good default for high row counts.",
      modelId: "claude-sonnet-5",
      useCases: ["web-research", "content"],
      creditsPerRun: 2,
      supportsWebSearch: true,
      maxOutputTokens: 16000,
    },
  ],
};
