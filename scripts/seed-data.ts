// Demo data set: the two courses of frontend/fixtures/graph-merged.json (CSE 471 and
// CSE 475) with a backdated review history per concept. The history is replayed through
// the real learning-model functions, so every Tiger row is self-consistent (predicted
// retention, stability before/after) and the final stability / last review land on the
// fixture values. Imported by scripts/seed.ts (CLI) and by the offline tests.

import fixtureJson from "../frontend/fixtures/graph-merged.json";
import { S0 } from "../backend/lambda/lib/contracts";
import type { ConfidenceSource, CrossCourseLink, EventType, QuizMode } from "../backend/lambda/lib/contracts";
import { nextStability, retentionAfterQuiz, retentionAfterSelfReview, retentionAt } from "../backend/lambda/lib/data/decay";
import { collections, deleteUserData } from "../backend/lambda/lib/data/mongo";
import * as svc from "../backend/lambda/lib/data/service";
import * as tiger from "../backend/lambda/lib/data/tiger";
import type { ReviewEvent } from "../backend/lambda/lib/data/tiger";
import { computeZScores } from "../backend/lambda/lib/data/zscore";

const DAY = 86_400_000;
/** The moment the fixture's retention values were computed for. */
const FIXTURE_NOW = Date.parse("2026-11-15T06:00:00Z");
/** Days before "now" each course was ingested (review history needs room before the fixture's createdAt). */
const INGEST_DAYS_AGO: Record<string, number> = { cse471: 24, cse475: 22 };

interface FixtureNode {
  id: string;
  label: string;
  courseId: string;
  lastReviewed: string;
  stability: number;
  retention: number;
  confidence: number | null;
  confidenceSource: ConfidenceSource | null;
}
interface Fixture {
  courses: { id: string; name: string; industrySkills: string[]; skillsSummary: string }[];
  nodes: FixtureNode[];
  edges: { source: string; target: string; relationType: string }[];
  crossCourseLinks: CrossCourseLink[];
}

export function loadFixture(): Fixture {
  // Imported (not read from disk) so the same code also bundles into the seeding Lambda.
  return fixtureJson as unknown as Fixture;
}

// ---------- history plans ----------

type StepKind = "got-it" | "shaky" | "full" | "short" | "upload";
/** `at` = days before now. "tune" = solved so the final stability hits the fixture value. "last" = the fixture's lastReviewed. */
interface Step {
  kind: StepKind;
  score?: number;
  at: number | "tune" | "last";
}
interface Plan {
  summary: string;
  steps: Step[];
}

const s = (kind: StepKind, at: Step["at"], score?: number): Step => ({ kind, at, score });

