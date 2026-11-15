// In-memory implementation of `Api`, built from /fixtures. Mutations really change
// state and follow the learning model in CONTRACTS.md section 2, so the whole
// product can be demonstrated with no backend.
//
// Start state: ?fixture=empty|one|merged (remembered in sessionStorage, default merged).
//   empty  -> 1st upload adds the graph.json course, 2nd adds graph2.json + cross-course links
//   one    -> starts with the graph.json course; the next upload adds graph2.json + links
//   merged -> both courses and their links
// A file whose name contains "fail" makes the course fail (to demo the failed copy).
// A quiz file whose name contains "canvas" or "gradescope" parses; anything else
// returns parseFailed: true.
import graphA from "../../fixtures/graph.json";
import graphB from "../../fixtures/graph2.json";
import graphMerged from "../../fixtures/graph-merged.json";
import type {
  ConceptNode,
  ConfidenceSource,
  Course,
  CrossCourseLink,
  DecayStatus,
  Difficulty,
  Edge,
  GraphResponse,
  GuideEntry,
  QuizMode,
  QuizUploadResponse,
  Resource,
  StoredQuiz,
  StoredQuizQuestion,
} from "../contracts";
import { ALLOWED_UPLOAD_TYPES, FORGET_THRESHOLD, FULL_QUIZ_MIX, S0 } from "../contracts";
import {
  predictedForgetAt,
  retentionAt,
  retentionAfterQuiz,
  retentionAfterSelfReview,
  stabilityAfterQuiz,
  stabilityAfterSelfReview,
  urgency,
  zScoreFor,
} from "../lib/learning";
import { confidenceText, pct } from "../lib/format";
import { CONTENT, EXTRA_COURSE, contentFor, firstSentence, type ConceptContent } from "./fixtureContent";
import { ApiRequestError, type Api } from "./types";

type FixtureStart = "empty" | "one" | "merged";

interface ConceptRec {
  id: string;
  label: string;
  courseId: string;
  lastReviewed: string;
  stability: number;
  /** Retention right after the last review (R0). */
  retentionStart: number;
  confidence: number | null;
  confidenceSource: ConfidenceSource | null;
  lastGenerated: { mode: QuizMode; score: number; at: string } | null;
  lastUploaded: { score: number; at: string } | null;
  /** Quiz residuals (result - predicted retention), oldest first. */
  residuals: number[];
  reviewCount: number;
  generatedAt: string | null;
  generatedSummary: string | null;
}

interface PendingCourse {
  courseId: string;
  readyAt: number;
  template: "a" | "b" | "extra" | "fail";
}

interface Db {
  courses: Course[];
  concepts: ConceptRec[];
  edges: Edge[];
  links: CrossCourseLink[];
  quizzes: Record<string, StoredQuiz>;
  pending: PendingCourse[];
  extraContent: Record<string, ConceptContent>;
  seq: number;
}

// The frozen fixture files predate Course.semester, so default it to null on load.
const withSemester = (g: unknown): GraphResponse => {
  const graph = g as GraphResponse;
  return { ...graph, courses: graph.courses.map((c) => ({ ...c, semester: c.semester ?? null })) };
};
const A = withSemester(graphA);
const B = withSemester(graphB);
const MERGED = withSemester(graphMerged);
// Demo semesters for the two built-in fixture courses, so the Home semester filter has something to show.
const SEED_SEMESTER: Record<string, string> = { cse471: "Fall 2026", cse475: "Spring 2027" };

// The fixtures' retention values were computed as of this instant. Timestamps are
// shifted so the same values hold when the session starts, then decay in real time.
const FIXTURE_NOW = Date.parse("2026-11-15T06:00:00Z");
const START_KEY = "synapse.fixture";
const DB_KEY = "synapse.fixture.db";
const PROCESSING_MS = 5200;

// Seeded quiz history so the anomaly badge and urgency order have something to show.
const SEED_RESIDUALS: Record<string, number[]> = {
  "cse471-alpha-beta": [-0.42, -0.55],
  "cse475-regularization": [-0.3, -0.41],
};

