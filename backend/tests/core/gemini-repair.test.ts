import { describe, expect, it } from "vitest";
import { repairLinks } from "../../lambda/lib/gemini/compare";
import { repairExtraction } from "../../lambda/lib/gemini/extract";
import { interpretParsedQuiz } from "../../lambda/lib/gemini/parseQuiz";
import { repairSkills } from "../../lambda/lib/gemini/skills";
import { repairTutoring } from "../../lambda/lib/gemini/tutoring";
import { context } from "./helpers";

describe("repairExtraction", () => {
  it("slugs keys, fixes parents and drops dangling dependencies", () => {
    const out = repairExtraction({
      concepts: [
        { key: "CPU Scheduling", label: "CPU Scheduling", summary: "s", parentKey: null },
        { key: "rr", label: "Round Robin", summary: "s", parentKey: "CPU Scheduling" },
        { key: "quantum", label: "Time Quantum", summary: "s", parentKey: "rr" }, // grandchild -> top level
        { key: "rr", label: "Deadlock", summary: "", parentKey: "missing" }, // duplicate key, bad parent
        { key: "x", label: "", summary: "no label" },
      ],
      dependencies: [
        { from: "CPU Scheduling", to: "rr", type: "prerequisite" }, // repeats the parent pair
        { from: "quantum", to: "CPU Scheduling", type: "prerequisite" },
        { from: "CPU Scheduling", to: "quantum", type: "related" }, // duplicate pair
        { from: "quantum", to: "ghost", type: "related" },
        { from: "quantum", to: "quantum", type: "related" },
      ],
    });
    expect(out.concepts.map((c) => c.key)).toEqual(["cpu-scheduling", "quantum", "rr-2", "rr"]);
    expect(out.concepts.find((c) => c.key === "rr")?.parentKey).toBe("cpu-scheduling");
    expect(out.concepts.find((c) => c.key === "quantum")?.parentKey).toBeNull();
    expect(out.concepts.find((c) => c.key === "rr-2")?.summary).toBe("Deadlock");
    expect(out.dependencies).toEqual([{ from: "quantum", to: "cpu-scheduling", type: "prerequisite" }]);
  });

  it("caps the map at 40 nodes and 3 sub-concepts per parent", () => {
    const concepts = [
      ...Array.from({ length: 30 }, (_, i) => ({ key: `t${i}`, label: `Top ${i}`, summary: "s", parentKey: null })),
      ...Array.from({ length: 30 }, (_, i) => ({ key: `s${i}`, label: `Sub ${i}`, summary: "s", parentKey: `t${i % 5}` })),
    ];
    const out = repairExtraction({ concepts, dependencies: [] });
    expect(out.concepts.length).toBeLessThanOrEqual(40);
    for (let p = 0; p < 5; p++) {
      expect(out.concepts.filter((c) => c.parentKey === `t${p}`).length).toBeLessThanOrEqual(3);
    }
  });

  it("rejects output with too few concepts", () => {
    expect(() => repairExtraction({ concepts: [{ key: "a", label: "A", summary: "s" }], dependencies: [] })).toThrow();
  });
});

describe("repairTutoring", () => {
  const explanation = "x".repeat(300);
  it("builds search URLs in code and never passes a model URL through", () => {
    const out = repairTutoring(
      {
        summary: "S",
        explanation,
        resources: [
          { title: "RR video", type: "video", searchQuery: "round robin scheduling & quantum" },
          { title: "RR article", type: "article", searchQuery: "https://evil.example/x" },
          { title: "RR drills", type: "practice", searchQuery: "round robin practice" },
          { title: "Bad type", type: "podcast", searchQuery: "q" },
        ],
      },
      context(),
    );
    expect(out.resources.length).toBeGreaterThanOrEqual(3);
    expect(out.resources.length).toBeLessThanOrEqual(5);
    expect(out.resources[0].url).toBe(
      "https://www.youtube.com/results?search_query=round%20robin%20scheduling%20%26%20quantum",
    );
    for (const r of out.resources) {
      expect(r.url.startsWith(r.type === "video" ? "https://www.youtube.com/results?search_query=" : "https://www.google.com/search?q=")).toBe(true);
      expect(r.url).not.toContain("evil.example");
    }
  });

  it("pads to 3 resources and rejects a too-short explanation", () => {
    expect(repairTutoring({ summary: "", explanation, resources: [] }, context()).resources).toHaveLength(3);
    expect(() => repairTutoring({ summary: "S", explanation: "short", resources: [] }, context())).toThrow();
  });
});

