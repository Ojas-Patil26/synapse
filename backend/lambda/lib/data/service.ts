// The only data API handlers use (CONTRACTS.md section 4).
// MongoDB holds the graph and caches; Tiger Data holds the review-event history.
// Every query filters by userId; userId never appears in a returned API-shaped object.

import { randomBytes } from "node:crypto";
import { FORGET_THRESHOLD, S0 } from "../contracts";
import type {
  AlertItem,
  ConceptBrief,
  ConceptContext,
  ConceptNode,
  ConfidenceSource,
  Course,
  CourseStatus,
  CrossCourseLink,
  DecayStatus,
  Edge,
  ExtractedConcept,
  ExtractedDependency,
  GraphResponse,
  GuideEntry,
  QuizMode,
  Rating,
  Resource,
  StoredQuiz,
} from "../contracts";
import {
  nextStability,
  predictedForgetAt,
  retentionAfterQuiz,
  retentionAfterSelfReview,
  retentionAt,
  urgency,
} from "./decay";
import { collections, deleteUserData } from "./mongo";
import type { Collections, ConceptDoc, CourseDoc, EdgeDoc, LinkDoc } from "./mongo";
import { safeError } from "./redact";
import * as tiger from "./tiger";

const SOURCE_TEXT_MAX = 60_000;
const EXCERPT_MAX = 6_000;
const EXCERPT_LEAD = 1_000;

/** Thrown for an unknown course or concept. Handlers can test `err.name === "NotFoundError"`. */
export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

// ---------- helpers ----------

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

function newId(prefix: "crs_" | "cpt_"): string {
  let out = "";
  for (const byte of randomBytes(10)) out += ID_ALPHABET[byte % ID_ALPHABET.length];
  return prefix + out;
}

const round4 = (value: number): number => Math.round(value * 1e4) / 1e4;
const clamp01 = (value: number): number => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);
const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

const NO_ID = { projection: { _id: 0 } } as const;
const COURSE_PUBLIC = { projection: { _id: 0, sourceText: 0 } } as const;

function toCourse(doc: CourseDoc): Course {
  return {
    id: doc.id,
    name: doc.name,
    conceptCount: doc.conceptCount ?? 0,
    industrySkills: doc.industrySkills ?? [],
    skillsSummary: doc.skillsSummary ?? "",
    status: doc.status,
    error: doc.error ?? null,
    createdAt: doc.createdAt,
    semester: doc.semester ?? null,
  };
}

/** Retention is always recomputed here; the cached value in Mongo is never served. */
function toNode(doc: ConceptDoc, now: Date): ConceptNode {
  return {
    id: doc.id,
    label: doc.label,
    courseId: doc.courseId,
    lastReviewed: doc.lastReviewed,
    stability: round4(doc.stability),
    retention: round4(retentionAt(doc.lastReviewed, doc.stability, now, doc.retentionStart ?? 1)),
    confidence: doc.confidence ?? null,
    confidenceSource: doc.confidenceSource ?? null,
    connectionCount: doc.connectionCount ?? 0,
  };
}

function toEdge(doc: EdgeDoc): Edge {
  return { source: doc.source, target: doc.target, relationType: doc.relationType, isCrossCourse: false };
}

function toLink(doc: LinkDoc): CrossCourseLink {
  return {
    sourceCourseId: doc.sourceCourseId,
    targetCourseId: doc.targetCourseId,
    sharedConceptIds: doc.sharedConceptIds,
    description: doc.description,
  };
}

function toGuideEntry(doc: ConceptDoc, courseName: string, now: Date): GuideEntry {
  const retention = retentionAt(doc.lastReviewed, doc.stability, now, doc.retentionStart ?? 1);
  const zScore = doc.zScore ?? null;
  return {
    conceptId: doc.id,
    label: doc.label,
    courseId: doc.courseId,
    courseName,
    retention: round4(retention),
    stability: round4(doc.stability),
    lastReviewed: doc.lastReviewed,
    confidence: doc.confidence ?? null,
    confidenceSource: doc.confidenceSource ?? null,
    predictedForgetAt: predictedForgetAt(doc.lastReviewed, doc.stability, doc.retentionStart ?? 1),
    zScore: zScore === null ? null : round4(zScore),
    anomalous: doc.anomalous === true,
    urgency: round4(urgency(retention, doc.confidence ?? null, zScore)),
    summary: doc.summary ?? "",
    explanation: doc.explanation ?? null,
    resources: doc.resources ?? [],
    generatedAt: doc.generatedAt ?? null,
  };
}

