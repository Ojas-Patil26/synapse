// Pure learning-model functions (CONTRACTS.md section 2). No I/O.

import {
  FORGET_THRESHOLD,
  RETENTION_FLOOR,
  RETENTION_FULL_SCORE,
  S0,
  SHAKY_RETENTION_CAP,
  S_MAX,
  S_MIN,
} from "../contracts";
import type { EventType } from "../contracts";

const MS_PER_DAY = 86_400_000;

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/**
 * R = R0 * e^(-t/S), t = fractional days since lastReviewed, R0 = the retention the concept
 * was left at by its last review (1 unless a weak quiz or a "still shaky" rating lowered it).
 * Never above 1, never NaN.
 */
export function retentionAt(lastReviewed: string, stability: number, now?: Date, startRetention = 1): number {
  const reviewedMs = new Date(lastReviewed).getTime();
  const nowMs = (now ?? new Date()).getTime();
  if (!Number.isFinite(reviewedMs) || !Number.isFinite(nowMs)) return 0;
  const days = Math.max(0, (nowMs - reviewedMs) / MS_PER_DAY);
  const s = Number.isFinite(stability) && stability > 0 ? stability : S_MIN;
  const r0 = Number.isFinite(startRetention) ? clamp(startRetention, 0, 1) : 1;
  return r0 * Math.exp(-days / s);
}

/** Retention a concept starts from after a quiz: 0.15 at a score of 0%, rising to 1 at 80% or better. */
export function retentionAfterQuiz(score: number): number {
  const p = clamp(Number.isFinite(score) ? score : 0, 0, 1);
  return RETENTION_FLOOR + (1 - RETENTION_FLOOR) * Math.min(1, p / RETENTION_FULL_SCORE);
}

/** "Got it" restores full retention; "still shaky" pushes it below the at-risk line (0.4 at most). */
export function retentionAfterSelfReview(rating: "got-it" | "still-shaky", retentionBefore: number): number {
  return rating === "got-it" ? 1 : Math.min(clamp(retentionBefore, 0, 1), SHAKY_RETENTION_CAP);
}

/**
 * New stability after an event, clamped to [S_MIN, S_MAX].
 * - ingested: S0
 * - self-review: result 1 (got it) -> S * 1.5; result 0 (still shaky) -> S unchanged
 * - quiz (generated or uploaded), score p = result: p >= 0.5 -> S * (1 + p * (2 - R_before)); else S * 0.7
 */
export function nextStability(
  stabilityBefore: number,
  retentionBefore: number,
  eventType: EventType,
  result: number | null,
): number {
  let next: number;
  if (eventType === "ingested") {
    next = S0;
  } else if (eventType === "self-review") {
    next = (result ?? 0) >= 0.5 ? stabilityBefore * 1.5 : stabilityBefore;
  } else {
    const p = clamp(result ?? 0, 0, 1);
    const r = clamp(retentionBefore, 0, 1);
    next = p >= 0.5 ? stabilityBefore * (1 + p * (2 - r)) : stabilityBefore * 0.7;
  }
  if (!Number.isFinite(next)) next = S0;
  return clamp(next, S_MIN, S_MAX);
}

/** When R is predicted to cross FORGET_THRESHOLD: lastReviewed + S * ln(R0 / threshold) days (now, if R0 is already below it). */
export function predictedForgetAt(lastReviewed: string, stability: number, startRetention = 1): string {
  const reviewedMs = new Date(lastReviewed).getTime();
  const r0 = Number.isFinite(startRetention) ? clamp(startRetention, 0, 1) : 1;
  const days = r0 > FORGET_THRESHOLD ? stability * Math.log(r0 / FORGET_THRESHOLD) : 0;
  return new Date(reviewedMs + days * MS_PER_DAY).toISOString();
}

/** urgency = 0.5 * (1 - R) + 0.3 * (1 - C) + 0.2 * A; C = 0.5 when null; A = clamp(-z / 3, 0, 1), 0 when null. */
export function urgency(retention: number, confidence: number | null, zScore: number | null): number {
  const r = clamp(retention, 0, 1);
  const c = confidence === null ? 0.5 : clamp(confidence, 0, 1);
  const a = zScore === null ? 0 : clamp(-zScore / 3, 0, 1);
  return 0.5 * (1 - r) + 0.3 * (1 - c) + 0.2 * a;
}
