/**
 * The decisions of the automatic follow-up sender (autoFollowUps.ts), kept
 * pure so they can be tested without a database or a send.
 */
import type { CrmChannel, CrmWorkflowState } from "./schema";

/**
 * A follow-up still unsent this long after it was drafted goes to a person:
 * its account stayed disconnected, out of hours or out of budget, and by now
 * the timing it was written for has passed.
 */
export const AUTO_FOLLOW_UP_HANDOFF_MS = 48 * 60 * 60 * 1000;

export type AutoFollowUpCandidate = {
  draftId: string;
  revision: number;
  channel: CrmChannel;
  /** The sending account: mailbox address, LinkedIn or WhatsApp Unipile account id. */
  accountRef: string;
  autoSendAt: Date;
  sequenceAutoSend: boolean;
  workflowState: CrmWorkflowState;
  runActive: boolean;
  stepAwaitingReview: boolean;
  /** The draft was written for the record's current context. */
  contextCurrent: boolean;
  /** Whether the draft is a one-off/direct send scheduled to go out in working hours */
  isScheduledDirectSend?: boolean;
};

export type AutoFollowUpHandoffReason =
  | "sequence_auto_send_off"
  | "record_needs_a_person"
  | "not_sent_in_48_hours"
  /** sendDraft refused before anything was sent (e.g. Do Not Contact). */
  | "send_refused";

export type AutoFollowUpVerdict =
  | { verdict: "send" }
  | { verdict: "wait" }
  | { verdict: "hand_to_rep"; reason: AutoFollowUpHandoffReason };

export function autoFollowUpVerdict(candidate: AutoFollowUpCandidate, now: Date): AutoFollowUpVerdict {
  if (candidate.isScheduledDirectSend) {
    if (["paused", "closed", "error"].includes(candidate.workflowState)) return { verdict: "wait" };
    if (now.getTime() - candidate.autoSendAt.getTime() > AUTO_FOLLOW_UP_HANDOFF_MS) {
      return { verdict: "hand_to_rep", reason: "not_sent_in_48_hours" };
    }
    if (!candidate.contextCurrent) return { verdict: "wait" };
    return { verdict: "send" };
  }

  // Switched off after it was drafted: it becomes an ordinary draft to review.
  if (!candidate.sequenceAutoSend) return { verdict: "hand_to_rep", reason: "sequence_auto_send_off" };
  // Something else put the record on a person's desk; they send it with the rest.
  if (candidate.workflowState === "action_required") return { verdict: "hand_to_rep", reason: "record_needs_a_person" };
  // Paused or closed by a person, or failed: theirs to pick up, not ours.
  if (["paused", "closed", "error"].includes(candidate.workflowState)) return { verdict: "wait" };
  if (now.getTime() - candidate.autoSendAt.getTime() > AUTO_FOLLOW_UP_HANDOFF_MS) {
    return { verdict: "hand_to_rep", reason: "not_sent_in_48_hours" };
  }
  if (
    candidate.workflowState === "waiting"
    && candidate.runActive
    && candidate.stepAwaitingReview
    && candidate.contextCurrent
  ) {
    return { verdict: "send" };
  }
  // Mid-change (a reply or a stage move is retiring this draft): leave it.
  return { verdict: "wait" };
}

export function sendingAccountKey(candidate: Pick<AutoFollowUpCandidate, "channel" | "accountRef">): string {
  return `${candidate.channel}:${candidate.accountRef}`;
}

/**
 * At most one follow-up per sending account per run: the oldest. `candidates`
 * must already be ordered oldest first.
 */
export function oldestPerAccount<T extends Pick<AutoFollowUpCandidate, "channel" | "accountRef">>(
  candidates: readonly T[],
): T[] {
  const picked = new Map<string, T>();
  for (const candidate of candidates) {
    const key = sendingAccountKey(candidate);
    if (!picked.has(key)) picked.set(key, candidate);
  }
  return [...picked.values()];
}

/** True when the account's last automatic follow-up is at least `gapMinutes` old. */
export function followUpGapPassed(lastAutoSendAt: Date | null, gapMinutes: number, now: Date): boolean {
  if (!lastAutoSendAt) return true;
  return now.getTime() - lastAutoSendAt.getTime() >= gapMinutes * 60_000;
}