/** One cross-course edge per (source-course concept, target-course concept) pair of each link. */
function materializeCrossEdges(links: CrossCourseLink[], courseOf: Map<string, string>): Edge[] {
  const seen = new Set<string>();
  const edges: Edge[] = [];
  for (const link of links) {
    const sources = link.sharedConceptIds.filter((id) => courseOf.get(id) === link.sourceCourseId);
    const targets = link.sharedConceptIds.filter((id) => courseOf.get(id) === link.targetCourseId);
    for (const source of sources) {
      for (const target of targets) {
        const key = pairKey(source, target);
        if (source === target || seen.has(key)) continue;
        seen.add(key);
        edges.push({ source, target, relationType: "cross-course", isCrossCourse: true });
      }
    }
  }
  return edges;
}

/** connectionCount = edges touching the node across the user's whole graph, cross-course included. */
async function recomputeConnectionCounts(c: Collections, userId: string): Promise<Map<string, number>> {
  const [concepts, edges, links] = await Promise.all([
    c.concepts.find({ userId }, { projection: { _id: 0, id: 1, courseId: 1, connectionCount: 1 } }).toArray(),
    c.edges.find({ userId }, { projection: { _id: 0, source: 1, target: 1 } }).toArray(),
    c.links.find({ userId }, NO_ID).toArray(),
  ]);
  const courseOf = new Map(concepts.map((doc) => [doc.id, doc.courseId]));
  const counts = new Map<string, number>(concepts.map((doc) => [doc.id, 0]));
  const bump = (id: string): void => {
    if (counts.has(id)) counts.set(id, (counts.get(id) ?? 0) + 1);
  };
  for (const edge of edges) {
    bump(edge.source);
    bump(edge.target);
  }
  for (const edge of materializeCrossEdges(links.map(toLink), courseOf)) {
    bump(edge.source);
    bump(edge.target);
  }
  const ops = concepts
    .filter((doc) => doc.connectionCount !== counts.get(doc.id))
    .map((doc) => ({
      updateOne: { filter: { userId, id: doc.id }, update: { $set: { connectionCount: counts.get(doc.id) ?? 0 } } },
    }));
  if (ops.length > 0) await c.concepts.bulkWrite(ops, { ordered: false });
  return counts;
}

async function loadConcept(c: Collections, userId: string, conceptId: string): Promise<ConceptDoc> {
  const doc = await c.concepts.findOne({ userId, id: conceptId }, NO_ID);
  if (!doc) throw new NotFoundError(`Concept ${conceptId} not found`);
  return doc as ConceptDoc;
}

function excerptFor(sourceText: string, label: string): string {
  if (!sourceText) return "";
  if (sourceText.length <= EXCERPT_MAX) return sourceText;
  const haystack = sourceText.toLowerCase();
  const needles = [label, label.replace(/\s*\(.*?\)\s*/g, " ").trim()].map((s) => s.toLowerCase()).filter(Boolean);
  let at = -1;
  for (const needle of needles) {
    at = haystack.indexOf(needle);
    if (at >= 0) break;
  }
  if (at < 0) return sourceText.slice(0, EXCERPT_MAX);
  const start = Math.max(0, Math.min(at - EXCERPT_LEAD, sourceText.length - EXCERPT_MAX));
  return sourceText.slice(start, start + EXCERPT_MAX);
}

// ---------- courses ----------

export async function createCourse(userId: string, name: string, semester?: string | null): Promise<Course> {
  const c = await collections();
  const doc: CourseDoc = {
    userId,
    id: newId("crs_"),
    name,
    conceptCount: 0,
    industrySkills: [],
    skillsSummary: "",
    status: "processing",
    error: null,
    createdAt: new Date().toISOString(),
    semester: semester && semester.trim() ? semester.trim() : null,
  };
  await c.courses.insertOne({ ...doc });
  return toCourse(doc);
}

export async function getCourse(userId: string, courseId: string): Promise<Course | null> {
  const c = await collections();
  const doc = await c.courses.findOne({ userId, id: courseId }, COURSE_PUBLIC);
  return doc ? toCourse(doc as CourseDoc) : null;
}