describe("repairLinks", () => {
  const a = { id: "A", name: "OS", concepts: [{ id: "a-1", label: "x", summary: "" }, { id: "a-2", label: "y", summary: "" }] };
  const b = { id: "B", name: "DB", concepts: [{ id: "b-1", label: "z", summary: "" }] };
  it("maps refs to real ids and drops links without a real id on each side", () => {
    const out = repairLinks(
      {
        links: [
          { description: "Both lock.", conceptsA: ["A1", "A9"], conceptsB: ["b1"] },
          { description: "No B side.", conceptsA: ["A2"], conceptsB: ["B7"] },
          { description: "Wrong side.", conceptsA: ["B1"], conceptsB: ["A1"] },
          { description: "", conceptsA: ["A2"], conceptsB: ["B1"] },
          { description: "Raw ids work too.", conceptsA: ["a-2"], conceptsB: ["b-1"] },
        ],
      },
      a,
      b,
    );
    expect(out).toEqual([
      { sourceCourseId: "A", targetCourseId: "B", sharedConceptIds: ["a-1", "b-1"], description: "Both lock." },
      { sourceCourseId: "A", targetCourseId: "B", sharedConceptIds: ["a-2", "b-1"], description: "Raw ids work too." },
    ]);
  });
  it("caps at 6 links and accepts none", () => {
    expect(repairLinks({ links: [] }, a, b)).toEqual([]);
    const many = Array.from({ length: 9 }, (_, i) => ({ description: `d${i}`, conceptsA: [i % 2 ? "A1" : "A2"], conceptsB: ["B1"] }));
    expect(repairLinks({ links: many }, a, b).length).toBeLessThanOrEqual(6);
  });
});

describe("interpretParsedQuiz", () => {
  const q = (earned: number | null, possible: number | null, relevant: boolean) => ({
    number: 1, topic: "t", pointsEarned: earned, pointsPossible: possible, relevantToConcept: relevant,
  });
  it("scores only the relevant questions", () => {
    expect(
      interpretParsedQuiz({ documentKind: "digital-quiz-export", questions: [q(1, 1, true), q(0, 2, true), q(5, 5, false), q(9, 2, true)] }),
    ).toEqual({ ok: true, pointsEarned: 3, totalPoints: 5, questionCount: 3 });
  });
  it("maps every failure to its reason", () => {
    const reason = (raw: unknown) => {
      const r = interpretParsedQuiz(raw);
      return r.ok ? "ok" : r.reason;
    };
    expect(reason({ documentKind: "handwritten-or-photographed", questions: [q(1, 1, true)] })).toBe("not-digital");
    expect(reason({ documentKind: "not-a-quiz", questions: [] })).toBe("not-digital");
    expect(reason({ documentKind: "unreadable", questions: [] })).toBe("unreadable");
    expect(reason({ documentKind: "digital-quiz-export", questions: [q(null, null, true)] })).toBe("no-points-found");
    expect(reason({ documentKind: "digital-quiz-export", questions: [] })).toBe("no-points-found");
    expect(reason({ documentKind: "digital-quiz-export", questions: [q(1, 1, false)] })).toBe("no-relevant-questions");
    expect(reason({ documentKind: "digital-quiz-export", questions: [q(1, 1, false), q(null, null, true)] })).toBe("no-points-found");
  });
});

describe("repairSkills", () => {
  it("dedupes, caps at 8 and requires at least 4", () => {
    const out = repairSkills({ industrySkills: ["A", "a", "B", "C", "D", "E", "F", "G", "H", "I"], skillsSummary: "Sum." });
    expect(out.industrySkills).toEqual(["A", "B", "C", "D", "E", "F", "G", "H"]);
    expect(() => repairSkills({ industrySkills: ["A", "B"], skillsSummary: "Sum." })).toThrow();
  });
});
