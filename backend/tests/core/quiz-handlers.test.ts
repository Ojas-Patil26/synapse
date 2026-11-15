import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lambda/lib/data/service");
vi.mock("../../lambda/lib/supermemory");
vi.mock("../../lambda/lib/usage");
vi.mock("../../lambda/lib/gemini");
vi.mock("../../lambda/lib/aws/textract");

import { extractText } from "../../lambda/lib/aws/textract";
import * as data from "../../lambda/lib/data/service";
import { generateQuiz, parseDigitalQuiz } from "../../lambda/lib/gemini";
import { HttpError } from "../../lambda/lib/http";
import { getLearnerProfile, logLearningEvent } from "../../lambda/lib/supermemory";
import { generate, submit, upload } from "../../lambda/handlers/quiz";
import { USER, context, makeEvent, node, parse, storedQuiz } from "./helpers";

const path = { pathParameters: { conceptId: "c1" } };
const updated = node({ confidence: 0.5, confidenceSource: "generated-quiz", retention: 1 });

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.mocked(data.getConceptContext).mockResolvedValue(context());
  vi.mocked(data.applyAssessment).mockResolvedValue(updated);
  vi.mocked(getLearnerProfile).mockResolvedValue("profile text");
});

describe("quiz.generate", () => {
  it("never leaks correctIndex or explanation, and stores the key", async () => {
    vi.mocked(generateQuiz).mockResolvedValue(storedQuiz().questions);
    const res = await generate(makeEvent({ ...path, body: { mode: "short" } }));
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toMatch(/correctIndex|explanation|Because/);
    const body = parse(res);
    expect(body.totalPoints).toBe(6);
    expect(body.mode).toBe("short");
    expect(body.conceptId).toBe("c1");
    for (const q of body.questions) {
      expect(Object.keys(q).sort()).toEqual(["difficulty", "id", "options", "points", "prompt"]);
    }
    const saved = vi.mocked(data.saveQuiz).mock.calls[0];
    expect(saved[0]).toBe(USER);
    expect(saved[1].quizId).toBe(body.quizId);
    expect(saved[1].submittedAt).toBeNull();
    expect(saved[1].questions[2].correctIndex).toBe(2);
    // profile is read before Gemini is called
    expect(vi.mocked(getLearnerProfile).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(generateQuiz).mock.invocationCallOrder[0],
    );
    expect(vi.mocked(generateQuiz).mock.calls[0][1]).toBe("profile text");
  });

  it("400 on a bad mode, 404 on an unknown concept", async () => {
    expect((await generate(makeEvent({ ...path, body: { mode: "huge" } }))).statusCode).toBe(400);
    vi.mocked(data.getConceptContext).mockResolvedValue(null);
    expect((await generate(makeEvent({ ...path, body: { mode: "full" } }))).statusCode).toBe(404);
    expect(generateQuiz).not.toHaveBeenCalled();
  });
});

describe("quiz.submit", () => {
  const answers = (list: [string, number | null][]) => list.map(([questionId, selectedIndex]) => ({ questionId, selectedIndex }));

  it("grades against the stored key with a weighted score", async () => {
    vi.mocked(data.getQuiz).mockResolvedValue(storedQuiz());
    // q1 (1 pt) right, q2 (2 pt) wrong, q3 (3 pt) right -> 4 / 6
    const res = await submit(makeEvent({ ...path, body: { quizId: "quiz-1", answers: answers([["q1", 0], ["q2", 3], ["q3", 2]]) } }));
    expect(res.statusCode).toBe(200);
    const body = parse(res);
    expect(body).toMatchObject({ quizId: "quiz-1", pointsEarned: 4, totalPoints: 6, node: updated });
    expect(body.score).toBeCloseTo(4 / 6, 10);
    expect(body.results).toEqual([
      { questionId: "q1", correct: true, correctIndex: 0, explanation: "Because 1." },
      { questionId: "q2", correct: false, correctIndex: 1, explanation: "Because 2." },
      { questionId: "q3", correct: true, correctIndex: 2, explanation: "Because 3." },
    ]);
    expect(data.markQuizSubmitted).toHaveBeenCalledWith(USER, "quiz-1");
    expect(data.applyAssessment).toHaveBeenCalledWith(USER, "c1", { source: "generated-quiz", mode: "short", score: 4 / 6 });
    expect(vi.mocked(data.markQuizSubmitted).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(data.applyAssessment).mock.invocationCallOrder[0],
    );
    expect(logLearningEvent).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({ type: "generated-quiz", score: 4 / 6, missedQuestions: ["Question 2?"], courseName: "Operating Systems" }),
    );
  });

  it("treats unanswered, null and unknown-question answers as wrong", async () => {
    vi.mocked(data.getQuiz).mockResolvedValue(storedQuiz());
    const res = await submit(makeEvent({ ...path, body: { quizId: "quiz-1", answers: answers([["q2", null], ["nope", 1], ["q3", 2]]) } }));
    const body = parse(res);
    expect(body.pointsEarned).toBe(3);
    expect(body.score).toBeCloseTo(0.5, 10);
    expect(body.results.map((r: { correct: boolean }) => r.correct)).toEqual([false, false, true]);
  });

  it("scores 0 with no answers and 1 with all correct", async () => {
    vi.mocked(data.getQuiz).mockResolvedValue(storedQuiz());
    expect(parse(await submit(makeEvent({ ...path, body: { quizId: "quiz-1", answers: [] } }))).score).toBe(0);
    const all = await submit(makeEvent({ ...path, body: { quizId: "quiz-1", answers: answers([["q1", 0], ["q2", 1], ["q3", 2]]) } }));
    expect(parse(all).score).toBe(1);
  });

  it("returns 409 on a second submit and does not re-apply the assessment", async () => {
    vi.mocked(data.getQuiz).mockResolvedValue(storedQuiz({ submittedAt: "2026-11-14T01:00:00.000Z" }));
    const res = await submit(makeEvent({ ...path, body: { quizId: "quiz-1", answers: [] } }));
    expect(res.statusCode).toBe(409);
    expect(parse(res).error.code).toBe("conflict");
    expect(data.applyAssessment).not.toHaveBeenCalled();
    expect(data.markQuizSubmitted).not.toHaveBeenCalled();
  });

  it("404 for a missing quiz or a quiz that belongs to another concept", async () => {
    vi.mocked(data.getQuiz).mockResolvedValue(null);
    expect((await submit(makeEvent({ ...path, body: { quizId: "quiz-x", answers: [] } }))).statusCode).toBe(404);
    vi.mocked(data.getQuiz).mockResolvedValue(storedQuiz({ conceptId: "other" }));
    expect((await submit(makeEvent({ ...path, body: { quizId: "quiz-1", answers: [] } }))).statusCode).toBe(404);
    expect(data.applyAssessment).not.toHaveBeenCalled();
  });

  it("400 on malformed input", async () => {
    for (const body of [{ answers: [] }, { quizId: "q", answers: "x" }, { quizId: "q", answers: [{ questionId: "q1", selectedIndex: 7 }] }, { quizId: "q", answers: [{ selectedIndex: 1 }] }]) {
      expect((await submit(makeEvent({ ...path, body }))).statusCode).toBe(400);
    }
    expect(data.getQuiz).not.toHaveBeenCalled();
  });
});