export async function setCourseStatus(
  userId: string,
  courseId: string,
  status: CourseStatus,
  error?: string,
): Promise<void> {
  const c = await collections();
  await c.courses.updateOne(
    { userId, id: courseId },
    { $set: { status, error: status === "failed" ? (error ?? "Processing failed") : null } },
  );
}

/** Assigns ids, writes "ingested" Tiger rows, computes connectionCount and conceptCount. */
export async function saveExtractedGraph(
  userId: string,
  courseId: string,
  input: { concepts: ExtractedConcept[]; dependencies: ExtractedDependency[]; sourceText: string },
): Promise<{ nodes: ConceptNode[]; edges: Edge[] }> {
  const c = await collections();
  const course = await c.courses.findOne({ userId, id: courseId }, { projection: { _id: 0, id: 1 } });
  if (!course) throw new NotFoundError(`Course ${courseId} not found`);

  const now = new Date();
  const nowIso = now.toISOString();

  // key -> new id (first occurrence of a key wins; blank keys/labels are skipped)
  const idByKey = new Map<string, string>();
  const kept: ExtractedConcept[] = [];
  for (const concept of input.concepts ?? []) {
    const key = (concept.key ?? "").trim();
    const label = (concept.label ?? "").trim();
    if (!key || !label || idByKey.has(key)) continue;
    idByKey.set(key, newId("cpt_"));
    kept.push({ ...concept, key, label });
  }

  // parentKey -> subconcept edge (source = child, target = parent). Unknown parents,
  // self-parents and parent cycles are ignored.
  const parentOf = new Map<string, string>();
  for (const concept of kept) {
    const parentKey = (concept.parentKey ?? "").trim();
    if (!parentKey || parentKey === concept.key || !idByKey.has(parentKey)) continue;
    let cursor: string | undefined = parentKey;
    let cyclic = false;
    for (let hops = 0; cursor && hops <= kept.length; hops++) {
      if (cursor === concept.key) {
        cyclic = true;
        break;
      }
      cursor = parentOf.get(cursor);
    }
    if (!cyclic) parentOf.set(concept.key, parentKey);
  }

  const edgeDocs: EdgeDoc[] = [];
  const seenPairs = new Set<string>();
  for (const [childKey, parentKey] of parentOf) {
    const source = idByKey.get(childKey) as string;
    const target = idByKey.get(parentKey) as string;
    seenPairs.add(pairKey(source, target));
    edgeDocs.push({ userId, courseId, source, target, relationType: "subconcept", isCrossCourse: false });
  }
  for (const dep of input.dependencies ?? []) {
    const source = idByKey.get((dep.from ?? "").trim());
    const target = idByKey.get((dep.to ?? "").trim());
    if (!source || !target || source === target) continue;
    const key = pairKey(source, target);
    if (seenPairs.has(key)) continue;
    seenPairs.add(key);
    edgeDocs.push({
      userId,
      courseId,
      source,
      target,
      relationType: dep.type === "prerequisite" ? "prerequisite" : "related",
      isCrossCourse: false,
    });
  }

  const conceptDocs: ConceptDoc[] = kept.map((concept) => ({
    userId,
    id: idByKey.get(concept.key) as string,
    courseId,
    label: concept.label,
    summary: (concept.summary ?? "").trim(),
    lastReviewed: nowIso,
    stability: S0,
    retention: 1,
    confidence: null,
    confidenceSource: null,
    connectionCount: 0,
    lastGenerated: null,
    lastUploaded: null,
    zScore: null,
    anomalous: false,
    scannedAt: null,
    explanation: null,
    resources: [],
    generatedAt: null,
    createdAt: nowIso,
  }));

  // A retried ingest replaces the course's previous graph instead of duplicating it.
  const previous = await c.concepts.countDocuments({ userId, courseId });
  if (previous > 0) {
    await Promise.all([
      c.concepts.deleteMany({ userId, courseId }),
      c.edges.deleteMany({ userId, courseId }),
      c.links.deleteMany({ userId, $or: [{ sourceCourseId: courseId }, { targetCourseId: courseId }] }),
      tiger.deleteCourseEvents(userId, courseId),
    ]);
  }

  // Tiger first: it is the source of truth, and a failure here leaves Mongo untouched.
  await tiger.insertEvents(
    conceptDocs.map((doc) => ({
      ts: now,
      userId,
      courseId,
      conceptId: doc.id,
      eventType: "ingested" as const,
      result: null,
      predictedRetention: null,
      stabilityBefore: null,
      stabilityAfter: S0,
    })),
  );
  if (conceptDocs.length > 0) await c.concepts.insertMany(conceptDocs.map((doc) => ({ ...doc })));
  if (edgeDocs.length > 0) await c.edges.insertMany(edgeDocs.map((doc) => ({ ...doc })));
  await c.courses.updateOne(
    { userId, id: courseId },
    { $set: { conceptCount: conceptDocs.length, sourceText: (input.sourceText ?? "").slice(0, SOURCE_TEXT_MAX) } },
  );

  const counts = await recomputeConnectionCounts(c, userId);
  return {
    nodes: conceptDocs.map((doc) => toNode({ ...doc, connectionCount: counts.get(doc.id) ?? 0 }, now)),
    edges: edgeDocs.map(toEdge),
  };
}

