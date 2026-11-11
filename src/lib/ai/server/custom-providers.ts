import "server-only";

import { ANTHROPIC_PROVIDER } from "../providers/anthropic";
import { OPENAI_PROVIDER } from "../providers/openai";
import type { OpenRouterModelSummary, OpenRouterProviderModels } from "../openrouter-types";

export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com";

function ensureScheme(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/**
 * Normalizes a user-supplied OpenAI Responses Base URL so that appending
 * `/responses` or `/models` hits the right path whether the user entered
 * `https://api.openai.com`, `https://api.openai.com/v1`,
 * `https://gateway.example.com/openai`, or `https://gateway.example.com/v1/responses`.
 */
export function normalizeOpenAiBaseUrl(raw?: string | null): string {
  const input = ensureScheme(raw ?? "");
  if (!input) return DEFAULT_OPENAI_BASE_URL;

  let cleaned = input
    .replace(/\/+$/, "")
    .replace(/\/v1\/responses$/i, "/v1")
    .replace(/\/responses$/i, "")
    .replace(/\/v1\/chat\/completions$/i, "/v1")
    .replace(/\/chat\/completions$/i, "")
    .replace(/\/v1\/models$/i, "/v1")
    .replace(/\/models$/i, "")
    .replace(/\/+$/, "");

  try {
    const parsed = new URL(cleaned);
    if (!parsed.pathname || parsed.pathname === "/") {
      cleaned = `${cleaned}/v1`;
    }
  } catch {
    throw new Error("Base URL must be a valid http(s) URL");
  }

  return cleaned;
}

/**
 * Normalizes a user-supplied Anthropic Messages Base URL.
 * Returns the base without trailing `/v1` or `/v1/messages` so we can
 * deterministically append `/v1/messages` and `/v1/models`.
 */
export function normalizeAnthropicBaseUrl(raw?: string | null): string {
  const input = ensureScheme(raw ?? "");
  if (!input) return DEFAULT_ANTHROPIC_BASE_URL;

  const cleaned = input
    .replace(/\/+$/, "")
    .replace(/\/v1\/messages$/i, "")
    .replace(/\/messages$/i, "")
    .replace(/\/v1\/models$/i, "")
    .replace(/\/models$/i, "")
    .replace(/\/v1$/i, "")
    .replace(/\/+$/, "");

  try {
    new URL(cleaned);
  } catch {
    throw new Error("Base URL must be a valid http(s) URL");
  }

  return cleaned;
}

export function candidateOpenAiEndpointUrls(baseUrl: string, suffix: "/responses" | "/models" | "/images/generations"): string[] {
  const normalized = normalizeOpenAiBaseUrl(baseUrl);
  const primary = `${normalized}${suffix}`;
  if (normalized.endsWith("/v1")) {
    return [primary];
  }
  return [primary, `${normalized}/v1${suffix}`];
}

export function candidateAnthropicEndpointUrls(baseUrl: string, suffix: "/messages" | "/models"): string[] {
  const normalized = normalizeAnthropicBaseUrl(baseUrl);
  return [`${normalized}/v1${suffix}`, `${normalized}${suffix}`];
}

export type ParsedToolCall = {
  id?: string;
  name: string;
  arguments: string;
};

export type UnifiedModelCallResult = {
  id?: string;
  model: string;
  endpoint: string;
  text: string;
  toolCalls: ParsedToolCall[];
  stopReason?: string | null;
  usage: {
    inputTokens?: number;
    outputTokens?: number;
  };
  raw: unknown;
};

function extractErrorMessage(body: unknown, status: number, fallbackPrefix: string): string {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    if (typeof record.error === "string" && record.error.trim()) return record.error.trim();
    if (record.error && typeof record.error === "object") {
      const errObj = record.error as Record<string, unknown>;
      if (typeof errObj.message === "string" && errObj.message.trim()) return errObj.message.trim();
      if (typeof errObj.type === "string" && errObj.type.trim()) return `${errObj.type} (${status})`;
    }
    if (typeof record.message === "string" && record.message.trim()) return record.message.trim();
    if (typeof record.detail === "string" && record.detail.trim()) return record.detail.trim();
  }
  if (typeof body === "string" && body.trim()) {
    return body.trim().slice(0, 400);
  }
  return `${fallbackPrefix} failed (HTTP ${status})`;
}

/**
 * Parses an OpenAI Responses API JSON object or SSE stream text into a
 * normalized UnifiedModelCallResult.
 */
