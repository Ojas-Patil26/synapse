import { describe, expect, it } from "vitest";
import { FULL_QUIZ_MIX, type Difficulty } from "../../lambda/lib/contracts";
import { buildFullQuiz, buildShortQuiz, parseDrafts, type DraftQuestion } from "../../lambda/lib/gemini/quiz";

const draft = (n: number, difficulty: Difficulty, correctIndex = 0): DraftQuestion => ({
  prompt: `Question ${n}?`,
  options: [`right-${n}`, `wrong-${n}-a`, `wrong-${n}-b`, `wrong-${n}-c`].map((o, i, all) =>
    i === correctIndex ? all[0] : i === 0 ? all[correctIndex] : o,
  ),
  correctIndex,
  explanation: `Explanation ${n}`,
  difficulty,
});
const drafts = (mix: Difficulty[]) => mix.map((d, i) => draft(i + 1, d, i % 4));
const count = (qs: { difficulty: Difficulty }[], d: Difficulty) => qs.filter((q) => q.difficulty === d).length;
const E = "easy", M = "medium", H = "hard";

function expectFullInvariants(qs: ReturnType<typeof buildFullQuiz>) {
  expect(qs).toHaveLength(10);
  for (const d of ["easy", "medium", "hard"] as Difficulty[]) {
    expect(count(qs, d)).toBe(FULL_QUIZ_MIX[d].count);
    for (const q of qs.filter((x) => x.difficulty === d)) expect(q.points).toBe(FULL_QUIZ_MIX[d].points);
  }
  expect(qs.reduce((s, q) => s + q.points, 0)).toBe(19);
  expect(new Set(qs.map((q) => q.id)).size).toBe(10);
  for (const q of qs) {
    expect(q.options).toHaveLength(4);
    expect(q.options[q.correctIndex]).toMatch(/^right-/); // correctIndex followed the shuffle
  }
}

describe("buildFullQuiz", () => {
  it("enforces 4 easy / 3 medium / 3 hard with 1 / 2 / 3 points", () => {
    expectFullInvariants(buildFullQuiz(drafts([E, E, E, E, M, M, M, H, H, H])));
  });

  it("repairs a wrong difficulty mix from the model", () => {
    expectFullInvariants(buildFullQuiz(drafts([E, E, E, E, E, E, M, M, H, H])));
    expectFullInvariants(buildFullQuiz(drafts([H, H, H, H, H, H, H, H, H, H])));
  });

  it("trims extra questions down to exactly 10", () => {
    expectFullInvariants(buildFullQuiz(drafts([E, E, E, E, E, M, M, M, M, H, H, H, H])));
  });

  it("rejects fewer than 10 valid questions", () => {
    expect(() => buildFullQuiz(drafts([E, E, E, E, M, M, M, H, H]))).toThrowError(/needs 10/);
  });

  it("shuffles question order and option order", () => {
    const orders = new Set<string>();
    const positions = new Set<number>();
    for (let i = 0; i < 25; i++) {
      const qs = buildFullQuiz(drafts([E, E, E, E, M, M, M, H, H, H]).map((d) => ({ ...draft(Number(d.prompt.match(/\d+/)![0]), d.difficulty, 0) })));
      orders.add(qs.map((q) => q.difficulty[0]).join(""));
      qs.forEach((q) => positions.add(q.correctIndex));
    }
    expect(orders.size).toBeGreaterThan(1);
    expect(positions.size).toBe(4); // the right answer is not always first
  });
});

describe("buildShortQuiz", () => {
  it("orders easiest to hardest and gives question k exactly k points", () => {
    const qs = buildShortQuiz(drafts([H, E, M, M]));
    expect(qs.map((q) => q.difficulty)).toEqual([E, M, M, H]);
    expect(qs.map((q) => q.points)).toEqual([1, 2, 3, 4]);
    for (const q of qs) expect(q.options[q.correctIndex]).toMatch(/^right-/);
  });

  it("keeps between 3 and 5 questions", () => {
    expect(buildShortQuiz(drafts([E, M, H])).map((q) => q.points)).toEqual([1, 2, 3]);
    expect(buildShortQuiz(drafts([E, E, M, M, H, H, H])).map((q) => q.points)).toEqual([1, 2, 3, 4, 5]);
    expect(() => buildShortQuiz(drafts([E, M]))).toThrowError(/needs 3/);
  });
});

describe("parseDrafts", () => {
  it("drops malformed questions and keeps valid ones", () => {
    const good = { difficulty: "easy", prompt: "P?", options: ["a", "b", "c", "d"], correctIndex: 2, explanation: "" };
    const out = parseDrafts({
      questions: [
        good,
        { ...good, prompt: "three options", options: ["a", "b", "c"] },
        { ...good, prompt: "bad index", correctIndex: 4 },
        { ...good, prompt: "dup options", options: ["a", "a", "c", "d"] },
        { ...good, prompt: "bad difficulty", difficulty: "extreme" },
        { ...good }, // duplicate prompt
        null,
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0].explanation).toContain('"c"'); // fallback explanation names the answer
  });
});