export async function saveCourseSkills(
  userId: string,
  courseId: string,
  industrySkills: string[],
  skillsSummary: string,
): Promise<void> {
  const c = await collections();
  await c.courses.updateOne({ userId, id: courseId }, { $set: { industrySkills, skillsSummary } });
}

export async function listReadyCourses(userId: string): Promise<Course[]> {
  const c = await collections();
  const docs = await c.courses.find({ userId, status: "ready" }, COURSE_PUBLIC).sort({ createdAt: 1, id: 1 }).toArray();
  return docs.map((doc) => toCourse(doc as CourseDoc));
}

// ---------- concepts ----------

export async function listConceptBriefs(userId: string, courseId: string): Promise<ConceptBrief[]> {
  const c = await collections();
  const docs = await c.concepts
    .find({ userId, courseId }, { projection: { _id: 0, id: 1, label: 1, summary: 1 } })
    .sort({ _id: 1 })
    .toArray();
  return docs.map((doc) => ({ id: doc.id, label: doc.label, summary: doc.summary ?? "" }));
}

export async function getConceptContext(userId: string, conceptId: string): Promise<ConceptContext | null> {
  const c = await collections();
  const doc = await c.concepts.findOne({ userId, id: conceptId }, NO_ID);
  if (!doc) return null;
  const course = await c.courses.findOne(
    { userId, id: doc.courseId },
    { projection: { _id: 0, name: 1, sourceText: 1 } },
  );
  if (!course) return null;
  return {
    node: toNode(doc as ConceptDoc, new Date()),
    courseName: course.name,
    summary: doc.summary ?? "",
    explanation: doc.explanation ?? null,
    resources: doc.resources ?? [],
    generatedAt: doc.generatedAt ?? null,
    sourceExcerpt: excerptFor(course.sourceText ?? "", doc.label),
  };
}

// ---------- cross-course links ----------

export async function replaceCrossCourseLinks(
  userId: string,
  courseIdA: string,
  courseIdB: string,
  links: CrossCourseLink[],
): Promise<{ links: CrossCourseLink[]; edges: Edge[] }> {
  if (courseIdA === courseIdB) return { links: [], edges: [] };
  const c = await collections();
  const concepts = await c.concepts
    .find({ userId, courseId: { $in: [courseIdA, courseIdB] } }, { projection: { _id: 0, id: 1, courseId: 1 } })
    .toArray();
  const courseOf = new Map(concepts.map((doc) => [doc.id, doc.courseId]));

  const nowIso = new Date().toISOString();
  const docs: LinkDoc[] = [];
  for (const link of links ?? []) {
    // Keep the caller's orientation when it names this pair; otherwise use (A, B).
    const reversed = link.sourceCourseId === courseIdB && link.targetCourseId === courseIdA;
    const sourceCourseId = reversed ? courseIdB : courseIdA;
    const targetCourseId = reversed ? courseIdA : courseIdB;
    const shared = [...new Set(link.sharedConceptIds ?? [])].filter((id) => courseOf.has(id));
    const hasSource = shared.some((id) => courseOf.get(id) === sourceCourseId);
    const hasTarget = shared.some((id) => courseOf.get(id) === targetCourseId);
    if (!hasSource || !hasTarget) continue;
    docs.push({
      userId,
      sourceCourseId,
      targetCourseId,
      sharedConceptIds: shared,
      description: (link.description ?? "").trim(),
      createdAt: nowIso,
    });
  }

  await c.links.deleteMany({
    userId,
    $or: [
      { sourceCourseId: courseIdA, targetCourseId: courseIdB },
      { sourceCourseId: courseIdB, targetCourseId: courseIdA },
    ],
  });
  if (docs.length > 0) await c.links.insertMany(docs.map((doc) => ({ ...doc })));
  await recomputeConnectionCounts(c, userId);

  const saved = docs.map(toLink);
  return { links: saved, edges: materializeCrossEdges(saved, courseOf) };
}

