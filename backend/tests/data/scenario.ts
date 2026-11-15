// End-to-end scenario for lib/data/service. Runs twice:
//   - live, against real MongoDB + Tiger Data (tests/data/integration.ts)
//   - offline, against in-memory fakes (tests/data/service.test.ts)
// It creates data only for the given throwaway user and deletes all of it at the end.

import { S0 } from "../../lambda/lib/contracts";
import type { CrossCourseLink, Edge, StoredQuiz } from "../../lambda/lib/contracts";
import { urgency } from "../../lambda/lib/data/decay";
import * as mongo from "../../lambda/lib/data/mongo";
import * as svc from "../../lambda/lib/data/service";
import * as tiger from "../../lambda/lib/data/tiger";

const DAY = 86_400_000;

export async function runScenario(userId: string, log: (line: string) => void = () => {}): Promise<string[]> {
  const failures: string[] = [];
  const check = (name: string, ok: boolean, detail?: unknown): void => {
    if (ok) log(`PASS ${name}`);
    else {
      const line = `FAIL ${name}${detail === undefined ? "" : ` -> ${JSON.stringify(detail)}`}`;
      failures.push(line);
      log(line);
    }
  };
  const near = (a: number | null | undefined, b: number, tol = 1e-6): boolean =>
    typeof a === "number" && Math.abs(a - b) <= tol;
  const touching = (edges: Edge[], id: string): number => edges.filter((e) => e.source === id || e.target === id).length;
  const leaksUser = (value: unknown): boolean => JSON.stringify(value).includes(userId) || JSON.stringify(value).includes('"userId"');

  try {
    // ---------- 1. course + extracted graph ----------
    const courseA = await svc.createCourse(userId, "ITEST Intro to AI");
    check("createCourse shape", courseA.status === "processing" && courseA.conceptCount === 0 && courseA.error === null && courseA.industrySkills.length === 0 && /^crs_[a-z0-9]{10}$/.test(courseA.id), courseA);
    check("createCourse hides userId", !leaksUser(courseA));

    const filler = "Lecture filler sentence about nothing in particular. ".repeat(260); // ~13.8k chars
    const sourceText = `${filler}\nNotes on Q-Learning: an off-policy temporal-difference method.\n${filler}`;
    const saved = await svc.saveExtractedGraph(userId, courseA.id, {
      concepts: [
        { key: "search", label: "State-Space Search", summary: "Search summary.", parentKey: null },
        { key: "astar", label: "A* Search", summary: "A* summary.", parentKey: null },
        { key: "heur", label: "Admissible Heuristics", summary: "Heuristic summary.", parentKey: "astar" },
        { key: "minimax", label: "Minimax", summary: "Minimax summary.", parentKey: null },
        { key: "csp", label: "Constraint Satisfaction", summary: "CSP summary.", parentKey: "nope" },
        { key: "mdp", label: "Markov Decision Processes", summary: "MDP summary.", parentKey: null },
        { key: "qlearn", label: "Q-Learning", summary: "Q summary.", parentKey: "qlearn" },
        { key: "bayes", label: "Bayes Rule", summary: "Bayes summary.", parentKey: null },
        { key: "search", label: "Duplicate key, must be dropped", summary: "x", parentKey: null },
      ],
      dependencies: [
        { from: "search", to: "astar", type: "prerequisite" },
        { from: "search", to: "minimax", type: "prerequisite" },
        { from: "search", to: "csp", type: "prerequisite" },
        { from: "mdp", to: "qlearn", type: "prerequisite" },
        { from: "csp", to: "astar", type: "related" },
        { from: "bayes", to: "mdp", type: "prerequisite" },
        { from: "ghost", to: "astar", type: "prerequisite" }, // unknown key
        { from: "astar", to: "astar", type: "related" }, // self-loop
        { from: "astar", to: "search", type: "related" }, // duplicate pair (reversed)
        { from: "search", to: "astar", type: "prerequisite" }, // exact duplicate
        { from: "heur", to: "astar", type: "related" }, // duplicates the subconcept pair
      ],
      sourceText,
    });
    const idOf = (label: string): string => saved.nodes.find((n) => n.label === label)?.id ?? "missing";
    const A = {
      search: idOf("State-Space Search"), astar: idOf("A* Search"), heur: idOf("Admissible Heuristics"),
      minimax: idOf("Minimax"), csp: idOf("Constraint Satisfaction"), mdp: idOf("Markov Decision Processes"),
      qlearn: idOf("Q-Learning"), bayes: idOf("Bayes Rule"),
    };
    check("saveExtractedGraph: 8 nodes, 7 edges", saved.nodes.length === 8 && saved.edges.length === 7, { n: saved.nodes.length, e: saved.edges.length });
    check("concept ids", saved.nodes.every((n) => /^cpt_[a-z0-9]{10}$/.test(n.id)));
    const sub = saved.edges.filter((e) => e.relationType === "subconcept");
    check("subconcept edge child -> parent", sub.length === 1 && sub[0].source === A.heur && sub[0].target === A.astar, sub);
    check("in-course edges are not cross-course", saved.edges.every((e) => e.isCrossCourse === false));
    check("new nodes: S0, R~1, no confidence", saved.nodes.every((n) => n.stability === S0 && n.retention > 0.999 && n.confidence === null && n.confidenceSource === null));
    check("connectionCount matches edges (save)", saved.nodes.every((n) => n.connectionCount === touching(saved.edges, n.id)), saved.nodes.map((n) => [n.label, n.connectionCount]));
    check("expected degrees", saved.nodes.find((n) => n.id === A.search)?.connectionCount === 3 && saved.nodes.find((n) => n.id === A.astar)?.connectionCount === 3 && saved.nodes.find((n) => n.id === A.heur)?.connectionCount === 1);
    check("ingested rows in Tiger", (await tiger.countUserEvents(userId)) === 8);

    check("buildGraph(course) null while processing", (await svc.buildGraph(userId, courseA.id)) === null);
    const emptyMerged = await svc.buildGraph(userId);
    check("merged graph empty while processing", emptyMerged !== null && emptyMerged.courses.length === 0 && emptyMerged.nodes.length === 0);
    await svc.setCourseStatus(userId, courseA.id, "ready");
    await svc.saveCourseSkills(userId, courseA.id, ["Search", "Planning"], "Two sentences.");
    const gotA = await svc.getCourse(userId, courseA.id);
    check("getCourse after ready", gotA?.status === "ready" && gotA.conceptCount === 8 && gotA.industrySkills.length === 2 && gotA.skillsSummary === "Two sentences." && !("sourceText" in (gotA as object)), gotA);
    check("getCourse unknown -> null", (await svc.getCourse(userId, "crs_nope")) === null);

    const g1 = await svc.buildGraph(userId);
    check("merged graph: 1 course, 8 nodes, 7 edges", g1?.courses.length === 1 && g1.nodes.length === 8 && g1.edges.length === 7 && g1.crossCourseLinks.length === 0);
    check("merged graph connectionCount matches edges", !!g1 && g1.nodes.every((n) => n.connectionCount === touching(g1.edges, n.id)));
    check("merged graph retention ~1", !!g1 && g1.nodes.every((n) => n.retention > 0.999 && n.retention <= 1));
    check("graph hides userId", !leaksUser(g1));

    // ---------- 2. second course + cross-course links ----------
    const courseB = await svc.createCourse(userId, "ITEST Machine Learning");
    const savedB = await svc.saveExtractedGraph(userId, courseB.id, {
      concepts: [
        { key: "gd", label: "Gradient Descent", summary: "GD summary.", parentKey: null },
        { key: "nb", label: "Naive Bayes", summary: "NB summary.", parentKey: null },
        { key: "nn", label: "Neural Networks", summary: "NN summary.", parentKey: null },
      ],
      dependencies: [{ from: "gd", to: "nn", type: "prerequisite" }],
      sourceText: "Short notes about gradient descent and naive Bayes.",
    });
    await svc.setCourseStatus(userId, courseB.id, "ready");
    const B = {
      gd: savedB.nodes.find((n) => n.label === "Gradient Descent")?.id ?? "missing",
      nb: savedB.nodes.find((n) => n.label === "Naive Bayes")?.id ?? "missing",
      nn: savedB.nodes.find((n) => n.label === "Neural Networks")?.id ?? "missing",
    };
    const linkInput: CrossCourseLink[] = [
      { sourceCourseId: courseA.id, targetCourseId: courseB.id, sharedConceptIds: [A.bayes, A.mdp, B.nb], description: "Bayes theme." },
      { sourceCourseId: courseB.id, targetCourseId: courseA.id, sharedConceptIds: [B.gd, A.qlearn, "cpt_bogus00000"], description: "Iterative updates." },
      { sourceCourseId: courseA.id, targetCourseId: courseB.id, sharedConceptIds: [A.search, A.astar], description: "Only one course: dropped." },
    ];
    const linked = await svc.replaceCrossCourseLinks(userId, courseA.id, courseB.id, linkInput);
    check("links: 2 kept, 3 materialized edges", linked.links.length === 2 && linked.edges.length === 3, linked);
    check("materialized edges are cross-course", linked.edges.every((e) => e.relationType === "cross-course" && e.isCrossCourse === true));
    check("bogus id removed from link", linked.links.every((l) => !l.sharedConceptIds.includes("cpt_bogus00000")));
    check("edge orientation follows the link", linked.edges.some((e) => e.source === A.bayes && e.target === B.nb) && linked.edges.some((e) => e.source === A.mdp && e.target === B.nb) && linked.edges.some((e) => e.source === B.gd && e.target === A.qlearn), linked.edges);

    const g2 = await svc.buildGraph(userId);
    const count = (g: typeof g2, id: string): number => g?.nodes.find((n) => n.id === id)?.connectionCount ?? -1;
    check("merged graph: 2 courses, 11 nodes, 11 edges, 2 links", g2?.courses.length === 2 && g2.nodes.length === 11 && g2.edges.length === 11 && g2.crossCourseLinks.length === 2, g2 && { c: g2.courses.length, n: g2.nodes.length, e: g2.edges.length, l: g2.crossCourseLinks.length });
    check("merged graph has 3 cross-course edges", g2?.edges.filter((e) => e.isCrossCourse).length === 3);
    check("connectionCount includes cross-course edges", !!g2 && g2.nodes.every((n) => n.connectionCount === touching(g2.edges, n.id)));
    check("connectionCount increased", count(g2, A.bayes) === 2 && count(g2, A.mdp) === 3 && count(g2, B.nb) === 2 && count(g2, B.gd) === 2 && count(g2, A.qlearn) === 2, [count(g2, A.bayes), count(g2, A.mdp), count(g2, B.nb), count(g2, B.gd), count(g2, A.qlearn)]);
    const single = await svc.buildGraph(userId, courseA.id);
    check("single-course view: no cross edges, no links", single?.courses.length === 1 && single.nodes.length === 8 && single.edges.length === 7 && single.edges.every((e) => !e.isCrossCourse) && single.crossCourseLinks.length === 0);
    check("single-course view keeps whole-graph connectionCount", count(single, A.bayes) === 2);
    check("buildGraph unknown course -> null", (await svc.buildGraph(userId, "crs_nope")) === null);
    check("other user sees nothing", JSON.stringify(await svc.buildGraph(`${userId}-other`)) === JSON.stringify({ courses: [], nodes: [], edges: [], crossCourseLinks: [] }));
    check("listReadyCourses", (await svc.listReadyCourses(userId)).length === 2);

    await svc.setCourseStatus(userId, courseB.id, "failed", "boom");
    const failedB = await svc.getCourse(userId, courseB.id);
    const g3 = await svc.buildGraph(userId);
    check("failed course stores error", failedB?.status === "failed" && failedB.error === "boom");
    check("failed course leaves the graph", (await svc.buildGraph(userId, courseB.id)) === null && g3?.courses.length === 1 && g3.edges.every((e) => !e.isCrossCourse) && g3.crossCourseLinks.length === 0);
    await svc.setCourseStatus(userId, courseB.id, "ready");
    check("status back to ready clears error", (await svc.getCourse(userId, courseB.id))?.error === null);

    const relinked = await svc.replaceCrossCourseLinks(userId, courseB.id, courseA.id, [linkInput[0]]);
    const g4 = await svc.buildGraph(userId);
    check("replace is a replace (either direction)", relinked.links.length === 1 && relinked.edges.length === 2 && g4?.crossCourseLinks.length === 1 && g4.edges.filter((e) => e.isCrossCourse).length === 2);
    check("connectionCount drops after replace", count(g4, B.gd) === 1 && count(g4, A.qlearn) === 1 && count(g4, B.nb) === 2);

    // ---------- 3. self-review ----------
    const r1 = await svc.applySelfReview(userId, A.search, "got-it");
    check("got-it: S * 1.5, R = 1", near(r1.stability, 3) && r1.retention === 1 && r1.id === A.search, r1);
    const r2 = await svc.applySelfReview(userId, A.search, "still-shaky");
    check("still-shaky: S unchanged, retention capped at 0.4", near(r2.stability, 3) && near(r2.retention, 0.4, 0.001), r2);
    check("still-shaky: predicted forget date is the review time itself", near(new Date((await svc.getGuideEntry(userId, A.search))?.predictedForgetAt ?? 0).getTime(), new Date(r2.lastReviewed).getTime(), 1000));
    await new Promise((resolve) => setTimeout(resolve, 5)); // distinct timestamps: events in one millisecond would tie
    const r3 = await svc.applySelfReview(userId, A.search, "got-it");
    check("got-it after still-shaky restores retention to 1", r3.retention === 1 && near(r3.stability, 4.5), r3);
    check("Tiger latest state follows self-review", near((await tiger.latestStates(userId, [A.search])).get(A.search)?.stability, 4.5));
    let notFound = "";
    try {
      await svc.applySelfReview(userId, "cpt_nope", "got-it");
    } catch (err) {
      notFound = (err as Error).name;
    }
    check("unknown concept -> NotFoundError", notFound === "NotFoundError", notFound);

    // ---------- 4. assessments: the confidence table, row by row ----------
    const TOL = 0.01; // R_before is ~1 but not exactly 1 (milliseconds to seconds of latency)
    const a1 = await svc.applyAssessment(userId, A.astar, { source: "generated-quiz", mode: "full", score: 0.8 });
    check("full quiz: confidence = score, generated", a1.confidence === 0.8 && a1.confidenceSource === "generated-quiz" && near(a1.stability, 3.6, TOL) && a1.retention === 1, a1);
    check("quiz at 80% or better restores retention to 1", a1.retention === 1);
    const a2 = await svc.applyAssessment(userId, A.astar, { source: "uploaded-quiz", score: 0.3 });
    check("upload after FULL: uploaded score only", a2.confidence === 0.3 && a2.confidenceSource === "uploaded-quiz" && near(a2.stability, 3.6 * 0.7, TOL), a2);
    const m1 = await svc.applyAssessment(userId, A.minimax, { source: "uploaded-quiz", score: 0.6 });
    check("upload first: uploaded score", m1.confidence === 0.6 && m1.confidenceSource === "uploaded-quiz" && near(m1.stability, 3.2, TOL), m1);
    const m2 = await svc.applyAssessment(userId, A.minimax, { source: "generated-quiz", mode: "short", score: 0.9 });
    check("short after upload: mean, uploaded", near(m2.confidence, 0.75) && m2.confidenceSource === "uploaded-quiz" && near(m2.stability, 3.2 * (1 + 0.9 * (2 - 0.7875)), 2 * TOL) && m2.retention === 1, m2);
    check("weak-ish quiz leaves retention below 1 (0.6 -> 0.7875)", near(m1.retention, 0.7875, 0.001), m1);
    const m3 = await svc.applyAssessment(userId, A.minimax, { source: "generated-quiz", mode: "full", score: 0.5 });
    check("full quiz overrides, p = 0.5 grows S", m3.confidence === 0.5 && m3.confidenceSource === "generated-quiz" && near(m3.stability, 3.2 * (1 + 0.9 * (2 - 0.7875)) * 1.5, 4 * TOL) && near(m3.retention, 0.68125, 0.001), m3);
    const m4 = await svc.applyAssessment(userId, A.minimax, { source: "generated-quiz", mode: "short", score: 0.7 });
    check("full quiz cleared lastUploaded (short alone = its score)", m4.confidence === 0.7 && m4.confidenceSource === "generated-quiz", m4);
    const c1 = await svc.applyAssessment(userId, A.csp, { source: "generated-quiz", mode: "short", score: 0.4 });
    check("short without upload: its score, generated; p < 0.5 shrinks S", c1.confidence === 0.4 && c1.confidenceSource === "generated-quiz" && near(c1.stability, 1.4, TOL) && near(c1.retention, 0.575, 0.001), c1);
    check("poor quiz (40%) lowers retention to 0.575", near(c1.retention, 0.575, 0.001));
    const c2 = await svc.applyAssessment(userId, A.csp, { source: "uploaded-quiz", score: 0.8 });
    check("upload after SHORT: mean, uploaded", near(c2.confidence, 0.6) && c2.confidenceSource === "uploaded-quiz" && near(c2.stability, 1.4 * (1 + 0.8 * (2 - 0.575)), TOL), c2);
    const h1 = await svc.applyAssessment(userId, A.heur, { source: "generated-quiz", mode: "full", score: 1.7 });
    check("score is clamped to 1", h1.confidence === 1, h1);

    // ---------- 5. backdated quiz history -> anomalous z-score ----------
    const now = Date.now();
    await tiger.insertEvents(
      [3, 2, 1].map((daysAgo) => ({
        ts: new Date(now - daysAgo * DAY), userId, courseId: courseA.id, conceptId: A.mdp,
        eventType: "generated-quiz" as const, result: 0.2, predictedRetention: 0.9, stabilityBefore: 2, stabilityAfter: 1.4,
      })),
    );
    // Independent expectation: each live quiz above is compared with the retention it started from,
    // which earlier quizzes on the same concept may have left below 1.
    const residuals = [0.8 - 1, 0.3 - 1, 0.6 - 1, 0.9 - 0.7875, 0.5 - 1, 0.7 - 0.68125, 0.4 - 1, 0.8 - 0.575, 1 - 1].concat([-0.7, -0.7, -0.7]);
    const mean = residuals.reduce((x, y) => x + y, 0) / residuals.length;
    const sigma = Math.max(0.15, Math.sqrt(residuals.reduce((x, y) => x + (y - mean) ** 2, 0) / (residuals.length - 1)));
    const expectedZ = (-0.7 * Math.sqrt(3)) / sigma;

    const before = await svc.decayStatus(userId, courseA.id);
    check("decayStatus before recalculate: mdp not yet flagged", before?.concepts.find((x) => x.conceptId === A.mdp)?.anomalous === false && before.scannedAt === null);
    const status = await svc.decayStatus(userId, courseA.id, { recalculate: true });
    const mdp = status?.concepts.find((x) => x.conceptId === A.mdp);
    check("decayStatus shape", status?.courseId === courseA.id && status.threshold === 0.5 && status.concepts.length === 8 && typeof status.scannedAt === "string" && !leaksUser(status));
    check("z-score matches the formula", near(mdp?.zScore, expectedZ, 0.06), { got: mdp?.zScore, expectedZ });
    check("mdp anomalous, reviewCount 3", mdp?.anomalous === true && mdp.reviewCount === 3, mdp);
    check("reviewCount excludes ingested", status?.concepts.find((x) => x.conceptId === A.search)?.reviewCount === 3 && status.concepts.find((x) => x.conceptId === A.qlearn)?.reviewCount === 0 && status.concepts.find((x) => x.conceptId === A.minimax)?.reviewCount === 4);
    check("no quiz events -> zScore null", status?.concepts.find((x) => x.conceptId === A.qlearn)?.zScore === null && status.concepts.find((x) => x.conceptId === A.qlearn)?.anomalous === false);
    check("n = 1 is never anomalous", status?.concepts.find((x) => x.conceptId === A.heur)?.anomalous === false);
    check("summary counts", !!status && status.summary.anomalousCount === status.concepts.filter((x) => x.anomalous).length && status.summary.anomalousCount >= 1 && status.summary.atRiskCount === status.concepts.filter((x) => x.retention < 0.5).length && near(status.summary.averageRetention, status.concepts.reduce((t, x) => t + x.retention, 0) / status.concepts.length, 0.001), status?.summary);
    check("predictedForgetAt = lastReviewed + S ln 2 (R0 = 1)", !!mdp && near(new Date(mdp.predictedForgetAt).getTime(), new Date(mdp.lastReviewed).getTime() + mdp.stability * Math.LN2 * DAY, 1000));
    const mm = status?.concepts.find((x) => x.conceptId === A.minimax);
    check("scan keeps the lowered start retention (minimax left at R0 0.89375 by its last quiz)", !!mm && near(mm.retention, 0.89375, 0.002), mm?.retention);
    check("predictedForgetAt = lastReviewed + S ln(R0 / 0.5)", !!mm && near(new Date(mm.predictedForgetAt).getTime(), new Date(mm.lastReviewed).getTime() + mm.stability * Math.log(0.89375 / 0.5) * DAY, 10_000)); // S is rounded to 4 decimals in the API
    check("decayStatus unknown course -> null", (await svc.decayStatus(userId, "crs_nope")) === null);

    // Tiger is the source of truth: a stale Mongo cache is repaired by the scan.
    const cols = await mongo.collections();
    const trueLastReviewed = (await svc.getGuideEntry(userId, A.bayes))?.lastReviewed ?? "";
    await cols.concepts.updateOne({ userId, id: A.bayes }, { $set: { lastReviewed: new Date(now - 10 * DAY).toISOString() } });
    const repaired = await svc.decayStatus(userId, courseA.id, { recalculate: true });
    check("scan repairs a stale Mongo cache from Tiger", repaired?.concepts.find((x) => x.conceptId === A.bayes)?.lastReviewed === trueLastReviewed, { trueLastReviewed, got: repaired?.concepts.find((x) => x.conceptId === A.bayes)?.lastReviewed });

    // ---------- 6. guide ----------
    const guide = await svc.buildGuide(userId);
    check("guide: every concept of ready courses", guide.length === 11 && !leaksUser(guide));
    check("guide sorted by urgency desc", guide.every((e, i) => i === 0 || guide[i - 1].urgency >= e.urgency), guide.map((e) => e.urgency));
    check("guide urgency = formula", guide.every((e) => near(e.urgency, urgency(e.retention, e.confidence, e.zScore), 1e-3)));
    const gm = guide.find((e) => e.conceptId === A.mdp);
    check("guide entry carries cached z-score", gm?.anomalous === true && near(gm.zScore, expectedZ, 0.06) && gm.courseName === "ITEST Intro to AI" && gm.summary === "MDP summary." && gm.explanation === null && gm.resources.length === 0 && gm.generatedAt === null, gm);
    check("applyAssessment refreshed the cached z-score", typeof guide.find((e) => e.conceptId === A.astar)?.zScore === "number");
    const savedEntry = await svc.saveGuideContent(userId, A.qlearn, {
      summary: "Personalized summary.", explanation: "## Q-Learning\nBody.", resources: [{ title: "Video", url: "https://www.youtube.com/results?search_query=q-learning", type: "video" }],
    });
    const reread = await svc.getGuideEntry(userId, A.qlearn);
    check("saveGuideContent", savedEntry.explanation === "## Q-Learning\nBody." && savedEntry.summary === "Personalized summary." && savedEntry.resources.length === 1 && typeof savedEntry.generatedAt === "string" && JSON.stringify(reread) !== "null" && reread?.explanation === savedEntry.explanation);
    check("getGuideEntry unknown -> null", (await svc.getGuideEntry(userId, "cpt_nope")) === null);
    let saveMissing = "";
    try {
      await svc.saveGuideContent(userId, "cpt_nope", { summary: "", explanation: "", resources: [] });
    } catch (err) {
      saveMissing = (err as Error).name;
    }
    check("saveGuideContent unknown -> NotFoundError", saveMissing === "NotFoundError");
    const ctx = await svc.getConceptContext(userId, A.qlearn);
    check("getConceptContext", ctx?.node.id === A.qlearn && ctx.courseName === "ITEST Intro to AI" && ctx.summary === "Personalized summary." && ctx.explanation !== null && ctx.resources.length === 1 && !leaksUser(ctx));
    check("sourceExcerpt is a window around the label", !!ctx && ctx.sourceExcerpt.includes("Notes on Q-Learning") && ctx.sourceExcerpt.length <= 6000 && ctx.sourceExcerpt.length > 3000, ctx?.sourceExcerpt.length);
    const ctx2 = await svc.getConceptContext(userId, A.bayes);
    check("sourceExcerpt falls back to the beginning", !!ctx2 && ctx2.sourceExcerpt === sourceText.slice(0, 6000));
    check("getConceptContext unknown -> null", (await svc.getConceptContext(userId, "cpt_nope")) === null);
    const briefs = await svc.listConceptBriefs(userId, courseA.id);
    check("listConceptBriefs", briefs.length === 8 && briefs.every((b) => b.id && b.label && typeof b.summary === "string") && Object.keys(briefs[0]).sort().join() === "id,label,summary");

    // ---------- 7. quizzes ----------
    const quiz: StoredQuiz = {
      quizId: `quiz_${Math.random().toString(36).slice(2, 12)}`, conceptId: A.astar, mode: "short", createdAt: new Date().toISOString(), submittedAt: null,
      questions: [{ id: "q1", prompt: "P?", options: ["a", "b", "c", "d"], difficulty: "easy", points: 1, correctIndex: 2, explanation: "Because." }],
    };
    await svc.saveQuiz(userId, quiz);
    const q1 = await svc.getQuiz(userId, quiz.quizId);
    check("saveQuiz / getQuiz round trip", JSON.stringify(q1) === JSON.stringify(quiz), q1);
    check("quiz is user-scoped", (await svc.getQuiz(`${userId}-other`, quiz.quizId)) === null && (await svc.getQuiz(userId, "quiz_nope")) === null);
    await svc.markQuizSubmitted(userId, quiz.quizId);
    const q2 = await svc.getQuiz(userId, quiz.quizId);
    check("markQuizSubmitted", typeof q2?.submittedAt === "string" && q2.questions[0].correctIndex === 2);

    // ---------- 8. scheduled scan ----------
    await tiger.insertEvents(
      [2, 1].map((daysAgo) => ({
        ts: new Date(now - daysAgo * DAY), userId, courseId: courseB.id, conceptId: B.nn,
        eventType: "uploaded-quiz" as const, result: 0.1, predictedRetention: 0.95, stabilityBefore: 2, stabilityAfter: 1.4,
      })),
    );
    const scan = await svc.runDecayScan();
    const mineAnomalous = scan.newlyAnomalous.filter((x) => x.userId === userId);
    check("runDecayScan counts", scan.conceptsScanned >= 11, scan.conceptsScanned);
    check("runDecayScan: newly anomalous only", mineAnomalous.some((x) => x.conceptId === B.nn && x.courseName === "ITEST Machine Learning") && !mineAnomalous.some((x) => x.conceptId === A.mdp), mineAnomalous);
    const scan2 = await svc.runDecayScan();
    check("second scan reports nothing new for this user", !scan2.newlyAnomalous.some((x) => x.userId === userId) && !scan2.newlyAtRisk.some((x) => x.userId === userId));
  } catch (err) {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    failures.push(`THROWN ${message.replace(/[a-z+]+:\/\/\S*/gi, "[redacted-url]")}`);
    log(failures[failures.length - 1]);
  } finally {
    // ---------- cleanup: nothing of this user may remain ----------
    try {
      const deletedDocs = await mongo.deleteUserData(userId);
      const deletedRows = await tiger.deleteUserEvents(userId);
      const leftDocs = Object.values(await mongo.countUserData(userId)).reduce((x, y) => x + y, 0);
      const leftRows = await tiger.countUserEvents(userId);
      log(`cleanup: deleted mongo ${JSON.stringify(deletedDocs)}, tiger rows ${deletedRows}`);
      check("cleanup leaves nothing behind", leftDocs === 0 && leftRows === 0, { leftDocs, leftRows });
    } catch (err) {
      failures.push(`CLEANUP FAILED ${(err as Error).name}`);
      log(failures[failures.length - 1]);
    }
  }
  return failures;
}