const PLANS: Record<string, Plan> = {
  // ----- CSE 471 Intro to AI -----
  "cse471-state-space-search": {
    summary: "Models a problem as states, actions and a goal test, then explores the resulting graph with strategies such as BFS, DFS and uniform-cost search.",
    steps: [s("shaky", 20), s("shaky", 13), s("got-it", "tune"), s("full", 3.2, 0.7), s("full", "last", 0.89)],
  },
  "cse471-a-star": {
    summary: "Best-first search that expands the node with the lowest f(n) = g(n) + h(n); it returns an optimal path when the heuristic is admissible.",
    steps: [s("shaky", 19), s("shaky", "tune"), s("full", 4.5, 0.6), s("full", "last", 0.53)],
  },
  "cse471-admissible-heuristics": {
    summary: "A heuristic is admissible when it never overestimates the true cost to the goal, which is what guarantees A* finds an optimal solution.",
    steps: [s("got-it", 15), s("got-it", 3.38)],
  },
  "cse471-minimax": {
    summary: "Chooses moves in a two-player zero-sum game by assuming the opponent plays optimally: MAX nodes take the largest child value, MIN nodes the smallest.",
    steps: [s("full", 12, 0.35), s("shaky", "tune"), s("upload", 6.01, 0.7), s("short", "last", 0.78)],
  },
  "cse471-alpha-beta": {
    summary: "Speeds up minimax by skipping branches that cannot change the final decision, tracking the best value found so far for MAX (alpha) and MIN (beta).",
    steps: [s("got-it", 21), s("got-it", "tune"), s("full", 10, 0.8), s("got-it", 9.3), s("full", 8.5, 0.3), s("got-it", 7.8), s("full", 7.2, 0.25), s("got-it", 6.5), s("full", "last", 0.21)],
  },
  "cse471-csp": {
    summary: "Problems defined by variables, domains and constraints, solved with backtracking search plus pruning such as forward checking and arc consistency.",
    steps: [s("got-it", 18), s("got-it", 10.14)],
  },
  "cse471-mdp": {
    summary: "A model of sequential decisions under uncertainty with states, actions, transition probabilities, rewards and a discount factor; solving it yields an optimal policy.",
    steps: [s("got-it", 21), s("got-it", "tune"), s("full", 9, 0.5), s("full", 5, 0.32), s("got-it", "last")],
  },
  "cse471-q-learning": {
    summary: "A model-free reinforcement learning method that learns action values from experience, nudging Q(s, a) toward the reward plus the discounted best next value.",
    steps: [s("got-it", 16), s("full", 8, 0.47), s("got-it", 2.1)],
  },
  "cse471-bayes-rule": {
    summary: "Bayes' rule inverts a conditional probability, P(A|B) = P(B|A) P(A) / P(B), so beliefs can be updated when new evidence arrives.",
    steps: [s("got-it", 20), s("got-it", 14), s("got-it", "tune"), s("upload", "last", 0.95)],
  },
  "cse471-bayes-nets": {
    summary: "A directed acyclic graph whose nodes are random variables, each with a conditional probability table given its parents; together they encode a joint distribution compactly.",
    steps: [s("shaky", "tune"), s("full", 7.5, 0.55), s("full", "last", 0.63)],
  },
  // ----- CSE 475 Foundations of ML -----
  "cse475-linear-regression": {
    summary: "Fits a linear function to predict a continuous target by choosing the weights that minimize the mean squared error on the training data.",
    steps: [s("got-it", 20), s("got-it", 17), s("got-it", 12), s("got-it", "tune"), s("upload", "last", 0.84)],
  },
  "cse475-gradient-descent": {
    summary: "An iterative optimizer that repeatedly moves the parameters a small step against the gradient of the loss, with the step size set by the learning rate.",
    steps: [s("shaky", 15), s("got-it", "tune"), s("full", "last", 0.58)],
  },
  "cse475-logistic-regression": {
    summary: "A linear classifier that passes a weighted sum through the sigmoid to output a class probability and is trained by minimizing cross-entropy loss.",
    steps: [s("shaky", 14), s("got-it", "tune"), s("full", "last", 0.68)],
  },
  "cse475-regularization": {
    summary: "Overfitting is fitting noise in the training set so the model generalizes poorly; regularization such as L1 or L2 penalties counters it by discouraging large weights.",
    steps: [s("got-it", 21), s("got-it", 19.5), s("got-it", 17.5), s("got-it", 15), s("got-it", 12.5), s("full", 10.5, 0.42), s("got-it", 9.8), s("full", 9, 0.4), s("got-it", 8.2), s("full", 7.29, 0.37)],
  },
  "cse475-cross-validation": {
    summary: "Estimates how well a model generalizes by rotating which fold of the data is held out for validation and averaging the scores, typically with k folds.",
    steps: [s("got-it", "last")],
  },
  "cse475-naive-bayes": {
    summary: "A probabilistic classifier that applies Bayes' rule while assuming the features are conditionally independent given the class.",
    steps: [s("got-it", 18), s("got-it", "tune"), s("upload", "last", 0.79)],
  },
  "cse475-neural-networks": {
    summary: "Layers of weighted sums followed by nonlinear activations that can approximate complex functions; the weights are learned with gradient-based training.",
    steps: [s("shaky", "tune"), s("full", 6, 0.6), s("full", 4, 0.26), s("got-it", "last")],
  },
  "cse475-backpropagation": {
    summary: "Computes the gradient of the loss with respect to every weight by applying the chain rule backward through the network, one layer at a time.",
    steps: [s("shaky", "last")],
  },
  "cse475-decision-trees": {
    summary: "Predicts by following a sequence of feature tests from the root to a leaf; splits are chosen to maximize information gain or reduce impurity.",
    steps: [s("got-it", 20), s("got-it", "tune"), s("full", 13, 0.6), s("upload", "last", 0.42)],
  },
};

// ---------- simulation ----------