// ---------- graph ----------

/** Returns null when courseId is given but that course does not exist or is not ready. */
export async function buildGraph(userId: string, courseId?: string): Promise<GraphResponse | null> {
  const c = await collections();
  const now = new Date();

  if (courseId !== undefined) {
    const course = await c.courses.findOne({ userId, id: courseId }, COURSE_PUBLIC);
    if (!course || course.status !== "ready") return null;
    const [concepts, edges] = await Promise.all([
      c.concepts.find({ userId, courseId }, NO_ID).sort({ _id: 1 }).toArray(),
      c.edges.find({ userId, courseId }, NO_ID).sort({ _id: 1 }).toArray(),
    ]);
    const ids = new Set(concepts.map((doc) => doc.id));
    return {
      courses: [toCourse(course as CourseDoc)],
      nodes: concepts.map((doc) => toNode(doc as ConceptDoc, now)),
      edges: edges.filter((e) => ids.has(e.source) && ids.has(e.target)).map((e) => toEdge(e as EdgeDoc)),
      crossCourseLinks: [],
    };
  }

  const courses = await c.courses.find({ userId, status: "ready" }, COURSE_PUBLIC).sort({ createdAt: 1, id: 1 }).toArray();
  if (courses.length === 0) return { courses: [], nodes: [], edges: [], crossCourseLinks: [] };
  const courseIds = courses.map((doc) => doc.id);
  const ready = new Set(courseIds);
  const [concepts, edges, links] = await Promise.all([
    c.concepts.find({ userId, courseId: { $in: courseIds } }, NO_ID).sort({ _id: 1 }).toArray(),
    c.edges.find({ userId, courseId: { $in: courseIds } }, NO_ID).sort({ _id: 1 }).toArray(),
    c.links.find({ userId }, NO_ID).sort({ _id: 1 }).toArray(),
  ]);
  const courseOf = new Map(concepts.map((doc) => [doc.id, doc.courseId]));
  const readyLinks = links
    .filter((link) => ready.has(link.sourceCourseId) && ready.has(link.targetCourseId))
    .map((link) => toLink(link as LinkDoc));
  return {
    courses: courses.map((doc) => toCourse(doc as CourseDoc)),
    nodes: concepts.map((doc) => toNode(doc as ConceptDoc, now)),
    edges: [
      ...edges.filter((e) => courseOf.has(e.source) && courseOf.has(e.target)).map((e) => toEdge(e as EdgeDoc)),
      ...materializeCrossEdges(readyLinks, courseOf),
    ],
    crossCourseLinks: readyLinks,
  };
}

// ---------- guide ----------

/** Sorted by urgency, descending. */
export async function buildGuide(userId: string): Promise<GuideEntry[]> {
  const c = await collections();
  const courses = await c.courses
    .find({ userId, status: "ready" }, { projection: { _id: 0, id: 1, name: 1 } })
    .toArray();
  if (courses.length === 0) return [];
  const nameOf = new Map(courses.map((doc) => [doc.id, doc.name]));
  const concepts = await c.concepts.find({ userId, courseId: { $in: [...nameOf.keys()] } }, NO_ID).toArray();
  const now = new Date();
  return concepts
    .map((doc) => toGuideEntry(doc as ConceptDoc, nameOf.get(doc.courseId) ?? "", now))
    .sort((a, b) => b.urgency - a.urgency || a.label.localeCompare(b.label));
}

export async function getGuideEntry(userId: string, conceptId: string): Promise<GuideEntry | null> {
  const c = await collections();
  const doc = await c.concepts.findOne({ userId, id: conceptId }, NO_ID);
  if (!doc) return null;
  const course = await c.courses.findOne({ userId, id: doc.courseId }, { projection: { _id: 0, name: 1 } });
  if (!course) return null;
  return toGuideEntry(doc as ConceptDoc, course.name, new Date());
}