export function parseOpenAiResponsesPayload(
  payload: unknown,
  rawText: string,
  fallbackModel: string,
  endpoint: string,
): UnifiedModelCallResult {
  // Handle SSE streams returned by gateways that stream even when stream=false
  if (!payload && rawText.includes("event:")) {
    let completedResponse: Record<string, unknown> | null = null;
    const textDeltas: string[] = [];
    const functionCallsByItem = new Map<string, { name: string; args: string }>();

    for (const line of rawText.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const dataStr = trimmed.slice(5).trim();
      if (!dataStr || dataStr === "[DONE]") continue;
      try {
        const evt = JSON.parse(dataStr) as Record<string, unknown>;
        if (evt.type === "response.completed" && evt.response && typeof evt.response === "object") {
          completedResponse = evt.response as Record<string, unknown>;
        } else if (evt.type === "response.output_text.delta" && typeof evt.delta === "string") {
          textDeltas.push(evt.delta);
        } else if (evt.type === "response.output_item.added" || evt.type === "response.output_item.done") {
          const item = evt.item as Record<string, unknown> | undefined;
          if (item?.type === "function_call" && typeof item.name === "string") {
            const key = String(item.id ?? item.call_id ?? item.name);
            functionCallsByItem.set(key, {
              name: item.name,
              args: typeof item.arguments === "string" ? item.arguments : functionCallsByItem.get(key)?.args ?? "",
            });
          }
        }
      } catch {
        // ignore malformed SSE line
      }
    }

    if (completedResponse) {
      payload = completedResponse;
    } else {
      return {
        model: fallbackModel,
        endpoint,
        text: textDeltas.join("").trim(),
        toolCalls: [...functionCallsByItem.values()].map((item) => ({ name: item.name, arguments: item.args })),
        usage: {},
        raw: rawText,
      };
    }
  }

  const obj = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  if (obj.error) {
    throw new Error(extractErrorMessage(obj, 400, "OpenAI Responses"));
  }

  const textParts: string[] = [];
  const toolCalls: ParsedToolCall[] = [];

  if (typeof obj.output_text === "string" && obj.output_text.trim()) {
    textParts.push(obj.output_text.trim());
  }

  const outputItems = Array.isArray(obj.output) ? obj.output : [];
  for (const rawItem of outputItems) {
    if (!rawItem || typeof rawItem !== "object") continue;
    const item = rawItem as Record<string, unknown>;
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const rawBlock of item.content) {
        if (!rawBlock || typeof rawBlock !== "object") continue;
        const block = rawBlock as Record<string, unknown>;
        if ((block.type === "output_text" || block.type === "text") && typeof block.text === "string") {
          if (!textParts.includes(block.text.trim())) {
            textParts.push(block.text);
          }
        }
      }
    } else if (item.type === "function_call" && typeof item.name === "string") {
      toolCalls.push({
        id: typeof item.call_id === "string" ? item.call_id : typeof item.id === "string" ? item.id : undefined,
        name: item.name,
        arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {}),
      });
    }
  }

  // Fallback if an OpenAI-compatible proxy translated Responses into Chat Completions shape
  if (!textParts.length && !toolCalls.length && Array.isArray(obj.choices)) {
    const firstChoice = obj.choices[0] as Record<string, unknown> | undefined;
    const message = firstChoice?.message as Record<string, unknown> | undefined;
    if (typeof message?.content === "string") {
      textParts.push(message.content);
    }
    if (Array.isArray(message?.tool_calls)) {
      for (const tc of message.tool_calls) {
        const fn = (tc as { function?: { name?: string; arguments?: string } })?.function;
        if (fn?.name) {
          toolCalls.push({
            name: fn.name,
            arguments: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
          });
        }
      }
    }
  }

  const usageObj = (obj.usage && typeof obj.usage === "object" ? obj.usage : {}) as Record<string, unknown>;
  const inputTokens = Number(usageObj.input_tokens ?? usageObj.prompt_tokens);
  const outputTokens = Number(usageObj.output_tokens ?? usageObj.completion_tokens);
  const incompleteDetails = obj.incomplete_details as { reason?: string } | undefined;
  const stopReason =
    obj.status === "incomplete" && incompleteDetails?.reason === "max_output_tokens"
      ? "length"
      : typeof obj.status === "string"
      ? obj.status
      : null;

  return {
    id: typeof obj.id === "string" ? obj.id : undefined,
    model: typeof obj.model === "string" ? obj.model : fallbackModel,
    endpoint,
    text: textParts.join("\n").trim(),
    toolCalls,
    stopReason,
    usage: {
      ...(Number.isFinite(inputTokens) ? { inputTokens } : {}),
      ...(Number.isFinite(outputTokens) ? { outputTokens } : {}),
    },
    raw: payload ?? rawText,
  };
}