const delay = (min = 300, max = 800) => new Promise<void>((r) => setTimeout(r, min + Math.random() * (max - min)));
const nowIso = () => new Date().toISOString();
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function shuffle<T>(items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function shiftIso(iso: string, offset: number): string {
  return new Date(Date.parse(iso) + offset).toISOString();
}

function recFromNode(n: ConceptNode, offset: number): ConceptRec {
  const residuals =
    SEED_RESIDUALS[n.id] ?? (n.confidence === null ? [] : [Math.max(-0.3, Math.min(0.3, +(n.confidence - 0.65).toFixed(2)))]);
  return {
    id: n.id,
    label: n.label,
    courseId: n.courseId,
    lastReviewed: shiftIso(n.lastReviewed, offset),
    stability: n.stability,
    retentionStart: 1,
    confidence: n.confidence,
    confidenceSource: n.confidenceSource,
    lastGenerated:
      n.confidenceSource === "generated-quiz" && n.confidence !== null
        ? { mode: "full", score: n.confidence, at: shiftIso(n.lastReviewed, offset) }
        : null,
    lastUploaded:
      n.confidenceSource === "uploaded-quiz" && n.confidence !== null
        ? { score: n.confidence, at: shiftIso(n.lastReviewed, offset) }
        : null,
    residuals,
    reviewCount: residuals.length,
    generatedAt: null,
    generatedSummary: null,
  };
}

function addFixtureCourse(db: Db, src: GraphResponse, name?: string, existing?: Course) {
  const offset = Date.now() - FIXTURE_NOW;
  const c = src.courses[0];
  const course: Course = {
    ...clone(c),
    name: name ?? c.name,
    status: "ready",
    error: null,
    createdAt: existing?.createdAt ?? shiftIso(c.createdAt, offset),
    semester: existing ? existing.semester : SEED_SEMESTER[c.id] ?? null,
  };
  const idx = db.courses.findIndex((x) => x.id === course.id);
  if (idx >= 0) db.courses[idx] = course;
  else db.courses.push(course);
  db.concepts.push(...src.nodes.map((n) => recFromNode(n, offset)));
  db.edges.push(...clone(src.edges));
  addCrossLinksIfReady(db);
}

function addCrossLinksIfReady(db: Db) {
  const ready = new Set(db.courses.filter((c) => c.status === "ready").map((c) => c.id));
  if (!ready.has(A.courses[0].id) || !ready.has(B.courses[0].id) || db.links.length > 0) return;
  db.links.push(...clone(MERGED.crossCourseLinks));
  db.edges.push(...clone(MERGED.edges.filter((e) => e.isCrossCourse)));
}

function addExtraCourse(db: Db, course: Course) {
  const at = nowIso();
  const idOf = (key: string) => `${course.id}-${key}`;
  for (const c of EXTRA_COURSE.concepts) {
    db.concepts.push({
      id: idOf(c.key),
      label: c.label,
      courseId: course.id,
      lastReviewed: at,
      stability: S0,
      retentionStart: 1,
      confidence: null,
      confidenceSource: null,
      lastGenerated: null,
      lastUploaded: null,
      residuals: [],
      reviewCount: 0,
      generatedAt: null,
      generatedSummary: null,
    });
    db.extraContent[idOf(c.key)] = EXTRA_COURSE.content[c.key];
    if (c.parent) {
      db.edges.push({ source: idOf(c.key), target: idOf(c.parent), relationType: "subconcept", isCrossCourse: false });
    }
  }
  for (const e of EXTRA_COURSE.edges) {
    db.edges.push({ source: idOf(e.from), target: idOf(e.to), relationType: e.type, isCrossCourse: false });
  }
  course.conceptCount = EXTRA_COURSE.concepts.length;
  course.industrySkills = [...EXTRA_COURSE.industrySkills];
  course.skillsSummary = EXTRA_COURSE.skillsSummary;
  course.status = "ready";
}

function freshDb(start: FixtureStart): Db {
  const db: Db = { courses: [], concepts: [], edges: [], links: [], quizzes: {}, pending: [], extraContent: {}, seq: 1 };
  if (start === "one" || start === "merged") addFixtureCourse(db, A);
  if (start === "merged") addFixtureCourse(db, B);
  return db;
}

function readStart(): FixtureStart {
  let fromUrl: string | null = null;
  try {
    fromUrl = new URLSearchParams(window.location.search).get("fixture");
  } catch {
    /* no window */
  }
  const valid = (v: string | null): v is FixtureStart => v === "empty" || v === "one" || v === "merged";
  try {
    if (valid(fromUrl)) {
      sessionStorage.setItem(START_KEY, fromUrl);
      sessionStorage.removeItem(DB_KEY); // an explicit ?fixture= always restarts the scenario
      return fromUrl;
    }
    const saved = sessionStorage.getItem(START_KEY);
    if (valid(saved)) return saved;
  } catch {
    /* storage blocked */
  }
  return valid(fromUrl) ? fromUrl : "merged";
}

function loadDb(): Db {
  const start = readStart();
  try {
    const saved = sessionStorage.getItem(DB_KEY);
    if (saved) return JSON.parse(saved) as Db; // survive a page refresh mid-demo
  } catch {
    /* fall through */
  }
  return freshDb(start);
}

export function createFixtureApi(): Api {
  const db = loadDb();

  const save = () => {
    try {
      sessionStorage.setItem(DB_KEY, JSON.stringify(db));
    } catch {
      /* storage blocked or full: state simply stays in memory */
    }
  };

  /** Finish any course whose simulated ingest time has elapsed. */
  const tick = () => {
    const due = db.pending.filter((p) => p.readyAt <= Date.now());
    if (!due.length) return;
    db.pending = db.pending.filter((p) => p.readyAt > Date.now());
    for (const p of due) {
      const course = db.courses.find((c) => c.id === p.courseId);
      if (!course) continue;
      if (p.template === "fail") {
        course.status = "failed";
        course.error = "No readable text was found in the uploaded files.";
      } else if (p.template === "a") addFixtureCourse(db, A, course.name, course);
      else if (p.template === "b") addFixtureCourse(db, B, course.name, course);
      else addExtraCourse(db, course);
    }
    save();
  };

  const notFound = (what: string) => new ApiRequestError(404, "not_found", `${what} not found`);
  const readyCourse = (id: string) => db.courses.find((c) => c.id === id && c.status === "ready");
  const concept = (id: string) => {
    const rec = db.concepts.find((c) => c.id === id);
    if (!rec) throw notFound("Concept");
    return rec;
  };
  const courseName = (id: string) => db.courses.find((c) => c.id === id)?.name ?? "";
  const content = (id: string) => contentFor(id, db.extraContent);

  const toNode = (rec: ConceptRec): ConceptNode => ({
    id: rec.id,
    label: rec.label,
    courseId: rec.courseId,
    lastReviewed: rec.lastReviewed,
    stability: rec.stability,
    retention: retentionAt(rec.lastReviewed, rec.stability, Date.now(), rec.retentionStart),
    confidence: rec.confidence,
    confidenceSource: rec.confidenceSource,
    connectionCount: db.edges.filter((e) => e.source === rec.id || e.target === rec.id).length,
  });

  const buildGraph = (courseId?: string): GraphResponse => {
    const readyIds = new Set(db.courses.filter((c) => c.status === "ready").map((c) => c.id));
    if (courseId) {
      if (!readyIds.has(courseId)) throw notFound("Course");
      const nodes = db.concepts.filter((c) => c.courseId === courseId);
      const ids = new Set(nodes.map((n) => n.id));
      return clone({
        courses: db.courses.filter((c) => c.id === courseId),
        nodes: nodes.map(toNode),
        edges: db.edges.filter((e) => !e.isCrossCourse && ids.has(e.source) && ids.has(e.target)),
        crossCourseLinks: [],
      });
    }
    return clone({
      courses: db.courses.filter((c) => c.status === "ready"),
      nodes: db.concepts.filter((c) => readyIds.has(c.courseId)).map(toNode),
      edges: db.edges,
      crossCourseLinks: db.links,
    });
  };

  const allResiduals = () => db.concepts.flatMap((c) => c.residuals);

  const neighbors = (id: string) => {
    const label = (cid: string) => db.concepts.find((c) => c.id === cid)?.label ?? cid;
    const out = { buildsOn: [] as string[], leadsTo: [] as string[], related: [] as string[], parts: [] as string[], partOf: [] as string[], cross: [] as string[] };
    for (const e of db.edges) {
      if (e.source !== id && e.target !== id) continue;
      const other = label(e.source === id ? e.target : e.source);
      if (e.relationType === "prerequisite") (e.target === id ? out.buildsOn : out.leadsTo).push(other);
      else if (e.relationType === "subconcept") (e.source === id ? out.partOf : out.parts).push(other);
      else if (e.relationType === "related") out.related.push(other);
      else out.cross.push(`${other} (${courseName(db.concepts.find((c) => c.label === other)?.courseId ?? "")})`);
    }
    return out;
  };

  const personalNote = (rec: ConceptRec): string => {
    const r = retentionAt(rec.lastReviewed, rec.stability, Date.now(), rec.retentionStart);
    if (rec.confidence === null) return r < 0.5 ? "You have not been quizzed on this yet and it is already fading, so start with the key points below." : "You have not been quizzed on this yet; a short quiz will show how well it has stuck.";
    if (rec.confidence < 0.4) return r >= 0.5 ? "You reviewed this recently, but your last quiz says the understanding is not there yet. Work the example before you move on." : "This has faded and your last quiz was shaky, so rebuild it from the key points.";
    if (r < 0.5) return "You understood this well when you last tested it, but it has faded. A quick review should bring it back.";
    return "You are in good shape here. Skim the key points to keep it fresh.";
  };

  const explanation = (rec: ConceptRec): string => {
    const c = content(rec.id);
    const n = neighbors(rec.id);
    const r = retentionAt(rec.lastReviewed, rec.stability, Date.now(), rec.retentionStart);
    const connects = [
      n.buildsOn.length ? `- **Builds on:** ${n.buildsOn.join(", ")}` : "",
      n.leadsTo.length ? `- **Leads to:** ${n.leadsTo.join(", ")}` : "",
      n.partOf.length ? `- **Part of:** ${n.partOf.join(", ")}` : "",
      n.parts.length ? `- **Includes:** ${n.parts.join(", ")}` : "",
      n.related.length ? `- **Related:** ${n.related.join(", ")}` : "",
      n.cross.length ? `- **In your other courses:** ${n.cross.join(", ")}` : "",
    ].filter(Boolean);
    return [
      `## The idea`,
      c.summary,
      `## Key points`,
      c.points.map((p) => `- ${p}`).join("\n"),
      `## See it in action`,
      `${c.example} Before you read on, try to explain in one sentence why this counts as ${rec.label}.`,
      `## Watch out`,
      `**Common mistake:** ${c.pitfall}`,
      `**Not true:** "${c.myth}"`,
      ...(connects.length ? [`## How it connects`, connects.join("\n")] : []),
      `## Where you stand`,
      `Retention is **${pct(r)}** and confidence is **${confidenceText(rec.confidence)}**. ${personalNote(rec)}`,
    ].join("\n\n");
  };

  const resources = (rec: ConceptRec): Resource[] => {
    const q = (s: string) => encodeURIComponent(s);
    return [
      { title: `${rec.label}, explained step by step`, url: `https://www.youtube.com/results?search_query=${q(`${rec.label} explained`)}`, type: "video" },
      { title: `${rec.label}: a written walkthrough`, url: `https://www.google.com/search?q=${q(`${rec.label} tutorial`)}`, type: "article" },
      { title: `Practice problems on ${rec.label}`, url: `https://www.google.com/search?q=${q(`${rec.label} practice problems with solutions`)}`, type: "practice" },
    ];
  };

  const toEntry = (rec: ConceptRec, full: boolean): GuideEntry => {
    const retention = retentionAt(rec.lastReviewed, rec.stability, Date.now(), rec.retentionStart);
    const { zScore, anomalous } = zScoreFor(rec.residuals, allResiduals());
    const generated = rec.generatedAt !== null;
    return {
      conceptId: rec.id,
      label: rec.label,
      courseId: rec.courseId,
      courseName: courseName(rec.courseId),
      retention,
      stability: rec.stability,
      lastReviewed: rec.lastReviewed,
      confidence: rec.confidence,
      confidenceSource: rec.confidenceSource,
      predictedForgetAt: predictedForgetAt(rec.lastReviewed, rec.stability, rec.retentionStart),
      zScore,
      anomalous,
      urgency: urgency(retention, rec.confidence, zScore),
      summary: rec.generatedSummary ?? content(rec.id).summary,
      explanation: generated || full ? explanation(rec) : null,
      resources: generated || full ? resources(rec) : [],
      generatedAt: rec.generatedAt,
    };
  };

  // ----- quiz building -----

  type Draft = Omit<StoredQuizQuestion, "id" | "difficulty" | "points">;

  const draft = (prompt: string, correct: string, wrong: string[], why: string): Draft => {
    const distinct = wrong.filter((w, i) => w !== correct && wrong.indexOf(w) === i).slice(0, 3);
    const options = shuffle([correct, ...distinct]);
    return { prompt, options, correctIndex: options.indexOf(correct), explanation: why };
  };

  const buildDrafts = (rec: ConceptRec) => {
    const c = content(rec.id);
    const others = shuffle(db.concepts.filter((x) => x.id !== rec.id));
    const sameCourseFirst = [...others.filter((x) => x.courseId === rec.courseId), ...others.filter((x) => x.courseId !== rec.courseId)];
    const oc = (i: number) => content(sameCourseFirst[i % sameCourseFirst.length].id);
    const myths = (skip = 0) => [oc(skip).myth, oc(skip + 1).myth, oc(skip + 2).myth];
    const linked = new Set(
      db.edges.filter((e) => e.source === rec.id || e.target === rec.id).map((e) => (e.source === rec.id ? e.target : e.source)),
    );
    const neighbor = db.concepts.find((x) => linked.has(x.id));
    const strangers = others.filter((x) => !linked.has(x.id)).map((x) => x.label);

    const example = draft(
      `Which of these is ${rec.label} in action?`,
      c.example,
      [oc(0).example, oc(1).example, oc(2).example],
      `That scenario is ${rec.label} at work. ${firstSentence(c.summary)}`,
    );
    const trueA = draft(`Thinking about ${rec.label}: which statement is true?`, c.points[0], myths(0), `Correct: ${c.points[0]} The other statements are common misconceptions.`);
    const trueB = draft(`Which of these statements is accurate?`, c.points[1], myths(3), `Correct: ${c.points[1]} The other statements are common misconceptions.`);
    const keyIdea = draft(
      `Which of these is a key idea of ${rec.label}?`,
      c.points[2],
      [oc(3).points[0], oc(4).points[1], oc(5).points[2]],
      `${c.points[2]} The other options describe different concepts.`,
    );
    const connected =
      neighbor && strangers.length >= 3
        ? draft(
            `In your concept map, which concept is directly connected to ${rec.label}?`,
            neighbor.label,
            strangers,
            `${neighbor.label} is linked to ${rec.label} in your map, so reviewing one supports the other.`,
          )
        : draft(`Which statement fits ${rec.label}?`, firstSentence(c.summary), myths(6), firstSentence(c.summary));
    const falseOne = draft(`Which statement about ${rec.label} is false?`, c.myth, [...c.points], `That statement is false. In fact: ${c.points[0]}`);
    const pitfall = draft(
      `Which is a common mistake when working with ${rec.label}?`,
      c.pitfall,
      [oc(0).pitfall, oc(1).pitfall, oc(2).pitfall],
      `The classic mistake here: ${c.pitfall}`,
    );
    const handwritten: Draft = (() => {
      const correct = c.q.options[c.q.answer];
      const options = shuffle([...c.q.options]);
      return { prompt: c.q.prompt, options, correctIndex: options.indexOf(correct), explanation: c.q.why };
    })();
    const notKey = draft(
      `Which of these is NOT a key idea of ${rec.label}?`,
      oc(6).points[0],
      [...c.points],
      `That idea belongs to a different concept. The other three are all central to ${rec.label}.`,
    );
    const nc = neighbor ? content(neighbor.id) : null;
    const bridge =
      neighbor && nc
        ? draft(
            `${neighbor.label} is connected to ${rec.label} in your map. Which statement about ${neighbor.label} is true?`,
            nc.points[0],
            [nc.myth, oc(7).myth, oc(8).myth].filter((m, i, a) => a.indexOf(m) === i).concat(myths(9)).slice(0, 3),
            `${nc.points[0]} Knowing this makes ${rec.label} easier to hold on to.`,
          )
        : draft(`Which statement about ${rec.label} is true?`, c.points[1], myths(7), c.points[1]);
    return { example, trueA, trueB, keyIdea, connected, falseOne, pitfall, handwritten, notKey, bridge };
  };

  const buildQuiz = (rec: ConceptRec, mode: QuizMode): StoredQuiz => {
    const d = buildDrafts(rec);
    const quizId = `quiz-${db.seq++}-${Math.random().toString(36).slice(2, 8)}`;
    let questions: StoredQuizQuestion[];
    if (mode === "short") {
      // 3-5 questions, easiest to hardest; question k is worth k points.
      const order: [Draft, Difficulty][] = [
        [d.example, "easy"],
        [d.trueA, "easy"],
        [d.pitfall, "medium"],
        [d.handwritten, "hard"],
      ];
      questions = order.map(([q, difficulty], i) => ({ ...q, id: `${quizId}-q${i + 1}`, difficulty, points: i + 1 }));
    } else {
      // 4 easy (1 pt), 3 medium (2 pts), 3 hard (3 pts), mixed order. 19 points.
      const byDifficulty: Record<Difficulty, Draft[]> = {
        easy: [d.example, d.trueA, d.connected, d.keyIdea],
        medium: [d.falseOne, d.pitfall, d.trueB],
        hard: [d.handwritten, d.notKey, d.bridge],
      };
      const all = (Object.keys(byDifficulty) as Difficulty[]).flatMap((difficulty) =>
        byDifficulty[difficulty]
          .slice(0, FULL_QUIZ_MIX[difficulty].count)
          .map((q) => ({ ...q, difficulty, points: FULL_QUIZ_MIX[difficulty].points })),
      );
      questions = shuffle(all).map((q, i) => ({ ...q, id: `${quizId}-q${i + 1}` }));
    }
    return { quizId, conceptId: rec.id, mode, createdAt: nowIso(), submittedAt: null, questions };
  };

  /** Shared by quiz submit and quiz upload: stability, retention reset, residual, confidence rule. */
  const applyAssessment = (rec: ConceptRec, source: ConfidenceSource, score: number, mode?: QuizMode) => {
    const at = nowIso();
    const rBefore = retentionAt(rec.lastReviewed, rec.stability, Date.now(), rec.retentionStart);
    rec.stability = stabilityAfterQuiz(rec.stability, rBefore, score);
    rec.retentionStart = retentionAfterQuiz(score); // a weak score leaves the node red
    rec.lastReviewed = at;
    rec.residuals.push(score - rBefore);
    rec.reviewCount += 1;
    if (source === "generated-quiz") {
      if (mode === "full") {
        rec.confidence = score;
        rec.confidenceSource = "generated-quiz";
        rec.lastUploaded = null;
      } else if (rec.lastUploaded) {
        rec.confidence = (score + rec.lastUploaded.score) / 2;
        rec.confidenceSource = "uploaded-quiz";
      } else {
        rec.confidence = score;
        rec.confidenceSource = "generated-quiz";
      }
      rec.lastGenerated = { mode: mode ?? "full", score, at };
    } else {
      rec.confidence = rec.lastGenerated?.mode === "short" ? (score + rec.lastGenerated.score) / 2 : score;
      rec.confidenceSource = "uploaded-quiz";
      rec.lastUploaded = { score, at };
    }
  };

  const api: Api = {
    async getGraph(courseId) {
      await delay();
      tick();
      return buildGraph(courseId);
    },

    async postReview({ conceptId, rating }) {
      await delay();
      tick();
      if (rating !== "got-it" && rating !== "still-shaky") throw new ApiRequestError(400, "bad_request", "Invalid rating");
      const rec = concept(conceptId);
      const rBefore = retentionAt(rec.lastReviewed, rec.stability, Date.now(), rec.retentionStart);
      rec.stability = stabilityAfterSelfReview(rec.stability, rating === "got-it");
      rec.retentionStart = retentionAfterSelfReview(rating, rBefore);
      rec.lastReviewed = nowIso();
      rec.reviewCount += 1;
      save();
      return { node: toNode(rec) };
    },

    async getDecayStatus(courseId) {
      await delay();
      tick();
      if (!readyCourse(courseId)) throw notFound("Course");
      const entries = db.concepts.filter((c) => c.courseId === courseId).map((rec) => ({ rec, e: toEntry(rec, false) }));
      const status: DecayStatus = {
        courseId,
        scannedAt: nowIso(),
        threshold: FORGET_THRESHOLD,
        summary: {
          averageRetention: entries.length ? entries.reduce((s, x) => s + x.e.retention, 0) / entries.length : 0,
          atRiskCount: entries.filter((x) => x.e.retention < FORGET_THRESHOLD).length,
          anomalousCount: entries.filter((x) => x.e.anomalous).length,
        },
        concepts: entries.map(({ rec, e }) => ({
          conceptId: e.conceptId,
          label: e.label,
          retention: e.retention,
          stability: e.stability,
          lastReviewed: e.lastReviewed,
          predictedForgetAt: e.predictedForgetAt,
          zScore: e.zScore,
          anomalous: e.anomalous,
          reviewCount: rec.reviewCount,
        })),
      };
      return status;
    },

    async generateQuiz(conceptId, mode) {
      await delay(900, 1600);
      tick();
      const quiz = buildQuiz(concept(conceptId), mode);
      db.quizzes[quiz.quizId] = quiz;
      save();
      return {
        quizId: quiz.quizId,
        conceptId,
        mode,
        totalPoints: quiz.questions.reduce((s, q) => s + q.points, 0),
        // The answer key and explanations never leave the "server" before submission.
        questions: quiz.questions.map(({ id, prompt, options, difficulty, points }) => ({ id, prompt, options, difficulty, points })),
      };
    },

    async submitQuiz(conceptId, { quizId, answers }) {
      await delay();
      tick();
      const quiz = db.quizzes[quizId];
      if (!quiz || quiz.conceptId !== conceptId) throw notFound("Quiz");
      if (quiz.submittedAt) throw new ApiRequestError(409, "already_submitted", "This quiz was already submitted.");
      const rec = concept(conceptId);
      const picked = new Map(answers.map((a) => [a.questionId, a.selectedIndex]));
      const results = quiz.questions.map((q) => ({
        questionId: q.id,
        correct: picked.get(q.id) === q.correctIndex,
        correctIndex: q.correctIndex,
        explanation: q.explanation,
      }));
      const totalPoints = quiz.questions.reduce((s, q) => s + q.points, 0);
      const pointsEarned = quiz.questions.reduce((s, q, i) => s + (results[i].correct ? q.points : 0), 0);
      const score = totalPoints ? pointsEarned / totalPoints : 0;
      quiz.submittedAt = nowIso();
      applyAssessment(rec, "generated-quiz", score, quiz.mode);
      save();
      return { quizId, score, pointsEarned, totalPoints, results, node: toNode(rec) };
    },

    async uploadQuiz(conceptId, { s3Key }) {
      await delay(1400, 2200); // OCR + parsing takes a moment on the real backend
      tick();
      const rec = concept(conceptId);
      if (!/canvas|gradescope/i.test(s3Key)) {
        const failed: QuizUploadResponse = { parseFailed: true, reason: "not-digital", node: null };
        return failed;
      }
      const totalPoints = 20;
      const pointsEarned = 13 + Math.floor(Math.random() * 6);
      const score = pointsEarned / totalPoints;
      applyAssessment(rec, "uploaded-quiz", score);
      save();
      return { parseFailed: false, score, pointsEarned, totalPoints, questionCount: 8, node: toNode(rec) };
    },

    async linkCourses(courseId, otherCourseId) {
      await delay(700, 1200);
      tick();
      if (!db.courses.some((c) => c.id === courseId) || !db.courses.some((c) => c.id === otherCourseId)) throw notFound("Course");
      if (!readyCourse(courseId) || !readyCourse(otherCourseId)) throw new ApiRequestError(409, "course_not_ready", "Both courses must be ready.");
      addCrossLinksIfReady(db);
      save();
      const pair = new Set([courseId, otherCourseId]);
      const links = db.links.filter((l) => pair.has(l.sourceCourseId) && pair.has(l.targetCourseId));
      const courseOf = (id: string) => db.concepts.find((c) => c.id === id)?.courseId ?? "";
      const edges = db.edges.filter((e) => e.isCrossCourse && pair.has(courseOf(e.source)) && pair.has(courseOf(e.target)));
      return clone({ links, edges });
    },

    async getCourseSkills(courseId) {
      await delay();
      tick();
      const course = db.courses.find((c) => c.id === courseId);
      if (!course) throw notFound("Course");
      return { courseId, industrySkills: [...course.industrySkills], skillsSummary: course.skillsSummary };
    },

    async getGuide() {
      await delay();
      tick();
      const readyIds = new Set(db.courses.filter((c) => c.status === "ready").map((c) => c.id));
      const entries = db.concepts.filter((c) => readyIds.has(c.courseId)).map((rec) => toEntry(rec, false));
      entries.sort((a, b) => b.urgency - a.urgency);
      return { entries };
    },

    async getGuideEntry(conceptId, opts) {
      tick();
      const rec = concept(conceptId);
      const firstTime = rec.generatedAt === null || opts?.refresh === true;
      // First load "generates" the explanation, which takes several seconds for real.
      await (firstTime ? delay(1800, 2800) : delay());
      if (firstTime) {
        rec.generatedAt = nowIso();
        rec.generatedSummary = `${firstSentence(content(rec.id).summary)} ${personalNote(rec)}`;
        save();
      }
      return { entry: toEntry(rec, true) };
    },

    async presign({ fileName, contentType, purpose }) {
      await delay(150, 350);
      if (!ALLOWED_UPLOAD_TYPES[purpose]?.includes(contentType)) {
        throw new ApiRequestError(400, "unsupported_type", "That file type isn't supported.");
      }
      const s3Key = `fixture/${purpose}/${db.seq++}-${fileName}`;
      return { uploadUrl: `fixture://uploads/${encodeURIComponent(s3Key)}`, s3Key, expiresIn: 900 };
    },

    async putFile() {
      await delay(250, 600);
    },

    async createCourse({ name, semester, s3Keys }) {
      await delay();
      tick();
      if (!name.trim()) throw new ApiRequestError(400, "bad_request", "Enter a course name.");
      if (s3Keys.length < 1 || s3Keys.length > 5) throw new ApiRequestError(400, "bad_request", "Add between 1 and 5 files.");
      const taken = (id: string) => db.courses.some((c) => c.id === id && c.status !== "failed");
      let template: PendingCourse["template"];
      let id: string;
      if (s3Keys.some((k) => /fail/i.test(k))) [template, id] = ["fail", `course-${db.seq++}`];
      else if (!taken(A.courses[0].id)) [template, id] = ["a", A.courses[0].id];
      else if (!taken(B.courses[0].id)) [template, id] = ["b", B.courses[0].id];
      else [template, id] = ["extra", `course-${db.seq++}`];
      db.courses = db.courses.filter((c) => c.id !== id); // replace an earlier failed attempt
      const course: Course = {
        id,
        name: name.trim(),
        conceptCount: 0,
        industrySkills: [],
        skillsSummary: "",
        status: "processing",
        error: null,
        createdAt: nowIso(),
        semester: semester && semester.trim() ? semester.trim().slice(0, 40) : null,
      };
      db.courses.push(course);
      db.pending.push({ courseId: id, readyAt: Date.now() + PROCESSING_MS, template });
      save();
      return { course: clone(course) };
    },

    async deleteAccount() {
      await delay();
      try {
        sessionStorage.removeItem(DB_KEY);
      } catch {
        /* storage blocked */
      }
      return { deleted: true };
    },

    async getCourse(courseId) {
      await delay(150, 350);
      tick();
      const course = db.courses.find((c) => c.id === courseId);
      if (!course) throw notFound("Course");
      return { course: clone(course) };
    },
  };

  return api;
}

// CONTENT is re-exported for tests and tooling that want to inspect the mock material.
export { CONTENT };