export async function saveGuideContent(
  userId: string,
  conceptId: string,
  content: { summary: string; explanation: string; resources: Resource[] },
): Promise<GuideEntry> {
  const c = await collections();
  const result = await c.concepts.updateOne(
    { userId, id: conceptId },
    {
      $set: {
        summary: content.summary,
        explanation: content.explanation,
        resources: content.resources ?? [],
        generatedAt: new Date().toISOString(),
      },
    },
  );
  if (result.matchedCount === 0) throw new NotFoundError(`Concept ${conceptId} not found`);
  const entry = await getGuideEntry(userId, conceptId);
  if (!entry) throw new NotFoundError(`Concept ${conceptId} not found`);
  return entry;
}

// ---------- decay scan ----------

interface ScanOutcome {
  doc: ConceptDoc;
  retention: number;
  zScore: number | null;
  anomalous: boolean;
}

/**
 * Flow G for a set of one user's concepts: latest state from Tiger, R = e^(-t/S),
 * z-scores from one SQL query, then persist retention / zScore / anomalous / scannedAt.
 */
async function scanConcepts(
  c: Collections,
  userId: string,
  docs: ConceptDoc[],
  scope: "user" | "subset",
  now: Date,
): Promise<ScanOutcome[]> {
  if (docs.length === 0) return [];
  const ids = scope === "subset" ? docs.map((doc) => doc.id) : undefined;
  const [zs, latest] = await Promise.all([tiger.zScores(userId, ids), tiger.latestStates(userId, ids)]);
  const scannedAt = now.toISOString();
  const outcomes: ScanOutcome[] = [];
  const ops = [];
  for (const doc of docs) {
    // Tiger is the source of truth. If it holds a newer event than the Mongo cache
    // (a review whose Mongo write was lost), repair the cache from it.
    const state = latest.get(doc.id);
    const repair = state !== undefined && state.lastEventAt.getTime() > new Date(doc.lastReviewed).getTime() + 1000;
    const lastReviewed = repair && state ? state.lastEventAt.toISOString() : doc.lastReviewed;
    const stability = repair && state ? state.stability : doc.stability;
    const start = repair ? 1 : doc.retentionStart ?? 1;
    const retention = retentionAt(lastReviewed, stability, now, start);
    const z = zs.get(doc.id);
    const zScore = z ? z.zScore : null;
    const anomalous = z ? z.anomalous : false;
    outcomes.push({ doc: { ...doc, lastReviewed, stability }, retention, zScore, anomalous });
    ops.push({
      updateOne: {
        // Guarded on lastReviewed so a review landing mid-scan is never overwritten.
        filter: { userId, id: doc.id, lastReviewed: doc.lastReviewed },
        update: {
          $set: { retention, zScore, anomalous, scannedAt, ...(repair ? { lastReviewed, stability, retentionStart: 1 } : {}) },
        },
      },
    });
  }
  await c.concepts.bulkWrite(ops, { ordered: false });
  return outcomes;
}

export async function decayStatus(
  userId: string,
  courseId: string,
  opts?: { recalculate?: boolean },
): Promise<DecayStatus | null> {
  const c = await collections();
  const course = await c.courses.findOne({ userId, id: courseId }, { projection: { _id: 0, id: 1 } });
  if (!course) return null;

  const load = async (): Promise<ConceptDoc[]> =>
    (await c.concepts.find({ userId, courseId }, NO_ID).sort({ _id: 1 }).toArray()) as ConceptDoc[];
  let docs = await load();
  if (opts?.recalculate) {
    await scanConcepts(c, userId, docs, "subset", new Date());
    docs = await load();
  }

  let counts = new Map<string, number>();
  try {
    counts = await tiger.reviewCounts(userId, courseId);
  } catch (err) {
    console.warn(`decayStatus: review counts unavailable (${safeError(err)})`);
  }

  const now = new Date();
  const concepts = docs.map((doc) => ({
    conceptId: doc.id,
    label: doc.label,
    retention: round4(retentionAt(doc.lastReviewed, doc.stability, now, doc.retentionStart ?? 1)),
    stability: round4(doc.stability),
    lastReviewed: doc.lastReviewed,
    predictedForgetAt: predictedForgetAt(doc.lastReviewed, doc.stability, doc.retentionStart ?? 1),
    zScore: doc.zScore === null || doc.zScore === undefined ? null : round4(doc.zScore),
    anomalous: doc.anomalous === true,
    reviewCount: counts.get(doc.id) ?? 0,
  }));
  const scannedTimes = docs.map((doc) => doc.scannedAt).filter((value): value is string => Boolean(value));
  const total = concepts.reduce((sum, item) => sum + item.retention, 0);
  return {
    courseId,
    scannedAt: scannedTimes.length > 0 ? scannedTimes.sort()[scannedTimes.length - 1] : null,
    threshold: FORGET_THRESHOLD,
    summary: {
      averageRetention: concepts.length > 0 ? round4(total / concepts.length) : 0,
      atRiskCount: concepts.filter((item) => item.retention < FORGET_THRESHOLD).length,
      anomalousCount: concepts.filter((item) => item.anomalous).length,
    },
    concepts,
  };
}

