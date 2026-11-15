import { randomUUID } from "node:crypto";
import { assertOwnsKey } from "../lib/aws/s3";
import { extractText } from "../lib/aws/textract";
import type {
  ParseFailReason,
  QuizGenerateResponse,
  QuizMode,
  QuizQuestion,
  QuizSubmitResponse,
  QuizUploadResponse,
  StoredQuiz,
} from "../lib/contracts";
import { applyAssessment, getConceptContext, getQuiz, markQuizSubmitted, saveQuiz } from "../lib/data/service";
import { generateQuiz, parseDigitalQuiz } from "../lib/gemini";
import { consume } from "../lib/usage";
import {
  badRequest,
  conflict,
  describeError,
  getUserId,
  handler,
  json,
  notFound,
  parseBody,
  pathParam,
  requireString,
} from "../lib/http";
import { getLearnerProfile, logLearningEvent } from "../lib/supermemory";

const MODES: QuizMode[] = ["short", "full"];

/** POST /quiz/{conceptId}/generate */
export const generate = handler(async (event) => {
  const userId = getUserId(event);
  const conceptId = pathParam(event, "conceptId");
  const mode = MODES.find((m) => m === parseBody(event).mode);
  if (!mode) throw badRequest('"mode" must be "short" or "full".');

  const ctx = await getConceptContext(userId, conceptId);
  if (!ctx) throw notFound("That concept does not exist.");

  await consume(userId, "ai");
  const profile = await getLearnerProfile(userId, {
    conceptLabel: ctx.node.label,
    courseName: ctx.courseName,
  });
  const stored = await generateQuiz(ctx, profile, mode);

  const quiz: StoredQuiz = {
    quizId: `quiz_${randomUUID()}`,
    conceptId,
    mode,
    createdAt: new Date().toISOString(),
    submittedAt: null,
    questions: stored,
  };
  await saveQuiz(userId, quiz);

  // Whitelist the public fields: the answer key and explanations stay server-side.
  const questions: QuizQuestion[] = stored.map((q) => ({
    id: q.id,
    prompt: q.prompt,
    options: q.options,
    difficulty: q.difficulty,
    points: q.points,
  }));
  const response: QuizGenerateResponse = {
    quizId: quiz.quizId,
    conceptId,
    mode,
    totalPoints: questions.reduce((sum, q) => sum + q.points, 0),
    questions,
  };
  return json(200, response);
});

function parseAnswers(raw: unknown): Map<string, number | null> {
  if (!Array.isArray(raw)) throw badRequest('"answers" must be an array.');
  const answers = new Map<string, number | null>();
  for (const item of raw) {
    if (typeof item !== "object" || item === null) throw badRequest("Each answer must be an object.");
    const { questionId, selectedIndex } = item as Record<string, unknown>;
    if (typeof questionId !== "string" || !questionId) throw badRequest('Each answer needs a "questionId".');
    const isIndex = typeof selectedIndex === "number" && Number.isInteger(selectedIndex) && selectedIndex >= 0 && selectedIndex <= 3;
    if (selectedIndex !== null && selectedIndex !== undefined && !isIndex) {
      throw badRequest('"selectedIndex" must be 0, 1, 2, 3 or null.');
    }
    answers.set(questionId, isIndex ? (selectedIndex as number) : null);
  }
  return answers;
}

