import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  buildDraftPrompt,
  draftJsonSchema,
  generateCrmDraft,
  sanitizeProviderMetadata,
  validateDraftOutput,
  type DraftCompletion,
  type DraftCompletionInput,
  type GenerateCrmDraftInput,
} from "./draft";

function fixture(overrides: Partial<GenerateCrmDraftInput> = {}): GenerateCrmDraftInput {
  return {
    channel: "email",
    sequenceStep: {
      id: "step-1",
      name: "Answer demo request",
      purpose: "Answer the question and offer a demo time",
      position: 1,
      stepType: "reply",
      subjectTemplate: "Re: {{last_subject}}",
      bodyTemplate: "Hi {{first_name}}, ...",
      aiInstructions: "Be concise and propose the scheduling link.",
      knowledgeTags: ["scheduling", "product"],
    },
    knowledge: [{
      documentVersionId: "knowledge-version-2",
      documentId: "knowledge-1",
      title: "Scheduling",
      kind: "scheduling",
      excerpt: "Book a 30-minute demo at https://example.com/demo.",
      excerptHash: "sha256:example",
      rank: 1.25,
    }],
    person: {
      id: "person-1",
      fullName: "Priya Rao",
      email: "priya@example.com",
      attributes: { region: "India" },
    },
    company: { id: "company-1", name: "Example", domain: "example.com" },
    recentConversation: [{
      id: "message-1",
      channel: "email",
      direction: "inbound",
      sentAt: "2026-08-31T12:00:00.000Z",
      subject: "Demo",
      bodyText: "Can you show me the product this week?",
    }],
    acceptedClassification: {
      categoryKey: "interested",
      subcategoryKey: "demo_requested",
      reasoning: "The person explicitly requested a demo.",
    },
    mergeVariables: { last_subject: "Demo", first_name: "Priya" },
    requestedModel: { provider: "azure", modelId: "openai/gpt-5.2" },
    ...overrides,
  };
}

function completion(
  text: string,
  capture?: (input: DraftCompletionInput) => void,
): DraftCompletion {
  return async (input) => {
    capture?.(input);
    return {
      text,
      provider: "azure",
      model: "openai/gpt-5.2",
      request: {
        model: "openai/gpt-5.2",
        provider: { only: ["azure"], allow_fallbacks: false },
        authorization: "Bearer secret",
      },
      response: { id: "response-1", api_key: "secret" },
      usage: { inputTokens: 240, outputTokens: 70 },
    };
  };
}

describe("CRM draft prompt", () => {
  test("shows who else is on an email thread", () => {
    const input = fixture();
    const [message] = input.recentConversation;
    const prompt = buildDraftPrompt(fixture({
      recentConversation: [{ ...message!, participants: { from: "priya@example.com", to: ["me@us.com"], cc: ["boss@example.com"] } }],
    }));
    assert.match(prompt.userPrompt, /"cc": \[\s*"boss@example.com"\s*\]/);
    assert.doesNotMatch(buildDraftPrompt(fixture()).userPrompt, /"participants"/);
  });

  test("assembles every required source deterministically with human-send-only safety", () => {
    const first = buildDraftPrompt(fixture());
    const second = buildDraftPrompt(fixture({ mergeVariables: {
      first_name: "Priya",
      last_subject: "Demo",
    } }));

    assert.equal(first.userPrompt, second.userPrompt);
    assert.match(first.systemPrompt, /human-send-only/i);
    assert.match(first.systemPrompt, /Never send/i);
    assert.match(first.userPrompt, /Answer the question and offer a demo time/);
    assert.match(first.userPrompt, /knowledge-version-2/);
    assert.match(first.userPrompt, /Priya Rao/);
    assert.match(first.userPrompt, /Can you show me the product/);
    assert.match(first.userPrompt, /demo_requested/);
    assert.match(first.userPrompt, /first_name/);
  });

  test("a regeneration carries the rejected draft and the reviewer's feedback", () => {
    const plain = buildDraftPrompt(fixture());
    const revised = buildDraftPrompt(fixture({ revision: {
      previousDraft: { subject: "Re: Demo", bodyText: "Hi Priya, happy to show you around — here is a 60 minute slot." },
      reviewerFeedback: "Too long and too formal. Offer a 30 minute slot and drop the pleasantries.",
    } }));

    assert.doesNotMatch(plain.userPrompt, /revisionRequest/);
    assert.match(revised.userPrompt, /rejected the previous draft/);
    assert.match(revised.userPrompt, /do not return the previous draft again/);
    assert.match(revised.userPrompt, /here is a 60 minute slot/);
    assert.match(revised.userPrompt, /Offer a 30 minute slot/);
    assert.deepEqual((revised.snapshot.revisionRequest as { previousDraft: { subject: string } }).previousDraft.subject, "Re: Demo");
    assert.throws(() => buildDraftPrompt(fixture({ revision: {
      previousDraft: { subject: null, bodyText: "Some draft" },
      reviewerFeedback: "   ",
    } })), /reviewer feedback is required/i);
  });

  test("an initial draft or failed-draft recovery with operator feedback succeeds without a previous draft body", () => {
    const initialWithFeedback = buildDraftPrompt(fixture({
      recentConversation: [],
      revision: {
        previousDraft: { subject: null, bodyText: "" },
        reviewerFeedback: "Focus on cross-border treasury automation for Hong Kong teams.",
      },
    }));

    assert.doesNotMatch(initialWithFeedback.userPrompt, /rejected the previous draft/);
    assert.match(initialWithFeedback.userPrompt, /revisionRequest\.reviewerFeedback is an instruction from the operator/);
    assert.match(initialWithFeedback.userPrompt, /Focus on cross-border treasury automation/);
    assert.deepEqual(initialWithFeedback.snapshot.revisionRequest, {
      reviewerFeedback: "Focus on cross-border treasury automation for Hong Kong teams.",
    });
  });

  test("uses closed, channel-specific schemas", () => {
    const email = draftJsonSchema("email") as {
      additionalProperties: boolean;
      properties: { subject: { type: string } };
    };
    const linkedin = draftJsonSchema("linkedin") as {
      additionalProperties: boolean;
      properties: { subject: { type: string }; bodyHtml: { type: string } };
    };
    assert.equal(email.additionalProperties, false);
    assert.equal(email.properties.subject.type, "string");
    assert.equal(linkedin.additionalProperties, false);
    assert.equal(linkedin.properties.subject.type, "null");
    assert.equal(linkedin.properties.bodyHtml.type, "null");
  });
});

