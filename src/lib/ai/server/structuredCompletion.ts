import "server-only";

import {
  isRetryableOpenRouterError,
  openRouterTokenLimit,
  toolCallSystemPrompt,
  type OpenRouterModelSelection,
} from "@/lib/ai/openrouter-types";
import { getPrompt, getPromptTemplate, traceGeneration, type ResolvedPrompt } from "@/lib/observability/langfuse";
import { invokeAnthropicMessages, invokeOpenAiResponses } from "./custom-providers";
import { getActiveAiRuntime, getOpenRouterRuntime } from "./runtime";
import { parseJsonResponse } from "./types";

/**
 * Every structured answer in the app is requested as a function call, never
 * as `response_format`. JSON mode is the parameter the pinned providers
 * disagree on (minimax-m3 drifts off-schema in it, and strict json_schema is
 * refused outright by its endpoint), whereas every configured provider
 * supports `tools`, and a call hands back the arguments as one JSON string.
 *
 * The single tool is offered with `tool_choice: "auto"` on purpose. Probed
 * on 16 Sep 2026 with `require_parameters: true`: a forced function or
 * `"required"` is refused by OpenRouter's routing for minimax and z-ai ("No
 * endpoints found that support the provided 'tool_choice' value"), and
 * z-ai's own API rejects a forced function outright; `"auto"` is honoured on
 * all three providers and the one offered tool is called.
 *
 * Because "auto" leaves the model free to answer in prose, and because a
 * call's arguments can still miss the schema, each attempt is judged and
 * a bad one is retried: no tool call, arguments that are not a JSON object,
 * arguments the caller's `accept` rejects, or a transient transport error
 * (429, 5xx, timeout). Routing and configuration errors (400, 401, 403,
 * 404) are not retried — another attempt would fail the same way.
 *
 * Reasoning models spend `max_tokens` on thinking before the call:
 * minimax-m3 was measured using 799 of an 800-token budget on reasoning and
 * finishing with `length` and no call, and neither `reasoning.effort` nor
 * `reasoning.max_tokens` capped it reliably. A `length` finish is therefore
 * retried with double the output budget each time.
 *
 * The whole completion, every attempt, is one Langfuse generation: the
 * messages sent, the prompt versions they came from (the caller's, plus
 * shared/structured-output), the parsed arguments, and the tokens and cost
 * of all attempts together.
 */

const DEFAULT_MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [500, 1_500];

export type StructuredCompletionInput = {
  requestedModel?: OpenRouterModelSelection;
  timeoutMs: number;
  systemPrompt: string;
  userPrompt: string;
  maxOutputTokens: number;
  /** JSON Schema for the tool's parameters; the model's arguments must satisfy it. */
  jsonSchema: Record<string, unknown>;
  /** Tool name; snake_case, as it is shown to the model. */
  schemaName: string;
  /** What the tool submits, in one sentence, as shown to the model. */
  schemaDescription?: string;
  /**
   * Caller-side validation of the parsed arguments. Throw to reject the
   * attempt; the thrown message is surfaced if every attempt is rejected.
   */
  accept?: (text: string) => void;
  /** OpenRouter plugins, e.g. `[{ id: "web" }]` for grounded answers. */
  plugins?: Array<Record<string, unknown>>;
  /** Sees each request before it is sent, so a caller can audit one that fails. */
  onRequest?: (request: Record<string, unknown>) => void;
  maxAttempts?: number;
  signal?: AbortSignal;
  /** How the call appears in Langfuse. Never put secrets in metadata. */
  trace?: StructuredCompletionTrace;
};

export type StructuredCompletionTrace = {
  /** e.g. "crm-draft"; defaults to the schema name. */
  name: string;
  /** The prompts the system and user text were built from. */
  prompts?: ResolvedPrompt[];
  metadata?: Record<string, unknown>;
  sessionId?: string;
};

export type StructuredCompletionResult = {
  /** The tool's arguments, verbatim JSON text. */
  text: string;
  provider: string;
  model: string;
  request: Record<string, unknown>;
  response: unknown;
  usage: {
    inputTokens?: number;
    outputTokens?: number;
  };
  attempts: number;
};

class RejectedAttemptError extends Error {}

function describeResponseError(response: unknown): string | null {
  const error = (response as { error?: unknown } | null)?.error;
  if (!error || typeof error !== "object") return null;
  const { message, code } = error as { message?: unknown; code?: unknown };
  const parts = [code, message].filter((part) => typeof part === "string" || typeof part === "number");
  return parts.length ? parts.join(" ") : null;
}

function isJsonObjectText(text: string): boolean {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

/** The slice of the runtime this module uses; tests substitute a fake client here. */
export type StructuredCompletionRuntime = (
  requested: OpenRouterModelSelection | undefined,
  timeoutMs: number,
) => Promise<{
  client: { chat: { completions: { create: (request: never, options: { signal?: AbortSignal }) => Promise<StructuredChatResponse> } } };
  selection: OpenRouterModelSelection;
  provider: unknown;
}>;

type StructuredChatResponse = {
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      content?: string | null;
      tool_calls?: Array<{ type: string; function?: { name: string; arguments: string } }>;
    };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  error?: unknown;
};