/** POST /quiz/{conceptId}/submit */
export const submit = handler(async (event) => {
  const userId = getUserId(event);
  const conceptId = pathParam(event, "conceptId");
  const body = parseBody(event);
  const quizId = requireString(body, "quizId");
  const answers = parseAnswers(body.answers);

  const quiz = await getQuiz(userId, quizId);
  if (!quiz || quiz.conceptId !== conceptId) throw notFound("That quiz does not exist.");
  if (quiz.submittedAt) throw conflict("This quiz has already been submitted.");
  const ctx = await getConceptContext(userId, conceptId);
  if (!ctx) throw notFound("That concept does not exist.");

  // Grade against the stored key. A missing or null answer is wrong.
  let pointsEarned = 0;
  let totalPoints = 0;
  const missedQuestions: string[] = [];
  const results: QuizSubmitResponse["results"] = quiz.questions.map((q) => {
    const selected = answers.get(q.id) ?? null;
    const correct = selected !== null && selected === q.correctIndex;
    totalPoints += q.points;
    if (correct) pointsEarned += q.points;
    else missedQuestions.push(q.prompt);
    return { questionId: q.id, correct, correctIndex: q.correctIndex, explanation: q.explanation };
  });
  const score = totalPoints > 0 ? pointsEarned / totalPoints : 0;

  await markQuizSubmitted(userId, quizId);
  const node = await applyAssessment(userId, conceptId, { source: "generated-quiz", mode: quiz.mode, score });
  await logLearningEvent(userId, {
    type: "generated-quiz",
    courseName: ctx.courseName,
    conceptLabel: ctx.node.label,
    score,
    confidence: node.confidence,
    retention: ctx.node.retention, // retention just before this quiz
    missedQuestions,
    timestamp: new Date().toISOString(),
  });

  const response: QuizSubmitResponse = { quizId, score, pointsEarned, totalPoints, results, node };
  return json(200, response);
});

// Upload timing: the whole request must finish well inside API Gateway's 30 s limit.
const UPLOAD_TOTAL_MS = 24_000;
const UPLOAD_OCR_MS = 12_000;
const UPLOAD_SAVE_RESERVE_MS = 3_000;

/**
 * POST /quiz/{conceptId}/upload. Bad input is still 400/404, but once the file is being
 * read EVERY failure is a 200 with parseFailed: true so the UI can fall back to a full quiz.
 */
export const upload = handler(async (event) => {
  const startedAt = Date.now();
  const userId = getUserId(event);
  const conceptId = pathParam(event, "conceptId");
  const s3Key = parseBody(event).s3Key;
  assertOwnsKey(userId, s3Key);

  const ctx = await getConceptContext(userId, conceptId);
  if (!ctx) throw notFound("That concept does not exist.");
  await consume(userId, "ai");

  const failed = (reason: ParseFailReason) => {
    const response: QuizUploadResponse = { parseFailed: true, reason, node: null };
    return json(200, response);
  };

  let response: Extract<QuizUploadResponse, { parseFailed: false }>;
  try {
    const text = await extractText(s3Key, undefined, { deadlineMs: UPLOAD_OCR_MS });
    const remaining = UPLOAD_TOTAL_MS - (Date.now() - startedAt) - UPLOAD_SAVE_RESERVE_MS;
    if (remaining < 4_000) return failed("unreadable");
    const parsed = await parseDigitalQuiz(text, ctx.node.label, { budgetMs: remaining });
    if (!parsed.ok) return failed(parsed.reason);
    if (!(parsed.totalPoints > 0)) return failed("no-points-found");

    const score = Math.min(Math.max(parsed.pointsEarned / parsed.totalPoints, 0), 1);
    const node = await applyAssessment(userId, conceptId, { source: "uploaded-quiz", score });
    response = {
      parseFailed: false,
      score,
      pointsEarned: parsed.pointsEarned,
      totalPoints: parsed.totalPoints,
      questionCount: parsed.questionCount,
      node,
    };
  } catch (err) {
    console.warn(`[quiz.upload] falling back to a generated quiz: ${describeError(err)}`);
    return failed("unreadable");
  }

  await logLearningEvent(userId, {
    type: "uploaded-quiz",
    courseName: ctx.courseName,
    conceptLabel: ctx.node.label,
    score: response.score,
    confidence: response.node.confidence,
    retention: ctx.node.retention,
    timestamp: new Date().toISOString(),
  });
  return json(200, response);
});
