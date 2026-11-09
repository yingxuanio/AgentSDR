import "server-only";

import { PermanentRunError, RetryableRunError } from "@/lib/grid/runners/types";
import { invokeAnthropicMessages } from "./custom-providers";
import { jsonInstruction, parseJsonResponse, type AiRunner } from "./types";

/**
 * Claude and Anthropic Messages API (/v1/messages) compatible models.
 */
export const runAnthropic: AiRunner = async ({
  config,
  model,
  credentials,
  prompt,
  schema,
  examples,
  timeoutMs,
  signal,
}) => {
  const system = [
    "You are filling in one row of a spreadsheet.",
    "Answer only from what you are given or can verify. If a value cannot be",
    "determined, return an empty string for it rather than guessing.",
    schema ? jsonInstruction(schema) : "Respond with the answer only — no preamble.",
  ].join("\n");

  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const example of examples) {
    messages.push({ role: "user", content: example.input });
    messages.push({ role: "assistant", content: example.response });
  }
  messages.push({ role: "user", content: prompt });

  try {
    const { result, requestBody } = await invokeAnthropicMessages({
      credentials,
      model: model.modelId,
      maxTokens: config.maxTokens ?? model.maxOutputTokens ?? 8192,
      system,
      messages,
      ...(schema
        ? {
            tools: [
              {
                name: "fill_row",
                description: "Submit the structured row values.",
                input_schema: schema,
              },
            ],
            toolChoice: { type: "auto" },
          }
        : {}),
      timeoutMs,
      signal,
    });

    if (result.stopReason === "refusal") {
      throw new PermanentRunError("Claude declined this prompt");
    }

    const toolCall = result.toolCalls.find((call) => call.name === "fill_row") ?? result.toolCalls[0];
    const text = (toolCall?.arguments ?? result.text ?? "").trim();

    return {
      value: schema ? parseJsonResponse(text) : text,
      usage: result.usage,
      raw: result.raw,
      request: requestBody,
    };
  } catch (cause) {
    if (cause instanceof PermanentRunError || cause instanceof RetryableRunError) throw cause;
    const status = (cause as { status?: number })?.status;
    if (status === 429 || (typeof status === "number" && status >= 500)) {
      throw new RetryableRunError(cause instanceof Error ? cause.message : "Anthropic Messages temporary error");
    }
    if (status === 401 || status === 403) {
      throw new PermanentRunError("Anthropic rejected this API key");
    }
    if (status === 400 || status === 404) {
      throw new PermanentRunError(cause instanceof Error ? cause.message : "Anthropic Messages rejected the request");
    }
    throw cause;
  }
};
