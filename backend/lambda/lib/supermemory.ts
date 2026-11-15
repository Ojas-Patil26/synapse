// Supermemory client (API v5, namespace-scoped REST, https://supermemory.ai/docs/v5/api-reference/overview).
//
// Contract (CONTRACTS.md section 4): neither exported function ever throws.
// getLearnerProfile returns "" on any failure and never takes longer than 3 seconds;
// logLearningEvent gives up after 4 seconds. With SUPERMEMORY_API_KEY unset both are no-ops.
//
// Per-user scoping: every learner gets their own namespace (v5's name for a container
// tag), derived from the opaque Cognito user id. Nothing else that identifies the
// person is ever sent.
//
//   POST /ns/{namespace}/document   one document per learning event
//   POST /ns/{namespace}/profile    synthesized profile (takes no query)
//   POST /ns/{namespace}/search     memories/chunks relevant to the focus concept

import { createHash } from "node:crypto";
import type { LearningEvent } from "./contracts";

const BASE_URL = "https://api.supermemory.ai";
const PROFILE_TIMEOUT_MS = 3000;
const LOG_TIMEOUT_MS = 4000;
const PROFILE_MAX_CHARS = 1500;
const LINE_MAX_CHARS = 240;
const NAMESPACE_PREFIX = "synapse-";
const NAMESPACE_MAX_CHARS = 100; // API limit; allowed characters are [a-zA-Z0-9_:-]

// Sent with every document; tells Supermemory's extractor what to learn from the events.
const SUPPORTING_CONTEXT =
  "These are study events for one student using a spaced-repetition learning app. " +
  "Learn which courses and concepts the learner is strong or weak at, how they scored on " +
  "quizzes, which questions they missed, and how well they retain material over time. " +
  "Scores, confidence and retention are on a 0 to 1 scale (or shown as a percentage).";

type Focus = { conceptLabel?: string; courseName?: string };

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function getLearnerProfile(userId: string, focus?: Focus): Promise<string> {
  try {
    const key = apiKey();
    const namespace = learnerNamespace(userId);
    if (!key || !namespace) return "";

    const got: { profile?: unknown; search?: unknown } = {};
    const timer = startDeadline(PROFILE_TIMEOUT_MS);
    try {
      const work = Promise.all([
        post(key, `/ns/${namespace}/profile`, {}, timer.signal, "profile").then((r) => {
          got.profile = r;
        }),
        post(
          key,
          `/ns/${namespace}/search`,
          { query: searchQuery(focus), searchMode: "hybrid", limit: 8 },
          timer.signal,
          "search",
        ).then((r) => {
          got.search = r;
        }),
      ]);
      // Whatever has arrived by the deadline is used; a slow call is simply left out.
      await Promise.race([work, timer.expired]);
    } finally {
      timer.stop();
    }
    return formatProfile(got.profile, got.search, focus);
  } catch {
    return "";
  }
}

export async function logLearningEvent(userId: string, event: LearningEvent): Promise<void> {
  try {
    const key = apiKey();
    const namespace = learnerNamespace(userId);
    if (!key || !namespace || !event || typeof event !== "object") return;

    const body: Record<string, unknown> = {
      // A stable id makes a retried log call a no-op instead of a duplicate memory.
      id: eventDocumentId(namespace, event),
      content: describeLearningEvent(event),
      metadata: eventMetadata(event),
      supportingContext: SUPPORTING_CONTEXT,
      taskType: "memory",
      // "instant" forms memories as soon as this document is processed, so the next
      // quiz or explanation can already use it (costs one extra operation per event).
      dreaming: "instant",
    };
    const when = parseDate(event.timestamp);
    if (when) body.date = when.toISOString();

    const timer = startDeadline(LOG_TIMEOUT_MS);
    try {
      await Promise.race([
        post(key, `/ns/${namespace}/document`, body, timer.signal, "log event"),
        timer.expired,
      ]);
    } finally {
      timer.stop();
    }
  } catch {
    // Logging is best effort.
  }
}

/** Deletes everything stored about one learner. Never throws; returns false when nothing could be confirmed deleted. */
export async function deleteLearnerData(userId: string): Promise<boolean> {
  try {
    const key = apiKey();
    const namespace = learnerNamespace(userId);
    if (!key || !namespace) return true; // nothing was ever sent
    const timer = startDeadline(8000);
    try {
      const res = await fetch(`${BASE_URL}/ns/${namespace}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${key}` },
        signal: timer.signal,
      });
      if (!res.ok && res.status !== 404) warn(`delete learner data failed: HTTP ${res.status}`);
      return res.ok || res.status === 404;
    } finally {
      timer.stop();
    }
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Helpers exported for tests and the live test script (not part of the contract)
// ---------------------------------------------------------------------------

