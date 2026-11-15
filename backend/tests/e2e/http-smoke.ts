// HTTP contract smoke test for the Synapse API (CONTRACTS.md section 3).
// Works against the local server, the fake-backed server, or the deployed API.
//
// From /backend:
//   npx tsx tests/e2e/http-smoke.ts                               local, user "dev-user", needs seeded data
//   BASE_URL=https://xxxx.execute-api.us-east-2.amazonaws.com TOKEN=<cognito id token> npx tsx tests/e2e/http-smoke.ts
//   ... --uploads      also runs the S3-backed flows: note upload -> ingest -> graph, digital quiz upload
//
// Mutates the target user's data (reviews, quizzes, links, and a new course with --uploads).

const BASE = (process.env.BASE_URL ?? "http://localhost:3001").replace(/\/+$/, "");
const TOKEN = process.env.TOKEN;
const WITH_UPLOADS = process.argv.includes("--uploads");

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    passed++;
    console.log(`PASS ${name}`);
  } else {
    failures.push(`${name}${detail ? ` (${detail})` : ""}`);
    console.log(`FAIL ${name}${detail ? ` (${detail})` : ""}`);
  }
}

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any; ms: number }> {
  const started = Date.now();
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : { "x-dev-user": "dev-user" }),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { unparsed: text.slice(0, 200) };
  }
  return { status: res.status, json, ms: Date.now() - started };
}

const NODE_KEYS = ["id", "label", "courseId", "lastReviewed", "stability", "retention", "confidence", "confidenceSource", "connectionCount"];
const isNode = (n: any): boolean =>
  n && NODE_KEYS.every((k) => k in n) && Object.keys(n).length === NODE_KEYS.length && n.retention >= 0 && n.retention <= 1;
const isErrorShape = (j: any): boolean => typeof j?.error?.code === "string" && typeof j?.error?.message === "string";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function uploadText(fileName: string, purpose: "notes" | "quiz", content: string): Promise<string | null> {
  const pre = await call("POST", "/uploads/presign", { fileName, contentType: "text/plain", purpose });
  check(`presign ${purpose} -> 200 with uploadUrl and s3Key`, pre.status === 200 && !!pre.json?.uploadUrl && !!pre.json?.s3Key, `status ${pre.status}`);
  if (pre.status !== 200) return null;
  const put = await fetch(pre.json.uploadUrl, { method: "PUT", headers: { "content-type": "text/plain" }, body: content });
  check(`PUT ${purpose} file to presigned URL`, put.ok, `status ${put.status}`);
  return put.ok ? pre.json.s3Key : null;
}

const NOTES = `CSE 310 Data Structures and Algorithms - lecture notes, weeks 5-7

Hash tables. A hash table stores key-value pairs in an array of buckets. A hash function maps a key to a
bucket index. A good hash function spreads keys uniformly. The load factor is n/m, items over buckets.
Collisions happen when two keys map to the same bucket. Chaining resolves collisions by keeping a linked list
per bucket; average lookup is O(1 + load factor). Open addressing instead probes for another slot: linear
probing checks the next slot and suffers primary clustering; double hashing uses a second hash function for
the step size. When the load factor passes a threshold we resize and rehash every key, which is O(n) but
amortized O(1) per insert.

Binary search trees. A BST keeps keys ordered: left subtree smaller, right subtree larger. Search, insert and
delete are O(h) where h is the height. An unbalanced BST can degrade to a linked list with h = n.
Balanced trees fix this. AVL trees keep the heights of the two subtrees of every node within one, restoring
balance with rotations (single and double). Red-black trees use node colors and guarantee h <= 2 log(n+1).
Tree traversals: in-order visits keys in sorted order; pre-order and post-order are used for copying and
deleting trees.

Heaps and priority queues. A binary heap is a complete binary tree stored in an array where each parent is
no larger than its children (min-heap). Insert sifts up, extract-min sifts down, both O(log n). Build-heap
runs in O(n). Heapsort uses a heap to sort in O(n log n) in place. A priority queue is the abstract data type;
a heap is the usual implementation.

Graphs. Represented by adjacency lists (space O(V+E)) or an adjacency matrix (O(V^2)). Breadth-first search
uses a queue and finds shortest paths in unweighted graphs. Depth-first search uses a stack or recursion and
is the basis of topological sort and cycle detection. Dijkstra's algorithm finds shortest paths with
non-negative weights using a priority queue in O((V+E) log V); it relies on the heap operations above.
`;