function parsedOrText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function completeStructuredWithOpenRouter(
  input: StructuredCompletionInput,
  dependencies: { runtime?: StructuredCompletionRuntime; sleep?: typeof sleep } = {},
): Promise<StructuredCompletionResult> {
  if (!dependencies.runtime) {
    const activeRuntime = await getActiveAiRuntime(input.requestedModel, input.timeoutMs);
    if (activeRuntime.kind === "openai" || activeRuntime.kind === "anthropic") {
      return completeStructuredWithCustomRuntime(input, activeRuntime, dependencies.sleep ?? sleep);
    }
  }

  const { client, selection, provider } = await (dependencies.runtime ?? getOpenRouterRuntime)(
    input.requestedModel,
    input.timeoutMs,
  );
  const maxAttempts = Math.max(1, Math.floor(input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS));
  let outputTokens = input.maxOutputTokens;
  const [outputRule, defaultDescription] = await Promise.all([
    getPromptTemplate("shared/structured-output"),
    input.schemaDescription === undefined ? getPrompt("shared/tool-description") : null,
  ]);
  const messages = [
    { role: "system" as const, content: toolCallSystemPrompt(input.systemPrompt, input.schemaName, outputRule.text) },
    { role: "user" as const, content: input.userPrompt },
  ];
  // Every attempt is paid for, so the trace reports their sum.
  const spent = { input: 0, output: 0, costUsd: 0, reported: false, costReported: false };

  function buildRequest() {
    return {
      model: selection.modelId,
      messages,
      ...openRouterTokenLimit(selection.modelId, outputTokens),
      provider,
      ...(input.plugins?.length ? { plugins: input.plugins } : {}),
      tools: [{
        type: "function" as const,
        function: {
          name: input.schemaName,
          description: input.schemaDescription ?? defaultDescription?.text ?? "",
          parameters: input.jsonSchema,
        },
      }],
      tool_choice: "auto" as const,
    };
  }

  async function attempt(): Promise<Omit<StructuredCompletionResult, "attempts">> {
    const request = buildRequest();
    input.onRequest?.(request);
    const response: StructuredChatResponse = await client.chat.completions.create(request as never, { signal: input.signal });
    if (response.usage) {
      spent.reported = true;
      spent.input += response.usage.prompt_tokens ?? 0;
      spent.output += response.usage.completion_tokens ?? 0;
      if (typeof response.usage.cost === "number") {
        spent.costReported = true;
        spent.costUsd += response.usage.cost;
      }
    }
    // OpenRouter can answer 200 with an `error` body and no `choices`; that
    // used to surface as "undefined is not an object (evaluating 'a.choices[0]')".
    const message = response.choices?.[0]?.message;
    const call = message?.tool_calls?.find((candidate) => (
      candidate.type === "function" && candidate.function?.name === input.schemaName
    ))?.function;
    if (!call) {
      const detail = describeResponseError(response);
      if (detail) throw new Error(`OpenRouter returned no ${input.schemaName} call: ${detail}`);
      if (response.choices?.[0]?.finish_reason === "length") {
        const spent = outputTokens;
        outputTokens *= 2;
        throw new RejectedAttemptError(
          `The model ran out of output tokens (${spent}) before calling ${input.schemaName}`,
        );
      }
      throw new RejectedAttemptError(
        message?.content?.trim()
          ? `The model answered in prose instead of calling ${input.schemaName}`
          : `The model returned neither a ${input.schemaName} call nor content`,
      );
    }
    const text = call.arguments;
    if (typeof text !== "string" || !isJsonObjectText(text)) {
      throw new RejectedAttemptError(`The ${input.schemaName} call carried arguments that are not a JSON object`);
    }
    try {
      input.accept?.(text);
    } catch (error) {
      throw new RejectedAttemptError(error instanceof Error ? error.message : String(error));
    }
    return {
      text,
      provider: selection.provider,
      model: selection.modelId,
      request,
      response,
      usage: {
        inputTokens: response.usage?.prompt_tokens,
        outputTokens: response.usage?.completion_tokens,
      },
    };
  }

  const trace = input.trace;
  return traceGeneration({
    name: trace?.name ?? input.schemaName,
    model: selection.modelId,
    input: messages,
    prompts: [...(trace?.prompts ?? []), outputRule, defaultDescription],
    modelParameters: { max_tokens: input.maxOutputTokens },
    metadata: {
      ...trace?.metadata,
      provider: selection.provider,
      tool: input.schemaName,
      ...(input.plugins?.length ? { plugins: input.plugins.map((plugin) => plugin.id) } : {}),
    },
    sessionId: trace?.sessionId,
  }, async (record) => {
    const report = (attempts: number, output?: unknown) => record({
      output,
      usage: spent.reported
        ? { input: spent.input, output: spent.output, costUsd: spent.costReported ? spent.costUsd : null }
        : null,
      metadata: { attempts, ...(outputTokens !== input.maxOutputTokens ? { finalMaxTokens: outputTokens } : {}) },
    });
    let lastError: unknown;
    for (let index = 0; index < maxAttempts; index += 1) {
      if (index > 0) {
        await (dependencies.sleep ?? sleep)(RETRY_BACKOFF_MS[Math.min(index - 1, RETRY_BACKOFF_MS.length - 1)], input.signal);
      }
      try {
        const result = { ...(await attempt()), attempts: index + 1 };
        report(result.attempts, parsedOrText(result.text));
        return result;
      } catch (error) {
        lastError = error;
        const retryable = error instanceof RejectedAttemptError || isRetryableOpenRouterError(error);
        if (!retryable || input.signal?.aborted) {
          report(index + 1);
          throw error;
        }
      }
    }
    report(maxAttempts);
    const reason = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`${input.schemaName} failed after ${maxAttempts} attempts: ${reason}`, { cause: lastError });
  });
}

