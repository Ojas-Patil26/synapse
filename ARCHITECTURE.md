# Synapse Architecture

Synapse is a per-course knowledge map. It shows what you learned, how well you still
remember it (retention), how well you understood it (confidence), and when you are
predicted to forget it.

Built solo for SunHacks 2026 (deadline Nov 15, 2026, 11:00 MST). Design rule: working
and demoable beats complete. Exact schemas, formulas, routes and module signatures
live in CONTRACTS.md. This document covers components, data flows and ownership.

## 1. Components

```
  Browser: React SPA (Vite + TypeScript)
     |                                   |
     | static files                      | HTTPS, Authorization: Bearer <Cognito ID token>
     v                                   v
  CloudFront ---> S3 site bucket      API Gateway HTTP API (us-east-2)
  (custom domain,                        |  JWT authorizer <--- Cognito User Pool
   *.cloudfront.net fallback)            v
                                      Lambda functions (Node.js 20, TypeScript)
       +-----------+-----------+---------+----------+-------------+-------------+
       v           v           v                    v             v             v
   S3 uploads   Textract    Gemini API       MongoDB Atlas    Tiger Data    Supermemory
   (presigned     (OCR)   (extract, tutor,  (courses, graph, (review-event  (learner
    PUT)                   quiz, parse,      links, quizzes,  time series)   profile)
                           link, skills)     guide cache)

  EventBridge (rate: 1 hour) ---> decayScan Lambda ---> Tiger Data + MongoDB ---> SNS
```

| Piece | Exact role |
|---|---|
| Gemini API | Concept and dependency extraction, tutoring explanations, quiz generation, digital-quiz parsing, cross-course comparison, industry-skills tagging. Always called with a JSON response schema. |
| Supermemory | One learner profile per user. Read before every explanation and quiz generation. Written after every review, quiz, upload and explanation view. |
| MongoDB Atlas | Course metadata, concept nodes, edges, CrossCourseLink records, industrySkills/skillsSummary, quizzes with answer keys, cached guide content. |
| Tiger Data | Append-only `review_events` hypertable. Source of truth for stability (S), last review time, and the z-score anomaly calculation. |
| S3 | `uploads` bucket (notes and digital quizzes, private, presigned PUT) and `site` bucket (built frontend). |
| Textract | OCR for PDFs and images, both notes and digital quiz exports. |
| Cognito | Email + password sign-up and login. Issues the JWT that API Gateway verifies. |
| EventBridge | Hourly trigger for the decay scan. |
| SNS / CloudWatch | Forgetting alerts and logs. Nice-to-have. |

## 2. Sources of truth

| Data | Source of truth | Cached in |
|---|---|---|
| Review history, S, last review time | Tiger Data `review_events` | Mongo concept (`stability`, `lastReviewed`) |
| Retention R | Computed: `e^(-t/S)` on every read | Mongo concept (`retention`, written by the scan) |
| Z-score, anomalous flag | Computed from Tiger Data | Mongo concept |
| Graph structure, courses, links, skills | MongoDB | none |
| Confidence | MongoDB concept | none |
| Learner profile | Supermemory | none |

Retention is recomputed on every graph read, so the graph is correct even if the
scheduled scan has not run. The scan persists values, refreshes z-scores and raises
alerts.

## 3. Pages and navigation

```
  /  Landing (public pitch; Log in / Sign up top right)
        |
        v
  /login, /signup  ---> Cognito ---> token stored by the SPA
        |
        v
  /app  ---> GET /graph
        |-- courses = 0 ---> /app/upload   (default when the user has no courses)
        '-- courses >= 1 --> /app/home     (default once a course exists)

  Top nav after login:   Home | Upload Course | Guide

  /app/upload   name + drag-and-drop files -> processing -> redirect to /app/home
  /app/home     merged graph of all courses with cross-course links;
                top-right dropdown filters to one course (GET /graph/:courseId)
                node click -> popup -> "View full guide entry"
  /app/guide    every concept, worst first
  /app/guide/:conceptId   one concept's full explanation and resources
```

## 4. Data flows

### A. Note upload -> Textract -> Gemini extraction -> Mongo