async function main(): Promise<void> {
  console.log(`target: ${BASE}  auth: ${TOKEN ? "bearer token" : "x-dev-user"}  uploads: ${WITH_UPLOADS}`);

  // ---- graph ----
  const graph = await call("GET", "/graph");
  check("GET /graph -> 200", graph.status === 200, `status ${graph.status}`);
  const g = graph.json ?? {};
  check("GraphResponse has the four arrays", ["courses", "nodes", "edges", "crossCourseLinks"].every((k) => Array.isArray(g[k])));
  if (!g.courses?.length) {
    console.log("No courses for this user: seed first, or run with --uploads on an empty account.");
  }
  check("every node matches the Node schema exactly", (g.nodes ?? []).every(isNode));
  const ids = new Set((g.nodes ?? []).map((n: any) => n.id));
  check("every edge references existing nodes", (g.edges ?? []).every((e: any) => ids.has(e.source) && ids.has(e.target)));
  const degree = new Map<string, number>();
  for (const e of g.edges ?? []) for (const id of [e.source, e.target]) degree.set(id, (degree.get(id) ?? 0) + 1);
  check("connectionCount equals the number of edges touching each node", (g.nodes ?? []).every((n: any) => n.connectionCount === (degree.get(n.id) ?? 0)));
  check("isCrossCourse is true exactly for cross-course edges", (g.edges ?? []).every((e: any) => e.isCrossCourse === (e.relationType === "cross-course")));
  check("courses carry status ready and conceptCount", (g.courses ?? []).every((c: any) => c.status === "ready" && Number.isInteger(c.conceptCount)));

  const course = g.courses?.[0];
  const other = g.courses?.[1];
  if (course) {
    const single = await call("GET", `/graph/${course.id}`);
    check("GET /graph/:courseId -> only that course, no cross-course data", single.status === 200 && single.json.courses.length === 1 && single.json.nodes.every((n: any) => n.courseId === course.id) && single.json.edges.every((e: any) => !e.isCrossCourse) && single.json.crossCourseLinks.length === 0);
    const got = await call("GET", `/courses/${course.id}`);
    check("GET /courses/:courseId -> course", got.status === 200 && got.json?.course?.id === course.id);
    const skills = await call("GET", `/courses/${course.id}/skills`);
    check("GET /courses/:courseId/skills -> skills", skills.status === 200 && Array.isArray(skills.json?.industrySkills) && skills.json.industrySkills.length > 0 && typeof skills.json.skillsSummary === "string", `status ${skills.status}`);
    const decay = await call("GET", `/decay-status/${course.id}?recalculate=true`);
    check("GET /decay-status/:courseId?recalculate=true -> shape", decay.status === 200 && decay.json?.threshold === 0.5 && Array.isArray(decay.json?.concepts) && typeof decay.json?.summary?.anomalousCount === "number" && decay.json.concepts.every((c: any) => "zScore" in c && "predictedForgetAt" in c && "reviewCount" in c), `status ${decay.status}`);
    console.log(`     decay summary: ${JSON.stringify(decay.json?.summary)}`);
  }
  const missing = await call("GET", "/graph/crs_does_not_exist");
  check("GET /graph/<unknown> -> 404 with the error shape", missing.status === 404 && isErrorShape(missing.json), `status ${missing.status}`);

  // ---- guide ----
  const guide = await call("GET", "/guide");
  const entries: any[] = guide.json?.entries ?? [];
  check("GET /guide -> entries for every node", guide.status === 200 && entries.length === (g.nodes ?? []).length, `${entries.length} entries`);
  check("guide is sorted by urgency, worst first", entries.every((e, i) => i === 0 || entries[i - 1].urgency >= e.urgency));
  check("every guide entry has a summary", entries.every((e) => typeof e.summary === "string" && e.summary.length > 0));
  console.log(`     guide list took ${guide.ms} ms; anomalous: ${entries.filter((e) => e.anomalous).map((e) => e.label).join(", ") || "none"}`);

  const target = entries[0];
  if (target) {
    const entry = await call("GET", `/guide/${target.conceptId}`);
    const e = entry.json?.entry;
    check("GET /guide/:conceptId -> explanation and resources generated", entry.status === 200 && typeof e?.explanation === "string" && e.explanation.length > 200 && Array.isArray(e.resources) && e.resources.length >= 3 && e.resources.every((r: any) => /^https:\/\/(www\.youtube\.com\/results|www\.google\.com\/search)\?/.test(r.url)), `status ${entry.status}`);
    console.log(`     tutoring for "${target.label}" took ${entry.ms} ms`);
    const again = await call("GET", `/guide/${target.conceptId}`);
    check("second GET /guide/:conceptId is served from cache", again.status === 200 && again.json?.entry?.generatedAt === e?.generatedAt, `${again.ms} ms`);

    // ---- review ----
    const before = (g.nodes as any[]).find((n) => n.id === target.conceptId);
    const review = await call("POST", "/review", { conceptId: target.conceptId, rating: "got-it" });
    check("POST /review got-it -> node with retention ~1 and S * 1.5", review.status === 200 && isNode(review.json?.node) && review.json.node.retention > 0.99 && Math.abs(review.json.node.stability - Math.min(365, before.stability * 1.5)) < 0.01, `status ${review.status}, S ${before?.stability} -> ${review.json?.node?.stability}`);
    const shaky = await call("POST", "/review", { conceptId: target.conceptId, rating: "still-shaky" });
    check("POST /review still-shaky -> retention drops to 0.4 or less and S is unchanged", shaky.status === 200 && shaky.json.node.retention <= 0.401 && Math.abs(shaky.json.node.stability - review.json.node.stability) < 0.01, `retention ${shaky.json?.node?.retention}`);
    const badRating = await call("POST", "/review", { conceptId: target.conceptId, rating: "meh" });
    check("POST /review with a bad rating -> 400", badRating.status === 400 && isErrorShape(badRating.json), `status ${badRating.status}`);
    const unknown = await call("POST", "/review", { conceptId: "cpt_does_not_exist", rating: "got-it" });
    check("POST /review for an unknown concept -> 404", unknown.status === 404 && isErrorShape(unknown.json), `status ${unknown.status}`);

    // ---- generated quiz, full ----
    const gen = await call("POST", `/quiz/${target.conceptId}/generate`, { mode: "full" });
    const qs: any[] = gen.json?.questions ?? [];
    check("generate full -> 10 questions, 19 points", gen.status === 200 && qs.length === 10 && gen.json.totalPoints === 19 && qs.reduce((s, q) => s + q.points, 0) === 19, `status ${gen.status}, ${qs.length} questions`);
    check("questions have 4 options and leak no answers", qs.every((q) => q.options?.length === 4 && !("correctIndex" in q) && !("explanation" in q)));
    console.log(`     full quiz took ${gen.ms} ms`);
    if (gen.status === 200) {
      const answers = qs.map((q) => ({ questionId: q.id, selectedIndex: 0 }));
      const sub = await call("POST", `/quiz/${target.conceptId}/submit`, { quizId: gen.json.quizId, answers });
      const s = sub.json ?? {};
      const earned = (s.results ?? []).reduce((sum: number, r: any) => sum + (r.correct ? qs.find((q) => q.id === r.questionId).points : 0), 0);
      check("submit -> weighted score matches the per-question results", sub.status === 200 && s.totalPoints === 19 && s.pointsEarned === earned && Math.abs(s.score - earned / 19) < 1e-6, `status ${sub.status}`);
      check("submit -> node confidence equals the score, source generated-quiz", isNode(s.node) && Math.abs(s.node.confidence - s.score) < 1e-6 && s.node.confidenceSource === "generated-quiz");
      const expectedR0 = 0.15 + 0.85 * Math.min(1, s.score / 0.8);
      check("submit -> retention follows the score (0.15 at 0%, 1 at 80%+)", Math.abs(s.node.retention - expectedR0) < 0.02, `score ${s.score.toFixed(2)} -> retention ${s.node.retention} (expected ${expectedR0.toFixed(2)})`);
      check("submit -> every result has correctIndex and an explanation", (s.results ?? []).length === 10 && s.results.every((r: any) => Number.isInteger(r.correctIndex) && typeof r.explanation === "string" && r.explanation.length > 0));
      const twice = await call("POST", `/quiz/${target.conceptId}/submit`, { quizId: gen.json.quizId, answers });
      check("submitting the same quiz twice -> 409", twice.status === 409, `status ${twice.status}`);
      console.log(`     score ${s.pointsEarned}/19; submit took ${sub.ms} ms`);
    }
    const short = await call("POST", `/quiz/${target.conceptId}/generate`, { mode: "short" });
    const sq: any[] = short.json?.questions ?? [];
    check("generate short -> 3-5 questions worth 1..n points", short.status === 200 && sq.length >= 3 && sq.length <= 5 && sq.every((q, i) => q.points === i + 1), `status ${short.status}, points ${sq.map((q) => q.points).join(",")}`);
  }

  // ---- cross-course link ----
  if (course && other) {
    const link = await call("POST", `/courses/${course.id}/link/${other.id}`);
    check("POST /courses/:a/link/:b -> links and edges", link.status === 200 && Array.isArray(link.json?.links) && Array.isArray(link.json?.edges) && link.json.edges.every((e: any) => e.isCrossCourse), `status ${link.status}`);
    console.log(`     ${link.json?.links?.length ?? 0} links, ${link.json?.edges?.length ?? 0} cross-course edges, ${link.ms} ms`);
    const after = await call("GET", "/graph");
    check("merged graph reflects the new links", after.status === 200 && after.json.crossCourseLinks.length === (link.json?.links?.length ?? -1) && after.json.edges.filter((e: any) => e.isCrossCourse).length === (link.json?.edges?.length ?? -1));
  }

  // ---- S3-backed flows ----
  if (WITH_UPLOADS) {
    const key = await uploadText("cse310-notes.txt", "notes", NOTES);
    if (key) {
      const created = await call("POST", "/courses", { name: "CSE 310 smoke", semester: "  Fall   2026 ", s3Keys: [key] });
      check("POST /courses -> 202 processing, semester trimmed", created.status === 202 && created.json?.course?.status === "processing" && created.json.course.semester === "Fall 2026", `status ${created.status}, semester ${JSON.stringify(created.json?.course?.semester)}`);
      const badSem = await call("POST", "/courses", { name: "x", semester: "y".repeat(41), s3Keys: [key] });
      check("POST /courses with a 41-character semester -> 400", badSem.status === 400, `status ${badSem.status}`);
      const id = created.json?.course?.id;
      let status = "processing";
      const started = Date.now();
      while (id && status === "processing" && Date.now() - started < 180_000) {
        await sleep(2000);
        status = (await call("GET", `/courses/${id}`)).json?.course?.status ?? "processing";
      }
      check("ingest finishes with status ready", status === "ready", `status ${status} after ${Math.round((Date.now() - started) / 1000)} s`);
      const merged = await call("GET", "/graph");
      check("the course carries its semester in the graph", (merged.json?.courses ?? []).find((c: any) => c.id === id)?.semester === "Fall 2026");
      check("every course has a semester field (string or null)", (merged.json?.courses ?? []).every((c: any) => c.semester === null || typeof c.semester === "string"));
      const mine = (merged.json?.nodes ?? []).filter((n: any) => n.courseId === id);
      check("new course appears in the merged graph with concepts", mine.length >= 5, `${mine.length} concepts`);
      console.log(`     ingest took ${Math.round((Date.now() - started) / 1000)} s; ${mine.length} concepts; ${merged.json?.crossCourseLinks?.length} cross-course links in total`);
      const concept = mine.find((n: any) => /hash/i.test(n.label)) ?? mine[0];
      if (concept) {
        const quizText = `Canvas Quiz Export\nQuiz 4: Hashing\nScore for this attempt: 7 out of 10\n\nQuestion 1    2 / 2 pts\nWhat does a hash function do?\nYour answer: Maps a key to a bucket index\nCorrect!\n\nQuestion 2    3 / 3 pts\nWhat is the load factor of a hash table with 30 items and 60 buckets?\nYour answer: 0.5\nCorrect!\n\nQuestion 3    2 / 3 pts\nExplain how chaining resolves collisions.\nYour answer: Each bucket keeps a list\nPartial credit\n\nQuestion 4    0 / 2 pts\nLinear probing suffers from which problem?\nYour answer: Secondary clustering\nIncorrect. Correct answer: Primary clustering\n`;
        const qKey = await uploadText("canvas-quiz-export.txt", "quiz", quizText);
        if (qKey) {
          const up = await call("POST", `/quiz/${concept.id}/upload`, { s3Key: qKey });
          check("digital quiz upload parses and updates confidence", up.status === 200 && up.json?.parseFailed === false && isNode(up.json.node) && up.json.node.confidenceSource === "uploaded-quiz", `status ${up.status}, body ${JSON.stringify(up.json).slice(0, 160)}`);
          console.log(`     uploaded quiz: ${up.json?.pointsEarned}/${up.json?.totalPoints} over ${up.json?.questionCount} questions on "${concept.label}", ${up.ms} ms`);
        }
        const junkKey = await uploadText("grocery-list.txt", "quiz", "milk\neggs\nbread\ncall mom on friday\n");
        if (junkKey) {
          const bad = await call("POST", `/quiz/${concept.id}/upload`, { s3Key: junkKey });
          check("non-quiz upload -> 200 with parseFailed true and node null", bad.status === 200 && bad.json?.parseFailed === true && bad.json.node === null && typeof bad.json.reason === "string", `status ${bad.status}, reason ${bad.json?.reason}`);
        }
        const foreign = await call("POST", `/quiz/${concept.id}/upload`, { s3Key: "uploads/someone-else/quiz/x.txt" });
        check("an s3Key outside the caller's prefix -> 400", foreign.status === 400, `status ${foreign.status}`);
      }
    }
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log(`  FAILED: ${f}`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
  console.error(`smoke test crashed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