export interface PlannedEvent {
  daysAgo: number;
  eventType: EventType;
  result: number | null;
  predictedRetention: number | null;
  stabilityBefore: number | null;
  stabilityAfter: number;
}
export interface PlannedConcept {
  fixtureId: string;
  label: string;
  courseId: string;
  summary: string;
  events: PlannedEvent[];
  stability: number;
  lastReviewedDaysAgo: number;
  confidence: number | null;
  confidenceSource: ConfidenceSource | null;
  lastGenerated: { mode: QuizMode; score: number; daysAgo: number } | null;
  lastUploaded: { score: number; daysAgo: number } | null;
  /** Retention the last event left the concept at (R0). */
  retentionStart: number;
  target: { stability: number; retention: number; lastReviewedDaysAgo: number };
}

function simulate(node: FixtureNode, plan: Plan, times: number[]): PlannedConcept {
  const ingestAt = INGEST_DAYS_AGO[node.courseId];
  const events: PlannedEvent[] = [
    { daysAgo: ingestAt, eventType: "ingested", result: null, predictedRetention: null, stabilityBefore: null, stabilityAfter: S0 },
  ];
  let stability = S0;
  let last = ingestAt;
  let confidence: number | null = null;
  let confidenceSource: ConfidenceSource | null = null;
  let lastGenerated: PlannedConcept["lastGenerated"] = null;
  let lastUploaded: PlannedConcept["lastUploaded"] = null;
  let r0 = 1;

  plan.steps.forEach((step, i) => {
    const at = times[i];
    if (!(at < last)) throw new Error(`${node.id}: step ${i} is not after the previous event`);
    const before = retentionAt(new Date(0).toISOString(), stability, new Date((last - at) * DAY), r0);
    const isSelf = step.kind === "got-it" || step.kind === "shaky";
    const eventType: EventType = isSelf ? "self-review" : step.kind === "upload" ? "uploaded-quiz" : "generated-quiz";
    const result = isSelf ? (step.kind === "got-it" ? 1 : 0) : (step.score as number);
    const after = nextStability(stability, before, eventType, result);
    events.push({ daysAgo: at, eventType, result, predictedRetention: before, stabilityBefore: stability, stabilityAfter: after });
    // Same confidence rule table as service.applyAssessment.
    if (step.kind === "full") {
      lastGenerated = { mode: "full", score: result, daysAgo: at };
      lastUploaded = null;
      confidence = result;
      confidenceSource = "generated-quiz";
    } else if (step.kind === "short") {
      const uploaded: PlannedConcept["lastUploaded"] = lastUploaded;
      lastGenerated = { mode: "short", score: result, daysAgo: at };
      confidence = uploaded ? (result + uploaded.score) / 2 : result;
      confidenceSource = uploaded ? "uploaded-quiz" : "generated-quiz";
    } else if (step.kind === "upload") {
      const generated: PlannedConcept["lastGenerated"] = lastGenerated;
      confidence = generated && generated.mode === "short" ? (result + generated.score) / 2 : result;
      confidenceSource = "uploaded-quiz";
      lastUploaded = { score: result, daysAgo: at };
    }
    stability = after;
    // A weak quiz or a "still shaky" rating leaves the concept low, as in the live app.
    r0 = isSelf ? retentionAfterSelfReview(step.kind === "got-it" ? "got-it" : "still-shaky", before) : retentionAfterQuiz(result);
    last = at;
  });

  return {
    fixtureId: node.id, label: node.label, courseId: node.courseId, summary: plan.summary, events,
    stability, lastReviewedDaysAgo: last, confidence, confidenceSource, lastGenerated, lastUploaded, retentionStart: r0,
    target: { stability: node.stability, retention: node.retention, lastReviewedDaysAgo: (FIXTURE_NOW - Date.parse(node.lastReviewed)) / DAY },
  };
}