describe("quiz.upload", () => {
  const key = `uploads/${USER}/quiz/abc-quiz.pdf`;
  const call = (...args: unknown[]) => upload(makeEvent({ ...path, body: { s3Key: args.length ? args[0] : key } }));
  const expectFailed = async (res: Awaited<ReturnType<typeof call>>, reason: string) => {
    expect(res.statusCode).toBe(200);
    expect(parse(res)).toEqual({ parseFailed: true, reason, node: null });
    expect(logLearningEvent).not.toHaveBeenCalled();
  };

  it("applies the uploaded score on success", async () => {
    vi.mocked(extractText).mockResolvedValue("Question 1 ... 1 / 1 pts ".repeat(5));
    vi.mocked(parseDigitalQuiz).mockResolvedValue({ ok: true, pointsEarned: 3, totalPoints: 4, questionCount: 2 });
    const res = await call();
    expect(res.statusCode).toBe(200);
    expect(parse(res)).toEqual({ parseFailed: false, score: 0.75, pointsEarned: 3, totalPoints: 4, questionCount: 2, node: updated });
    expect(data.applyAssessment).toHaveBeenCalledWith(USER, "c1", { source: "uploaded-quiz", score: 0.75 });
    expect(logLearningEvent).toHaveBeenCalledWith(USER, expect.objectContaining({ type: "uploaded-quiz", score: 0.75 }));
  });

  it("parseFailed when Textract throws or times out", async () => {
    vi.mocked(extractText).mockRejectedValue(new HttpError(502, "ocr_timeout", "too slow"));
    await expectFailed(await call(), "unreadable");
    vi.mocked(extractText).mockRejectedValue(new Error("AccessDeniedException"));
    await expectFailed(await call(), "unreadable");
    expect(parseDigitalQuiz).not.toHaveBeenCalled();
  });

  it("parseFailed when Gemini throws", async () => {
    vi.mocked(extractText).mockResolvedValue("some text");
    vi.mocked(parseDigitalQuiz).mockRejectedValue(new HttpError(502, "gemini_failed", "nope"));
    await expectFailed(await call(), "unreadable");
  });

  it.each(["not-digital", "no-points-found", "no-relevant-questions", "unreadable"] as const)(
    "parseFailed with reason %s from the parser",
    async (reason) => {
      vi.mocked(extractText).mockResolvedValue("some text");
      vi.mocked(parseDigitalQuiz).mockResolvedValue({ ok: false, reason });
      await expectFailed(await call(), reason);
      expect(data.applyAssessment).not.toHaveBeenCalled();
    },
  );

  it("parseFailed when the parser reports zero total points or saving fails", async () => {
    vi.mocked(extractText).mockResolvedValue("some text");
    vi.mocked(parseDigitalQuiz).mockResolvedValue({ ok: true, pointsEarned: 0, totalPoints: 0, questionCount: 1 });
    await expectFailed(await call(), "no-points-found");
    vi.mocked(parseDigitalQuiz).mockResolvedValue({ ok: true, pointsEarned: 1, totalPoints: 2, questionCount: 1 });
    vi.mocked(data.applyAssessment).mockRejectedValue(new Error("mongo down"));
    await expectFailed(await call(), "unreadable");
  });

  it("parseFailed when OCR used up the time budget", async () => {
    vi.useFakeTimers();
    vi.mocked(extractText).mockImplementation(async () => {
      vi.advanceTimersByTime(20_000);
      return "some text";
    });
    await expectFailed(await call(), "unreadable");
    expect(parseDigitalQuiz).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("400 when the s3Key belongs to someone else or is missing", async () => {
    for (const bad of ["uploads/other-user/quiz/x.pdf", `uploads/${USER}x/quiz/x.pdf`, `notes/${USER}/x.pdf`, undefined, 42, `uploads/${USER}/../other/x.pdf`]) {
      const res = await call(bad);
      expect(res.statusCode).toBe(400);
      expect(parse(res).error.code).toBe("bad_request");
    }
    expect(extractText).not.toHaveBeenCalled();
  });

  it("404 for an unknown concept", async () => {
    vi.mocked(data.getConceptContext).mockResolvedValue(null);
    expect((await call()).statusCode).toBe(404);
  });
});