/**
 * Parses an Anthropic Messages API JSON object or SSE stream text into a
 * normalized UnifiedModelCallResult.
 */
export function parseAnthropicMessagesPayload(
  payload: unknown,
  rawText: string,
  fallbackModel: string,
  endpoint: string,
): UnifiedModelCallResult {
  if (!payload && rawText.includes("event:")) {
    const textDeltas: string[] = [];
    const toolBlocks = new Map<number, { id?: string; name: string; jsonParts: string[] }>();
    let model = fallbackModel;
    let stopReason: string | null = null;
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;

    for (const line of rawText.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const dataStr = trimmed.slice(5).trim();
      if (!dataStr || dataStr === "[DONE]") continue;
      try {
        const evt = JSON.parse(dataStr) as Record<string, unknown>;
        if (evt.type === "message_start" && evt.message && typeof evt.message === "object") {
          const msg = evt.message as Record<string, unknown>;
          if (typeof msg.model === "string") model = msg.model;
          const u = msg.usage as Record<string, unknown> | undefined;
          if (typeof u?.input_tokens === "number") inputTokens = u.input_tokens;
        } else if (evt.type === "content_block_start" && evt.content_block && typeof evt.content_block === "object") {
          const idx = Number(evt.index ?? 0);
          const block = evt.content_block as Record<string, unknown>;
          if (block.type === "tool_use" && typeof block.name === "string") {
            toolBlocks.set(idx, {
              id: typeof block.id === "string" ? block.id : undefined,
              name: block.name,
              jsonParts:
                block.input && typeof block.input === "object" && Object.keys(block.input).length > 0
                  ? [JSON.stringify(block.input)]
                  : [],
            });
          } else if (block.type === "text" && typeof block.text === "string" && block.text) {
            textDeltas.push(block.text);
          }
        } else if (evt.type === "content_block_delta" && evt.delta && typeof evt.delta === "object") {
          const idx = Number(evt.index ?? 0);
          const delta = evt.delta as Record<string, unknown>;
          if (delta.type === "text_delta" && typeof delta.text === "string") {
            textDeltas.push(delta.text);
          } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
            toolBlocks.get(idx)?.jsonParts.push(delta.partial_json);
          }
        } else if (evt.type === "message_delta") {
          const delta = evt.delta as Record<string, unknown> | undefined;
          if (typeof delta?.stop_reason === "string") stopReason = delta.stop_reason;
          const u = evt.usage as Record<string, unknown> | undefined;
          if (typeof u?.output_tokens === "number") outputTokens = u.output_tokens;
        }
      } catch {
        // ignore malformed SSE line
      }
    }

    return {
      model,
      endpoint,
      text: textDeltas.join("").trim(),
      toolCalls: [...toolBlocks.values()].map((tb) => ({
        id: tb.id,
        name: tb.name,
        arguments: tb.jsonParts.join("") || "{}",
      })),
      stopReason,
      usage: {
        ...(inputTokens !== undefined ? { inputTokens } : {}),
        ...(outputTokens !== undefined ? { outputTokens } : {}),
      },
      raw: rawText,
    };
  }

  const obj = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  if (obj.type === "error" || obj.error) {
    throw new Error(extractErrorMessage(obj, 400, "Anthropic Messages"));
  }

  const textParts: string[] = [];
  const toolCalls: ParsedToolCall[] = [];
  const contentBlocks = Array.isArray(obj.content) ? obj.content : [];

  for (const rawBlock of contentBlocks) {
    if (!rawBlock || typeof rawBlock !== "object") continue;
    const block = rawBlock as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string") {
      textParts.push(block.text);
    } else if (block.type === "tool_use" && typeof block.name === "string") {
      toolCalls.push({
        id: typeof block.id === "string" ? block.id : undefined,
        name: block.name,
        arguments: typeof block.input === "string" ? block.input : JSON.stringify(block.input ?? {}),
      });
    }
  }

  const usageObj = (obj.usage && typeof obj.usage === "object" ? obj.usage : {}) as Record<string, unknown>;
  const inputTokens = Number(usageObj.input_tokens);
  const outputTokens = Number(usageObj.output_tokens);

  return {
    id: typeof obj.id === "string" ? obj.id : undefined,
    model: typeof obj.model === "string" ? obj.model : fallbackModel,
    endpoint,
    text: textParts.join("\n").trim(),
    toolCalls,
    stopReason: typeof obj.stop_reason === "string" ? obj.stop_reason : null,
    usage: {
      ...(Number.isFinite(inputTokens) ? { inputTokens } : {}),
      ...(Number.isFinite(outputTokens) ? { outputTokens } : {}),
    },
    raw: payload ?? rawText,
  };
}