```
Upload page -- POST /uploads/presign --------------> uploads Lambda -> presigned PUT URL
Upload page -- PUT file ---------------------------> S3 uploads bucket
Upload page -- POST /courses {name, s3Keys} -------> courses Lambda
                                                       Mongo: course {status: "processing"}
                                                       async-invoke ingest Lambda
                                                 <---- 202 {course}
ingest Lambda (up to 5 min, no API Gateway limit):
   each file:  pdf/png/jpg --> Textract --> text        txt/md --> read directly
   all text --> Gemini extract --> concepts (+ summary, + parent) and dependencies
            --> Mongo: concepts, edges, connectionCount, conceptCount, sourceText
            --> Tiger: one "ingested" row per concept (S = S0)
            --> Gemini skills tagging --> Mongo course.industrySkills / skillsSummary
            --> for every other ready course: flow F (cross-course linking)
            --> Supermemory: log "course-ingested"
            --> Mongo: course.status = "ready"   (or "failed" + error)
Upload page polls GET /courses/:courseId every 2 s --> "ready" --> /app/home
```

### B. Review event -> Tiger Data -> decay calc -> retention update

```
Popup or Guide entry: "Mark reviewed" -> Got it | Still shaky
   -- POST /review {conceptId, rating} --> review Lambda --> data.applySelfReview
        1. Mongo: read concept (lastReviewed, S)
        2. R_before = e^(-t/S)
        3. S_after  = nextStability(S, R_before, event)
        4. Tiger: INSERT review_events (result, predicted_retention, stability before/after)
        5. Mongo: lastReviewed = now, stability = S_after, retention = 1
      --> Supermemory: log "self-review"
   <-- {node} --> that node recolors on the graph
```

Quiz submissions (flows D and E) run the same five steps through
`data.applyAssessment`; the client never calls `/review` for a quiz.

### C. Tutoring explanation (any node, any color)

```
Click a node --> popup opens at once with `summary` from the cached GET /guide list
   -- GET /guide/:conceptId --> guide Lambda
        explanation cached in Mongo?  yes --> return it
        no:  Supermemory.getLearnerProfile(user, concept)     <- always before Gemini
             --> Gemini tutor prompt: concept, course, notes excerpt, profile, R, confidence
             --> {summary, explanation, resource queries} --> server builds resource URLs
             --> Mongo: cache on concept;  Supermemory: log "explanation-viewed"
   <-- {entry} --> popup swaps in the personalized summary
   "View full guide entry" --> /app/guide/:conceptId
```

### D. Generated quiz -> Gemini -> confidence update

```
"Take quiz" --> "Have a Canvas quiz for this concept?"
     No  --> POST /quiz/:conceptId/generate {mode: "full"}    10 questions, mixed order
     Yes --> flow E first, then generate {mode: "short"}      3-5 questions, easy to hard
generate:  Supermemory profile --> Gemini --> questions + answer key
           --> Mongo quizzes (key stays server-side)  <-- questions without answers
submit:    POST /quiz/:conceptId/submit {quizId, answers}
           --> grade against the stored key --> weighted score
           --> data.applyAssessment: confidence rule, Tiger row, S and R update, z-score
           --> Supermemory: log score and missed questions
           <-- {score, results, node} --> node border and fill update live
```

### E. Digital quiz upload -> parse -> confidence update, with fallback

```
"Yes, upload it" --> disclaimer + file picker
   -- POST /uploads/presign {purpose: "quiz"} --> PUT to S3
   -- POST /quiz/:conceptId/upload {s3Key} --> quiz Lambda
        S3 --> Textract --> text --> Gemini parse:
              typed/digital export with per-question points?  which questions fit this concept?
        ok   --> score = earned / possible --> data.applyAssessment("uploaded-quiz")
             <-- {parseFailed: false, score, node} --> UI continues to the short quiz
        fail --> handwritten or photographed, no points, nothing relevant, OCR or
                 Gemini error, timeout
             <-- {parseFailed: true, reason}
             --> UI shows no error and switches to the full generated quiz
```

### F. Cross-course trigger -> Gemini comparison -> Mongo write

```
Trigger: end of ingest when >= 2 ready courses exist (each pair with the new course),
         or manual POST /courses/:courseId/link/:otherCourseId
   Mongo: concept lists of both courses --> Gemini compare --> shared or related themes
   --> Mongo: replace CrossCourseLink records for the pair; recompute connectionCount
   --> GET /graph now returns crossCourseLinks plus materialized cross-course edges
```