export async function runDecayScan(): Promise<{
  conceptsScanned: number;
  newlyAnomalous: AlertItem[];
  newlyAtRisk: AlertItem[];
}> {
  const c = await collections();
  const userIds = (await c.concepts.distinct("userId")) as string[];
  let conceptsScanned = 0;
  const newlyAnomalous: AlertItem[] = [];
  const newlyAtRisk: AlertItem[] = [];

  for (const userId of userIds) {
    try {
      const [docs, courses] = await Promise.all([
        c.concepts.find({ userId }, NO_ID).toArray(),
        c.courses.find({ userId }, { projection: { _id: 0, id: 1, name: 1, status: 1 } }).toArray(),
      ]);
      const courseOf = new Map(courses.map((doc) => [doc.id, doc]));
      const outcomes = await scanConcepts(c, userId, docs as ConceptDoc[], "user", new Date());
      conceptsScanned += outcomes.length;
      for (const outcome of outcomes) {
        const course = courseOf.get(outcome.doc.courseId);
        if (!course || course.status !== "ready") continue; // alerts only for visible concepts
        const original = docs.find((doc) => doc.id === outcome.doc.id);
        const item: AlertItem = {
          userId,
          conceptId: outcome.doc.id,
          label: outcome.doc.label,
          courseName: course.name,
          retention: round4(outcome.retention),
          zScore: outcome.zScore === null ? null : round4(outcome.zScore),
        };
        if (outcome.anomalous && original?.anomalous !== true) newlyAnomalous.push(item);
        const cached = typeof original?.retention === "number" ? original.retention : 1;
        if (outcome.retention < FORGET_THRESHOLD && cached >= FORGET_THRESHOLD) newlyAtRisk.push(item);
      }
    } catch (err) {
      // One user's failure must not stop the scan for everyone else.
      console.error(`decay scan failed for one user: ${safeError(err)}`);
    }
  }
  return { conceptsScanned, newlyAnomalous, newlyAtRisk };
}

// ---------- review events (flow B) ----------

export async function applySelfReview(userId: string, conceptId: string, rating: Rating): Promise<ConceptNode> {
  const c = await collections();
  const doc = await loadConcept(c, userId, conceptId);
  const now = new Date();
  const nowIso = now.toISOString();
  const result = rating === "got-it" ? 1 : 0;
  const retentionBefore = retentionAt(doc.lastReviewed, doc.stability, now, doc.retentionStart ?? 1);
  const stabilityAfter = nextStability(doc.stability, retentionBefore, "self-review", result);
  const retentionStart = retentionAfterSelfReview(rating, retentionBefore);

  await tiger.insertEvent({
    ts: now,
    userId,
    courseId: doc.courseId,
    conceptId,
    eventType: "self-review",
    result,
    predictedRetention: retentionBefore,
    stabilityBefore: doc.stability,
    stabilityAfter,
  });
  await c.concepts.updateOne(
    { userId, id: conceptId },
    { $set: { lastReviewed: nowIso, stability: stabilityAfter, retentionStart, retention: retentionStart } },
  );
  return toNode({ ...doc, lastReviewed: nowIso, stability: stabilityAfter, retentionStart }, now);
}

