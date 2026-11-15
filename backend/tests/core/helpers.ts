import type { ApiEvent } from "../../lambda/lib/http";
import type { ConceptContext, ConceptNode, Course, StoredQuiz } from "../../lambda/lib/contracts";

export const USER = "user-1";

export function makeEvent(opts: {
  body?: unknown;
  rawBody?: string;
  pathParameters?: Record<string, string>;
  query?: Record<string, string>;
  userId?: string | null;
} = {}): ApiEvent {
  const userId = opts.userId === undefined ? USER : opts.userId;
  return {
    version: "2.0",
    routeKey: "TEST /route",
    rawPath: "/route",
    rawQueryString: "",
    headers: {},
    isBase64Encoded: false,
    pathParameters: opts.pathParameters,
    queryStringParameters: opts.query,
    body: opts.rawBody ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
    requestContext: {
      authorizer: userId === null ? undefined : { jwt: { claims: { sub: userId }, scopes: [] } },
    },
  } as unknown as ApiEvent;
}

export const parse = (res: { body?: string }) => JSON.parse(res.body ?? "null");

export const node = (over: Partial<ConceptNode> = {}): ConceptNode => ({
  id: "c1",
  label: "Round Robin",
  courseId: "course-1",
  lastReviewed: "2026-11-14T00:00:00.000Z",
  stability: 2,
  retention: 0.6,
  confidence: null,
  confidenceSource: null,
  connectionCount: 2,
  ...over,
});

export const context = (over: Partial<ConceptContext> = {}): ConceptContext => ({
  node: node(),
  courseName: "Operating Systems",
  summary: "Each process gets a fixed time slice in turn.",
  explanation: null,
  resources: [],
  generatedAt: null,
  sourceExcerpt: "Round robin gives each process a quantum.",
  ...over,
});

export const course = (over: Partial<Course> = {}): Course => ({
  id: "course-1",
  name: "Operating Systems",
  conceptCount: 12,
  industrySkills: [],
  skillsSummary: "",
  status: "ready",
  error: null,
  createdAt: "2026-11-14T00:00:00.000Z",
  ...over,
});

/** Three questions worth 1, 2 and 3 points; correct answers are index 0, 1, 2. */
export const storedQuiz = (over: Partial<StoredQuiz> = {}): StoredQuiz => ({
  quizId: "quiz-1",
  conceptId: "c1",
  mode: "short",
  createdAt: "2026-11-14T00:00:00.000Z",
  submittedAt: null,
  questions: [1, 2, 3].map((k) => ({
    id: `q${k}`,
    prompt: `Question ${k}?`,
    options: ["a", "b", "c", "d"],
    difficulty: "easy" as const,
    points: k,
    correctIndex: k - 1,
    explanation: `Because ${k}.`,
  })),
  ...over,
});
