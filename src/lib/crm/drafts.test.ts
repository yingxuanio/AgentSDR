import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { generateCrmDraft, type DraftCompletion } from "./ai/draft";
import {
  buildInitialDraftRevision,
  buildRegenerateDraftRevision,
  resolveCompanyCode,
  selectRegenerateTargetDrafts,
} from "./drafts";

const mockCompletion: DraftCompletion = async () => ({
  text: JSON.stringify({
    subject: "Exploring partnership with HK32",
    bodyText: "Hi Alex, reaching out regarding your Hong Kong operations.",
    bodyHtml: "<p>Hi Alex, reaching out regarding your Hong Kong operations.</p>",
  }),
  provider: "openrouter",
  model: "openai/gpt-5.2",
  request: { model: "openai/gpt-5.2" },
  response: { id: "resp-initial-1" },
});

describe("CRM initial outreach draft generation without historical draft body", () => {
  test("generates first draft for a brand-new customer with feedback and no previous draft body", async () => {
    const revision = buildInitialDraftRevision(
      {
        feedback: "Introduce our HK cross-border settlement workflow concisely.",
      },
      null,
    );

    assert.deepEqual(revision, {
      previousDraft: null,
      reviewerFeedback: "Introduce our HK cross-border settlement workflow concisely.",
    });

    const generated = await generateCrmDraft(
      {
        channel: "email",
        sequenceStep: {
          id: null,
          name: "Initial outreach",
          position: 1,
          stepType: "reply",
          subjectTemplate: null,
          bodyTemplate: null,
          aiInstructions: "This is an initial outbound outreach draft (no inbound reply yet).",
          knowledgeTags: [],
        },
        knowledge: [],
        person: {
          id: "66a68a6d-50b3-4bd5-b038-8cc556816536",
          fullName: "Alex Chan",
          email: "alex@hk32.example",
        },
        company: {
          id: "comp-hk32",
          name: "HK32 Holdings",
          domain: "hk32.example",
        },
        recentConversation: [],
        acceptedClassification: {
          categoryKey: "other",
          subcategoryKey: null,
          reasoning: "Human-approved CRM classification",
        },
        revision,
      },
      { complete: mockCompletion },
    );

    assert.equal(generated.subject, "Exploring partnership with HK32");
    assert.match(generated.bodyText, /Hong Kong operations/);
    assert.equal("autoSend" in generated, false);
    assert.equal("sendNow" in generated, false);
  });

  test("returns null revision when generating first draft without feedback", () => {
    assert.equal(buildInitialDraftRevision({}, null), null);
    assert.equal(buildInitialDraftRevision({ feedback: "   " }, null), null);
  });
});

describe("CRM failed draft recovery via regenerate", () => {
  test("recovers a failed draft that has no historical body or provider", async () => {
    const failedDraft = {
      subject: null,
      editedBodyText: null,
      aiBodyText: null,
      sequenceStepRunId: null,
      replyForMessageId: null,
    };

    const revisionWithFeedback = buildRegenerateDraftRevision(
      failedDraft,
      "Write a short first-outreach email tailored to HK32.",
    );
    assert.deepEqual(revisionWithFeedback, {
      previousDraft: null,
      reviewerFeedback: "Write a short first-outreach email tailored to HK32.",
    });

    const revisionWithoutFeedback = buildRegenerateDraftRevision(failedDraft, null);
    assert.equal(revisionWithoutFeedback, null);

    const generated = await generateCrmDraft(
      {
        channel: "email",
        sequenceStep: {
          id: null,
          name: "Initial outreach",
          position: 1,
          stepType: "reply",
          subjectTemplate: null,
          bodyTemplate: null,
          aiInstructions: "This is an initial outbound outreach draft (no inbound reply yet).",
          knowledgeTags: [],
        },
        knowledge: [],
        person: {
          id: "66a68a6d-50b3-4bd5-b038-8cc556816536",
          fullName: "Alex Chan",
          email: "alex@hk32.example",
        },
        company: {
          id: "comp-hk32",
          name: "HK32 Holdings",
          domain: "hk32.example",
        },
        recentConversation: [],
        acceptedClassification: {
          categoryKey: "other",
          subcategoryKey: null,
          reasoning: "Human-approved CRM classification",
        },
        revision: revisionWithFeedback,
      },
      { complete: mockCompletion },
    );

    assert.equal(generated.subject, "Exploring partnership with HK32");
    assert.ok(generated.bodyText.length > 0);
  });

  test("resolves company code when custom is empty object and code lives in raw", () => {
    assert.equal(
      resolveCompanyCode({ custom: {}, raw: { company_code: "HK32", x_code: "HK32" } }),
      "HK32",
    );
    assert.equal(
      resolveCompanyCode({ custom: { x_code: "HK31" }, raw: {} }),
      "HK31",
    );
    assert.equal(resolveCompanyCode({ custom: {}, raw: {} }), null);
    assert.equal(resolveCompanyCode(null), null);
  });

  test("selectRegenerateTargetDrafts matches failed drafts and deduplicates per CRM record", () => {
    const candidates = [
      {
        id: "draft-hk31-review",
        crmRecordId: "record-hk31",
        status: "awaiting_review",
        toEmail: "contact@hk31.example",
        person: { id: "person-hk31" },
        company: { code: "HK31" },
      },
      {
        id: "394c102a-01c3-47dc-a422-acfb1ff758df",
        crmRecordId: "62d9f3e4-9608-419f-8d1c-e0b7686c8e34",
        status: "failed",
        toEmail: "contact@hk32.example",
        person: { id: "66a68a6d-50b3-4bd5-b038-8cc556816536" },
        company: { code: "HK32" },
      },
      {
        id: "draft-hk31-old-failed",
        crmRecordId: "record-hk31",
        status: "failed",
        toEmail: "contact@hk31.example",
        person: { id: "person-hk31" },
        company: { code: "HK31" },
      },
    ];

    // Matches failed draft by plural or singular companyCode, draftId, recordId, or personId
    const byCompanyCodes = selectRegenerateTargetDrafts(candidates, { companyCodes: ["hk32"] });
    assert.equal(byCompanyCodes.length, 1);
    assert.equal(byCompanyCodes[0]?.id, "394c102a-01c3-47dc-a422-acfb1ff758df");

    const bySingularCode = selectRegenerateTargetDrafts(candidates, { companyCode: "HK32" });
    assert.equal(bySingularCode.length, 1);
    assert.equal(bySingularCode[0]?.id, "394c102a-01c3-47dc-a422-acfb1ff758df");

    const byRecordId = selectRegenerateTargetDrafts(candidates, {
      recordId: "62d9f3e4-9608-419f-8d1c-e0b7686c8e34",
    });
    assert.equal(byRecordId.length, 1);
    assert.equal(byRecordId[0]?.id, "394c102a-01c3-47dc-a422-acfb1ff758df");

    const byPersonId = selectRegenerateTargetDrafts(candidates, {
      personIds: ["66a68a6d-50b3-4bd5-b038-8cc556816536"],
    });
    assert.equal(byPersonId.length, 1);
    assert.equal(byPersonId[0]?.id, "394c102a-01c3-47dc-a422-acfb1ff758df");

    // Deduplicates per record when multiple drafts exist, preferring awaiting_review
    const allTargets = selectRegenerateTargetDrafts(candidates, {});
    assert.equal(allTargets.length, 2);
    assert.deepEqual(
      allTargets.map((d) => d.id),
      ["draft-hk31-review", "394c102a-01c3-47dc-a422-acfb1ff758df"],
    );
  });
});
