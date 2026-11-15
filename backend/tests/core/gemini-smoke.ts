// LIVE Gemini smoke test. Calls the real API with the real key.
//   cd backend && npx tsx --env-file=../.env tests/core/gemini-smoke.ts
// Prints counts, timings and a few labels only. Exits 1 if any invariant fails.

import assert from "node:assert/strict";
import { FULL_QUIZ_MIX, type ConceptBrief, type ConceptContext, type Difficulty } from "../../lambda/lib/contracts";
import {
  compareCourses,
  extractConcepts,
  generateQuiz,
  generateTutoring,
  parseDigitalQuiz,
  tagSkills,
} from "../../lambda/lib/gemini";
import { modelName } from "../../lambda/lib/gemini/client";

const NOTES = `CSE 330 Operating Systems - Lecture 7: CPU Scheduling

Why scheduling matters. A process alternates between CPU bursts and I/O bursts. Whenever the CPU goes idle the short-term scheduler picks one process from the ready queue and the dispatcher gives it the CPU. The dispatcher performs the context switch: it saves the registers and program counter of the old process into its process control block (PCB), loads the state of the new one and jumps to user mode. The time this takes is dispatch latency and it is pure overhead.

Preemptive vs non-preemptive. Under non-preemptive scheduling a process keeps the CPU until it terminates or blocks for I/O. Under preemptive scheduling the OS can take the CPU away, usually on a timer interrupt or when a higher-priority process becomes ready. Preemption needs care with shared kernel data, which is why we need synchronization (next unit: locks and semaphores).

Scheduling criteria. CPU utilization (keep the CPU busy), throughput (processes finished per time unit), turnaround time (submission to completion), waiting time (time spent in the ready queue) and response time (submission to first response). Interactive systems care most about response time; batch systems care about throughput and turnaround.

First-Come First-Served (FCFS). Simplest policy, a FIFO queue, non-preemptive. Problem: the convoy effect. One long CPU-bound job at the front makes every short job wait. Example: bursts P1=24, P2=3, P3=3 arriving in that order give waiting times 0, 24, 27, average 17 ms. In the order P2, P3, P1 the average is only 3 ms.

Shortest Job First (SJF). Run the process with the shortest next CPU burst. Provably optimal for average waiting time. The catch is that we cannot know the next burst length, so we predict it with exponential averaging: tau(n+1) = alpha * t(n) + (1 - alpha) * tau(n), where t(n) is the last measured burst and alpha (commonly 0.5) controls how much history matters. The preemptive version is Shortest Remaining Time First (SRTF): if a new arrival has a shorter burst than what is left of the running process, preempt.

Priority scheduling. Each process has a priority number and the CPU goes to the highest priority. SJF is a special case where priority is the predicted burst. Main problem: starvation (indefinite blocking) of low-priority processes. Fix: aging, which gradually raises the priority of processes that wait a long time.

Round Robin (RR). Designed for time sharing. Each process gets a small time quantum q (10-100 ms); when it expires a timer interrupt preempts the process and puts it at the tail of the ready queue. With n processes nobody waits more than (n-1)q. Choosing q is a trade-off: if q is very large RR degenerates into FCFS; if q is very small the context-switch overhead dominates. Rule of thumb: 80% of CPU bursts should be shorter than q. RR usually has a higher average turnaround than SJF but much better response time.

Multilevel queue. Split the ready queue into separate queues, for example foreground (interactive, RR) and background (batch, FCFS), with fixed-priority or time-slice scheduling between the queues. Processes never move between queues.

Multilevel feedback queue (MLFQ). Processes can move between queues. A process that uses its whole quantum is demoted to a lower-priority queue with a longer quantum; a process that waits too long is promoted (aging again). This approximates SRTF without knowing burst lengths and favours I/O-bound interactive jobs. Parameters: number of queues, the algorithm per queue, and the promotion and demotion rules.

Multiprocessor scheduling. Symmetric multiprocessing (SMP) lets each core schedule itself, with a common ready queue or per-core queues. Processor affinity: keep a process on the same core because its cache is warm (soft vs hard affinity). Load balancing evens out the queues with push migration and pull migration, and it works against affinity.

Evaluation. Deterministic modelling with Gantt charts on a fixed workload, queueing models, and simulation with traces.`;

