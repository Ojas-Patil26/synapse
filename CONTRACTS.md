# Synapse Contracts

Frozen once Phase 2 starts. Every agent builds against this file. If code and this
file disagree, this file wins.

## 0. Conventions

- JSON everywhere, camelCase keys. Timestamps are ISO-8601 UTC strings. IDs are
  opaque strings.
- Every API route requires `Authorization: Bearer <Cognito ID token>`. The user id is
  the token's `sub` claim. Every stored document and row carries `userId`; it is never
  returned by the API and a user can only ever read their own data.
- Errors: `{ "error": { "code": string, "message": string } }` with status 400
  (bad input), 401, 404, 409 (course not ready), 429 (`rate_limited`: daily per-user limit reached), 502 (Gemini/Textract failed), 500.
- Base URL comes from `VITE_API_BASE_URL`. CORS allows the CloudFront domain, the
  custom domain and `http://localhost:5173`.

## 1. Schemas

### Node (a concept)

| Field | Type | Notes |
|---|---|---|
| `id` | string | |
| `label` | string | Concept name shown on the node |
| `courseId` | string | |
| `lastReviewed` | string | Time of the last review. Set to ingest time when created. |
| `stability` | number | S, in days |
| `retention` | number | R, 0-1, computed at read time as `R0 * e^(-t/S)` (R0 = retention left by the last review, see section 2) |
| `confidence` | number \| null | 0-1. `null` = never assessed |
| `confidenceSource` | `"generated-quiz"` \| `"uploaded-quiz"` \| `null` | |
| `connectionCount` | integer | Number of edges touching this node across the user's whole graph, cross-course edges included. Drives node size. |

Course hubs are **not** nodes. The frontend draws one hub per entry in `courses` and
one hub-to-concept line for every concept that is not the `source` of a `subconcept`
edge. Those synthesized lines are not edges and do not count in `connectionCount`.

### Edge

| Field | Type | Notes |
|---|---|---|
| `source` | string | Node id |
| `target` | string | Node id |
| `relationType` | `"prerequisite"` \| `"related"` \| `"subconcept"` \| `"cross-course"` | |
| `isCrossCourse` | boolean | `true` only when `relationType` is `"cross-course"` |

Direction: `prerequisite` means `source` must be learned before `target`.
`subconcept` means `source` is a sub-concept of `target` (this is how sub-concept
nodes are identified; they render smaller and unlabeled). `related` and
`cross-course` are undirected.

### Course

| Field | Type | Notes |
|---|---|---|
| `id` | string | |
| `name` | string | Typed by the user at upload. Rendered on the hub. |
| `conceptCount` | integer | All concept nodes including sub-concepts. Drives hub size. |
| `industrySkills` | string[] | 4-8 short skill names |
| `skillsSummary` | string | 2-3 sentences |
| `status` | `"processing"` \| `"ready"` \| `"failed"` | Addition, see section 6 |
| `error` | string \| null | Set when `status` is `"failed"` |
| `createdAt` | string | |
| `semester` | string \| null | Optional label chosen at upload (e.g. "Fall 2026", max 40 chars); `null` when not given. The Home view can filter by it. Addition, see section 6 |

### CrossCourseLink

| Field | Type | Notes |
|---|---|---|
| `sourceCourseId` | string | |
| `targetCourseId` | string | |
| `sharedConceptIds` | string[] | Concept ids from both courses that share one theme. At least one from each course. |
| `description` | string | One sentence on what connects them |

For every link, the backend materializes one `cross-course` edge per
(source-course concept, target-course concept) pair in `sharedConceptIds`. The
frontend also draws one hub-to-hub line per course pair that has at least one link.

### Tiger Data row (`review_events` hypertable)

