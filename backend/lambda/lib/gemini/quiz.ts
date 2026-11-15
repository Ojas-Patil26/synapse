import { randomUUID } from "node:crypto";
import {
  FULL_QUIZ_MIX,
  type ConceptContext,
  type Difficulty,
  type QuizMode,
  type StoredQuizQuestion,
} from "../contracts";
import { InvalidOutputError, Type, asArray, asObject, clip, generateJson, shuffle, str, type Schema } from "./client";
import { conceptSection, learnerSection } from "./tutoring";

const DIFFICULTIES: Difficulty[] = ["easy", "medium", "hard"];
const RANK: Record<Difficulty, number> = { easy: 0, medium: 1, hard: 2 };
export const FULL_QUIZ_COUNT = DIFFICULTIES.reduce((n, d) => n + FULL_QUIZ_MIX[d].count, 0);
export const SHORT_QUIZ_MIN = 3;
export const SHORT_QUIZ_MAX = 5;

/** A question as the model wrote it, after basic validation. No id, no points yet. */
export interface DraftQuestion {
  prompt: string;
  options: string[];
  correctIndex: number;
  explanation: string;
  difficulty: Difficulty;
}

const schema: Schema = {
  type: Type.OBJECT,
  properties: {
    questions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          difficulty: { type: Type.STRING, enum: DIFFICULTIES },
          prompt: { type: Type.STRING },
          options: { type: Type.ARRAY, items: { type: Type.STRING }, minItems: "4", maxItems: "4" },
          correctIndex: { type: Type.INTEGER, description: "0-3, index of the correct option" },
          explanation: { type: Type.STRING, description: "One sentence on why the answer is right" },
        },
        required: ["difficulty", "prompt", "options", "correctIndex", "explanation"],
      },
    },
  },
  required: ["questions"],
};

const SYSTEM_BASE = `You write multiple-choice quiz questions that test real understanding of ONE concept from a course.
- Every question has exactly 4 options, exactly one of them correct. correctIndex is the 0-based position of the correct option.
- Distractors are plausible mistakes a student would actually make. Never use "all of the above" or "none of the above".
- Keep prompts under 45 words and options under 20 words. explanation is one short sentence saying why the correct option is right.
- easy = recall a definition or fact. medium = apply the idea to a small scenario. hard = analyse, compare or reason through a tricky case.
- Stay on the given concept and the level of the course. Use the learner profile to target weak spots (for example topics of previously missed questions) without mentioning the profile.
- No two questions may test the same fact.
- Plain text only: no LaTeX, no dollar-sign math, no markdown. Write math with ordinary characters, for example O(n log n), x^2, s0, a -> b.`;

const SYSTEM_FULL = `${SYSTEM_BASE}
Write exactly ${FULL_QUIZ_COUNT} questions: ${FULL_QUIZ_MIX.easy.count} easy, ${FULL_QUIZ_MIX.medium.count} medium, ${FULL_QUIZ_MIX.hard.count} hard.`;

const SYSTEM_SHORT = `${SYSTEM_BASE}
Write between 3 and 5 questions ordered from easiest to hardest. Choose the count by how much there is to test: 3 for a narrow concept, 5 for a broad one. Start with an easy question and end with a hard one.`;

/** Drops malformed questions. Exported for unit tests. */
export function parseDrafts(raw: unknown): DraftQuestion[] {
  const root = asObject(raw, "quiz");
  const drafts: DraftQuestion[] = [];
  const seenPrompts = new Set<string>();
  for (const item of asArray(root.questions, "questions")) {
    if (typeof item !== "object" || item === null) continue;
    const q = item as Record<string, unknown>;
    const prompt = clip(str(q.prompt), 600);
    const options = Array.isArray(q.options) ? q.options.map((o) => clip(str(o), 300)) : [];
    const correctIndex = typeof q.correctIndex === "number" ? q.correctIndex : Number.NaN;
    const difficulty = DIFFICULTIES.find((d) => d === q.difficulty);
    if (!prompt || !difficulty) continue;
    if (options.length !== 4 || options.some((o) => !o)) continue;
    if (new Set(options.map((o) => o.toLowerCase())).size !== 4) continue;
    if (!Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex > 3) continue;
    const promptKey = prompt.toLowerCase();
    if (seenPrompts.has(promptKey)) continue;
    seenPrompts.add(promptKey);
    drafts.push({
      prompt,
      options,
      correctIndex,
      difficulty,
      explanation: clip(str(q.explanation), 500) || `The correct answer is "${options[correctIndex]}".`,
    });
  }
  return drafts;
}

