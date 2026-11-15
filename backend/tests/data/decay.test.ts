import { describe, expect, it } from "vitest";
import { S0, S_MAX, S_MIN, SIGMA_DEFAULT, SIGMA_FLOOR } from "../../lambda/lib/contracts";
import {
  nextStability,
  predictedForgetAt,
  retentionAfterQuiz,
  retentionAfterSelfReview,
  retentionAt,
  urgency,
} from "../../lambda/lib/data/decay";
import type { ReviewEvent } from "../../lambda/lib/data/tiger";
import { computeZScores } from "../../lambda/lib/data/zscore";

const DAY = 86_400_000;
const T0 = "2026-11-10T00:00:00.000Z";
const at = (days: number): Date => new Date(new Date(T0).getTime() + days * DAY);

describe("retentionAt", () => {
  it("is 1 at the moment of review", () => {
    expect(retentionAt(T0, 5, at(0))).toBe(1);
  });
  it("is e^(-t/S) with t in fractional days", () => {
    expect(retentionAt(T0, 12, at(1))).toBeCloseTo(Math.exp(-1 / 12), 12);
    expect(retentionAt(T0, 3, at(6))).toBeCloseTo(Math.exp(-2), 12);
    expect(retentionAt(T0, 2, at(0.25))).toBeCloseTo(Math.exp(-0.125), 12);
  });
  it("matches the fixture examples", () => {
    expect(retentionAt(T0, 6, at(3))).toBeCloseTo(0.607, 3);
    expect(retentionAt(T0, 5, at(6))).toBeCloseTo(0.301, 3);
  });
  it("never exceeds 1 when lastReviewed is in the future", () => {
    expect(retentionAt(T0, 5, at(-2))).toBe(1);
  });
  it("defaults now to the current time", () => {
    const r = retentionAt(new Date(Date.now() - DAY).toISOString(), 2);
    expect(r).toBeCloseTo(Math.exp(-0.5), 3);
  });
  it("does not return NaN for bad input", () => {
    expect(retentionAt("not a date", 5, at(0))).toBe(0);
    expect(Number.isFinite(retentionAt(T0, 0, at(1)))).toBe(true);
  });
});

describe("nextStability: every row of the table", () => {
  it("ingested -> S0", () => {
    expect(nextStability(40, 0.3, "ingested", null)).toBe(S0);
  });
  it("self-review, got it -> S * 1.5", () => {
    expect(nextStability(4, 0.6, "self-review", 1)).toBe(6);
  });
  it("self-review, still shaky -> S unchanged", () => {
    expect(nextStability(4, 0.6, "self-review", 0)).toBe(4);
  });
  it("quiz, p >= 0.5 -> S * (1 + p * (2 - R_before))", () => {
    expect(nextStability(4, 0.6, "generated-quiz", 0.8)).toBeCloseTo(4 * (1 + 0.8 * 1.4), 12);
    expect(nextStability(4, 0.6, "uploaded-quiz", 0.8)).toBeCloseTo(4 * (1 + 0.8 * 1.4), 12);
  });
  it("quiz, p exactly 0.5 counts as a pass", () => {
    expect(nextStability(4, 1, "generated-quiz", 0.5)).toBeCloseTo(6, 12);
  });
  it("quiz, p < 0.5 -> S * 0.7", () => {
    expect(nextStability(4, 0.6, "generated-quiz", 0.49)).toBeCloseTo(2.8, 12);
    expect(nextStability(4, 0.1, "uploaded-quiz", 0)).toBeCloseTo(2.8, 12);
  });
  it("spacing effect: a nearly forgotten concept grows more", () => {
    const fresh = nextStability(4, 0.95, "generated-quiz", 0.9);
    const stale = nextStability(4, 0.2, "generated-quiz", 0.9);
    expect(stale).toBeGreaterThan(fresh);
    expect(stale).toBeCloseTo(4 * (1 + 0.9 * 1.8), 12);
  });
  it("clamps to S_MIN", () => {
    expect(nextStability(1.2, 0.9, "generated-quiz", 0.1)).toBe(S_MIN);
    expect(nextStability(0.2, 0.9, "self-review", 0)).toBe(S_MIN);
  });
  it("clamps to S_MAX", () => {
    expect(nextStability(300, 0.5, "self-review", 1)).toBe(S_MAX);
    expect(nextStability(200, 0.1, "uploaded-quiz", 1)).toBe(S_MAX);
  });
});

