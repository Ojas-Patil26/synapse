import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  describeLearningEvent,
  getLearnerProfile,
  learnerNamespace,
  logLearningEvent,
} from "../../lambda/lib/supermemory";
import type { LearningEvent } from "../../lambda/lib/contracts";

const KEY = "sm_test_key";
const USER = "3f2a9c1e-1111-4222-8333-abcdefabcdef";
const NS = `synapse-${USER}`;
const BASE = "https://api.supermemory.ai";

const quizEvent: LearningEvent = {
  type: "generated-quiz",
  courseName: "CSE 471",
  conceptLabel: "A* Search",
  score: 0.53,
  confidence: 0.53,
  retention: 0.61,
  missedQuestions: ["Why must the heuristic be admissible?"],
  timestamp: "2026-11-15T18:00:00.000Z",
};

type Call = { url: string; init: RequestInit; body: any };
let calls: Call[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Installs a fetch mock; `respond` decides the outcome per request. */
function mockFetch(respond: (call: Call) => Response | Promise<Response>) {
  const fn = vi.fn(async (url: any, init: any = {}) => {
    const call: Call = { url: String(url), init, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    return respond(call);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

/** A fetch that never settles unless its signal is aborted (like the real one). */
function hang(call: Call): Promise<Response> {
  return new Promise((_, reject) => {
    call.init.signal?.addEventListener("abort", () =>
      reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
    );
  });
}

const profileBody = {
  profile: {
    static: [{ id: "m1", memory: "Learner studies CSE 471." }],
    dynamic: [{ id: "m2", memory: "[2026-11-15] Learner scored 90% on Bayesian Networks." }],
    buckets: {},
  },
};
const searchBody = {
  results: [
    { id: "m3", memory: "Learner scored 53% on the A* Search quiz.", similarity: 0.8 },
    { id: "c1", chunk: "On 2026-11-15 the learner opened the explanation for 'A* Search'.", similarity: 0.6 },
  ],
  searchTime: 12,
};

beforeEach(() => {
  calls = [];
  vi.stubEnv("SUPERMEMORY_API_KEY", KEY);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("missing API key", () => {
  it("makes both functions no-ops", async () => {
    vi.stubEnv("SUPERMEMORY_API_KEY", "");
    const fetchMock = mockFetch(() => json(profileBody));
    await expect(getLearnerProfile(USER, { conceptLabel: "A* Search" })).resolves.toBe("");
    await expect(logLearningEvent(USER, quizEvent)).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does nothing for an empty user id", async () => {
    const fetchMock = mockFetch(() => json(profileBody));
    await expect(getLearnerProfile("  ")).resolves.toBe("");
    await expect(logLearningEvent("", quizEvent)).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("getLearnerProfile", () => {
  it("calls the profile and search endpoints of the user's namespace with bearer auth", async () => {
    mockFetch((c) => json(c.url.endsWith("/profile") ? profileBody : searchBody));
    await getLearnerProfile(USER, { conceptLabel: "A* Search", courseName: "CSE 471" });

    expect(calls.map((c) => c.url).sort()).toEqual([`${BASE}/ns/${NS}/profile`, `${BASE}/ns/${NS}/search`]);
    for (const c of calls) {
      expect(c.init.method).toBe("POST");
      const headers = c.init.headers as Record<string, string>;
      expect(headers.Authorization).toBe(`Bearer ${KEY}`);
      expect(headers["Content-Type"]).toBe("application/json");
      expect(c.init.signal).toBeInstanceOf(AbortSignal);
    }
    const search = calls.find((c) => c.url.endsWith("/search"))!;
    expect(search.body.query).toContain("A* Search");
    expect(search.body.query).toContain("CSE 471");
    expect(search.body.searchMode).toBe("hybrid");
    // The user id travels only in the namespace path, never in a body.
    expect(JSON.stringify(calls.map((c) => c.body))).not.toContain(USER);
  });

  it("returns a compact plain-text profile with the focus section first", async () => {
    mockFetch((c) => json(c.url.endsWith("/profile") ? profileBody : searchBody));
    const out = await getLearnerProfile(USER, { conceptLabel: "A* Search", courseName: "CSE 471" });
    expect(out.startsWith('Most relevant to "A* Search" (CSE 471):')).toBe(true);
    expect(out).toContain("- Learner scored 53% on the A* Search quiz.");
    expect(out).toContain("- Learner studies CSE 471.");
    expect(out).toContain("Recent activity:");
    expect(out.indexOf("53%")).toBeLessThan(out.indexOf("Learner studies"));
  });

  it("never exceeds 1,500 characters and drops duplicates", async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ id: `m${i}`, memory: `Fact ${i}: ${"x".repeat(200)}` }));
    mockFetch((c) =>
      json(
        c.url.endsWith("/profile")
          ? { profile: { static: [...many, ...many], dynamic: many, buckets: {} } }
          : { results: [{ id: "m0", memory: many[0].memory }] },
      ),
    );
    const out = await getLearnerProfile(USER);
    expect(out.length).toBeGreaterThan(500);
    expect(out.length).toBeLessThanOrEqual(1500);
    expect(out.split(many[0].memory).length - 1).toBe(1);
  });

  it('returns "" when the user has no memories', async () => {
    mockFetch((c) =>
      json(c.url.endsWith("/profile") ? { profile: { static: [], dynamic: [], buckets: {} } } : { results: [] }),
    );
    await expect(getLearnerProfile(USER)).resolves.toBe("");
  });

  it('returns "" on a network error', async () => {
    mockFetch(() => {
      throw new TypeError("fetch failed");
    });
    await expect(getLearnerProfile(USER)).resolves.toBe("");
  });

  it.each([401, 402, 404, 429, 500])('returns "" on HTTP %i', async (status) => {
    mockFetch(() => json({ error: "nope" }, status));
    await expect(getLearnerProfile(USER)).resolves.toBe("");
  });

  it('returns "" on malformed JSON and on an unexpected JSON shape', async () => {
    mockFetch(() => new Response("<html>oops", { status: 200 }));
    await expect(getLearnerProfile(USER)).resolves.toBe("");
    mockFetch(() => json(["not", "an", "object"]));
    await expect(getLearnerProfile(USER)).resolves.toBe("");
    mockFetch(() => json({ profile: { static: "nope", dynamic: [null, 7, {}] }, results: "nope" }));
    await expect(getLearnerProfile(USER)).resolves.toBe("");
  });

  it("still returns what it has when only one of the two calls fails", async () => {
    mockFetch((c) => (c.url.endsWith("/profile") ? json(profileBody) : json({ error: "x" }, 500)));
    const out = await getLearnerProfile(USER, { conceptLabel: "A* Search" });
    expect(out).toContain("Learner studies CSE 471.");
  });

  it('returns "" after 3 seconds when Supermemory hangs, and aborts the requests', async () => {
    vi.useFakeTimers();
    mockFetch(hang);
    let settled: string | undefined;
    const p = getLearnerProfile(USER).then((v) => (settled = v));
    await vi.advanceTimersByTimeAsync(2999);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2);
    await p;
    expect(settled).toBe("");
    expect(calls.every((c) => (c.init.signal as AbortSignal).aborted)).toBe(true);
  });

  it("returns by the deadline even if fetch ignores the abort signal", async () => {
    vi.useFakeTimers();
    mockFetch(() => new Promise<Response>(() => {}));
    const p = getLearnerProfile(USER);
    await vi.advanceTimersByTimeAsync(3001);
    await expect(p).resolves.toBe("");
  });

  it("uses the profile that arrived when the search call is the slow one", async () => {
    vi.useFakeTimers();
    mockFetch((c) => (c.url.endsWith("/profile") ? json(profileBody) : hang(c)));
    const p = getLearnerProfile(USER);
    await vi.advanceTimersByTimeAsync(3001);
    expect(await p).toContain("Learner studies CSE 471.");
  });
});

describe("logLearningEvent", () => {
  it("adds one document to the user's namespace with content and metadata", async () => {
    mockFetch(() => json({ id: "doc1", status: "queued" }));
    await logLearningEvent(USER, quizEvent);

    expect(calls).toHaveLength(1);
    const { url, init, body } = calls[0];
    expect(url).toBe(`${BASE}/ns/${NS}/document`);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    expect(body.content).toContain("2026-11-15");
    expect(body.content).toContain("'A* Search' (course CSE 471)");
    expect(body.content).toContain("53%");
    expect(body.content).toContain("Why must the heuristic be admissible?");
    expect(body.metadata).toMatchObject({
      source: "synapse",
      type: "generated-quiz",
      courseName: "CSE 471",
      conceptLabel: "A* Search",
      score: 0.53,
      confidence: 0.53,
      retention: 0.61,
      missedCount: 1,
    });
    expect(body.date).toBe("2026-11-15T18:00:00.000Z");
    expect(body.id).toMatch(/^ev-[0-9a-f]{40}$/);
    expect(JSON.stringify(body)).not.toContain(USER);
    // Only fields the v5 add-document endpoint accepts (it rejects unknown ones).
    const allowed = ["id", "content", "metadata", "supportingContext", "taskType", "dreaming", "date", "group"];
    expect(Object.keys(body).every((k) => allowed.includes(k))).toBe(true);
    expect(body.supportingContext.length).toBeLessThanOrEqual(1500);
  });

  it("gives the same event the same document id, and different events different ids", async () => {
    mockFetch(() => json({ id: "doc1", status: "queued" }));
    await logLearningEvent(USER, quizEvent);
    await logLearningEvent(USER, quizEvent);
    await logLearningEvent(USER, { ...quizEvent, timestamp: "2026-11-15T19:00:00.000Z" });
    await logLearningEvent("another-user", quizEvent);
    const ids = calls.map((c) => c.body.id);
    expect(ids[0]).toBe(ids[1]);
    expect(new Set(ids).size).toBe(3);
  });

  it("never throws on network error, non-2xx or malformed JSON", async () => {
    mockFetch(() => {
      throw new TypeError("fetch failed");
    });
    await expect(logLearningEvent(USER, quizEvent)).resolves.toBeUndefined();
    mockFetch(() => json({ error: "boom" }, 500));
    await expect(logLearningEvent(USER, quizEvent)).resolves.toBeUndefined();
    mockFetch(() => new Response("not json", { status: 200 }));
    await expect(logLearningEvent(USER, quizEvent)).resolves.toBeUndefined();
  });

  it("never throws on a malformed event", async () => {
    mockFetch(() => json({ id: "d", status: "queued" }));
    await expect(logLearningEvent(USER, null as unknown as LearningEvent)).resolves.toBeUndefined();
    const bad = { type: "nope", courseName: 5, timestamp: "garbage", missedQuestions: "x", score: NaN };
    await expect(logLearningEvent(USER, bad as unknown as LearningEvent)).resolves.toBeUndefined();
  });

  it("gives up after 4 seconds when Supermemory hangs", async () => {
    vi.useFakeTimers();
    mockFetch(hang);
    let done = false;
    const p = logLearningEvent(USER, quizEvent).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(3999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    await p;
    expect(done).toBe(true);
    expect((calls[0].init.signal as AbortSignal).aborted).toBe(true);
  });
});

describe("learnerNamespace", () => {
  it("keeps a Cognito sub as is, behind a prefix", () => {
    expect(learnerNamespace(USER)).toBe(NS);
  });

  it("only ever produces characters and lengths the API allows", () => {
    for (const id of ["us-east-1:abc", "a b/c@d.e", "x".repeat(300), "ünï¢ode"]) {
      const ns = learnerNamespace(id);
      expect(ns).toMatch(/^[a-zA-Z0-9_:-]+$/);
      expect(ns.length).toBeLessThanOrEqual(100);
    }
  });

  it("does not let two different ids collide after sanitizing", () => {
    expect(learnerNamespace("a.b")).not.toBe(learnerNamespace("a_b"));
    expect(learnerNamespace("a.b")).not.toBe(learnerNamespace("a/b"));
    expect(learnerNamespace("x".repeat(300))).not.toBe(learnerNamespace("x".repeat(301)));
  });
});

describe("describeLearningEvent", () => {
  const base = { courseName: "CSE 471", timestamp: "2026-11-15T18:00:00.000Z" };

  it("covers all five event types", () => {
    expect(describeLearningEvent({ ...base, type: "course-ingested" })).toBe(
      "On 2026-11-15 the learner uploaded their notes for the course CSE 471 and started studying it.",
    );
    expect(
      describeLearningEvent({ ...base, type: "self-review", conceptLabel: "Minimax", rating: "still-shaky" }),
    ).toContain(`reviewed 'Minimax' (course CSE 471) and rated it "still shaky"`);
    expect(
      describeLearningEvent({ ...base, type: "self-review", conceptLabel: "Minimax", rating: "got-it" }),
    ).toContain(`"got it"`);
    expect(describeLearningEvent(quizEvent)).toBe(
      "On 2026-11-15 the learner took a generated practice quiz on 'A* Search' (course CSE 471) and scored 53%. " +
        'Missed questions: "Why must the heuristic be admissible?". ' +
        "Confidence in this concept is now 0.53; predicted retention before the quiz was 0.61.",
    );
    const uploaded = describeLearningEvent({ ...base, type: "uploaded-quiz", conceptLabel: "Bayes Nets", score: 0.9 });
    expect(uploaded).toContain("uploaded a graded quiz");
    expect(uploaded).toContain("90%");
    expect(uploaded).toContain("strong area");
    expect(
      describeLearningEvent({ ...base, type: "explanation-viewed", conceptLabel: "A* Search", retention: 0.4 }),
    ).toContain("opened the tutoring explanation for 'A* Search' (course CSE 471)");
  });

  it("flags low scores as weak and ignores a null confidence", () => {
    const out = describeLearningEvent({ ...base, type: "generated-quiz", conceptLabel: "X", score: 0.2, confidence: null });
    expect(out).toContain("weak area");
    expect(out).not.toContain("onfidence");
  });

  it("limits how many missed questions are listed", () => {
    const missedQuestions = Array.from({ length: 9 }, (_, i) => `Question ${i}?`);
    const out = describeLearningEvent({ ...quizEvent, missedQuestions });
    expect(out).toContain('"Question 4?"');
    expect(out).not.toContain('"Question 5?"');
    expect(out).toContain("and 4 more.");
  });
});
