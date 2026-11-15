# Synapse

**Know what you'll forget before you forget it.**

Synapse turns a learner's own notes into a map of every concept, predicts when each concept will fade, and shows what to review first. Live at **https://synapse-op.us**. A ready-made demo account (two courses with review history) is described in the submission notes; or sign up with your own email and upload notes.

- **Colour is memory.** Every concept is coloured from red (fading) to green (fresh) along a forgetting curve, `R = R0 · e^(-t/S)`, where `S` is that concept's stability and grows with each well-timed review.
- **The outline is understanding.** Short quizzes set a separate confidence score, drawn as the node's outline. A concept can be fresh but not understood, or understood but fading, and the map shows the difference. A weak quiz result also lowers a concept's retention so it does not stay green.
- **Courses connect.** Related concepts across a learner's courses are linked on one shared map. Courses can carry an optional semester label to filter the map.

## What it does

| Feature | Notes |
|---|---|
| Notes to map | Upload up to five files per course (PDF, PNG, JPG, TXT, MD). Photos and PDFs go through OCR. Gemini extracts concepts and how they depend on each other. |
| Hub-and-spoke graph | Force-directed, one hub per course, concepts coloured by retention, sized by connectedness, outlined by quiz confidence. |
| Tutoring | Click any concept for a short explanation; the Guide page has the full explanation and study resources, weakest concept first. |
| Quizzes | With no class quiz: 10 multiple-choice questions (easy 1 point, medium 2, hard 3). After uploading a typed quiz export from class: 3 to 5 questions ordered easy to hard. Confidence is points earned over points possible. |
| Review next | Home lists the three concepts most worth reviewing now. |
| Decay scan | An hourly job recomputes retention and flags concepts that are fading faster than their own curve predicts (a z-score on quiz results versus predicted retention, computed in SQL). |
| Accounts | Email and password with a confirmation code, password reset, and self-service deletion of the account and all its data. |

Not built: alert emails for fading concepts, handwritten or photographed quiz uploads (typed exports only).

## Architecture

```
Browser (React SPA)
   |  static files                      |  HTTPS + Cognito ID token
   v                                    v
CloudFront --> S3 (site)         API Gateway HTTP API (JWT authorizer = Cognito user pool)
                                        |
                                        v
                                 AWS Lambda (Node.js 22, TypeScript)
     +---------------+---------------+---------------+----------------+--------------+
     v               v               v               v                v              v
  S3 uploads      Textract       Gemini API     MongoDB Atlas     Tiger Data    Supermemory
  (presigned)     (OCR)          (extract,      (courses,         (TimescaleDB  (learner
                                  tutor, quiz,   concepts, links,  review-event profile)
                                  parse, link)   quizzes)          hypertable)

EventBridge (hourly) --> decay-scan Lambda --> Tiger Data + MongoDB
CloudWatch alarms ----> SNS ops topic (API 5xx, traffic spike, ingest and scan errors)
```

- **Source of truth for memory:** Tiger Data holds one append-only row per review or quiz event. Stability and the z-score come from that history; retention is recomputed on every read.
- **Where each service is used:** Gemini does extraction, tutoring, quiz generation, digital-quiz parsing and cross-course comparison (always with a JSON response schema). MongoDB Atlas stores the graph. Supermemory supplies a learner profile before every explanation and quiz. AWS runs everything else.
- Full data flows are in [ARCHITECTURE.md](ARCHITECTURE.md); schemas, formulas and API routes are in [CONTRACTS.md](CONTRACTS.md).

## Repository layout

```
frontend/              React + Vite + TypeScript single-page app (fixtures let it run without a backend)
backend/lambda/        Lambda handlers and libraries (data, gemini, aws, supermemory)
backend/tests/         Unit tests, live-API smoke test (tests/e2e)
scripts/               deploy.mjs, migrate.ts, seed.ts, preflight.mjs
serverless.yml         The whole AWS stack (Serverless Framework v4)
```

## Run it locally

Prerequisites: Node 20 or newer, and the keys listed in `.env.example`.

```bash
cp .env.example .env            # then fill it in
cd frontend && npm install
npm run dev                     # http://localhost:5173, demo mode with fixture data, no login needed
```

Demo mode uses fixtures: add `?fixture=empty|one|merged` to any URL to start from no courses, one course, or two linked courses.

To run the API locally against your own databases:

```bash
cd backend && npm install
npm run migrate                 # creates the Tiger Data hypertable and the MongoDB indexes
npm run dev                     # API on http://localhost:3001 (user "dev-user")
```

## Tests

```bash
cd backend && npm test          # unit tests (learning model, handlers, data layer against in-memory fakes)
cd backend && npx tsc --noEmit  # typecheck
cd frontend && npm run build    # typecheck + production build
BASE_URL=https://<api> TOKEN=<cognito id token> npx tsx backend/tests/e2e/http-smoke.ts --uploads   # live API contract check
```

## Deploy

```bash
node --env-file=.env scripts/deploy.mjs                 # backend stack, then build and upload the site
node --env-file=.env scripts/deploy.mjs --frontend-only
```

Needs AWS credentials, a Serverless Framework login, and the variables in `.env.example`. To attach a custom domain, request an ACM certificate in `us-east-1` and pass its ARN as `SITE_CERT_ARN`.

## Safety and privacy

- Every record carries the Cognito user id and every query filters on it; the id is never returned by the API.
- Per-user daily limits on AI requests and course uploads, API-wide throttling, and CloudWatch alarms guard cost and abuse.
- CORS is limited to the site's own origins.
- Users can delete their account and every piece of data from the Account page; see `/privacy` in the app for what is stored and where.

## License

MIT. See [LICENSE](LICENSE).
# synapse