/** Shuffles the options and moves correctIndex with them; assigns the id and the points. */
function finalize(
  draft: DraftQuestion,
  difficulty: Difficulty,
  points: number,
  random: () => number,
): StoredQuizQuestion {
  const order = shuffle([0, 1, 2, 3], random);
  return {
    id: `q_${randomUUID()}`,
    prompt: draft.prompt,
    options: order.map((i) => draft.options[i]),
    difficulty,
    points,
    correctIndex: order.indexOf(draft.correctIndex),
    explanation: draft.explanation,
  };
}

/**
 * Full quiz: exactly 10 questions = 4 easy (1 pt), 3 medium (2 pt), 3 hard (3 pt), in
 * shuffled order. The mix and the points come from FULL_QUIZ_MIX, never from the model:
 * the drafts are ranked by the model's difficulty label and then cut into the three bands.
 */
export function buildFullQuiz(drafts: DraftQuestion[], random: () => number = Math.random): StoredQuizQuestion[] {
  if (drafts.length < FULL_QUIZ_COUNT) {
    throw new InvalidOutputError(`full quiz needs ${FULL_QUIZ_COUNT} valid questions, got ${drafts.length}`);
  }
  // Too many: drop from whichever band has the largest surplus over the required mix.
  const pool = [...drafts];
  while (pool.length > FULL_QUIZ_COUNT) {
    const surplus = (d: Difficulty) => pool.filter((q) => q.difficulty === d).length - FULL_QUIZ_MIX[d].count;
    const worst = [...DIFFICULTIES].sort((a, b) => surplus(b) - surplus(a))[0];
    pool.splice(pool.map((q) => q.difficulty).lastIndexOf(worst), 1);
  }
  const ranked = pool
    .map((q, i) => ({ q, i }))
    .sort((a, b) => RANK[a.q.difficulty] - RANK[b.q.difficulty] || a.i - b.i)
    .map((x) => x.q);

  const questions: StoredQuizQuestion[] = [];
  let cursor = 0;
  for (const difficulty of DIFFICULTIES) {
    const { count, points } = FULL_QUIZ_MIX[difficulty];
    for (const draft of ranked.slice(cursor, cursor + count)) {
      questions.push(finalize(draft, difficulty, points, random));
    }
    cursor += count;
  }
  return shuffle(questions, random);
}

/** Short quiz: 3-5 questions, easiest to hardest, question k (1-based) is worth k points. */
export function buildShortQuiz(drafts: DraftQuestion[], random: () => number = Math.random): StoredQuizQuestion[] {
  if (drafts.length < SHORT_QUIZ_MIN) {
    throw new InvalidOutputError(`short quiz needs ${SHORT_QUIZ_MIN} valid questions, got ${drafts.length}`);
  }
  return drafts
    .slice(0, SHORT_QUIZ_MAX)
    .map((q, i) => ({ q, i }))
    .sort((a, b) => RANK[a.q.difficulty] - RANK[b.q.difficulty] || a.i - b.i)
    .map((x, position) => finalize(x.q, x.q.difficulty, position + 1, random));
}

export async function generateQuiz(
  ctx: ConceptContext,
  learnerProfile: string,
  mode: QuizMode,
): Promise<StoredQuizQuestion[]> {
  return generateJson({
    name: `generateQuiz:${mode}`,
    system: mode === "full" ? SYSTEM_FULL : SYSTEM_SHORT,
    prompt: `${conceptSection(ctx)}\n\n${learnerSection(ctx, learnerProfile)}`,
    schema,
    validate: (raw) => (mode === "full" ? buildFullQuiz(parseDrafts(raw)) : buildShortQuiz(parseDrafts(raw))),
    budgetMs: 24_000,
    temperature: 0.7,
    maxOutputTokens: 6_000,
  });
}