| Column | Type | Notes |
|---|---|---|
| `concept_id` | text | conceptId |
| `ts` | timestamptz | timestamp. Hypertable time column. |
| `event_type` | text | `"ingested"` \| `"self-review"` \| `"generated-quiz"` \| `"uploaded-quiz"` |
| `result` | double precision | 0-1. Quiz: that quiz's weighted score. Self-review: 1 = got it, 0 = still shaky. `null` for `ingested`. |
| `user_id` | text | Addition |
| `course_id` | text | Addition |
| `predicted_retention` | double precision | Addition. R just before the event. `null` for `ingested`. |
| `stability_before` | double precision | Addition. `null` for `ingested`. |
| `stability_after` | double precision | Addition. S after applying the event. |

Index: `(user_id, concept_id, ts DESC)`.

### GraphResponse

```
{ "courses": Course[], "nodes": Node[], "edges": Edge[], "crossCourseLinks": CrossCourseLink[] }
```

Only `ready` courses appear. In the single-course view `edges` has no cross-course
edges and `crossCourseLinks` is `[]`.

### GuideEntry

```
{
  "conceptId": string, "label": string, "courseId": string, "courseName": string,
  "retention": number, "stability": number, "lastReviewed": string,
  "confidence": number | null, "confidenceSource": "generated-quiz" | "uploaded-quiz" | null,
  "predictedForgetAt": string,        // when R is predicted to cross 0.5
  "zScore": number | null, "anomalous": boolean,
  "urgency": number,                  // 0-1, higher = review sooner
  "summary": string,                  // 1-2 sentences; always present (written at ingest)
  "explanation": string | null,       // markdown; null until first generated
  "resources": Resource[],            // [] until first generated
  "generatedAt": string | null
}
Resource = { "title": string, "url": string, "type": "video" | "article" | "practice" }
```

`Resource.url` is always a search URL the server builds from a Gemini-suggested
query (YouTube search for `video`, Google search otherwise). Gemini never emits URLs.

### Quiz

```
QuizQuestion = { "id": string, "prompt": string, "options": string[4],
                 "difficulty": "easy" | "medium" | "hard", "points": integer }
```

All questions are multiple choice with exactly 4 options. The answer key and
per-question explanations are stored in Mongo and never sent before submission.

## 2. Learning model

### Retention and stability

- `R = R0 * e^(-t/S)`; `t` = fractional days since `lastReviewed`; `S` = stability in days;
  `R0` = the retention the concept was left at by its last review (1 for a new concept).
- Constants: `S0 = 2.0`, `S_MIN = 1.0`, `S_MAX = 365`, `FORGET_THRESHOLD = 0.5`.
- `predictedForgetAt = lastReviewed + S * ln(R0 / 0.5)` days, or `lastReviewed` itself when
  `R0 <= 0.5` (already below the line).
- Every event sets `lastReviewed = now`, updates S (then clamps it to `[S_MIN, S_MAX]`) and
  sets a new `R0` from the table below. `R_before` is R just before the event.

| Event | New R0 |
|---|---|
| `ingested` | 1 |
| `self-review`, got it | 1 |
| `self-review`, still shaky | `min(R_before, 0.4)` |
| quiz, score `p` | `0.15 + 0.85 * min(1, p / 0.8)`: 0.15 at 0%, 1 at 80% or better |

So a weak quiz result shows up immediately as low retention (red) and an at-risk concept,
instead of resetting the node to green.

| Event | New S |
|---|---|
| `ingested` | `S0` |
| `self-review`, got it | `S * 1.5` |
| `self-review`, still shaky | `S` (unchanged) |
| quiz, score `p >= 0.5` | `S * (1 + p * (2 - R_before))` |
| quiz, score `p < 0.5` | `S * 0.7` |

The `(2 - R_before)` term is the spacing effect: a successful review of a
nearly-forgotten concept grows S more than one done right after the last review.

### Quizzes and confidence

- Quiz score = points earned / points possible.
- **Full quiz** (`mode: "full"`, used when the user has no Canvas quiz): 10 questions
  in mixed order: 4 easy (1 point each), 3 medium (2 points), 3 hard (3 points).
  19 points total.
- **Short quiz** (`mode: "short"`, used after a Canvas quiz upload): Gemini picks 3
  to 5 questions ordered easiest to hardest; question k is worth k points.
