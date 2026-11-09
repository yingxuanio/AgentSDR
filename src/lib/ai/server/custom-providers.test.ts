import { describe, expect, test } from "bun:test";
import { getAiModel } from "../catalog";
import {
  candidateAnthropicEndpointUrls,
  candidateOpenAiEndpointUrls,
  normalizeAnthropicBaseUrl,
  normalizeOpenAiBaseUrl,
  parseAnthropicMessagesPayload,
  parseOpenAiResponsesPayload,
} from "./custom-providers";

describe("custom AI provider URL normalization", () => {
  test("normalizes OpenAI Responses Base URLs", () => {
    expect(normalizeOpenAiBaseUrl("")).toBe("https://api.openai.com/v1");
    expect(normalizeOpenAiBaseUrl("https://api.openai.com")).toBe("https://api.openai.com/v1");
    expect(normalizeOpenAiBaseUrl("https://api.openai.com/v1/")).toBe("https://api.openai.com/v1");
    expect(normalizeOpenAiBaseUrl("https://gateway.example.com/v1/responses")).toBe("https://gateway.example.com/v1");
    expect(normalizeOpenAiBaseUrl("https://gateway.example.com/openai/v1")).toBe("https://gateway.example.com/openai/v1");
    expect(candidateOpenAiEndpointUrls("https://gateway.example.com/openai", "/responses")).toEqual([
      "https://gateway.example.com/openai/responses",
      "https://gateway.example.com/openai/v1/responses",
    ]);
  });

  test("normalizes Anthropic Messages Base URLs", () => {
    expect(normalizeAnthropicBaseUrl("")).toBe("https://api.anthropic.com");
    expect(normalizeAnthropicBaseUrl("https://api.anthropic.com/v1")).toBe("https://api.anthropic.com");
    expect(normalizeAnthropicBaseUrl("https://claude-proxy.example.com/v1/messages")).toBe("https://claude-proxy.example.com");
    expect(candidateAnthropicEndpointUrls("https://claude-proxy.example.com/api/v1", "/messages")).toEqual([
      "https://claude-proxy.example.com/api/v1/messages",
      "https://claude-proxy.example.com/api/messages",
    ]);
  });
});

describe("OpenAI Responses & Anthropic Messages payload parsing", () => {
  test("parses OpenAI Responses JSON output and function calls", () => {
    const parsed = parseOpenAiResponsesPayload(
      {
        id: "resp_123",
        model: "gpt-5.4",
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "Connection OK" }],
          },
          {
            type: "function_call",
            call_id: "call_1",
            name: "crm_reply_classification",
            arguments: '{"categoryKey":"interested"}',
          },
        ],
        usage: { input_tokens: 15, output_tokens: 8 },
      },
      "",
      "gpt-5.4",
      "https://api.openai.com/v1/responses",
    );
    expect(parsed.text).toBe("Connection OK");
    expect(parsed.toolCalls).toEqual([
      { id: "call_1", name: "crm_reply_classification", arguments: '{"categoryKey":"interested"}' },
    ]);
    expect(parsed.usage).toEqual({ inputTokens: 15, outputTokens: 8 });
  });

  test("parses OpenAI Responses SSE event stream fallback", () => {
    const sse = [
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","delta":"Hello "}',
      '',
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","delta":"world"}',
      '',
    ].join("\n");
    const parsed = parseOpenAiResponsesPayload(null, sse, "gpt-5.4", "https://api.openai.com/v1/responses");
    expect(parsed.text).toBe("Hello world");
  });

  test("parses Anthropic Messages JSON output and tool_use blocks", () => {
    const parsed = parseAnthropicMessagesPayload(
      {
        id: "msg_123",
        model: "claude-sonnet-4-5",
        stop_reason: "tool_use",
        content: [
          { type: "text", text: "Here is the classification." },
          {
            type: "tool_use",
            id: "toolu_1",
            name: "crm_reply_classification",
            input: { categoryKey: "interested" },
          },
        ],
        usage: { input_tokens: 42, output_tokens: 19 },
      },
      "",
      "claude-sonnet-4-5",
      "https://api.anthropic.com/v1/messages",
    );
    expect(parsed.text).toBe("Here is the classification.");
    expect(parsed.toolCalls).toEqual([
      { id: "toolu_1", name: "crm_reply_classification", arguments: '{"categoryKey":"interested"}' },
    ]);
    expect(parsed.usage).toEqual({ inputTokens: 42, outputTokens: 19 });
  });

  test("resolves arbitrary custom model IDs for openai and anthropic in getAiModel", () => {
    const customOpenAi = getAiModel("openai", "custom-gpt-5.4-turbo", "content");
    expect(customOpenAi?.modelId).toBe("custom-gpt-5.4-turbo");
    expect(customOpenAi?.useCases).toContain("content");

    const customAnthropic = getAiModel("anthropic", "claude-sonnet-4-5-20250929", "web-research");
    expect(customAnthropic?.modelId).toBe("claude-sonnet-4-5-20250929");
    expect(customAnthropic?.useCases).toContain("web-research");
  });
});
