/**
 * Pure policy helpers for outreach wave CLIs (testable without network).
 *
 * Bounce bands (user policy; 2–3% band interpretation pending Ivan confirmation):
 *   < 2%     → normal
 *   2–3%     → conservative_hold (no auto cold send)
 *   >= 3%    → circuit_breaker (halt paced send)
 *
 * Daily cap: Asia/Shanghai calendar day, limit 10 including sent + queued
 * (awaiting_review with autoSendAt). draft_only drafts do NOT count.
 */

export const DAILY_SEND_CAP = 10;
export const BOUNCE_NORMAL_MAX_PCT = 2;
export const BOUNCE_BREAKER_MIN_PCT = 3;

/** @typedef {'normal' | 'conservative_hold' | 'circuit_breaker'} BounceBand */

/**
 * @param {number} bounceRatePct
 * @returns {{ band: BounceBand, circuitBreakerTriggered: boolean, allowAutoColdSend: boolean, note: string }}
 */
export function evaluateBounceRate(bounceRatePct) {
  const pct = Number(bounceRatePct);
  const rate = Number.isFinite(pct) ? pct : 0;
  if (rate >= BOUNCE_BREAKER_MIN_PCT) {
    return {
      band: "circuit_breaker",
      circuitBreakerTriggered: true,
      allowAutoColdSend: false,
      note: `bounceRatePct=${rate}% >= ${BOUNCE_BREAKER_MIN_PCT}% — circuit breaker; no paced/auto cold send until reviewed.`,
    };
  }
  if (rate >= BOUNCE_NORMAL_MAX_PCT) {
    // 2–3% conservative band — interpretation pending Ivan confirmation.
    return {
      band: "conservative_hold",
      circuitBreakerTriggered: false,
      allowAutoColdSend: false,
      note: `bounceRatePct=${rate}% in 2–${BOUNCE_BREAKER_MIN_PCT}% band — conservative hold (pending Ivan confirmation); no auto cold send.`,
    };
  }
  return {
    band: "normal",
    circuitBreakerTriggered: false,
    allowAutoColdSend: true,
    note: `bounceRatePct=${rate}% < ${BOUNCE_NORMAL_MAX_PCT}% — normal.`,
  };
}

/**
 * Fixture snapshot from mini ledger (2026-11-17 10:30 CST) — NOT live 11/19 data.
 * Use only in tests to assert breaker logic against a known historical rate.
 */
export const FIXTURE_LEDGER_BOUNCE_2026_11_17 = {
  asOf: "2026-11-17T10:30:24+08:00",
  bounceRatePct: 4.69,
  circuitBreakerTriggered: true,
  note: "Historical fixture only; refresh before any real send decision.",
};

/**
 * Count sends that consume the daily domain-protection cap.
 * draft_only (awaiting_review without autoSendAt) must NOT count.
 *
 * @param {Array<{ status?: string, autoSendAt?: string | null, sentAt?: string | null, updatedAt?: string | null }>} drafts
 * @param {string} todayYmd  // YYYY-MM-DD in Asia/Shanghai
 * @param {(d: Date) => string} formatDateYmd
 */
export function countCapConsumingDraftsToday(drafts, todayYmd, formatDateYmd) {
  let n = 0;
  for (const d of drafts ?? []) {
    const isSentOrQueued = d.status === "sent" || (d.status === "awaiting_review" && Boolean(d.autoSendAt));
    if (!isSentOrQueued) continue;
    const ts = new Date(d.sentAt || d.updatedAt || 0);
    if (!Number.isFinite(ts.getTime())) continue;
    if (formatDateYmd(ts) === todayYmd) n += 1;
  }
  return n;
}

/**
 * @param {number} sentTodayCount
 * @param {number} requestedCount
 * @param {{ allowExceedCap?: boolean, limit?: number }} [opts]
 */
export function assertDailyCapAllows(sentTodayCount, requestedCount, opts = {}) {
  const limit = opts.limit ?? DAILY_SEND_CAP;
  const allowExceedCap = Boolean(opts.allowExceedCap);
  const sent = Math.max(0, Number(sentTodayCount) || 0);
  const req = Math.max(0, Number(requestedCount) || 0);
  if (!allowExceedCap && sent + req > limit) {
    return {
      ok: false,
      sentTodayCount: sent,
      requestedCount: req,
      limit,
      error: `Daily domain protection cap exceeded: sentToday=${sent}, requested=${req}, limit=${limit}. Pass --allow-exceed-cap to override.`,
    };
  }
  return { ok: true, sentTodayCount: sent, requestedCount: req, limit, remaining: Math.max(0, limit - sent) };
}

/**
 * Playbook-style NEW_TARGET discovery quota after referrals + Touch2 reservations.
 * Formula: remaining == 0 → 0; else min(8, max(0, remaining - referrals - touch2)).
 * (Script historically also used min(8, afterT2) without max(4,…); keep that for discovery.)
 *
 * @param {{ dailyRemaining: number, referralSlots: number, touch2Slots: number, discoveryMax?: number }} input
 */
export function computeDiscoveryQuota(input) {
  const dailyRemaining = Math.max(0, Number(input.dailyRemaining) || 0);
  if (dailyRemaining === 0) return 0;
  const referralSlots = Math.max(0, Number(input.referralSlots) || 0);
  const touch2Slots = Math.max(0, Number(input.touch2Slots) || 0);
  const discoveryMax = input.discoveryMax ?? 8;
  const afterRef = Math.max(0, dailyRemaining - referralSlots);
  const afterT2 = Math.max(0, afterRef - touch2Slots);
  return Math.min(discoveryMax, afterT2);
}

/** Valid outreach batch delivery modes. */
export const VALID_DELIVERY = new Set([
  "draft_only",
  "queue_working_hours",
  "send_now",
  "send_paced",
]);

/**
 * draft_only must not queue or auto-send.
 * @param {string} mode
 */
export function deliveryEffects(mode) {
  const m = VALID_DELIVERY.has(mode) ? mode : null;
  if (!m) return { ok: false, error: `Invalid delivery mode "${mode}"` };
  return {
    ok: true,
    mode: m,
    createsDraft: true,
    queuesAutoSend: m === "queue_working_hours",
    sendsImmediately: m === "send_now" || m === "send_paced",
    isDraftOnly: m === "draft_only",
  };
}

/**
 * Format a Date as YYYY-MM-DD in Asia/Shanghai (same semantics as wave-review).
 * @param {Date} d
 */
export function formatDateYmdShanghai(d) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const day = parts.find((p) => p.type === "day")?.value;
  return `${y}-${m}-${day}`;
}