- **Uploaded quiz**: score = earned / possible over the questions Gemini judges
  relevant to the concept.
- The concept stores `lastGenerated {mode, score, at}` and `lastUploaded {score, at}`
  (internal). Confidence rule:

| Event | `confidence` | `confidenceSource` |
|---|---|---|
| Full quiz submitted | its score; clears `lastUploaded` | `"generated-quiz"` |
| Short quiz submitted, `lastUploaded` exists | mean of the two scores | `"uploaded-quiz"` |
| Short quiz submitted, no `lastUploaded` | its score | `"generated-quiz"` |
| Upload parsed, `lastGenerated.mode` is `"short"` | mean of the two scores | `"uploaded-quiz"` |
| Upload parsed, otherwise | uploaded score | `"uploaded-quiz"` |

- Levels (frontend derives these for the border): `null` = unassessed,
  low `< 0.40`, medium `0.40-0.75`, high `> 0.75`.
- Every quiz event also runs the stability update above with `p` = that quiz's own
  score (not the combined confidence).

### Z-score (anomalous decay)

Measures whether a concept is being forgotten faster than its own curve predicts.

- For each quiz event i on a concept (`generated-quiz` or `uploaded-quiz`):
  `residual_i = result_i - predicted_retention_i`.
- Window: the concept's last 5 quiz events, `n` of them.
- `sigma` = sample standard deviation of all the user's quiz residuals in the last 90
  days. If the user has fewer than 5 residuals, `sigma = 0.25`. Floor `sigma` at 0.15.
- `zScore = mean(residuals in window) * sqrt(n) / sigma`. `null` when `n = 0`.
- `anomalous = n >= 2 && zScore <= -1.5`.

### Urgency (Guide order, worst first)

`urgency = 0.5 * (1 - R) + 0.3 * (1 - C) + 0.2 * A`, where `C` = confidence
(0.5 when `null`) and `A = clamp(-zScore / 3, 0, 1)` (0 when `zScore` is `null`).

## 3. API routes

| Method | Path | Purpose |
|---|---|---|
| GET | `/graph` | Merged multi-course graph (Home default) |
| GET | `/graph/:courseId` | Single-course view |
| POST | `/review` | Self-rated review |
| GET | `/decay-status/:courseId` | Retention, forecast and anomaly per concept |
| POST | `/quiz/:conceptId/generate` | Generate a quiz |
| POST | `/quiz/:conceptId/submit` | Grade it, update confidence |
| POST | `/quiz/:conceptId/upload` | Digital quiz upload, `parseFailed` flag |
| POST | `/courses/:courseId/link/:otherCourseId` | Cross-course comparison |
| GET | `/courses/:courseId/skills` | Industry skills |
| GET | `/guide` | All concepts, worst first |
| GET | `/guide/:conceptId` | One concept's full explanation and resources |
| POST | `/uploads/presign` | Addition: presigned S3 upload URL |
| POST | `/courses` | Addition: create a course from uploaded notes |
| GET | `/courses/:courseId` | Addition: course status for polling |
| DELETE | `/account` | Addition: delete the caller's data, uploads, learner profile and login |

**GET /graph**, **GET /graph/:courseId** -> 200 `GraphResponse`. 404 if the course
does not exist or is not `ready`.

**POST /review**
- Body: `{ "conceptId": string, "rating": "got-it" | "still-shaky" }`
- 200: `{ "node": Node }`

**GET /decay-status/:courseId** (optional `?recalculate=true` re-runs the scan for
this course before answering)
```
{ "courseId": string, "scannedAt": string | null, "threshold": 0.5,
  "summary": { "averageRetention": number, "atRiskCount": integer, "anomalousCount": integer },
  "concepts": [ { "conceptId": string, "label": string, "retention": number,
                  "stability": number, "lastReviewed": string, "predictedForgetAt": string,
                  "zScore": number | null, "anomalous": boolean, "reviewCount": integer } ] }
```
`atRiskCount` = concepts with `retention < threshold`.

