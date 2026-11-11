import assert from "node:assert/strict";
import { describe, test } from "bun:test";
import { deriveLeadCrmDisplay, type PersonCrmSummary } from "./leadTypes";

const NOW = Date.parse("2026-11-11T05:00:00Z");

function makeCrm(overrides: Partial<PersonCrmSummary> = {}): PersonCrmSummary {
  return {
    recordId: "rec-1",
    categoryKey: null,
    subcategory: null,
    workflowState: "idle",
    activeChannel: "email",
    activeSequence: null,
    currentStep: null,
    lastInboundAt: null,
    lastOutboundAt: null,
    lastInteractionAt: null,
    nextActionAt: null,
    unacknowledgedAiChange: false,
    dnc: false,
    latestDraft: null,
    ...overrides,
  };
}

describe("deriveLeadCrmDisplay", () => {
  test("shows New lead for freshly imported untouched leads", () => {
    const res = deriveLeadCrmDisplay(makeCrm(), NOW);
    assert.equal(res.kind, "new_lead");
    assert.equal(res.chip, "New lead");
    assert.equal(res.secondary, null);
  });

  test("shows Draft ready when an outreach draft is awaiting review", () => {
    const res = deriveLeadCrmDisplay(
      makeCrm({
        workflowState: "action_required",
        latestDraft: { status: "awaiting_review", autoSendAt: null, channel: "email", subject: "Hello" },
      }),
      NOW,
    );
    assert.equal(res.kind, "draft_ready");
    assert.equal(res.chip, "Draft ready");
    assert.equal(res.secondary, "Awaiting review");
  });

  test("shows Queued when an outreach draft is scheduled for working hours", () => {
    const res = deriveLeadCrmDisplay(
      makeCrm({
        workflowState: "waiting",
        latestDraft: { status: "awaiting_review", autoSendAt: "2026-11-12T01:00:00Z", channel: "email" },
      }),
      NOW,
    );
    assert.equal(res.kind, "queued");
    assert.equal(res.chip, "Queued");
    assert.equal(res.secondary, "Scheduled Nov 12");
  });

  test("shows Contacted with sent date when outbound email was sent and awaiting reply", () => {
    const res = deriveLeadCrmDisplay(
      makeCrm({
        workflowState: "idle",
        lastOutboundAt: "2026-11-11T04:50:00Z",
        latestDraft: { status: "sent", autoSendAt: null, channel: "email" },
      }),
      NOW,
    );
    assert.equal(res.kind, "contacted");
    assert.equal(res.chip, "Contacted");
    assert.equal(res.secondary, "Sent Nov 11");
  });

  test("shows Delivery issue on error or delivery_uncertain", () => {
    const res = deriveLeadCrmDisplay(
      makeCrm({
        workflowState: "error",
        latestDraft: { status: "delivery_uncertain", autoSendAt: null, channel: "email" },
      }),
      NOW,
    );
    assert.equal(res.kind, "delivery_issue");
    assert.equal(res.chip, "Delivery issue");
    assert.equal(res.secondary, "Check recipient");
  });

  test("shows Replied when inbound arrived and AI classification is pending", () => {
    const res = deriveLeadCrmDisplay(
      makeCrm({
        workflowState: "classifying",
        lastInboundAt: "2026-11-11T04:59:00Z",
      }),
      NOW,
    );
    assert.equal(res.kind, "replied");
    assert.equal(res.chip, "Replied");
    assert.equal(res.secondary, "Classifying · Nov 11");
  });

  test("shows classified category and subcategory once replied", () => {
    const res = deriveLeadCrmDisplay(
      makeCrm({
        categoryKey: "interested",
        subcategory: "Meeting requested",
        workflowState: "action_required",
      }),
      NOW,
    );
    assert.equal(res.kind, "interested");
    assert.equal(res.chip, "Interested · Meeting requested");
    assert.equal(res.secondary, "Action required");
  });

  test("shows Do not contact when dnc policy is active", () => {
    const res = deriveLeadCrmDisplay(makeCrm({ dnc: true }), NOW);
    assert.equal(res.kind, "dnc");
    assert.equal(res.chip, "Do not contact");
  });

  test("shows Closed when pre-reply record is closed", () => {
    const res = deriveLeadCrmDisplay(makeCrm({ workflowState: "closed" }), NOW);
    assert.equal(res.kind, "closed");
    assert.equal(res.chip, "Closed");
  });
});