function planConcept(node: FixtureNode): PlannedConcept {
  const plan = PLANS[node.id];
  if (!plan) throw new Error(`no history plan for ${node.id}`);
  const fixtureLast = (FIXTURE_NOW - Date.parse(node.lastReviewed)) / DAY;
  const times = plan.steps.map((step) => (step.at === "last" ? fixtureLast : step.at === "tune" ? Number.NaN : step.at));
  const tuneIndex = plan.steps.findIndex((step) => step.at === "tune");
  if (tuneIndex < 0) return simulate(node, plan, times);

  // Solve the tunable step's time (between its neighbours) so the final S hits the fixture value.
  const upper = (tuneIndex === 0 ? INGEST_DAYS_AGO[node.courseId] : times[tuneIndex - 1]) - 0.02;
  const lower = times[tuneIndex + 1] + 0.02;
  const errorAt = (t: number): number => {
    times[tuneIndex] = t;
    return Math.abs(simulate(node, plan, times).stability - node.stability);
  };
  let best = lower;
  let bestError = Number.POSITIVE_INFINITY;
  let span = upper - lower;
  let from = lower;
  for (let pass = 0; pass < 4; pass++) {
    const stepSize = span / 400;
    for (let k = 0; k <= 400; k++) {
      const t = Math.min(upper, Math.max(lower, from + k * stepSize));
      const error = errorAt(t);
      if (error < bestError) {
        bestError = error;
        best = t;
      }
    }
    from = best - stepSize;
    span = 2 * stepSize;
  }
  times[tuneIndex] = best;
  return simulate(node, plan, times);
}

export function planAll(): PlannedConcept[] {
  return loadFixture().nodes.map(planConcept);
}

const toEvents = (planned: PlannedConcept, now: number, userId: string, courseId: string, conceptId: string): ReviewEvent[] =>
  planned.events.map((e) => ({
    ts: new Date(now - e.daysAgo * DAY), userId, courseId, conceptId, eventType: e.eventType, result: e.result,
    predictedRetention: e.predictedRetention, stabilityBefore: e.stabilityBefore, stabilityAfter: e.stabilityAfter,
  }));

/** No database: the planned end state per concept, with z-scores from the TypeScript mirror of the SQL. */
export function dryRun(): { label: string; S: string; R: string; conf: string; z: string; anomalous: boolean; events: number }[] {
  const now = Date.now();
  const planned = planAll();
  const z = computeZScores(planned.flatMap((p) => toEvents(p, now, "dry", p.courseId, p.fixtureId)), new Date(now));
  return planned.map((p) => ({
    label: p.label,
    S: `${p.stability.toFixed(2)} (fixture ${p.target.stability})`,
    R: `${(p.retentionStart * Math.exp(-p.lastReviewedDaysAgo / p.stability)).toFixed(3)} (fixture ${p.target.retention})`,
    conf: p.confidence === null ? "null" : `${p.confidence.toFixed(2)} ${p.confidenceSource}`,
    z: z.get(p.fixtureId)?.zScore?.toFixed(2) ?? "null",
    anomalous: z.get(p.fixtureId)?.anomalous ?? false,
    events: p.events.length,
  }));
}

// ---------- database seed ----------

export interface SeedCounts {
  deleted: { mongoDocs: number; tigerRows: number } | null;
  courses: number;
  concepts: number;
  edges: number;
  crossCourseLinks: number;
  crossCourseEdges: number;
  reviewEvents: number;
  anomalousConcepts: number;
}

/** Semester labels for the demo account, so the Home semester filter has two terms to show. */
const DEMO_SEMESTERS: Record<string, string> = { cse471: "Fall 2026", cse475: "Spring 2026" };