describe("CRM draft output validation", () => {
  test("requires an Email subject and body and rejects unknown fields", () => {
    assert.throws(() => validateDraftOutput("not-json", "email"), /malformed JSON/);
    assert.throws(() => validateDraftOutput(JSON.stringify({
      subject: "Hello",
      bodyText: "Body",
      bodyHtml: null,
      sendNow: true,
    }), "email"), /unknown field/);
    assert.throws(() => validateDraftOutput({ subject: null, bodyText: "Body", bodyHtml: null }, "email"), /subject is required/);
    assert.throws(() => validateDraftOutput({ subject: "Hello", bodyText: " ", bodyHtml: null }, "email"), /bodyText is required/);
  });

  test("requires a null or absent LinkedIn subject and plain-text-only body", () => {
    assert.throws(() => validateDraftOutput({ subject: "No", bodyText: "Hello", bodyHtml: null }, "linkedin"), /subject must be null or absent/);
    assert.throws(() => validateDraftOutput({ subject: null, bodyText: "Hello", bodyHtml: "<p>Hello</p>" }, "linkedin"), /bodyHtml must be null/);
    assert.deepEqual(
      validateDraftOutput({ bodyText: " Hello ", bodyHtml: null }, "linkedin"),
      { subject: null, bodyText: "Hello", bodyHtml: null },
    );
  });
});

describe("CRM draft generation boundary", () => {
  test("pins the requested model, returns draft data, and sanitizes audit metadata", async () => {
    let captured: DraftCompletionInput | undefined;
    const result = await generateCrmDraft(fixture(), {
      complete: completion(JSON.stringify({
        subject: "Re: Demo",
        bodyText: "Hi Priya, here is the demo link.",
        bodyHtml: null,
      }), (input) => { captured = input; }),
    });

    assert.deepEqual(captured?.requestedModel, { provider: "azure", modelId: "openai/gpt-5.2" });
    assert.equal(captured?.jsonSchema.additionalProperties, false);
    assert.equal(result.subject, "Re: Demo");
    assert.equal(result.bodyText, "Hi Priya, here is the demo link.");
    assert.equal(result.provider, "azure");
    assert.equal(result.model, "openai/gpt-5.2");
    assert.deepEqual(result.request, {
      model: "openai/gpt-5.2",
      provider: { allow_fallbacks: false, only: ["azure"] },
    });
    assert.deepEqual(result.response, { id: "response-1" });
    assert.equal("send" in result, false);
    assert.equal("sendNow" in result, false);
  });

  test("rejects a completion that did not honor exact provider/model pinning", async () => {
    const wrong: DraftCompletion = async () => ({
      text: JSON.stringify({ subject: "Hello", bodyText: "Body", bodyHtml: null }),
      provider: "other",
      model: "other/model",
      request: {},
      response: {},
    });
    await assert.rejects(
      () => generateCrmDraft(fixture(), { complete: wrong }),
      /did not use the requested provider and model/,
    );
  });

  test("metadata sanitizer removes nested transport secrets", () => {
    assert.deepEqual(sanitizeProviderMetadata({
      headers: { Authorization: "Bearer secret", "x-api-key": "secret", "x-trace": "trace-1" },
      credentials: { apiKey: "secret" },
      refreshToken: "secret",
    }), {
      headers: { "x-trace": "trace-1" },
    });
  });
});