**POST /quiz/:conceptId/generate**
- Body: `{ "mode": "short" | "full" }`
- 200: `{ "quizId": string, "conceptId": string, "mode": "short" | "full", "totalPoints": integer, "questions": QuizQuestion[] }`

**POST /quiz/:conceptId/submit**
- Body: `{ "quizId": string, "answers": [ { "questionId": string, "selectedIndex": 0 | 1 | 2 | 3 | null } ] }`
- 200:
```
{ "quizId": string, "score": number, "pointsEarned": integer, "totalPoints": integer,
  "results": [ { "questionId": string, "correct": boolean, "correctIndex": integer, "explanation": string } ],
  "node": Node }
```
A quiz can be submitted once; a second submit returns 409.

**POST /quiz/:conceptId/upload**
- Body: `{ "s3Key": string }` (from `/uploads/presign` with `purpose: "quiz"`)
- Always 200 for parse outcomes:
  - `{ "parseFailed": false, "score": number, "pointsEarned": number, "totalPoints": number, "questionCount": integer, "node": Node }`
  - `{ "parseFailed": true, "reason": "not-digital" | "no-points-found" | "no-relevant-questions" | "unreadable", "node": null }`
- On `parseFailed: true` the frontend shows no error and starts a `full` generated quiz.

**POST /courses/:courseId/link/:otherCourseId**
- No body. Replaces any existing links between the two courses (idempotent).
- 200: `{ "links": CrossCourseLink[], "edges": Edge[] }`. 409 if either course is not `ready`.

**GET /courses/:courseId/skills**
- 200: `{ "courseId": string, "industrySkills": string[], "skillsSummary": string }`.
  Generated at ingest; generated on demand and cached if missing.

**GET /guide** -> 200 `{ "entries": GuideEntry[] }` sorted by `urgency` descending.
Makes no Gemini calls; `explanation` is `null` for entries not yet generated.

**GET /guide/:conceptId** (optional `?refresh=true` regenerates)
- 200: `{ "entry": GuideEntry }` with `explanation` and `resources` filled. Generates
  and caches on first call, reading the Supermemory profile first. Does not count as
  a review.

**POST /uploads/presign**
- Body: `{ "fileName": string, "contentType": string, "purpose": "notes" | "quiz" }`
- 200: `{ "uploadUrl": string, "s3Key": string, "expiresIn": 900 }`. The client then
  sends `PUT uploadUrl` with the same `Content-Type` header and the file as the body.
- Allowed types: notes = `application/pdf`, `image/png`, `image/jpeg`, `text/plain`,
  `text/markdown`; quiz = `application/pdf`, `image/png`, `image/jpeg`, `text/plain`.
  Max 10 MB per file.

**POST /courses**
- Body: `{ "name": string, "semester"?: string | null, "s3Keys": string[] }` (1-5 keys, `purpose: "notes"`;
  `semester` is optional, trimmed, max 40 chars, empty means none)
- 202: `{ "course": Course }` with `status: "processing"`.

**DELETE /account** -> 200 `{ "deleted": true, "documents": n, "reviewEvents": n, "uploads": n, "profileRemoved": boolean }`.
Removes MongoDB documents, Tiger Data rows, uploaded files and the Supermemory profile, then the Cognito user
(last, so a failure part-way leaves the account in place and the call can be repeated).

Daily limits (UTC day, per user, MongoDB `usage` counters): AI requests (guide generation, quiz generate and upload,
link, skills) default 80; course uploads default 8. Over the limit the route answers 429 `rate_limited`.

**GET /courses/:courseId** -> 200 `{ "course": Course }`. The upload page polls this
every 2 seconds until `status` is `ready` or `failed`.

## 4. Internal module contracts (backend)

TypeScript, ESM. Handlers never touch Mongo or Tiger directly; they call these.
Shared types live in `backend/lambda/lib/contracts.ts` (written by the lead before
Phase 2 forks; mirrors this file).

### `lib/data/decay.ts` (Data agent, pure functions)