describe("predictedForgetAt", () => {
  it("is lastReviewed + S * ln(2) days", () => {
    const iso = predictedForgetAt(T0, 6);
    expect(new Date(iso).getTime()).toBeCloseTo(new Date(T0).getTime() + 6 * Math.LN2 * DAY, -1);
  });
  it("is the time at which retention is 0.5", () => {
    expect(retentionAt(T0, 9, new Date(predictedForgetAt(T0, 9)))).toBeCloseTo(0.5, 6);
  });
});

describe("urgency", () => {
  it("0.5 * (1 - R) + 0.3 * (1 - C) + 0.2 * A", () => {
    expect(urgency(0.4, 0.2, -1.5)).toBeCloseTo(0.5 * 0.6 + 0.3 * 0.8 + 0.2 * 0.5, 12);
  });
  it("C = 0.5 when confidence is null", () => {
    expect(urgency(1, null, null)).toBeCloseTo(0.15, 12);
  });
  it("A = 0 when zScore is null or positive", () => {
    expect(urgency(0.5, 1, null)).toBeCloseTo(0.25, 12);
    expect(urgency(0.5, 1, 2.4)).toBeCloseTo(0.25, 12);
  });
  it("A is clamped to 1", () => {
    expect(urgency(0, 0, -9)).toBeCloseTo(1, 12);
    expect(urgency(0, 0, -3)).toBeCloseTo(1, 12);
  });
  it("is 0 for a fresh, mastered, non-anomalous concept", () => {
    expect(urgency(1, 1, 0)).toBe(0);
  });
});

describe("computeZScores (TypeScript mirror of the SQL)", () => {
  const now = new Date("2026-11-15T00:00:00Z");
  const ev = (conceptId: string, daysAgo: number, result: number, predicted: number, type: ReviewEvent["eventType"] = "generated-quiz"): ReviewEvent => ({
    ts: new Date(now.getTime() - daysAgo * DAY), userId: "u", courseId: "c", conceptId, eventType: type,
    result, predictedRetention: predicted, stabilityBefore: 2, stabilityAfter: 2,
  });

  it("uses sigma = 0.25 when the user has fewer than 5 residuals", () => {
    const z = computeZScores([ev("a", 2, 0.3, 0.8), ev("a", 1, 0.2, 0.9)], now).get("a");
    expect(z?.sigma).toBe(SIGMA_DEFAULT);
    expect(z?.n).toBe(2);
    expect(z?.zScore).toBeCloseTo((-0.6 * Math.SQRT2) / 0.25, 9);
    expect(z?.anomalous).toBe(true);
  });
  it("n = 1 is never anomalous", () => {
    const z = computeZScores([ev("a", 1, 0, 1)], now).get("a");
    expect(z?.zScore).toBeCloseTo(-4, 9);
    expect(z?.anomalous).toBe(false);
  });
  it("ignores self-reviews and ingests; no quiz events -> absent (null z)", () => {
    const z = computeZScores([ev("a", 1, 0, 1, "self-review"), { ...ev("a", 3, 0, 1, "ingested"), result: null, predictedRetention: null }], now);
    expect(z.has("a")).toBe(false);
  });
  it("floors sigma at 0.15", () => {
    const events = [1, 2, 3, 4, 5, 6].map((d) => ev("a", d, 0.5, 0.52));
    expect(computeZScores(events, now).get("a")?.sigma).toBe(SIGMA_FLOOR);
  });
  it("windows the last 5 quiz events and uses the sample stddev of all residuals", () => {
    const residuals = [0.3, -0.5, -0.4, -0.6, -0.5, -0.3, 0.2]; // oldest first
    const events = residuals.map((r, i) => ev(i < 6 ? "a" : "b", 10 - i, 0.5 + r / 2, 0.5 - r / 2));
    const mean = residuals.reduce((x, y) => x + y, 0) / residuals.length;
    const sigma = Math.sqrt(residuals.reduce((x, y) => x + (y - mean) ** 2, 0) / (residuals.length - 1));
    const a = computeZScores(events, now).get("a");
    expect(a?.n).toBe(5);
    expect(a?.sigma).toBeCloseTo(sigma, 9);
    expect(a?.zScore).toBeCloseTo(((-0.5 - 0.4 - 0.6 - 0.5 - 0.3) / 5) * Math.sqrt(5) / sigma, 9);
    expect(a?.anomalous).toBe(true);
    expect(computeZScores(events, now).get("b")?.anomalous).toBe(false);
  });
  it("sigma only looks at the last 90 days", () => {
    const old = [100, 101, 102, 103, 104, 105].map((d) => ev("old", d, 0.9, 0.1));
    const z = computeZScores([...old, ev("a", 1, 0.4, 0.8), ev("a", 2, 0.4, 0.8)], now).get("a");
    expect(z?.sigma).toBe(SIGMA_DEFAULT);
  });
});


