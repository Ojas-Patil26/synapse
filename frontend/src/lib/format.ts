import { confidenceLevel, type ConfidenceLevel } from "../contracts";

export const pct = (v: number) => `${Math.round(v * 100)}%`;

const LEVEL_LABEL: Record<ConfidenceLevel, string> = {
  unassessed: "Not assessed yet", // COPY.md, verbatim
  low: "Low",
  medium: "Medium",
  high: "High",
};

export function confidenceLabel(confidence: number | null): string {
  return LEVEL_LABEL[confidenceLevel(confidence)];
}

/** "Low (32%)" or "Not assessed yet". */
export function confidenceText(confidence: number | null): string {
  return confidence === null ? LEVEL_LABEL.unassessed : `${confidenceLabel(confidence)} (${pct(confidence)})`;
}

const DAY_MS = 86_400_000;

/** "Nov 17 (in 2 days)" / "Nov 12 (3 days ago)" / "Today". */
export function forgetDate(iso: string, now: number = Date.now()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Unknown";
  const date = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const days = Math.round((d.getTime() - now) / DAY_MS);
  if (days === 0) return `${date} (today)`;
  if (days === 1) return `${date} (tomorrow)`;
  if (days === -1) return `${date} (yesterday)`;
  return days > 0 ? `${date} (in ${days} days)` : `${date} (${-days} days ago)`;
}

export function forgetVerb(iso: string, now: number = Date.now()): string {
  return Date.parse(iso) < now ? "Predicted forgotten" : "Predicted to forget";
}