```ts
retentionAt(lastReviewed: string, stability: number, now?: Date): number
nextStability(stabilityBefore: number, retentionBefore: number,
              eventType: EventType, result: number | null): number
predictedForgetAt(lastReviewed: string, stability: number): string
urgency(retention: number, confidence: number | null, zScore: number | null): number
```

### `lib/data/service.ts` (Data agent; the only data API handlers use)

```ts
createCourse(userId: string, name: string): Promise<Course>
getCourse(userId: string, courseId: string): Promise<Course | null>
setCourseStatus(userId: string, courseId: string, status: CourseStatus, error?: string): Promise<void>
saveExtractedGraph(userId: string, courseId: string, input: {
  concepts: ExtractedConcept[]; dependencies: ExtractedDependency[]; sourceText: string;
}): Promise<{ nodes: Node[]; edges: Edge[] }>       // assigns ids, writes "ingested" Tiger rows,
                                                    // computes connectionCount and conceptCount
saveCourseSkills(userId: string, courseId: string, industrySkills: string[], skillsSummary: string): Promise<void>
listReadyCourses(userId: string): Promise<Course[]>
listConceptBriefs(userId: string, courseId: string): Promise<ConceptBrief[]>   // {id, label, summary}
getConceptContext(userId: string, conceptId: string): Promise<ConceptContext | null>
        // {node, courseName, summary, explanation, resources, generatedAt, sourceExcerpt}
replaceCrossCourseLinks(userId: string, courseIdA: string, courseIdB: string,
                        links: CrossCourseLink[]): Promise<{ links: CrossCourseLink[]; edges: Edge[] }>
buildGraph(userId: string, courseId?: string): Promise<GraphResponse | null>
buildGuide(userId: string): Promise<GuideEntry[]>
getGuideEntry(userId: string, conceptId: string): Promise<GuideEntry | null>
saveGuideContent(userId: string, conceptId: string, content: {
  summary: string; explanation: string; resources: Resource[];
}): Promise<GuideEntry>
decayStatus(userId: string, courseId: string, opts?: { recalculate?: boolean }): Promise<DecayStatus | null>
applySelfReview(userId: string, conceptId: string, rating: "got-it" | "still-shaky"): Promise<Node>
applyAssessment(userId: string, conceptId: string, a: {
  source: "generated-quiz" | "uploaded-quiz"; mode?: "short" | "full"; score: number;
}): Promise<Node>
saveQuiz(userId: string, quiz: StoredQuiz): Promise<void>
getQuiz(userId: string, quizId: string): Promise<StoredQuiz | null>
markQuizSubmitted(userId: string, quizId: string): Promise<void>
runDecayScan(): Promise<{ conceptsScanned: number; newlyAnomalous: AlertItem[]; newlyAtRisk: AlertItem[] }>
```

```ts
ExtractedConcept    = { key: string; label: string; summary: string; parentKey: string | null }
ExtractedDependency = { from: string; to: string; type: "prerequisite" | "related" }   // keys
StoredQuiz = { quizId: string; conceptId: string; mode: "short" | "full"; createdAt: string;
               submittedAt: string | null;
               questions: (QuizQuestion & { correctIndex: number; explanation: string })[] }
AlertItem  = { userId: string; conceptId: string; label: string; courseName: string;
               retention: number; zScore: number | null }
```

`parentKey` becomes a `subconcept` edge. Mongo collections: `courses`, `concepts`,
`edges`, `crossCourseLinks`, `quizzes`.

### `lib/supermemory.ts` (Supermemory agent)

```ts
getLearnerProfile(userId: string, focus?: { conceptLabel?: string; courseName?: string }): Promise<string>
logLearningEvent(userId: string, event: LearningEvent): Promise<void>

LearningEvent = {
  type: "course-ingested" | "self-review" | "generated-quiz" | "uploaded-quiz" | "explanation-viewed";
  courseName: string; conceptLabel?: string; rating?: "got-it" | "still-shaky";
  score?: number; confidence?: number | null; retention?: number;
  missedQuestions?: string[]; timestamp: string;
}
```