describe("retention after a review (R0)", () => {
  it("retentionAt scales the decay by the starting retention", () => {
    const now = new Date("2026-11-15T00:00:00Z");
    const reviewed = "2026-11-12T00:00:00Z"; // 3 days
    expect(retentionAt(reviewed, 3, now)).toBeCloseTo(Math.exp(-1), 6);
    expect(retentionAt(reviewed, 3, now, 0.5)).toBeCloseTo(0.5 * Math.exp(-1), 6);
    expect(retentionAt(reviewed, 3, now, 7)).toBeCloseTo(Math.exp(-1), 6); // clamped to 1
  });

  it("retentionAfterQuiz runs 0.15 at 0% to 1 at 80% or better", () => {
    expect(retentionAfterQuiz(0)).toBeCloseTo(0.15, 9);
    expect(retentionAfterQuiz(0.4)).toBeCloseTo(0.575, 9);
    expect(retentionAfterQuiz(0.8)).toBeCloseTo(1, 9);
    expect(retentionAfterQuiz(1)).toBe(1);
    expect(retentionAfterQuiz(-2)).toBeCloseTo(0.15, 9);
    expect(retentionAfterQuiz(Number.NaN)).toBeCloseTo(0.15, 9);
  });

  it("retentionAfterSelfReview restores on got-it and caps at 0.4 on still-shaky", () => {
    expect(retentionAfterSelfReview("got-it", 0.2)).toBe(1);
    expect(retentionAfterSelfReview("still-shaky", 0.9)).toBe(0.4);
    expect(retentionAfterSelfReview("still-shaky", 0.1)).toBe(0.1);
  });

  it("predictedForgetAt uses ln(R0 / 0.5) and is the review time when R0 is already at or below 0.5", () => {
    const reviewed = "2026-11-10T00:00:00Z";
    const day = 86_400_000;
    expect(new Date(predictedForgetAt(reviewed, 4)).getTime()).toBeCloseTo(Date.parse(reviewed) + 4 * Math.LN2 * day, -2);
    expect(new Date(predictedForgetAt(reviewed, 4, 0.8)).getTime()).toBeCloseTo(Date.parse(reviewed) + 4 * Math.log(1.6) * day, -2);
    expect(predictedForgetAt(reviewed, 4, 0.4)).toBe(new Date(reviewed).toISOString());
  });
});