export type OpenAiResponsesCallInput = {
  credentials: Record<string, string>;
  model: string;
  instructions?: string;
  input: string | Array<{ role: "user" | "assistant" | "system"; content: string }>;
  maxOutputTokens?: number;
  tools?: Array<Record<string, unknown>>;
  toolChoice?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export async function invokeOpenAiResponses(
  params: OpenAiResponsesCallInput,
): Promise<{ result: UnifiedModelCallResult; requestBody: Record<string, unknown> }> {
  const apiKey = params.credentials.apiKey?.trim();
  if (!apiKey) throw new Error("OpenAI API key is required");

  const urls = candidateOpenAiEndpointUrls(params.credentials.baseUrl ?? "", "/responses");
  const timeoutSignal = AbortSignal.timeout(params.timeoutMs ?? 60_000);
  const signal = params.signal ? AbortSignal.any([params.signal, timeoutSignal]) : timeoutSignal;

  const requestBody: Record<string, unknown> = {
    model: params.model,
    ...(params.instructions ? { instructions: params.instructions } : {}),
    input: params.input,
    max_output_tokens: params.maxOutputTokens ?? 4096,
    ...(params.tools?.length ? { tools: params.tools } : {}),
    ...(params.toolChoice !== undefined ? { tool_choice: params.toolChoice } : {}),
  };

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (params.credentials.organization?.trim()) {
    headers["OpenAI-Organization"] = params.credentials.organization.trim();
  }

  let lastError: Error | null = null;
  for (let i = 0; i < urls.length; i += 1) {
    const endpoint = urls[i];
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(requestBody),
        cache: "no-store",
        signal,
      });
      const rawText = await response.text();
      let jsonBody: unknown = null;
      try {
        jsonBody = rawText ? JSON.parse(rawText) : null;
      } catch {
        jsonBody = null;
      }

      if (!response.ok) {
        const isJsonApiError = jsonBody !== null && typeof jsonBody === "object";
        if (response.status === 404 && i < urls.length - 1 && !isJsonApiError) {
          continue;
        }
        const err = new Error(extractErrorMessage(jsonBody ?? rawText, response.status, "OpenAI Responses")) as Error & {
          status?: number;
          isApiError?: boolean;
        };
        err.status = response.status;
        err.isApiError = isJsonApiError;
        throw err;
      }

      if (!jsonBody && /^\s*<!doctype html/i.test(rawText)) {
        if (i < urls.length - 1) continue;
        throw new Error(
          `OpenAI Responses endpoint (${endpoint}) returned an HTML page instead of JSON (HTTP ${response.status}). Check that the Base URL points to an API endpoint rather than a web UI.`,
        );
      }

      const result = parseOpenAiResponsesPayload(jsonBody, rawText, params.model, endpoint);
      return { result, requestBody };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const httpErr = error as { status?: number; isApiError?: boolean } | null;
      if (httpErr?.isApiError) throw lastError;
      if (httpErr?.status && httpErr.status !== 404) throw lastError;
      if (i === urls.length - 1) throw lastError;
    }
  }

  throw lastError ?? new Error("OpenAI Responses request failed");
}