Neither function ever throws. `getLearnerProfile` returns `""` on any failure or
after a 3-second timeout, so a Supermemory outage never blocks a Gemini call.

### Handler files (Backend core agent, except `decayScan`)

| File | Exports | Route / trigger |
|---|---|---|
| `handlers/graph.ts` | `getGraph` | GET /graph, GET /graph/:courseId |
| `handlers/review.ts` | `postReview` | POST /review |
| `handlers/decay.ts` | `getDecayStatus` | GET /decay-status/:courseId |
| `handlers/quiz.ts` | `generate`, `submit`, `upload` | POST /quiz/:conceptId/* |
| `handlers/courses.ts` | `create`, `get`, `link`, `skills` | /courses routes |
| `handlers/ingest.ts` | `ingestCourse` | async invoke, payload `{userId, courseId, s3Keys}` |
| `handlers/guide.ts` | `list`, `get` | GET /guide, GET /guide/:conceptId |
| `handlers/uploads.ts` | `presign` | POST /uploads/presign |
| `handlers/auth.ts` | `preSignUp` | Cognito pre-sign-up trigger (auto-confirm) |
| `handlers/decayScan.ts` | `scan` | EventBridge rate(1 hour) (Data agent) |

## 5. Configuration names

| Where | Variables |
|---|---|
| Lambda env | `GEMINI_API_KEY`, `GEMINI_MODEL` (default `gemini-flash-latest`), `SUPERMEMORY_API_KEY`, `MONGODB_URI`, `MONGODB_DB` (default `synapse`), `TIGERDATA_URL`, `UPLOADS_BUCKET`, `INGEST_FUNCTION_NAME`, `ALERTS_TOPIC_ARN` |
| Frontend env | `VITE_API_BASE_URL`, `VITE_COGNITO_USER_POOL_ID`, `VITE_COGNITO_CLIENT_ID`, `VITE_USE_FIXTURES` (`true` during Phase 2) |

`AWS_REGION` is set by Lambda itself and must not be declared in `serverless.yml`.

## 6. Additions and decisions beyond the kickoff spec

1. Three extra routes (`/uploads/presign`, `POST /courses`, `GET /courses/:courseId`):
   the original list had no way to upload notes or create a course.
2. `Course.status`, `error`, `createdAt`: ingest runs asynchronously because OCR plus
   Gemini can exceed API Gateway's 30-second limit.
3. Five extra Tiger Data columns: `user_id` and `course_id` for scoping;
   `predicted_retention`, `stability_before`, `stability_after` because the z-score
   compares each quiz result to the retention predicted at that moment.
4. Sub-concepts are expressed as `subconcept` edges, so the Node schema keeps exactly
   the fields specified.
5. Quiz rules changed from "3 questions, correct/3" to the weighted short/full scheme
   in section 2, per the kickoff Q&A. Questions are multiple choice, graded against a
   stored key.
6. Short quiz plus Canvas upload combine as the mean of the two scores.
7. Self-rated review button (Got it / Still shaky) in addition to quizzes.
8. Z-score defined as the residual statistic in section 2.
9. Cross-course linking runs automatically at the end of ingest; the route also
   allows a manual re-run.
10. Cognito sign-ups are auto-confirmed (no email code) to keep the demo flow short.
11. Initial stability `S0 = 2` days; a new concept counts as reviewed at ingest time.
12. (2026-11-15, requested by the owner) Retention now starts from `R0` after a review instead of always
    resetting to 1: a low quiz score or "still shaky" leaves the node red so the user knows to revisit it.
13. (2026-11-15, requested by the owner) Optional `Course.semester`, set at upload, used to filter Home.
14. (2026-11-15) New accounts confirm their email with an emailed code and can reset a forgotten password; the
    pre-sign-up trigger only auto-confirms when `AUTO_CONFIRM_SIGNUPS=true` is set at deploy time.
15. (2026-11-15) `DELETE /account`, per-user daily limits (429), API-wide throttling, CloudWatch alarms, CORS limited to the
    site origins, Lambda runtime Node.js 22.