const DB_CONCEPTS: ConceptBrief[] = [
  { id: "db-1", label: "Transactions", summary: "A unit of work that must run with ACID guarantees." },
  { id: "db-2", label: "Two-Phase Locking", summary: "Transactions acquire locks in a growing phase and release them in a shrinking phase to stay serializable." },
  { id: "db-3", label: "Deadlock Detection", summary: "A waits-for graph is checked for cycles and a victim transaction is aborted." },
  { id: "db-4", label: "B+ Tree Indexes", summary: "A balanced tree that keeps keys sorted for fast range and point lookups." },
  { id: "db-5", label: "Query Optimizer", summary: "Chooses the cheapest execution plan using cost estimates and statistics." },
  { id: "db-6", label: "Buffer Pool", summary: "Caches disk pages in memory and evicts them with a replacement policy such as LRU or clock." },
  { id: "db-7", label: "Lock Starvation", summary: "A transaction waits indefinitely because others keep being granted the lock first." },
  { id: "db-8", label: "Normalization", summary: "Decomposing tables to remove redundancy and update anomalies." },
];

const DIGITAL_QUIZ = `Quiz 3: CPU Scheduling
Due Oct 12 at 11:59pm   Points 10   Questions 5   Time Limit 20 Minutes
Attempt History  Attempt 1   12 minutes   7 out of 10
Score for this quiz: 7 out of 10
Submitted Oct 11 at 8:14pm

Question 1   2 / 2 pts
In Round Robin scheduling, what happens when a process's time quantum expires?
Correct!  It is preempted and moved to the tail of the ready queue
It terminates
It is moved to the waiting queue until I/O completes
It keeps the CPU until it blocks

Question 2   0 / 2 pts
If the Round Robin time quantum is made extremely large, the policy behaves like:
You Answered  Shortest Job First
Correct Answer  First-Come First-Served
Priority scheduling
Multilevel feedback queue

Question 3   2 / 2 pts
Which technique prevents starvation in priority scheduling?
Correct!  Aging
Paging
Swapping
Spooling

Question 4   1 / 2 pts
With 5 processes in the ready queue and a Round Robin quantum of 20 ms, the maximum time a process waits before its next turn is ____ ms.
You Answered  100
Correct Answer  80

Question 5   2 / 2 pts
The convoy effect is associated with which algorithm?
Correct!  FCFS
SJF
Round Robin
MLFQ

Quiz Score: 7 out of 10`;

const NOT_A_QUIZ = `Grocery list for the week
- oat milk, two cartons
- brown rice, lentils, canned tomatoes
- call the landlord about the heater on Tuesday
- return library books before Friday
Meal plan: Monday curry, Tuesday pasta, Wednesday leftovers, Thursday stir fry.`;

let failures = 0;
async function step<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
  const startedAt = Date.now();
  try {
    const out = await fn();
    console.log(`PASS ${name} (${Date.now() - startedAt} ms)`);
    return out;
  } catch (err) {
    failures++;
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.log(`FAIL ${name} (${Date.now() - startedAt} ms): ${message.slice(0, 400)}`);
    return null;
  }
}

const words = (text: string) => text.split(/\s+/).filter(Boolean).length;