describe("CRM draft stage change", () => {
  test("briefs the model on a stage a person moved the record to", () => {
    const prompt = buildDraftPrompt(fixture({
      stageChange: {
        stage: "Meeting Done",
        occurredAt: "2026-09-21T12:00:00.000Z",
        note: "  They want pricing for 50 seats.  ",
      },
    }));
    assert.deepEqual(prompt.snapshot.stageChange, {
      stage: "Meeting Done",
      occurredAt: "2026-09-21T12:00:00.000Z",
      note: "They want pricing for 50 seats.",
    });
    assert.match(prompt.userPrompt, /Meeting Done/);
    assert.match(prompt.systemPrompt, /stageChange/);
  });

  test("leaves the snapshot unchanged without one", () => {
    assert.equal("stageChange" in buildDraftPrompt(fixture()).snapshot, false);
    assert.equal("stageChange" in buildDraftPrompt(fixture({ stageChange: null })).snapshot, false);
  });
});

describe("CRM draft operator instructions", () => {
  test("appends them to the system prompt after the fixed rules", () => {
    const base = buildDraftPrompt(fixture());
    const prompt = buildDraftPrompt(fixture({ instructions: "  Sign off as Priya. Keep it under 120 words.  " }));
    assert.ok(prompt.systemPrompt.startsWith(base.systemPrompt));
    assert.match(prompt.systemPrompt, /<operator_instructions>\nSign off as Priya\. Keep it under 120 words\.\n<\/operator_instructions>$/);
    assert.match(prompt.systemPrompt, /do not override the rules above/);
    assert.equal(prompt.userPrompt, base.userPrompt);
  });

  test("leaves the system prompt unchanged when blank", () => {
    const base = buildDraftPrompt(fixture()).systemPrompt;
    assert.equal(buildDraftPrompt(fixture({ instructions: null })).systemPrompt, base);
    assert.equal(buildDraftPrompt(fixture({ instructions: "   " })).systemPrompt, base);
  });
});

describe("CRM draft sender, time and sequence progress", () => {
  test("the snapshot says who it goes out as, when, and where the step sits", () => {
    const prompt = buildDraftPrompt(fixture({
      sequenceStep: { ...fixture().sequenceStep, position: 3, stepType: "follow_up" },
      totalSteps: 3,
      sender: { name: "Dinesh Arora", account: "LinkedIn @dinesh" },
      now: { iso: "2026-10-29T04:30:00.000Z", timeZone: "Asia/Kolkata", local: "Thursday, 29 October 2026 at 10:00" },
      recentConversation: [
        { id: "m1", channel: "email", direction: "inbound", sentAt: "2026-10-20T10:00:00.000Z", subject: null, bodyText: "Sounds interesting" },
        { id: "m2", channel: "email", direction: "outbound", sentAt: "2026-10-21T10:00:00.000Z", subject: null, bodyText: "Here is the demo" },
        { id: "m3", channel: "email", direction: "outbound", sentAt: "2026-10-24T10:00:00.000Z", subject: null, bodyText: "Following up" },
      ],
    }));
    assert.deepEqual(prompt.snapshot.sender, { name: "Dinesh Arora", account: "LinkedIn @dinesh" });
    assert.deepEqual(prompt.snapshot.now, { iso: "2026-10-29T04:30:00.000Z", timeZone: "Asia/Kolkata", local: "Thursday, 29 October 2026 at 10:00" });
    assert.deepEqual(prompt.snapshot.sequenceProgress, {
      step: 3, totalSteps: 3, stepType: "follow_up", isLastStep: true, ourMessagesSinceTheirLastReply: 2,
    });
  });

  test("without them the snapshot carries none of the keys", () => {
    const snapshot = buildDraftPrompt(fixture()).snapshot;
    for (const key of ["sender", "now", "sequenceProgress"]) assert.equal(key in snapshot, false);
  });

  test("the system prompt carries the general rules", () => {
    const { systemPrompt } = buildDraftPrompt(fixture());
    assert.match(systemPrompt, /sender is who this message goes out as/);
    assert.match(systemPrompt, /Never promise to send something later/);
    assert.match(systemPrompt, /You cannot see anyone's calendar/);
    assert.match(systemPrompt, /do not repeat an ask, figure or link/);
  });
});
