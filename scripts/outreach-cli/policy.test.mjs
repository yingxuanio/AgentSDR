import { describe, expect, test } from "bun:test";
import {
  FIXTURE_LEDGER_BOUNCE_2026_11_17,
  assertDailyCapAllows,
  computeDiscoveryQuota,
  countCapConsumingDraftsToday,
  deliveryEffects,
  evaluateBounceRate,
  formatDateYmdShanghai,
} from "./policy.mjs";

describe("evaluateBounceRate", () => {
  test("normal below 2%", () => {
    const e = evaluateBounceRate(1.5);
    expect(e.band).toBe("normal");
    expect(e.circuitBreakerTriggered).toBe(false);
    expect(e.allowAutoColdSend).toBe(true);
  });

  test("conservative hold 2–3% band (pending Ivan confirmation)", () => {
    const e = evaluateBounceRate(2.5);
    expect(e.band).toBe("conservative_hold");
    expect(e.circuitBreakerTriggered).toBe(false);
    expect(e.allowAutoColdSend).toBe(false);
  });

  test("circuit breaker at >= 3%", () => {
    const e = evaluateBounceRate(3);
    expect(e.band).toBe("circuit_breaker");
    expect(e.circuitBreakerTriggered).toBe(true);
    expect(e.allowAutoColdSend).toBe(false);
  });

  test("historical fixture 4.69% from 2026-11-17 is breaker (not live 11/19)", () => {
    expect(FIXTURE_LEDGER_BOUNCE_2026_11_17.asOf.startsWith("2026-11-17")).toBe(true);
    const e = evaluateBounceRate(FIXTURE_LEDGER_BOUNCE_2026_11_17.bounceRatePct);
    expect(e.band).toBe("circuit_breaker");
    expect(e.circuitBreakerTriggered).toBe(true);
  });
});

describe("deliveryEffects", () => {
  test("draft_only does not queue or send", () => {
    const e = deliveryEffects("draft_only");
    expect(e.ok).toBe(true);
    expect(e.isDraftOnly).toBe(true);
    expect(e.queuesAutoSend).toBe(false);
    expect(e.sendsImmediately).toBe(false);
  });

  test("queue_working_hours queues but does not send immediately", () => {
    const e = deliveryEffects("queue_working_hours");
    expect(e.queuesAutoSend).toBe(true);
    expect(e.sendsImmediately).toBe(false);
  });

  test("send_paced sends immediately", () => {
    const e = deliveryEffects("send_paced");
    expect(e.sendsImmediately).toBe(true);
    expect(e.isDraftOnly).toBe(false);
  });
});

describe("daily cap", () => {
  const ymd = "2026-11-19";
  const fmt = (d) => formatDateYmdShanghai(d);

  test("draft_only awaiting_review without autoSendAt does not consume cap", () => {
    const drafts = [
      { status: "awaiting_review", autoSendAt: null, updatedAt: "2026-11-19T02:00:00.000Z" },
      { status: "awaiting_review", autoSendAt: null, updatedAt: "2026-11-19T03:00:00.000Z" },
    ];
    expect(countCapConsumingDraftsToday(drafts, ymd, fmt)).toBe(0);
  });

  test("sent + queued autoSendAt consume cap; cross-batch request blocked at 10", () => {
    const drafts = [];
    for (let i = 0; i < 7; i++) {
      drafts.push({ status: "sent", sentAt: "2026-11-19T01:00:00.000Z" });
    }
    for (let i = 0; i < 2; i++) {
      drafts.push({
        status: "awaiting_review",
        autoSendAt: "2026-11-19T08:00:00.000Z",
        updatedAt: "2026-11-19T04:00:00.000Z",
      });
    }
    const sentToday = countCapConsumingDraftsToday(drafts, ymd, fmt);
    expect(sentToday).toBe(9);
    expect(assertDailyCapAllows(sentToday, 1).ok).toBe(true);
    expect(assertDailyCapAllows(sentToday, 2).ok).toBe(false);
  });

  test("concurrent/repeated runs share the same sentToday tally", () => {
    const a = assertDailyCapAllows(6, 3);
    const b = assertDailyCapAllows(6, 3);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    // After both succeed conceptually, tally would be 12 > 10
    expect(assertDailyCapAllows(6 + 3, 3).ok).toBe(false);
  });

  test("allowExceedCap override", () => {
    expect(assertDailyCapAllows(10, 1, { allowExceedCap: true }).ok).toBe(true);
  });
});

describe("computeDiscoveryQuota", () => {
  test("zero remaining → 0 discovery", () => {
    expect(computeDiscoveryQuota({ dailyRemaining: 0, referralSlots: 0, touch2Slots: 0 })).toBe(0);
  });

  test("10 - 2 referrals - 4 touch2 → 4 discovery (capped by 8)", () => {
    expect(computeDiscoveryQuota({ dailyRemaining: 10, referralSlots: 2, touch2Slots: 4 })).toBe(4);
  });

  test("does not exceed discoveryMax 8", () => {
    expect(computeDiscoveryQuota({ dailyRemaining: 10, referralSlots: 0, touch2Slots: 0 })).toBe(8);
  });
});