/** The Supermemory namespace holding one learner's memories. "" for an unusable id. */
export function learnerNamespace(userId: string): string {
  if (typeof userId !== "string") return "";
  const raw = userId.trim();
  if (!raw) return "";
  const safe = raw.replace(/[^a-zA-Z0-9_:-]/g, "_");
  const plain = NAMESPACE_PREFIX + safe;
  if (safe === raw && plain.length <= NAMESPACE_MAX_CHARS) return plain;
  // The id had to be altered or shortened: add a hash of the original so two
  // different users can never end up sharing a namespace.
  const digest = createHash("sha256").update(raw).digest("hex").slice(0, 16);
  const room = NAMESPACE_MAX_CHARS - NAMESPACE_PREFIX.length - digest.length - 1;
  return `${NAMESPACE_PREFIX}${safe.slice(0, room)}-${digest}`;
}

/** One natural-language sentence group describing the event, for the memory engine. */
export function describeLearningEvent(event: LearningEvent): string {
  const day = (parseDate(event.timestamp) ?? new Date()).toISOString().slice(0, 10);
  const course = text(event.courseName) || "an unnamed course";
  const concept = text(event.conceptLabel);
  const about = concept ? `'${concept}' (course ${course})` : `the course ${course}`;
  const score = unit(event.score);
  const retention = unit(event.retention);
  const confidence = unit(event.confidence);
  const parts: string[] = [];

  switch (event.type) {
    case "course-ingested":
      parts.push(
        `On ${day} the learner uploaded their notes for the course ${course} and started studying it` +
          (concept ? `, beginning with '${concept}'.` : "."),
      );
      break;
    case "self-review":
      if (event.rating === "got-it") {
        parts.push(`On ${day} the learner reviewed ${about} and rated it "got it": they recalled it well.`);
      } else if (event.rating === "still-shaky") {
        parts.push(
          `On ${day} the learner reviewed ${about} and rated it "still shaky": they are still struggling with it.`,
        );
      } else {
        parts.push(`On ${day} the learner reviewed ${about}.`);
      }
      break;
    case "generated-quiz":
      parts.push(
        `On ${day} the learner took a generated practice quiz on ${about}` +
          (score === null ? "." : ` and scored ${percent(score)}.`),
      );
      break;
    case "uploaded-quiz":
      parts.push(
        `On ${day} the learner uploaded a graded quiz from their class covering ${about}` +
          (score === null ? "." : ` and had scored ${percent(score)} on the questions about it.`),
      );
      break;
    case "explanation-viewed":
      parts.push(
        `On ${day} the learner opened the tutoring explanation for ${about}, so they wanted help understanding it.`,
      );
      break;
    default:
      parts.push(`On ${day} the learner had a study event (${text(event.type) || "unknown"}) on ${about}.`);
  }

  const isQuiz = event.type === "generated-quiz" || event.type === "uploaded-quiz";
  if (isQuiz && score !== null) {
    if (score < 0.5) parts.push("This is a weak area for the learner.");
    else if (score >= 0.8) parts.push("This is a strong area for the learner.");
  }

  const missed = Array.isArray(event.missedQuestions)
    ? event.missedQuestions.map((q) => clip(text(q), 200)).filter(Boolean)
    : [];
  if (missed.length > 0) {
    const shown = missed.slice(0, 5);
    const more = missed.length - shown.length;
    parts.push(
      `Missed questions: ${shown.map((q) => `"${q}"`).join("; ")}` + (more > 0 ? `; and ${more} more.` : "."),
    );
  }

  const stats: string[] = [];
  if (confidence !== null) stats.push(`confidence in this concept is now ${confidence.toFixed(2)}`);
  if (retention !== null) {
    stats.push(
      `predicted retention ${isQuiz ? "before the quiz" : "at that time"} was ${retention.toFixed(2)}`,
    );
  }
  if (stats.length > 0) {
    const line = stats.join("; ");
    parts.push(line.charAt(0).toUpperCase() + line.slice(1) + ".");
  }

  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function apiKey(): string {
  return (process.env.SUPERMEMORY_API_KEY ?? "").trim();
}

function eventMetadata(event: LearningEvent): Record<string, string | number | boolean> {
  const meta: Record<string, string | number | boolean> = { source: "synapse" };
  const set = (key: string, value: string | number | null) => {
    if (value !== null && value !== "") meta[key] = value;
  };
  set("type", text(event.type));
  set("courseName", clip(text(event.courseName), 200));
  set("conceptLabel", clip(text(event.conceptLabel), 200));
  set("rating", text(event.rating));
  set("score", unit(event.score));
  set("confidence", unit(event.confidence));
  set("retention", unit(event.retention));
  if (Array.isArray(event.missedQuestions)) meta.missedCount = event.missedQuestions.length;
  const when = parseDate(event.timestamp);
  if (when) meta.eventDate = when.toISOString().slice(0, 10);
  return meta;
}

function eventDocumentId(namespace: string, event: LearningEvent): string {
  const fingerprint = JSON.stringify([
    namespace,
    event.type,
    event.courseName,
    event.conceptLabel ?? null,
    event.rating ?? null,
    event.score ?? null,
    event.timestamp,
  ]);
  return "ev-" + createHash("sha256").update(fingerprint).digest("hex").slice(0, 40);
}

function searchQuery(focus?: Focus): string {
  const concept = text(focus?.conceptLabel);
  const course = text(focus?.courseName);
  if (concept && course) return `How the learner is doing on ${concept} in ${course}`;
  if (concept) return `How the learner is doing on ${concept}`;
  if (course) return `How the learner is doing in the course ${course}`;
  return "The learner's strengths, weaknesses and quiz scores";
}

/** POST JSON and return the parsed body, or null on any failure. Never rejects. */
async function post(
  key: string,
  path: string,
  body: unknown,
  signal: AbortSignal,
  what: string,
): Promise<unknown> {
  try {
    const res = await fetch(BASE_URL + path, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      // Status only: never the key, the user id or the content.
      warn(`${what} failed: HTTP ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    warn(`${what} failed: ${signal.aborted ? "timed out" : errorName(err)}`);
    return null;
  }
}

function startDeadline(ms: number): { signal: AbortSignal; expired: Promise<void>; stop: () => void } {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve();
    }, ms);
  });
  return {
    signal: controller.signal,
    expired,
    stop: () => {
      if (timer !== undefined) clearTimeout(timer);
      // Cancels anything still in flight so nothing keeps the Lambda busy.
      controller.abort();
    },
  };
}

function formatProfile(profile: unknown, search: unknown, focus?: Focus): string {
  const seen = new Set<string>();
  const take = (items: string[], max: number): string[] => {
    const out: string[] = [];
    for (const item of items) {
      const line = clip(item.replace(/\s+/g, " ").trim(), LINE_MAX_CHARS);
      const k = line.toLowerCase();
      if (!line || seen.has(k)) continue;
      seen.add(k);
      out.push(line);
      if (out.length >= max) break;
    }
    return out;
  };

  const p = isRecord(profile) && isRecord(profile.profile) ? profile.profile : {};
  const relevant = take(searchTexts(search), 5);
  const longTerm = take(memoryTexts(p.static), 8);
  const recent = take(memoryTexts(p.dynamic), 8);
  if (relevant.length + longTerm.length + recent.length === 0) return "";

  const concept = text(focus?.conceptLabel);
  const course = text(focus?.courseName);
  const topic = concept ? (course ? `"${concept}" (${course})` : `"${concept}"`) : course ? `the course ${course}` : "";

  const sections: [string, string[]][] = [
    [topic ? `Most relevant to ${topic}:` : "From the learner's study history:", relevant],
    ["What is known about this learner:", longTerm],
    ["Recent activity:", recent],
  ];

  const lines: string[] = [];
  let used = 0;
  for (const [title, items] of sections) {
    let titled = false;
    for (const item of items) {
      const cost = (titled ? 0 : title.length + 1) + item.length + 3;
      if (used + cost > PROFILE_MAX_CHARS) break;
      if (!titled) {
        lines.push(title);
        titled = true;
      }
      lines.push(`- ${item}`);
      used += cost;
    }
  }
  return lines.join("\n").slice(0, PROFILE_MAX_CHARS);
}

function memoryTexts(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const entry of list) {
    if (typeof entry === "string") out.push(entry);
    else if (isRecord(entry) && typeof entry.memory === "string") out.push(entry.memory);
  }
  return out;
}

function searchTexts(search: unknown): string[] {
  if (!isRecord(search) || !Array.isArray(search.results)) return [];
  const out: string[] = [];
  for (const r of search.results) {
    if (!isRecord(r)) continue;
    if (typeof r.memory === "string") out.push(r.memory);
    else if (typeof r.chunk === "string") out.push(r.chunk);
  }
  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function text(v: unknown): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 3).trimEnd() + "...";
}

/** A finite number clamped to 0-1, or null. */
function unit(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return Math.min(1, Math.max(0, v));
}

function percent(v: number): string {
  return `${Math.round(v * 100)}%`;
}

function parseDate(v: unknown): Date | null {
  if (typeof v !== "string" || !v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : "error";
}

function warn(message: string): void {
  try {
    console.warn(`[supermemory] ${message}`);
  } catch {
    // ignore
  }
}
