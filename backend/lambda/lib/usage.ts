// Per-user daily usage limits for the endpoints that call a paid or quota-limited API (Gemini,
// Textract). One counter document per user, kind and UTC day in MongoDB; a TTL index removes old days.
// Limits come from the environment so they can be raised without a code change.

import { HttpError } from "./http";
import { collections } from "./data/mongo";

export type UsageKind = "ai" | "ingest";

const DEFAULT_LIMITS: Record<UsageKind, number> = { ai: 80, ingest: 8 };
const ENV_NAMES: Record<UsageKind, string> = { ai: "AI_DAILY_LIMIT", ingest: "INGEST_DAILY_LIMIT" };
const WHAT: Record<UsageKind, string> = {
  ai: "AI requests (explanations, quizzes, links)",
  ingest: "course uploads",
};

export function limitFor(kind: UsageKind): number {
  const raw = Number(process.env[ENV_NAMES[kind]]);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_LIMITS[kind];
}

let indexReady = false;

/**
 * Counts one use and throws HttpError 429 once today's limit is passed. A failure of the counter
 * itself (a database blip) lets the request through rather than blocking a learner.
 */
export async function consume(userId: string, kind: UsageKind): Promise<void> {
  const limit = limitFor(kind);
  let count = 0;
  try {
    const { db } = await collections();
    const usage = db.collection("usage");
    if (!indexReady) {
      indexReady = true;
      await usage.createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 }).catch(() => undefined);
    }
    const day = new Date().toISOString().slice(0, 10);
    const doc = await usage.findOneAndUpdate(
      { userId, kind, day },
      { $inc: { count: 1 }, $setOnInsert: { expireAt: new Date(Date.now() + 3 * 86_400_000) } },
      { upsert: true, returnDocument: "after" },
    );
    count = Number(doc?.count ?? 0);
  } catch (err) {
    console.warn(`[usage] counter unavailable, allowing the request: ${err instanceof Error ? err.name : "error"}`);
    return;
  }
  if (count > limit) {
    throw new HttpError(429, "rate_limited", `You have reached today's limit of ${limit} ${WHAT[kind]}. It resets at midnight UTC.`);
  }
}