### G. EventBridge scan -> decay recalculation

```
EventBridge rate(1 hour) --> decayScan Lambda
   Tiger: latest event per concept --> lastReviewed, S
   R = e^(-t/S) for every concept;  z-score per concept (SQL window functions)
   --> Mongo: retention, zScore, anomalous, scannedAt
   --> SNS publish for concepts that newly became anomalous or crossed R < 0.5  (nice-to-have)
Manual fallback: GET /decay-status/:courseId?recalculate=true runs the same code for one course.
```

## 5. Repo layout and ownership

```
/frontend                 React SPA                                   Frontend agent
   /fixtures              graph.json, graph2.json, graph-merged.json  (Phase 1, frozen)
   COPY.md                exact UI copy                               (Phase 1, frozen)
/backend/lambda
   /handlers              one file per route group                    Backend core agent
   /handlers/decayScan.ts EventBridge scan                            Data/decay agent
   /lib/gemini            prompts + Gemini client                     Backend core agent
   /lib/aws               S3, Textract helpers                        Backend core agent
   /lib/data              mongo.ts, tiger.ts, decay.ts, service.ts    Data/decay agent
   /lib/supermemory.ts    learner profile                             Supermemory agent
   /lib/contracts.ts      CONTRACTS.md as TypeScript types            Lead
/infra/serverless.yml     all AWS resources                           Lead
/scripts                  preflight, schema migrate, seed             Data/decay agent
ARCHITECTURE.md, CONTRACTS.md                                         Lead (frozen in Phase 2)
```

## 6. Deployment

- One Serverless Framework stack in us-east-2: HTTP API, Lambdas, Cognito user pool
  and client, uploads bucket, site bucket, CloudFront distribution, EventBridge rule,
  SNS topic. Lambda runtime `nodejs20.x`; TypeScript bundled by Serverless v4's
  built-in esbuild with target `node20` (local Node 24 is only the build host).
- Secrets come from `.env` at deploy time and become Lambda environment variables.
  Nothing is hardcoded or committed.
- Frontend: `vite build`, sync to the site bucket, CloudFront serves it. 403/404 map
  to `/index.html` for SPA routing.
- Custom domain: ACM certificate requested in **us-east-1** (CloudFront requirement)
  for the bare domain and `www`, validated by CNAME records added in GoDaddy, then
  attached to the distribution as alternate domain names. The `*.cloudfront.net` URL
  stays live the whole time as the fallback.
- The stack is deployed early in Phase 2 with stub handlers so the CloudFront domain
  and certificate validation records exist hours before the deadline.
- If Serverless v4 refuses handlers outside the service directory, `serverless.yml`
  moves to the repo root. Nothing else changes.

## 7. Trade-offs

| Decision | Why | Cost / revisit later |
|---|---|---|
| Async ingest + polling | OCR plus Gemini can exceed API Gateway's 30 s limit | Extra status field and a poll loop. Step Functions later. |
| Multiple-choice quizzes graded against a stored key | Instant, deterministic, no grading call | No free-response questions. |
| R computed on read | Graph never depends on the scan having run | Cached `retention` in Mongo can lag; it is only used by the scan and alerts. |
| Secrets as Lambda env vars | Fastest path | Move to Secrets Manager. |
| Resource links are search URLs built server-side | A generated URL can be dead; a search URL cannot | Less specific than curated links. |
| Mongo cache of S and lastReviewed | One store to read for the graph | Two writes per review; a rebuild script replays Tiger into Mongo. |
| Email-code confirmation at sign-up (switchable with `AUTO_CONFIRM_SIGNUPS`) | Real addresses only; password reset works | Cognito default email sender is limited to 50 emails a day; move to SES for volume. |

## 8. Cut order under time pressure

1. Digital-quiz upload parsing (the "Yes" path hides; every quiz is the full quiz).
2. SNS alerts, CloudWatch extras.
3. EventBridge scan (the manual recalculate path already exists).
4. Cross-course linking (demo one course; frame it as coming next).

Never cut: the graph, retention coloring, the tutoring popup, generated-quiz confidence.
