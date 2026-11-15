// Reference implementation of the z-score statistic in plain TypeScript.
// Production reads it from SQL (tiger.ts, ZSCORE_SQL); this mirror exists so the
// seed's --dry-run and the offline tests can check a history without a database.

import { SIGMA_DEFAULT, SIGMA_FLOOR, ZSCORE_ANOMALY, ZSCORE_WINDOW } from "../contracts";
import type { ReviewEvent, ZScoreRow } from "./tiger";

const NINETY_DAYS_MS = 90 * 86_400_000;

export function computeZScores(events: ReviewEvent[], now: Date = new Date()): Map<string, ZScoreRow> {
  const quiz = events
    .filter(
      (e) =>
        (e.eventType === "generated-quiz" || e.eventType === "uploaded-quiz") &&
        e.result !== null &&
        e.predictedRetention !== null,
    )
    .map((e) => ({ conceptId: e.conceptId, ts: e.ts.getTime(), residual: (e.result as number) - (e.predictedRetention as number) }));

  const recent = quiz.filter((q) => q.ts >= now.getTime() - NINETY_DAYS_MS).map((q) => q.residual);
  let sigma = SIGMA_DEFAULT;
  if (recent.length >= 5) {
    const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
    sigma = Math.sqrt(recent.reduce((a, b) => a + (b - mean) ** 2, 0) / (recent.length - 1));
  }
  sigma = Math.max(sigma, SIGMA_FLOOR);

  const byConcept = new Map<string, { ts: number; residual: number }[]>();
  for (const q of quiz) {
    if (!byConcept.has(q.conceptId)) byConcept.set(q.conceptId, []);
    byConcept.get(q.conceptId)?.push(q);
  }
  const out = new Map<string, ZScoreRow>();
  for (const [conceptId, rows] of byConcept) {
    const window = rows.sort((a, b) => b.ts - a.ts).slice(0, ZSCORE_WINDOW);
    const n = window.length;
    const meanResidual = window.reduce((a, b) => a + b.residual, 0) / n;
    const zScore = (meanResidual * Math.sqrt(n)) / sigma;
    out.set(conceptId, { conceptId, n, meanResidual, sigma, zScore, anomalous: n >= 2 && zScore <= ZSCORE_ANOMALY });
  }
  return out;
}