async function completeStructuredWithCustomRuntime(
  input: StructuredCompletionInput,
  runtime: Extract<Awaited<ReturnType<typeof getActiveAiRuntime>>, { kind: "openai" | "anthropic" }>,
  sleepFn: typeof sleep,
): Promise<StructuredCompletionResult> {
  const maxAttempts = Math.max(1, Math.floor(input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS));
  let outputTokens = input.maxOutputTokens;
  const { selection, credentials, kind } = runtime;

  const systemWithTool = toolCallSystemPrompt(input.systemPrompt, input.schemaName);

  async function attempt(): Promise<Omit<StructuredCompletionResult, "attempts">> {
    const callOutcome =
      kind === "openai"
        ? await invokeOpenAiResponses({
            credentials,
            model: selection.modelId,
            instructions: systemWithTool,
            input: input.userPrompt,
            maxOutputTokens: outputTokens,
            tools: [
              {
                type: "function",
                name: input.schemaName,
                description:
                  input.schemaDescription
                  ?? "Submit the structured result. Call it exactly once; it is the only way to answer.",
                parameters: input.jsonSchema,
              },
            ],
            toolChoice: { type: "function", name: input.schemaName },
            timeoutMs: input.timeoutMs,
            signal: input.signal,
          })
        : await invokeAnthropicMessages({
            credentials,
            model: selection.modelId,
            system: systemWithTool,
            messages: [{ role: "user", content: input.userPrompt }],
            maxTokens: outputTokens,
            tools: [
              {
                name: input.schemaName,
                description:
                  input.schemaDescription
                  ?? "Submit the structured result. Call it exactly once; it is the only way to answer.",
                input_schema: input.jsonSchema,
              },
            ],
            toolChoice: { type: "tool", name: input.schemaName },
            timeoutMs: input.timeoutMs,
            signal: input.signal,
          });

    const { result, requestBody } = callOutcome;
    input.onRequest?.(requestBody);

    const matchedToolCall =
      result.toolCalls.find((candidate) => candidate.name === input.schemaName) ?? result.toolCalls[0];

    let text = matchedToolCall?.arguments ?? "";

    // If the model returned a direct JSON object in text instead of a tool call, accept it
    if ((!text || !isJsonObjectText(text)) && result.text.trim()) {
      try {
        const parsed = parseJsonResponse(result.text);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          text = JSON.stringify(parsed);
        }
      } catch {
        // handled below
      }
    }

    if (!text) {
      if (result.stopReason === "length" || result.stopReason === "max_tokens") {
        const spent = outputTokens;
        outputTokens *= 2;
        throw new RejectedAttemptError(
          `The model ran out of output tokens (${spent}) before calling ${input.schemaName}`,
        );
      }
      throw new RejectedAttemptError(
        result.text.trim()
          ? `The model answered in prose instead of calling ${input.schemaName}`
          : `The model returned neither a ${input.schemaName} call nor content`,
      );
    }

    if (!isJsonObjectText(text)) {
      throw new RejectedAttemptError(`The ${input.schemaName} call carried arguments that are not a JSON object`);
    }

    try {
      input.accept?.(text);
    } catch (error) {
      throw new RejectedAttemptError(error instanceof Error ? error.message : String(error));
    }

    return {
      text,
      provider: selection.provider,
      model: selection.modelId,
      request: requestBody,
      response: result.raw,
      usage: result.usage,
    };
  }

  let lastError: unknown;
  for (let index = 0; index < maxAttempts; index += 1) {
    if (index > 0) {
      await sleepFn(RETRY_BACKOFF_MS[Math.min(index - 1, RETRY_BACKOFF_MS.length - 1)], input.signal);
    }
    try {
      return { ...(await attempt()), attempts: index + 1 };
    } catch (error) {
      lastError = error;
      const retryable = error instanceof RejectedAttemptError || isRetryableOpenRouterError(error);
      if (!retryable || input.signal?.aborted) throw error;
    }
  }
  const reason = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`${input.schemaName} failed after ${maxAttempts} attempts: ${reason}`, { cause: lastError });
}
