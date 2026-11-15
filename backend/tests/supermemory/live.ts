// Live test against the real Supermemory API. Run from /backend:
//   npx tsx --env-file=../.env tests/supermemory/live.ts
// Uses a throwaway user id and deletes its namespace afterwards. Never prints the key.

import { randomBytes } from "node:crypto";
import { getLearnerProfile, learnerNamespace, logLearningEvent } from "../../lambda/lib/supermemory";
import type { LearningEvent } from "../../lambda/lib/contracts";

const POLL_EVERY_MS = 3000;
const POLL_FOR_MS = Number(process.env.SM_LIVE_POLL_MS ?? 90000);
const KEEP = process.env.SM_LIVE_KEEP === "1";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ms = (from: number) => Math.round(performance.now() - from);

async function main(): Promise<void> {
  const key = (process.env.SUPERMEMORY_API_KEY ?? "").trim();
  if (!key) {
    console.error("SUPERMEMORY_API_KEY is not set. Run with --env-file=../.env");
    process.exitCode = 1;
    return;
  }

  const userId = `sm-itest-${randomBytes(6).toString("hex")}`;
  const namespace = learnerNamespace(userId);
  console.log(`user: ${userId}\nnamespace: ${namespace}`);

  const now = Date.now();
  const at = (minutesAgo: number) => new Date(now - minutesAgo * 60000).toISOString();
  const events: LearningEvent[] = [
    { type: "course-ingested", courseName: "CSE 471", timestamp: at(60) },
    {
      type: "generated-quiz",
      courseName: "CSE 471",
      conceptLabel: "A* Search",
      score: 0.53,
      confidence: 0.53,
      retention: 0.61,
      missedQuestions: [
        "Why must an A* heuristic be admissible for the result to be optimal?",
        "What is the difference between a consistent and an admissible heuristic?",
      ],
      timestamp: at(40),
    },
    {
      type: "self-review",
      courseName: "CSE 471",
      conceptLabel: "Minimax",
      rating: "got-it",
      retention: 0.72,
      timestamp: at(30),
    },
    {
      type: "uploaded-quiz",
      courseName: "CSE 471",
      conceptLabel: "Bayesian Networks",
      score: 0.9,
      confidence: 0.9,
      retention: 0.8,
      timestamp: at(20),
    },
    { type: "explanation-viewed", courseName: "CSE 471", conceptLabel: "A* Search", retention: 0.95, timestamp: at(5) },
  ];

  // A profile for a user with no memories must be "".
  let t = performance.now();
  const empty = await getLearnerProfile(userId, { conceptLabel: "A* Search", courseName: "CSE 471" });
  console.log(`\nprofile before any event: length ${empty.length} (${ms(t)} ms)`);

  console.log("\nlogging events:");
  const logTimes: number[] = [];
  for (const event of events) {
    t = performance.now();
    await logLearningEvent(userId, event);
    logTimes.push(ms(t));
    console.log(`  ${event.type.padEnd(20)} ${logTimes[logTimes.length - 1]} ms`);
  }
  const loggedAt = performance.now();

  console.log("\npolling getLearnerProfile:");
  const focus = { conceptLabel: "A* Search", courseName: "CSE 471" };
  const profileTimes: number[] = [];
  let firstNonEmptyAt: number | null = null;
  let last = "";
  let stable = 0;
  while (performance.now() - loggedAt < POLL_FOR_MS) {
    t = performance.now();
    const profile = await getLearnerProfile(userId, focus);
    const took = ms(t);
    profileTimes.push(took);
    const since = ms(loggedAt);
    console.log(`  +${String(since).padStart(6)} ms  length ${String(profile.length).padStart(4)}  (${took} ms)`);
    if (profile && firstNonEmptyAt === null) firstNonEmptyAt = since;
    stable = profile && profile === last ? stable + 1 : 0;
    last = profile || last;
    if (stable >= 4) break; // unchanged for five polls in a row: indexing has settled
    await sleep(POLL_EVERY_MS);
  }

  t = performance.now();
  const unfocused = await getLearnerProfile(userId);
  const unfocusedMs = ms(t);

  const sorted = [...profileTimes].sort((a, b) => a - b);
  console.log("\nresults:");
  console.log(`  logLearningEvent latency: ${logTimes.join(", ")} ms`);
  console.log(
    `  getLearnerProfile latency: min ${sorted[0]} / median ${sorted[Math.floor(sorted.length / 2)]} / max ${sorted[sorted.length - 1]} ms over ${sorted.length} calls`,
  );
  console.log(
    `  first non-empty profile: ${firstNonEmptyAt === null ? "never" : `${firstNonEmptyAt} ms after the last event was logged`}`,
  );
  console.log(`  final focused profile length: ${last.length}`);
  console.log(`  first 300 chars:\n${last.slice(0, 300)}`);
  console.log(`\n  unfocused profile: length ${unfocused.length} (${unfocusedMs} ms)\n${unfocused.slice(0, 300)}`);
  if (process.env.SM_LIVE_FULL === "1") console.log(`\n--- full focused profile ---\n${last}`);

  if (KEEP) {
    console.log(`\nSM_LIVE_KEEP=1: leaving namespace ${namespace} in place`);
  } else {
    // Cleanup: DELETE /ns/{namespace} permanently removes its documents and memories.
    try {
      const res = await fetch(`https://api.supermemory.ai/ns/${namespace}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${key}` },
      });
      const body = await res.text();
      console.log(`\ncleanup: DELETE /ns/${namespace} -> HTTP ${res.status} ${body.slice(0, 200)}`);
    } catch (err) {
      console.log(`\ncleanup failed: ${err instanceof Error ? err.name : "error"}`);
    }
  }

  if (!last) process.exitCode = 1;
}

main().catch((err) => {
  console.error("live test crashed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
