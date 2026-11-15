// TypeScript mirror of CONTRACTS.md. If the two disagree, CONTRACTS.md wins.
// An identical copy lives at frontend/src/contracts.ts. Do not edit either copy.
//
// Naming: CONTRACTS.md calls a concept node "Node". It is ConceptNode here so it
// does not clash with the DOM's global Node type.

export type ConfidenceSource = "generated-quiz" | "uploaded-quiz";
export type RelationType = "prerequisite" | "related" | "subconcept" | "cross-course";
export type CourseStatus = "processing" | "ready" | "failed";
export type EventType = "ingested" | "self-review" | "generated-quiz" | "uploaded-quiz";
export type QuizMode = "short" | "full";
export type Difficulty = "easy" | "medium" | "hard";
export type Rating = "got-it" | "still-shaky";
export type ConfidenceLevel = "unassessed" | "low" | "medium" | "high";
export type UploadPurpose = "notes" | "quiz";
export type ParseFailReason = "not-digital" | "no-points-found" | "no-relevant-questions" | "unreadable";

// ---------- Section 1: schemas ----------

export interface ConceptNode {
  id: string;
  label: string;
  courseId: string;
  lastReviewed: string;
  stability: number;
  retention: number;
  confidence: number | null;
  confidenceSource: ConfidenceSource | null;
  connectionCount: number;
}

export interface Edge {
  source: string;
  target: string;
  relationType: RelationType;
  isCrossCourse: boolean;
}

export interface Course {
  id: string;
  name: string;
  conceptCount: number;
  industrySkills: string[];
  skillsSummary: string;
  status: CourseStatus;
  error: string | null;
  createdAt: string;
  semester: string | null;
}

export interface CrossCourseLink {
  sourceCourseId: string;
  targetCourseId: string;
  sharedConceptIds: string[];
  description: string;
}

export interface GraphResponse {
  courses: Course[];
  nodes: ConceptNode[];
  edges: Edge[];
  crossCourseLinks: CrossCourseLink[];
}

export interface Resource {
  title: string;
  url: string;
  type: "video" | "article" | "practice";
}

export interface GuideEntry {
  conceptId: string;
  label: string;
  courseId: string;
  courseName: string;
  retention: number;
  stability: number;
  lastReviewed: string;
  confidence: number | null;
  confidenceSource: ConfidenceSource | null;
  predictedForgetAt: string;
  zScore: number | null;
  anomalous: boolean;
  urgency: number;
  summary: string;
  explanation: string | null;
  resources: Resource[];
  generatedAt: string | null;
}

export interface QuizQuestion {
  id: string;
  prompt: string;
  options: string[]; // exactly 4
  difficulty: Difficulty;
  points: number;
}

// ---------- Section 2: learning-model constants ----------

export const S0 = 2.0;
export const S_MIN = 1.0;
export const S_MAX = 365;
export const FORGET_THRESHOLD = 0.5;
// Retention a concept starts from after a review (CONTRACTS.md section 2).
export const RETENTION_FLOOR = 0.15; // quiz score 0%
export const RETENTION_FULL_SCORE = 0.8; // quiz score at which retention is fully restored
export const SHAKY_RETENTION_CAP = 0.4; // "still shaky" leaves retention at most this high
export const CONFIDENCE_LOW_BELOW = 0.4; // confidence < 0.40 = low
export const CONFIDENCE_HIGH_ABOVE = 0.75; // confidence > 0.75 = high
export const ZSCORE_WINDOW = 5;
export const ZSCORE_ANOMALY = -1.5;
export const SIGMA_DEFAULT = 0.25;
export const SIGMA_FLOOR = 0.15;
export const FULL_QUIZ_MIX: Record<Difficulty, { count: number; points: number }> = {
  easy: { count: 4, points: 1 },
  medium: { count: 3, points: 2 },
  hard: { count: 3, points: 3 },
};

export function confidenceLevel(confidence: number | null): ConfidenceLevel {
  if (confidence === null) return "unassessed";
  if (confidence < CONFIDENCE_LOW_BELOW) return "low";
  if (confidence > CONFIDENCE_HIGH_ABOVE) return "high";
  return "medium";
}

// ---------- Section 3: API request / response bodies ----------