async function main() {
  console.log(`model: ${modelName()}  notes: ${words(NOTES)} words`);

  // ---- extractConcepts ----
  const extraction = await step("extractConcepts", async () => {
    const out = await extractConcepts(NOTES, "Operating Systems");
    const keys = out.concepts.map((c) => c.key);
    const top = out.concepts.filter((c) => !c.parentKey);
    assert.equal(new Set(keys).size, keys.length, "keys are unique");
    assert.ok(top.length >= 8 && top.length <= 20, `8-20 top-level concepts, got ${top.length}`);
    assert.ok(out.concepts.length <= 40, "at most 40 nodes");
    for (const c of out.concepts) {
      assert.match(c.key, /^[a-z0-9]+(-[a-z0-9]+)*$/, `slug key: ${c.key}`);
      assert.ok(c.label.length > 0 && c.summary.length >= 20, `label and summary present for ${c.key}`);
      if (c.parentKey) {
        const parent = out.concepts.find((p) => p.key === c.parentKey);
        assert.ok(parent && !parent.parentKey, `parent of ${c.key} exists and is top-level`);
        assert.ok(out.concepts.filter((x) => x.parentKey === c.parentKey).length <= 3, "at most 3 sub-concepts");
      }
    }
    assert.ok(out.dependencies.length >= 3, `some dependencies, got ${out.dependencies.length}`);
    for (const d of out.dependencies) {
      assert.ok(keys.includes(d.from) && keys.includes(d.to) && d.from !== d.to, "dependency keys resolve");
      assert.ok(d.type === "prerequisite" || d.type === "related");
    }
    console.log(
      `     concepts=${out.concepts.length} topLevel=${top.length} sub=${out.concepts.length - top.length} deps=${out.dependencies.length} ` +
        `(prereq=${out.dependencies.filter((d) => d.type === "prerequisite").length})`,
    );
    console.log(`     labels: ${top.slice(0, 6).map((c) => c.label).join(" | ")}`);
    return out;
  });

  const labels = extraction?.concepts.map((c) => c.label) ?? ["Round Robin", "Shortest Job First", "Context Switch"];

  // ---- tagSkills ----
  await step("tagSkills", async () => {
    const out = await tagSkills("Operating Systems", labels);
    assert.ok(out.industrySkills.length >= 4 && out.industrySkills.length <= 8, "4-8 skills");
    assert.equal(new Set(out.industrySkills.map((s) => s.toLowerCase())).size, out.industrySkills.length, "skills unique");
    const sentences = out.skillsSummary.split(/(?<=[.!?])\s+/).filter(Boolean).length;
    assert.ok(sentences >= 2 && sentences <= 4, `2-3 sentence summary, got ${sentences}`);
    console.log(`     skills=${out.industrySkills.length}: ${out.industrySkills.slice(0, 4).join(" | ")}  summarySentences=${sentences}`);
  });

  // ---- shared concept context ----
  const rr = extraction?.concepts.find((c) => /round/i.test(c.label));
  const ctx: ConceptContext = {
    node: {
      id: "c-rr",
      label: rr?.label ?? "Round Robin",
      courseId: "course-os",
      lastReviewed: new Date(Date.now() - 3 * 86_400_000).toISOString(),
      stability: 2.4,
      retention: 0.29,
      confidence: 0.42,
      confidenceSource: "generated-quiz",
      connectionCount: 4,
    },
    courseName: "Operating Systems",
    summary: rr?.summary ?? "Each process runs for a fixed time quantum and is then moved to the back of the ready queue.",
    explanation: null,
    resources: [],
    generatedAt: null,
    sourceExcerpt: NOTES.slice(NOTES.indexOf("Round Robin (RR)"), NOTES.indexOf("Multilevel queue.")),
  };
  const profile =
    "Prefers worked numeric examples over abstract definitions. Missed quiz questions about choosing the time quantum and about how Round Robin compares to FCFS. Self-rated 'still shaky' on Round Robin twice this week.";

  // ---- generateTutoring ----
  await step("generateTutoring", async () => {
    const out = await generateTutoring(ctx, profile);
    assert.ok(out.summary.length >= 20, "summary present");
    const n = words(out.explanation);
    assert.ok(n >= 150 && n <= 900, `explanation 150-900 words, got ${n}`);
    assert.ok(!/https?:\/\//.test(out.explanation), "no URLs in the explanation");
    assert.ok(out.resources.length >= 3 && out.resources.length <= 5, "3-5 resources");
    for (const r of out.resources) {
      assert.ok(["video", "article", "practice"].includes(r.type));
      const prefix = r.type === "video" ? "https://www.youtube.com/results?search_query=" : "https://www.google.com/search?q=";
      assert.ok(r.url.startsWith(prefix) && r.url.length > prefix.length, `server-built URL for ${r.type}`);
      assert.ok(r.title.length > 0);
    }
    console.log(
      `     explanationWords=${n} headings=${(out.explanation.match(/^##/gm) ?? []).length} resources=${out.resources.map((r) => r.type).join(",")}`,
    );
  });

  // ---- generateQuiz: full ----
  await step("generateQuiz(full)", async () => {
    const out = await generateQuiz(ctx, profile, "full");
    assert.equal(out.length, 10, "exactly 10 questions");
    for (const d of ["easy", "medium", "hard"] as Difficulty[]) {
      const qs = out.filter((q) => q.difficulty === d);
      assert.equal(qs.length, FULL_QUIZ_MIX[d].count, `${d} count`);
      assert.ok(qs.every((q) => q.points === FULL_QUIZ_MIX[d].points), `${d} points`);
    }
    assert.equal(out.reduce((s, q) => s + q.points, 0), 19, "19 points total");
    checkQuestions(out);
    console.log(`     order=${out.map((q) => q.difficulty[0]).join("")} correctIndexes=${out.map((q) => q.correctIndex).join("")}`);
  });

  // ---- generateQuiz: short ----
  await step("generateQuiz(short)", async () => {
    const out = await generateQuiz(ctx, profile, "short");
    assert.ok(out.length >= 3 && out.length <= 5, "3-5 questions");
    assert.deepEqual(out.map((q) => q.points), out.map((_, i) => i + 1), "question k is worth k points");
    const rank = { easy: 0, medium: 1, hard: 2 };
    for (let i = 1; i < out.length; i++) {
      assert.ok(rank[out[i].difficulty] >= rank[out[i - 1].difficulty], "ordered easiest to hardest");
    }
    checkQuestions(out);
    console.log(`     questions=${out.length} order=${out.map((q) => q.difficulty[0]).join("")} points=${out.map((q) => q.points).join(",")}`);
  });

  // ---- parseDigitalQuiz ----
  await step("parseDigitalQuiz(digital export, relevant concept)", async () => {
    const out = await parseDigitalQuiz(DIGITAL_QUIZ, "Round Robin");
    assert.ok(out.ok, `expected ok, got ${JSON.stringify(out)}`);
    // Questions 1, 2 and 4 are about Round Robin: 2/2 + 0/2 + 1/2 = 3 of 6.
    assert.ok(out.totalPoints > 0 && out.pointsEarned >= 0 && out.pointsEarned <= out.totalPoints, "points in range");
    assert.ok(out.questionCount >= 2 && out.questionCount <= 4, `2-4 relevant questions, got ${out.questionCount}`);
    assert.ok(out.totalPoints < 10, "does not count the whole quiz");
    console.log(`     earned=${out.pointsEarned} total=${out.totalPoints} questions=${out.questionCount} (expected 3/6 over 3)`);
  });

  await step("parseDigitalQuiz(no relevant questions)", async () => {
    const out = await parseDigitalQuiz(DIGITAL_QUIZ, "B+ Tree Indexes");
    assert.deepEqual(out, { ok: false, reason: "no-relevant-questions" });
  });

  await step("parseDigitalQuiz(not a quiz)", async () => {
    const out = await parseDigitalQuiz(NOT_A_QUIZ, "Round Robin");
    assert.deepEqual(out, { ok: false, reason: "not-digital" });
  });

  await step("parseDigitalQuiz(digital export without points)", async () => {
    const stripped = DIGITAL_QUIZ.replace(/\s+\d \/ \d pts/g, "").replace(/.*out of 10.*\n?/g, "").replace(/Points 10\s+/, "");
    const out = await parseDigitalQuiz(stripped, "Round Robin");
    assert.equal(out.ok, false);
    if (!out.ok) assert.ok(["no-points-found", "not-digital"].includes(out.reason), `reason ${out.reason}`);
    console.log(`     reason=${out.ok ? "ok" : out.reason}`);
  });

  await step("parseDigitalQuiz(empty OCR, no API call)", async () => {
    assert.deepEqual(await parseDigitalQuiz("  \n ", "Round Robin"), { ok: false, reason: "unreadable" });
  });

  // ---- compareCourses ----
  await step("compareCourses", async () => {
    const osConcepts: ConceptBrief[] = (extraction?.concepts ?? []).map((c, i) => ({ id: `os-${i + 1}`, label: c.label, summary: c.summary }));
    assert.ok(osConcepts.length > 0, "needs the extraction result");
    const a = { id: "course-os", name: "Operating Systems", concepts: osConcepts };
    const b = { id: "course-db", name: "Database Systems", concepts: DB_CONCEPTS };
    const out = await compareCourses(a, b);
    assert.ok(out.length <= 6, "at most 6 links");
    const aIds = new Set(osConcepts.map((c) => c.id));
    const bIds = new Set(DB_CONCEPTS.map((c) => c.id));
    for (const link of out) {
      assert.equal(link.sourceCourseId, "course-os");
      assert.equal(link.targetCourseId, "course-db");
      assert.ok(link.sharedConceptIds.every((id) => aIds.has(id) || bIds.has(id)), "only real concept ids");
      assert.ok(link.sharedConceptIds.some((id) => aIds.has(id)), "at least one id from course A");
      assert.ok(link.sharedConceptIds.some((id) => bIds.has(id)), "at least one id from course B");
      assert.ok(link.description.length >= 15, "description present");
    }
    assert.ok(out.length >= 1, "OS scheduling and DB concurrency share at least one theme (starvation, locking)");
    const label = (id: string) => [...osConcepts, ...DB_CONCEPTS].find((c) => c.id === id)?.label;
    console.log(`     links=${out.length}`);
    for (const link of out.slice(0, 3)) console.log(`     ${link.sharedConceptIds.map(label).join(" <-> ")}`);
  });

  console.log(failures === 0 ? "\nALL GEMINI SMOKE CHECKS PASSED" : `\n${failures} SMOKE CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

function checkQuestions(questions: { id: string; prompt: string; options: string[]; correctIndex: number; explanation: string }[]) {
  assert.equal(new Set(questions.map((q) => q.id)).size, questions.length, "ids unique");
  for (const q of questions) {
    assert.ok(q.prompt.length > 10, "prompt present");
    assert.equal(q.options.length, 4, "exactly 4 options");
    assert.equal(new Set(q.options).size, 4, "options distinct");
    assert.ok(Number.isInteger(q.correctIndex) && q.correctIndex >= 0 && q.correctIndex <= 3, "correctIndex 0-3");
    assert.ok(q.explanation.length > 0, "explanation present");
  }
  assert.ok(new Set(questions.map((q) => q.correctIndex)).size >= 2, "the right answer is not always in the same position");
}

main().catch((err) => {
  console.log(`smoke script crashed: ${err instanceof Error ? err.name : "unknown error"}`);
  process.exit(1);
});