export async function applyAssessment(
  userId: string,
  conceptId: string,
  a: { source: "generated-quiz" | "uploaded-quiz"; mode?: QuizMode; score: number },
): Promise<ConceptNode> {
  const c = await collections();
  const doc = await loadConcept(c, userId, conceptId);
  const now = new Date();
  const nowIso = now.toISOString();
  const score = clamp01(a.score);
  const retentionBefore = retentionAt(doc.lastReviewed, doc.stability, now, doc.retentionStart ?? 1);
  // p is this quiz's own score, never the combined confidence.
  const stabilityAfter = nextStability(doc.stability, retentionBefore, a.source, score);
  // A weak quiz leaves retention low so the concept shows as needing another look.
  const retentionStart = retentionAfterQuiz(score);

  // Confidence rule table (CONTRACTS.md section 2).
  let lastGenerated = doc.lastGenerated ?? null;
  let lastUploaded = doc.lastUploaded ?? null;
  let confidence: number;
  let confidenceSource: ConfidenceSource;
  if (a.source === "generated-quiz") {
    const mode: QuizMode = a.mode === "short" ? "short" : "full";
    lastGenerated = { mode, score, at: nowIso };
    if (mode === "full") {
      confidence = score;
      confidenceSource = "generated-quiz";
      lastUploaded = null;
    } else if (lastUploaded) {
      confidence = (score + lastUploaded.score) / 2;
      confidenceSource = "uploaded-quiz";
    } else {
      confidence = score;
      confidenceSource = "generated-quiz";
    }
  } else {
    confidence = lastGenerated?.mode === "short" ? (score + lastGenerated.score) / 2 : score;
    confidenceSource = "uploaded-quiz";
    lastUploaded = { score, at: nowIso };
  }

  await tiger.insertEvent({
    ts: now,
    userId,
    courseId: doc.courseId,
    conceptId,
    eventType: a.source,
    result: score,
    predictedRetention: retentionBefore,
    stabilityBefore: doc.stability,
    stabilityAfter,
  });

  // Refresh this concept's cached z-score now that the new residual is recorded.
  let zScore = doc.zScore ?? null;
  let anomalous = doc.anomalous === true;
  try {
    const z = (await tiger.zScores(userId, [conceptId])).get(conceptId);
    zScore = z ? z.zScore : null;
    anomalous = z ? z.anomalous : false;
  } catch (err) {
    console.warn(`applyAssessment: z-score refresh failed (${safeError(err)})`);
  }

  await c.concepts.updateOne(
    { userId, id: conceptId },
    {
      $set: {
        lastReviewed: nowIso,
        stability: stabilityAfter,
        retentionStart,
        retention: retentionStart,
        confidence,
        confidenceSource,
        lastGenerated,
        lastUploaded,
        zScore,
        anomalous,
      },
    },
  );
  return toNode(
    { ...doc, lastReviewed: nowIso, stability: stabilityAfter, retentionStart, confidence, confidenceSource },
    now,
  );
}

// ---------- quizzes ----------

export async function saveQuiz(userId: string, quiz: StoredQuiz): Promise<void> {
  const c = await collections();
  await c.quizzes.replaceOne({ userId, quizId: quiz.quizId }, { ...quiz, userId }, { upsert: true });
}

export async function getQuiz(userId: string, quizId: string): Promise<StoredQuiz | null> {
  const c = await collections();
  const doc = await c.quizzes.findOne({ userId, quizId }, NO_ID);
  if (!doc) return null;
  return {
    quizId: doc.quizId,
    conceptId: doc.conceptId,
    mode: doc.mode,
    createdAt: doc.createdAt,
    submittedAt: doc.submittedAt ?? null,
    questions: doc.questions,
  };
}

export async function markQuizSubmitted(userId: string, quizId: string): Promise<void> {
  const c = await collections();
  await c.quizzes.updateOne(
    { userId, quizId, submittedAt: null },
    { $set: { submittedAt: new Date().toISOString() } },
  );
}

/** Removes everything the database stores about one user: MongoDB documents and Tiger Data history. */
export async function deleteAllUserData(userId: string): Promise<{ documents: number; reviewEvents: number }> {
  const docs = await deleteUserData(userId);
  const reviewEvents = await tiger.deleteUserEvents(userId);
  const { db } = await collections();
  await db.collection("usage").deleteMany({ userId }).catch(() => undefined);
  return { documents: Object.values(docs).reduce((a, b) => a + b, 0), reviewEvents };
}
