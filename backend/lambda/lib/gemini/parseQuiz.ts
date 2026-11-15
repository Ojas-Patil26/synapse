import type { ParseFailReason } from "../contracts";
import { Type, asObject, generateJson, str, type Schema } from "./client";

export type ParsedQuiz =
  | { ok: true; pointsEarned: number; totalPoints: number; questionCount: number }
  | { ok: false; reason: ParseFailReason };

const KINDS = ["digital-quiz-export", "handwritten-or-photographed", "not-a-quiz", "unreadable"] as const;
const MIN_OCR_CHARS = 40;
const MAX_OCR_CHARS = 30_000;

const schema: Schema = {
  type: Type.OBJECT,
  properties: {
    documentKind: { type: Type.STRING, enum: [...KINDS] },
    questions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          number: { type: Type.INTEGER },
          topic: { type: Type.STRING, description: "What the question tests, under 12 words" },
          pointsEarned: { type: Type.NUMBER, nullable: true },
          pointsPossible: { type: Type.NUMBER, nullable: true },
          relevantToConcept: { type: Type.BOOLEAN },
        },
        required: ["number", "topic", "relevantToConcept"],
      },
    },
  },
  required: ["documentKind", "questions"],
};

const SYSTEM = `You read OCR text from a file a student uploaded as a graded quiz and report what it contains. Report only what the text shows; never guess numbers.
documentKind:
- "digital-quiz-export": a typed, system-generated results page from a learning platform (for example Canvas): clean question text, answer choices, and printed scores such as "1 / 1 pts" or "Score: 8 out of 10".
- "handwritten-or-photographed": a paper quiz that was handwritten, scanned or photographed (broken words, stray marks, handwriting artefacts, grades written by hand).
- "not-a-quiz": notes, slides, an ungraded question list, or anything else.
- "unreadable": too garbled or too short to tell.
questions: one entry per graded question that appears in the text.
- pointsEarned / pointsPossible: the per-question points PRINTED for that question. Use null for both when the question shows no points of its own. Do not derive per-question points from an overall total.
- relevantToConcept: true only when the question tests the given concept or a direct part of it.`;

/** Turns the model's reading into a score or a failure reason. Exported for unit tests. */
export function interpretParsedQuiz(raw: unknown): ParsedQuiz {
  const root = asObject(raw, "parsed quiz");
  const kind = str(root.documentKind);
  if (kind === "unreadable") return { ok: false, reason: "unreadable" };
  if (kind !== "digital-quiz-export") return { ok: false, reason: "not-digital" };

  const questions = (Array.isArray(root.questions) ? root.questions : []).filter(
    (q): q is Record<string, unknown> => typeof q === "object" && q !== null,
  );
  const scored = questions.filter(
    (q) =>
      typeof q.pointsPossible === "number" &&
      Number.isFinite(q.pointsPossible) &&
      q.pointsPossible > 0 &&
      typeof q.pointsEarned === "number" &&
      Number.isFinite(q.pointsEarned),
  );
  if (scored.length === 0) return { ok: false, reason: "no-points-found" };
  if (!questions.some((q) => q.relevantToConcept === true)) return { ok: false, reason: "no-relevant-questions" };
  const relevant = scored.filter((q) => q.relevantToConcept === true);
  if (relevant.length === 0) return { ok: false, reason: "no-points-found" };

  let pointsEarned = 0;
  let totalPoints = 0;
  for (const q of relevant) {
    const possible = q.pointsPossible as number;
    totalPoints += possible;
    pointsEarned += Math.min(Math.max(q.pointsEarned as number, 0), possible);
  }
  const round = (n: number) => Math.round(n * 100) / 100;
  return { ok: true, pointsEarned: round(pointsEarned), totalPoints: round(totalPoints), questionCount: relevant.length };
}

/** Throws HttpError(502) if Gemini fails; the upload route turns that into `unreadable`. */
export async function parseDigitalQuiz(
  ocrText: string,
  conceptLabel: string,
  opts: { budgetMs?: number } = {},
): Promise<ParsedQuiz> {
  const text = ocrText.trim();
  if (text.length < MIN_OCR_CHARS) return { ok: false, reason: "unreadable" };
  return generateJson({
    name: "parseDigitalQuiz",
    system: SYSTEM,
    prompt: `Concept: ${conceptLabel}\n\nOCR text of the uploaded file:\n"""\n${text.slice(0, MAX_OCR_CHARS)}\n"""`,
    schema,
    validate: interpretParsedQuiz,
    budgetMs: opts.budgetMs ?? 12_000,
    temperature: 0,
    maxOutputTokens: 4_096,
  });
}