export type AnthropicMessagesCallInput = {
  credentials: Record<string, string>;
  model: string;
  system?: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  maxTokens?: number;
  tools?: Array<Record<string, unknown>>;
  toolChoice?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export async function invokeAnthropicMessages(
  params: AnthropicMessagesCallInput,
): Promise<{ result: UnifiedModelCallResult; requestBody: Record<string, unknown> }> {
  const apiKey = params.credentials.apiKey?.trim();
  if (!apiKey) throw new Error("Anthropic API key is required");

  const urls = candidateAnthropicEndpointUrls(params.credentials.baseUrl ?? "", "/messages");
  const timeoutSignal = AbortSignal.timeout(params.timeoutMs ?? 60_000);
  const signal = params.signal ? AbortSignal.any([params.signal, timeoutSignal]) : timeoutSignal;

  const requestBody: Record<string, unknown> = {
    model: params.model,
    max_tokens: params.maxTokens ?? 4096,
    ...(params.system ? { system: params.system } : {}),
    messages: params.messages,
    ...(params.tools?.length ? { tools: params.tools } : {}),
    ...(params.toolChoice !== undefined ? { tool_choice: params.toolChoice } : {}),
  };

  const normalizedBase = normalizeAnthropicBaseUrl(params.credentials.baseUrl);
  const isOfficialAnthropic = normalizedBase === DEFAULT_ANTHROPIC_BASE_URL;
  const headers: Record<string, string> = {
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...(isOfficialAnthropic ? {} : { Authorization: `Bearer ${apiKey}` }),
  };

  let lastError: Error | null = null;
  for (let i = 0; i < urls.length; i += 1) {
    const endpoint = urls[i];
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(requestBody),
        cache: "no-store",
        signal,
      });
      const rawText = await response.text();
      let jsonBody: unknown = null;
      try {
        jsonBody = rawText ? JSON.parse(rawText) : null;
      } catch {
        jsonBody = null;
      }

      if (!response.ok) {
        const isJsonApiError = jsonBody !== null && typeof jsonBody === "object";
        if (response.status === 404 && i < urls.length - 1 && !isJsonApiError) {
          continue;
        }
        const err = new Error(extractErrorMessage(jsonBody ?? rawText, response.status, "Anthropic Messages")) as Error & {
          status?: number;
          isApiError?: boolean;
        };
        err.status = response.status;
        err.isApiError = isJsonApiError;
        throw err;
      }

      if (!jsonBody && /^\s*<!doctype html/i.test(rawText)) {
        if (i < urls.length - 1) continue;
        throw new Error(
          `Anthropic Messages endpoint (${endpoint}) returned an HTML page instead of JSON (HTTP ${response.status}). Check that the Base URL points to an API endpoint rather than a web UI.`,
        );
      }

      const result = parseAnthropicMessagesPayload(jsonBody, rawText, params.model, endpoint);
      return { result, requestBody };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const httpErr = error as { status?: number; isApiError?: boolean } | null;
      if (httpErr?.isApiError) throw lastError;
      if (httpErr?.status && httpErr.status !== 404) throw lastError;
      if (i === urls.length - 1) throw lastError;
    }
  }

  throw lastError ?? new Error("Anthropic Messages request failed");
}

type RawModelItem = {
  id?: string;
  name?: string;
  display_name?: string;
  description?: string;
  context_length?: number;
  max_input_tokens?: number;
};

/**
 * Fetches `/v1/models` from an OpenAI Responses or Anthropic Messages endpoint.
 * Returns `{ models, endpoint, liveDiscovered }` or throws on 401/403 auth errors.
 * If a reverse proxy returns 404/405/501 on `/v1/models`, returns an empty
 * discovered list so preset and custom models still work seamlessly.
 */
