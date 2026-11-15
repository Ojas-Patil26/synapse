// Learning-model math from CONTRACTS.md section 2. Used by the fixture API and for
// small client-side derivations (predicted forget date after a live node update).
import {
  FORGET_THRESHOLD,
  RETENTION_FLOOR,
  RETENTION_FULL_SCORE,
  SHAKY_RETENTION_CAP,
  SIGMA_DEFAULT,
  SIGMA_FLOOR,
  S_MAX,
  S_MIN,
  ZSCORE_ANOMALY,
  ZSCORE_WINDOW,
  type ConceptNode,
  type Rating,
} from "../contracts";

const DAY_MS = 86_400_000;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** R = R0 * e^(-t/S): R0 is the retention the last review left the concept at (1 unless it was lowered). */
export function retentionAt(lastReviewed: string, stability: number, now: number = Date.now(), startRetention = 1): number {
  const t = Math.max(0, (now - Date.parse(lastReviewed)) / DAY_MS);
  return clamp(startRetention, 0, 1) * Math.exp(-t / stability);
}

/** When R is predicted to cross 0.5; the review time itself when R0 is already at or below it. */
export function predictedForgetAt(lastReviewed: string, stability: number, startRetention = 1): string {
  const r0 = clamp(startRetention, 0, 1);
  const days = r0 > FORGET_THRESHOLD ? stability * Math.log(r0 / FORGET_THRESHOLD) : 0;
  return new Date(Date.parse(lastReviewed) + days * DAY_MS).toISOString();
}

/** A node carries only its current retention, so recover R0 from it: R0 = R / e^(-t/S). */
export function startRetentionOf(node: Pick<ConceptNode, "lastReviewed" | "stability" | "retention">, now: number = Date.now()): number {
  const decay = retentionAt(node.lastReviewed, node.stability, now);
  return decay > 0 ? clamp(node.retention / decay, 0, 1) : 1;
}

/** Retention a quiz leaves a concept at: 0.15 at a score of 0%, 1 at 80% or better. */
export function retentionAfterQuiz(score: number): number {
  const p = clamp(Number.isFinite(score) ? score : 0, 0, 1);
  return RETENTION_FLOOR + (1 - RETENTION_FLOOR) * Math.min(1, p / RETENTION_FULL_SCORE);
}

export function retentionAfterSelfReview(rating: Rating, retentionBefore: number): number {
  return rating === "got-it" ? 1 : Math.min(clamp(retentionBefore, 0, 1), SHAKY_RETENTION_CAP);
}

export function clampStability(s: number): number {
  return Math.min(S_MAX, Math.max(S_MIN, s));
}

export function stabilityAfterSelfReview(s: number, gotIt: boolean): number {
  return clampStability(gotIt ? s * 1.5 : s);
}

export function stabilityAfterQuiz(s: number, retentionBefore: number, score: number): number {
  return clampStability(score >= 0.5 ? s * (1 + score * (2 - retentionBefore)) : s * 0.7);
}

export function sampleStd(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/** zScore for one concept. `residuals` oldest first; `allResiduals` = every quiz residual of the user. */
export function zScoreFor(residuals: number[], allResiduals: number[]): { zScore: number | null; anomalous: boolean } {
  const window = residuals.slice(-ZSCORE_WINDOW);
  const n = window.length;
  if (n === 0) return { zScore: null, anomalous: false };
  const sigma = Math.max(SIGMA_FLOOR, allResiduals.length < 5 ? SIGMA_DEFAULT : sampleStd(allResiduals));
  const mean = window.reduce((a, b) => a + b, 0) / n;
  const zScore = (mean * Math.sqrt(n)) / sigma;
  return { zScore, anomalous: n >= 2 && zScore <= ZSCORE_ANOMALY };
}

export function urgency(retention: number, confidence: number | null, zScore: number | null): number {
  const c = confidence === null ? 0.5 : confidence;
  const a = zScore === null ? 0 : Math.min(1, Math.max(0, -zScore / 3));
  return 0.5 * (1 - retention) + 0.3 * (1 - c) + 0.2 * a;
}