export async function seedUser(userId: string, opts: { reset?: boolean } = {}): Promise<SeedCounts> {
  const fixture = loadFixture();
  const planned = planAll();
  const now = Date.now();
  const c = await collections();

  let deleted: SeedCounts["deleted"] = null;
  if (opts.reset) {
    const docs = await deleteUserData(userId);
    const rows = await tiger.deleteUserEvents(userId);
    deleted = { mongoDocs: Object.values(docs).reduce((a, b) => a + b, 0), tigerRows: rows };
  } else if ((await c.courses.countDocuments({ userId, name: { $in: fixture.courses.map((x) => x.name) } })) > 0) {
    throw new Error("this user already has the demo courses; rerun with --reset");
  }

  const idOf = new Map<string, string>(); // fixture concept id -> real id
  const courseIdOf = new Map<string, string>(); // fixture course id -> real id
  const events: ReviewEvent[] = [];
  let edgeCount = 0;

  for (const course of fixture.courses) {
    const nodes = fixture.nodes.filter((n) => n.courseId === course.id);
    const inCourse = new Set(nodes.map((n) => n.id));
    const edges = fixture.edges.filter((e) => inCourse.has(e.source) && inCourse.has(e.target));
    const created = await svc.createCourse(userId, course.name, DEMO_SEMESTERS[course.id] ?? null);
    courseIdOf.set(course.id, created.id);

    const sourceText = [
      `${course.name}: lecture notes`,
      ...nodes.map((n) => `${n.label}\n${PLANS[n.id].summary}`),
    ].join("\n\n");
    const saved = await svc.saveExtractedGraph(userId, created.id, {
      concepts: nodes.map((n) => ({
        key: n.id,
        label: n.label,
        summary: PLANS[n.id].summary,
        parentKey: edges.find((e) => e.relationType === "subconcept" && e.source === n.id)?.target ?? null,
      })),
      dependencies: edges
        .filter((e) => e.relationType === "prerequisite" || e.relationType === "related")
        .map((e) => ({ from: e.source, to: e.target, type: e.relationType as "prerequisite" | "related" })),
      sourceText,
    });
    edgeCount += saved.edges.length;
    nodes.forEach((n, i) => idOf.set(n.id, saved.nodes[i].id));
    await svc.saveCourseSkills(userId, created.id, course.industrySkills, course.skillsSummary);

    // Replace the "ingested just now" rows with the backdated history.
    await tiger.deleteCourseEvents(userId, created.id);
    const createdAt = new Date(now - INGEST_DAYS_AGO[course.id] * DAY).toISOString();
    await c.courses.updateOne({ userId, id: created.id }, { $set: { createdAt } });
    for (const p of planned.filter((x) => x.courseId === course.id)) {
      const conceptId = idOf.get(p.fixtureId) as string;
      events.push(...toEvents(p, now, userId, created.id, conceptId));
      const iso = (daysAgo: number): string => new Date(now - daysAgo * DAY).toISOString();
      await c.concepts.updateOne(
        { userId, id: conceptId },
        {
          $set: {
            createdAt,
            lastReviewed: iso(p.lastReviewedDaysAgo),
            stability: p.stability,
            retentionStart: p.retentionStart,
            retention: p.retentionStart * Math.exp(-p.lastReviewedDaysAgo / p.stability),
            confidence: p.confidence,
            confidenceSource: p.confidenceSource,
            lastGenerated: p.lastGenerated ? { mode: p.lastGenerated.mode, score: p.lastGenerated.score, at: iso(p.lastGenerated.daysAgo) } : null,
            lastUploaded: p.lastUploaded ? { score: p.lastUploaded.score, at: iso(p.lastUploaded.daysAgo) } : null,
          },
        },
      );
    }
    await svc.setCourseStatus(userId, created.id, "ready");
  }
  await tiger.insertEvents(events);

  let linkCount = 0;
  let crossEdges = 0;
  const pairs = new Map<string, CrossCourseLink[]>();
  for (const link of fixture.crossCourseLinks) {
    const mapped: CrossCourseLink = {
      sourceCourseId: courseIdOf.get(link.sourceCourseId) as string,
      targetCourseId: courseIdOf.get(link.targetCourseId) as string,
      sharedConceptIds: link.sharedConceptIds.map((id) => idOf.get(id) as string),
      description: link.description,
    };
    const key = [mapped.sourceCourseId, mapped.targetCourseId].sort().join("|");
    pairs.set(key, [...(pairs.get(key) ?? []), mapped]);
  }
  for (const links of pairs.values()) {
    const result = await svc.replaceCrossCourseLinks(userId, links[0].sourceCourseId, links[0].targetCourseId, links);
    linkCount += result.links.length;
    crossEdges += result.edges.length;
  }

  // Compute and cache z-scores / anomalous flags from the Tiger history (SQL).
  let anomalous = 0;
  for (const courseId of courseIdOf.values()) {
    const status = await svc.decayStatus(userId, courseId, { recalculate: true });
    anomalous += status?.summary.anomalousCount ?? 0;
  }

  return {
    deleted, courses: courseIdOf.size, concepts: idOf.size, edges: edgeCount, crossCourseLinks: linkCount,
    crossCourseEdges: crossEdges, reviewEvents: events.length, anomalousConcepts: anomalous,
  };
}