export async function fetchRemoteModelList(
  providerKey: "openai" | "anthropic",
  credentials: Record<string, string>,
  timeoutMs = 15_000,
): Promise<{ models: OpenRouterModelSummary[]; endpoint: string; liveDiscovered: boolean }> {
  const apiKey = credentials.apiKey?.trim();
  if (!apiKey) throw new Error("API key is required");

  const urls =
    providerKey === "openai"
      ? candidateOpenAiEndpointUrls(credentials.baseUrl ?? "", "/models")
      : candidateAnthropicEndpointUrls(credentials.baseUrl ?? "", "/models");

  const headers: Record<string, string> =
    providerKey === "openai"
      ? {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
          ...(credentials.organization?.trim() ? { "OpenAI-Organization": credentials.organization.trim() } : {}),
        }
      : {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
        };

  let lastStatus = 0;
  let lastMessage = "";

  for (let i = 0; i < urls.length; i += 1) {
    const endpoint = urls[i];
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "GET",
        headers,
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (i < urls.length - 1) continue;
      throw new Error(
        `Could not reach ${endpoint}: ${error instanceof Error ? error.message : "network error"}`,
      );
    }

    const body = await response.json().catch(() => null) as
      | { data?: RawModelItem[]; models?: RawModelItem[]; error?: unknown; message?: string }
      | RawModelItem[]
      | null;

    if (response.status === 401 || response.status === 403) {
      throw new Error(extractErrorMessage(body, response.status, `${providerKey === "openai" ? "OpenAI" : "Anthropic"} authentication`));
    }

    if (!response.ok) {
      lastStatus = response.status;
      lastMessage = extractErrorMessage(body, response.status, "Model list");
      if (i < urls.length - 1) continue;
      // Many custom Responses / Messages gateways only expose POST /v1/responses
      // or POST /v1/messages and return 404/405 on GET /v1/models.
      return { models: [], endpoint: urls[0], liveDiscovered: false };
    }

    const rawList = Array.isArray(body)
      ? body
      : Array.isArray(body?.data)
      ? body.data
      : Array.isArray(body?.models)
      ? body.models
      : [];

    const seen = new Set<string>();
    const discovered: OpenRouterModelSummary[] = [];
    for (const item of rawList) {
      const id = typeof item?.id === "string" ? item.id.trim() : typeof item?.name === "string" ? item.name.trim() : "";
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const isImage = /image|dall-e|flux/i.test(id);
      const displayName =
        (typeof item.display_name === "string" && item.display_name.trim())
        || (typeof item.name === "string" && item.name.trim())
        || id;
      const contextLen = Number(item.context_length ?? item.max_input_tokens);
      discovered.push({
        id,
        name: displayName,
        description:
          typeof item.description === "string" && item.description.trim()
            ? item.description.trim()
            : providerKey === "openai"
            ? "OpenAI Responses API model"
            : "Anthropic Messages API model",
        ...(Number.isFinite(contextLen) && contextLen > 0 ? { context_length: contextLen } : {}),
        supportedParameters: ["tools"],
        outputModalities: isImage ? ["image"] : ["text"],
      });
    }

    return {
      models: discovered,
      endpoint,
      liveDiscovered: discovered.length > 0,
    };
  }

  void lastStatus;
  void lastMessage;
  return { models: [], endpoint: urls[0], liveDiscovered: false };
}

/**
 * Builds the `OpenRouterProviderModels[]` catalog for an `openai` or
 * `anthropic` connection by combining live `/v1/models` discovery, built-in
 * preset models, and any custom model IDs already saved in AI Settings.
 */
export async function listCustomProviderCatalog(
  providerKey: "openai" | "anthropic",
  credentials: Record<string, string>,
  savedModelIds: string[] = [],
): Promise<OpenRouterProviderModels[]> {
  const definition = providerKey === "openai" ? OPENAI_PROVIDER : ANTHROPIC_PROVIDER;
  const discovery = await fetchRemoteModelList(providerKey, credentials).catch(() => ({
    models: [] as OpenRouterModelSummary[],
    endpoint: "",
    liveDiscovered: false,
  }));

  const byId = new Map<string, OpenRouterModelSummary>();

  // 1. Live discovered models from /v1/models
  for (const model of discovery.models) {
    byId.set(model.id, model);
  }

  // 2. Built-in preset models from OPENAI_PROVIDER / ANTHROPIC_PROVIDER
  for (const preset of definition.models) {
    if (!byId.has(preset.modelId)) {
      byId.set(preset.modelId, {
        id: preset.modelId,
        name: preset.name,
        description: preset.description,
        supportedParameters: preset.producesImages ? [] : ["tools"],
        outputModalities: preset.producesImages ? ["image"] : ["text"],
      });
    }
  }

  // 3. Any custom model IDs the user manually added or saved
  for (const rawId of savedModelIds) {
    const id = rawId.trim();
    if (!id || byId.has(id)) continue;
    const isImage = /image|dall-e|flux/i.test(id);
    byId.set(id, {
      id,
      name: id,
      description: `Custom ${definition.name} model`,
      supportedParameters: isImage ? [] : ["tools"],
      outputModalities: isImage ? ["image"] : ["text"],
    });
  }

  const models = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  return [
    {
      slug: providerKey,
      name: definition.name,
      credentialCount: 1,
      prioritizedCredentialCount: 1,
      fallbackCredentialCount: 0,
      discoveredModelCount: discovery.models.length || models.length,
      modelFilterRestricted: false,
      allowedModelCount: models.length,
      unmatchedAllowedModels: [],
      models,
    },
  ];
}
