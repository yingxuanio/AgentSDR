import "server-only";

import OpenAI from "openai";
import { PermanentRunError, RetryableRunError } from "@/lib/grid/runners/types";
import { invokeOpenAiResponses, normalizeOpenAiBaseUrl } from "./custom-providers";
import { jsonInstruction, parseJsonResponse, type AiRunner } from "./types";

function client(credentials: Record<string, string>, timeoutMs: number) {
  return new OpenAI({
    apiKey: credentials.apiKey,
    baseURL: normalizeOpenAiBaseUrl(credentials.baseUrl),
    organization: credentials.organization?.trim() || undefined,
    timeout: timeoutMs,
  });
}

/**
 * GPT text models via OpenAI Responses API (/v1/responses).
 */
export const runOpenAi: AiRunner = async ({
  config,
  model,
  credentials,
  prompt,
  schema,
  examples,
  timeoutMs,
  signal,
}) => {
  const instructions = [
    "You are filling in one row of a spreadsheet.",
    "Answer only from what you are given or can verify. If a value cannot be",
    "determined, return an empty string for it rather than guessing.",
    schema ? jsonInstruction(schema) : "Respond with the answer only — no preamble.",
    ...examples.map((example) => `Example input:\n${example.input}\nExpected response:\n${example.response}`),
  ].join("\n\n");

  try {
    const { result, requestBody } = await invokeOpenAiResponses({
      credentials,
      model: model.modelId,
      instructions,
      input: prompt,
      maxOutputTokens: config.maxTokens ?? model.maxOutputTokens ?? 16000,
      ...(schema
        ? {
            tools: [
              {
                type: "function",
                name: "fill_row",
                description: "Submit the structured row values.",
                parameters: schema,
              },
            ],
            toolChoice: "auto",
          }
        : {}),
      timeoutMs,
      signal,
    });

    const toolCall = result.toolCalls.find((call) => call.name === "fill_row") ?? result.toolCalls[0];
    const text = (toolCall?.arguments ?? result.text ?? "").trim();
    return {
      value: schema ? parseJsonResponse(text) : text,
      usage: result.usage,
      raw: result.raw,
      request: requestBody,
    };
  } catch (cause) {
    throw asPermanent(cause);
  }
};

/** GPT Image. Returns a data URL, which the image column renders directly. */
export const runOpenAiImage: AiRunner = async ({ model, credentials, prompt, timeoutMs }) => {
  const openai = client(credentials, timeoutMs);
  try {
    const response = await openai.images.generate({
      model: model.modelId,
      prompt,
      n: 1,
    });
    const image = response.data?.[0];
    if (image?.url) return { value: image.url };
    if (image?.b64_json) return { value: `data:image/png;base64,${image.b64_json}` };
    throw new PermanentRunError("The model returned no image");
  } catch (cause) {
    throw asPermanent(cause);
  }
};

/** A rejected key or unknown model will fail identically on every row. */
function asPermanent(cause: unknown): unknown {
  if (cause instanceof PermanentRunError || cause instanceof RetryableRunError) return cause;
  const status = (cause as { status?: number })?.status;
  if (status === 429 || (typeof status === "number" && status >= 500)) {
    return new RetryableRunError(cause instanceof Error ? cause.message : "OpenAI Responses temporary error");
  }
  if (cause instanceof OpenAI.AuthenticationError || status === 401 || status === 403) {
    return new PermanentRunError("OpenAI rejected this API key");
  }
  if (cause instanceof OpenAI.NotFoundError || cause instanceof OpenAI.BadRequestError || status === 400 || status === 404) {
    return new PermanentRunError(cause instanceof Error ? cause.message : "OpenAI Responses rejected the request");
  }
  return cause;
}