export interface ApiError {
  error: { code: string; message: string };
}

export interface ReviewRequest {
  conceptId: string;
  rating: Rating;
}
export interface ReviewResponse {
  node: ConceptNode;
}

export interface DecayConceptStatus {
  conceptId: string;
  label: string;
  retention: number;
  stability: number;
  lastReviewed: string;
  predictedForgetAt: string;
  zScore: number | null;
  anomalous: boolean;
  reviewCount: number;
}
export interface DecayStatus {
  courseId: string;
  scannedAt: string | null;
  threshold: number;
  summary: { averageRetention: number; atRiskCount: number; anomalousCount: number };
  concepts: DecayConceptStatus[];
}

export interface QuizGenerateRequest {
  mode: QuizMode;
}
export interface QuizGenerateResponse {
  quizId: string;
  conceptId: string;
  mode: QuizMode;
  totalPoints: number;
  questions: QuizQuestion[];
}

export interface QuizSubmitRequest {
  quizId: string;
  answers: { questionId: string; selectedIndex: number | null }[];
}
export interface QuizSubmitResponse {
  quizId: string;
  score: number;
  pointsEarned: number;
  totalPoints: number;
  results: { questionId: string; correct: boolean; correctIndex: number; explanation: string }[];
  node: ConceptNode;
}

export interface QuizUploadRequest {
  s3Key: string;
}
export type QuizUploadResponse =
  | {
      parseFailed: false;
      score: number;
      pointsEarned: number;
      totalPoints: number;
      questionCount: number;
      node: ConceptNode;
    }
  | { parseFailed: true; reason: ParseFailReason; node: null };

export interface LinkCoursesResponse {
  links: CrossCourseLink[];
  edges: Edge[];
}

export interface CourseSkillsResponse {
  courseId: string;
  industrySkills: string[];
  skillsSummary: string;
}

export interface GuideListResponse {
  entries: GuideEntry[];
}
export interface GuideEntryResponse {
  entry: GuideEntry;
}

export interface PresignRequest {
  fileName: string;
  contentType: string;
  purpose: UploadPurpose;
}
export interface PresignResponse {
  uploadUrl: string;
  s3Key: string;
  expiresIn: number;
}
export const ALLOWED_UPLOAD_TYPES: Record<UploadPurpose, string[]> = {
  notes: ["application/pdf", "image/png", "image/jpeg", "text/plain", "text/markdown"],
  quiz: ["application/pdf", "image/png", "image/jpeg", "text/plain"],
};
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_FILES_PER_COURSE = 5;

export interface CreateCourseRequest {
  name: string;
  semester?: string | null; // optional, e.g. "Fall 2026"; max 40 characters
  s3Keys: string[];
}
export const MAX_SEMESTER_LENGTH = 40;
export interface CourseResponse {
  course: Course;
}

// ---------- Section 4: internal (backend-only) types ----------

export interface ExtractedConcept {
  key: string;
  label: string;
  summary: string;
  parentKey: string | null;
}
export interface ExtractedDependency {
  from: string;
  to: string;
  type: "prerequisite" | "related";
}
export interface ConceptBrief {
  id: string;
  label: string;
  summary: string;
}
export interface ConceptContext {
  node: ConceptNode;
  courseName: string;
  summary: string;
  explanation: string | null;
  resources: Resource[];
  generatedAt: string | null;
  sourceExcerpt: string;
}
export type StoredQuizQuestion = QuizQuestion & { correctIndex: number; explanation: string };
export interface StoredQuiz {
  quizId: string;
  conceptId: string;
  mode: QuizMode;
  createdAt: string;
  submittedAt: string | null;
  questions: StoredQuizQuestion[];
}
export interface AlertItem {
  userId: string;
  conceptId: string;
  label: string;
  courseName: string;
  retention: number;
  zScore: number | null;
}
export interface IngestPayload {
  userId: string;
  courseId: string;
  s3Keys: string[];
}
export interface LearningEvent {
  type: "course-ingested" | "self-review" | "generated-quiz" | "uploaded-quiz" | "explanation-viewed";
  courseName: string;
  conceptLabel?: string;
  rating?: Rating;
  score?: number;
  confidence?: number | null;
  retention?: number;
  missedQuestions?: string[];
  timestamp: string;
}
