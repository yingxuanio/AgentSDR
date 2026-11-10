import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { normalizeManualPersonInput } from "./manualImport";

describe("manual People import", () => {
  test("normalizes both identities on the same Person input", () => {
    assert.deepEqual(normalizeManualPersonInput({
      email: " Jane@Example.COM ",
      linkedinUrl: "https://www.linkedin.com/in/Jane-Doe/",
      fullName: " Jane Doe ",
    }), {
      idempotencyKey: null,
      email: "jane@example.com",
      linkedinUrl: "jane-doe",
      firstName: null,
      lastName: null,
      fullName: "Jane Doe",
      title: null,
      companyName: null,
      companyDomain: null,
      notes: null,
      phone: null,
      workflowState: undefined,
      categoryKey: undefined,
      createCrmRecord: true,
      dnc: false,
      dncReason: "Set during ingestion",
      reviewAfter: null,
    });
  });

  test("validates and accepts idempotency keys and DNC settings", () => {
    const reviewDate = new Date("2026-12-01T00:00:00Z");
    const normalized = normalizeManualPersonInput({
      email: "jane@example.com",
      idempotencyKey: "import-lead-key-12345",
      dnc: true,
      dncReason: "Client request",
      reviewAfter: reviewDate,
      workflowState: "waiting",
    });
    assert.equal(normalized.idempotencyKey, "import-lead-key-12345");
    assert.equal(normalized.dnc, true);
    assert.equal(normalized.dncReason, "Client request");
    assert.equal(normalized.reviewAfter?.toISOString(), reviewDate.toISOString());
    assert.equal(normalized.workflowState, "waiting");
  });

  test("rejects invalid idempotency key format", () => {
    assert.throws(() => normalizeManualPersonInput({
      email: "jane@example.com",
      idempotencyKey: "short",
    }), /Invalid idempotency key format/);
  });

  test("normalizes a valid phone number and drops an invalid one without failing the row", () => {
    assert.equal(normalizeManualPersonInput({ email: "jane@example.com", phone: "+91 98765 43210" }).phone, "+919876543210");
    assert.equal(normalizeManualPersonInput({ email: "jane@example.com", phone: "not a phone number" }).phone, null);
    assert.equal(normalizeManualPersonInput({ email: "jane@example.com" }).phone, null);
  });

  test("requires a valid Email or LinkedIn identity", () => {
    assert.throws(() => normalizeManualPersonInput({}), /Email or LinkedIn URL/);
    assert.throws(() => normalizeManualPersonInput({ email: "not-an-email" }), /Invalid email/);
  });

  test("rejects one malformed supplied identity even when the other is valid", () => {
    assert.throws(() => normalizeManualPersonInput({
      email: "jane@example.com",
      linkedinUrl: "https://example.com/not-linkedin",
    }), /Invalid LinkedIn/);
  });
});
