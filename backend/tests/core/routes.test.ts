import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lambda/lib/data/service");
vi.mock("../../lambda/lib/supermemory");
vi.mock("../../lambda/lib/usage");
vi.mock("../../lambda/lib/gemini");
vi.mock("../../lambda/lib/aws/textract");
vi.mock("../../lambda/lib/aws/s3", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lambda/lib/aws/s3")>()),
  presignUpload: vi.fn(),
}));

import { presignUpload } from "../../lambda/lib/aws/s3";
import { extractText } from "../../lambda/lib/aws/textract";
import * as data from "../../lambda/lib/data/service";
import { compareCourses, extractConcepts, generateTutoring, tagSkills } from "../../lambda/lib/gemini";
import { HttpError } from "../../lambda/lib/http";
import { getLearnerProfile, logLearningEvent } from "../../lambda/lib/supermemory";
import { preSignUp } from "../../lambda/handlers/auth";
import * as courses from "../../lambda/handlers/courses";
import { getDecayStatus } from "../../lambda/handlers/decay";
import { getGraph } from "../../lambda/handlers/graph";
import * as guide from "../../lambda/handlers/guide";
import { ingestCourse } from "../../lambda/handlers/ingest";
import { postReview } from "../../lambda/handlers/review";
import { presign } from "../../lambda/handlers/uploads";
import { USER, context, course, makeEvent, node, parse } from "./helpers";

const notesKey = `uploads/${USER}/notes/abc-notes.txt`;
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  delete process.env.INGEST_FUNCTION_NAME;
});

describe("uploads.presign", () => {
  it("returns a key under the caller's prefix", async () => {
    vi.mocked(presignUpload).mockResolvedValue("https://signed.example/put");
    const res = await presign(makeEvent({ body: { fileName: "../My Notes (1).PDF", contentType: "application/pdf", purpose: "notes" } }));
    expect(res.statusCode).toBe(200);
    const body = parse(res);
    expect(body.uploadUrl).toBe("https://signed.example/put");
    expect(body.expiresIn).toBe(900);
    expect(body.s3Key).toMatch(new RegExp(`^uploads/${USER}/notes/[0-9a-f-]{36}-My_Notes_1_\\.PDF$`));
    expect(presignUpload).toHaveBeenCalledWith(body.s3Key, "application/pdf");
  });

  it("400 on a bad purpose or a type not allowed for that purpose", async () => {
    const bad = [
      { fileName: "a.pdf", contentType: "application/pdf", purpose: "avatar" },
      { fileName: "a.md", contentType: "text/markdown", purpose: "quiz" },
      { fileName: "a.exe", contentType: "application/octet-stream", purpose: "notes" },
      { contentType: "application/pdf", purpose: "notes" },
    ];
    for (const body of bad) expect((await presign(makeEvent({ body }))).statusCode).toBe(400);
    expect(presignUpload).not.toHaveBeenCalled();
  });
});

describe("courses.create", () => {
  it("202 with the processing course and starts ingest without waiting for it", async () => {
    const created = course({ status: "processing", conceptCount: 0 });
    vi.mocked(data.createCourse).mockResolvedValue(created);
    vi.mocked(data.getCourse).mockReturnValue(new Promise(() => undefined)); // ingest never finishes
    const res = await courses.create(makeEvent({ body: { name: "  Operating Systems ", s3Keys: [notesKey] } }));
    expect(res.statusCode).toBe(202);
    expect(parse(res)).toEqual({ course: created });
    expect(data.createCourse).toHaveBeenCalledWith(USER, "Operating Systems", null);
    expect(data.getCourse).toHaveBeenCalledWith(USER, created.id); // in-process ingest did start
  });

  it("passes a trimmed semester through, treats blank as none, and rejects bad ones", async () => {
    const created = course({ status: "processing", conceptCount: 0 });
    vi.mocked(data.createCourse).mockResolvedValue(created);
    vi.mocked(data.getCourse).mockReturnValue(new Promise(() => undefined));
    await courses.create(makeEvent({ body: { name: "OS", semester: "  Fall   2026 ", s3Keys: [notesKey] } }));
    expect(data.createCourse).toHaveBeenLastCalledWith(USER, "OS", "Fall 2026");
    await courses.create(makeEvent({ body: { name: "OS", semester: "   ", s3Keys: [notesKey] } }));
    expect(data.createCourse).toHaveBeenLastCalledWith(USER, "OS", null);
    const calls = vi.mocked(data.createCourse).mock.calls.length;
    for (const semester of ["x".repeat(41), 7, ["Fall"]]) {
      const res = await courses.create(makeEvent({ body: { name: "OS", semester, s3Keys: [notesKey] } }));
      expect(res.statusCode).toBe(400);
    }
    expect(vi.mocked(data.createCourse).mock.calls.length).toBe(calls);
  });

  it("400 on s3Keys the caller does not own, a bad name or a bad key count", async () => {
    const bad = [
      { name: "OS", s3Keys: ["uploads/someone-else/notes/a.txt"] },
      { name: "OS", s3Keys: [notesKey, "uploads/someone-else/notes/a.txt"] },
      { name: "", s3Keys: [notesKey] },
      { name: "x".repeat(81), s3Keys: [notesKey] },
      { name: "OS", s3Keys: [] },
      { name: "OS", s3Keys: Array.from({ length: 6 }, (_, i) => `uploads/${USER}/notes/${i}.txt`) },
      { name: "OS" },
    ];
    for (const body of bad) {
      const res = await courses.create(makeEvent({ body }));
      expect(res.statusCode).toBe(400);
      expect(parse(res).error.code).toBe("bad_request");
    }
    expect(data.createCourse).not.toHaveBeenCalled();
  });
});

describe("courses.get / link / skills", () => {
  it("get: 404 for an unknown course", async () => {
    vi.mocked(data.getCourse).mockResolvedValue(null);
    expect((await courses.get(makeEvent({ pathParameters: { courseId: "nope" } }))).statusCode).toBe(404);
  });

  it("link: 409 unless both courses are ready", async () => {
    vi.mocked(data.getCourse).mockImplementation(async (_u, id) => course({ id, status: id === "b" ? "processing" : "ready" }));
    const res = await courses.link(makeEvent({ pathParameters: { courseId: "a", otherCourseId: "b" } }));
    expect(res.statusCode).toBe(409);
    expect(compareCourses).not.toHaveBeenCalled();
  });

  it("link: compares the two concept lists and replaces the links", async () => {
    vi.mocked(data.getCourse).mockImplementation(async (_u, id) => course({ id, name: `Course ${id}` }));
    vi.mocked(data.listConceptBriefs).mockImplementation(async (_u, id) => [{ id: `${id}-1`, label: "L", summary: "S" }]);
    const links = [{ sourceCourseId: "a", targetCourseId: "b", sharedConceptIds: ["a-1", "b-1"], description: "d" }];
    const edges = [{ source: "a-1", target: "b-1", relationType: "cross-course" as const, isCrossCourse: true }];
    vi.mocked(compareCourses).mockResolvedValue(links);
    vi.mocked(data.replaceCrossCourseLinks).mockResolvedValue({ links, edges });
    const res = await courses.link(makeEvent({ pathParameters: { courseId: "a", otherCourseId: "b" } }));
    expect(res.statusCode).toBe(200);
    expect(parse(res)).toEqual({ links, edges });
    expect(compareCourses).toHaveBeenCalledWith(
      { id: "a", name: "Course a", concepts: [{ id: "a-1", label: "L", summary: "S" }] },
      { id: "b", name: "Course b", concepts: [{ id: "b-1", label: "L", summary: "S" }] },
    );
    expect(data.replaceCrossCourseLinks).toHaveBeenCalledWith(USER, "a", "b", links);
  });

  it("skills: returns cached skills without calling Gemini", async () => {
    vi.mocked(data.getCourse).mockResolvedValue(course({ industrySkills: ["A", "B", "C", "D"], skillsSummary: "Sum." }));
    const res = await courses.skills(makeEvent({ pathParameters: { courseId: "course-1" } }));
    expect(parse(res)).toEqual({ courseId: "course-1", industrySkills: ["A", "B", "C", "D"], skillsSummary: "Sum." });
    expect(tagSkills).not.toHaveBeenCalled();
  });

  it("skills: generates and caches when missing", async () => {
    vi.mocked(data.getCourse).mockResolvedValue(course());
    vi.mocked(data.listConceptBriefs).mockResolvedValue([{ id: "1", label: "Paging", summary: "" }]);
    vi.mocked(tagSkills).mockResolvedValue({ industrySkills: ["A", "B", "C", "D"], skillsSummary: "Sum." });
    const res = await courses.skills(makeEvent({ pathParameters: { courseId: "course-1" } }));
    expect(parse(res)).toEqual({ courseId: "course-1", industrySkills: ["A", "B", "C", "D"], skillsSummary: "Sum." });
    expect(tagSkills).toHaveBeenCalledWith("Operating Systems", ["Paging"]);
    expect(data.saveCourseSkills).toHaveBeenCalledWith(USER, "course-1", ["A", "B", "C", "D"], "Sum.");
  });
});

describe("ingestCourse", () => {
  const payload = { userId: USER, courseId: "course-1", s3Keys: [notesKey] };
  const extracted = {
    concepts: [
      { key: "a", label: "A", summary: "s", parentKey: null },
      { key: "b", label: "B", summary: "s", parentKey: "a" },
    ],
    dependencies: [],
  };
  beforeEach(() => {
    vi.mocked(data.getCourse).mockResolvedValue(course({ status: "processing" }));
    vi.mocked(extractText).mockResolvedValue("lecture notes ".repeat(40));
    vi.mocked(extractConcepts).mockResolvedValue(extracted);
    vi.mocked(data.saveExtractedGraph).mockResolvedValue({ nodes: [], edges: [] });
    vi.mocked(data.listReadyCourses).mockResolvedValue([course({ id: "course-1" }), course({ id: "course-2", name: "Databases" })]);
    vi.mocked(data.listConceptBriefs).mockResolvedValue([{ id: "x", label: "X", summary: "" }]);
    vi.mocked(compareCourses).mockResolvedValue([]);
    vi.mocked(data.replaceCrossCourseLinks).mockResolvedValue({ links: [], edges: [] });
    vi.mocked(tagSkills).mockResolvedValue({ industrySkills: ["A", "B", "C", "D"], skillsSummary: "Sum." });
  });

  it("runs flow A and marks the course ready", async () => {
    await ingestCourse(payload);
    expect(data.saveExtractedGraph).toHaveBeenCalledWith(USER, "course-1", expect.objectContaining({ concepts: extracted.concepts }));
    expect(tagSkills).toHaveBeenCalledWith("Operating Systems", ["A"]);
    expect(data.saveCourseSkills).toHaveBeenCalled();
    expect(compareCourses).toHaveBeenCalledTimes(1); // only the OTHER ready course
    expect(data.replaceCrossCourseLinks).toHaveBeenCalledWith(USER, "course-1", "course-2", []);
    expect(logLearningEvent).toHaveBeenCalledWith(USER, expect.objectContaining({ type: "course-ingested" }));
    expect(data.setCourseStatus).toHaveBeenCalledTimes(1);
    expect(data.setCourseStatus).toHaveBeenCalledWith(USER, "course-1", "ready");
  });

  it("still becomes ready when skills tagging and linking fail", async () => {
    vi.mocked(tagSkills).mockRejectedValue(new HttpError(502, "gemini_failed", "x"));
    vi.mocked(compareCourses).mockRejectedValue(new Error("boom"));
    await ingestCourse(payload);
    expect(data.setCourseStatus).toHaveBeenCalledWith(USER, "course-1", "ready");
    vi.mocked(data.setCourseStatus).mockClear();
    vi.mocked(data.listReadyCourses).mockRejectedValue(new Error("mongo"));
    await ingestCourse(payload);
    expect(data.setCourseStatus).toHaveBeenCalledWith(USER, "course-1", "ready");
  });

  it("fails with a clear message when the files hold too little text", async () => {
    vi.mocked(extractText).mockResolvedValue("   tiny  ");
    await ingestCourse(payload);
    expect(data.setCourseStatus).toHaveBeenCalledWith(USER, "course-1", "failed", expect.stringMatching(/enough readable text/));
    expect(extractConcepts).not.toHaveBeenCalled();
  });

  it("fails with a user-safe message and never throws", async () => {
    vi.mocked(extractConcepts).mockRejectedValue(new Error("secret upstream https://x/?key=abc"));
    await expect(ingestCourse(payload)).resolves.toBeUndefined();
    const call = vi.mocked(data.setCourseStatus).mock.calls[0];
    expect(call.slice(0, 3)).toEqual([USER, "course-1", "failed"]);
    expect(call[3]).not.toMatch(/secret|key=|https/);

    vi.mocked(data.setCourseStatus).mockClear();
    vi.mocked(extractText).mockRejectedValue(new HttpError(502, "ocr_failed", "That file could not be read."));
    vi.mocked(data.setCourseStatus).mockRejectedValue(new Error("mongo down"));
    await expect(ingestCourse(payload)).resolves.toBeUndefined();
    expect(vi.mocked(data.setCourseStatus).mock.calls[0][3]).toBe("That file could not be read.");
  });

  it("rejects keys the user does not own and skips courses that are not processing", async () => {
    await ingestCourse({ ...payload, s3Keys: ["uploads/other/notes/a.txt"] });
    expect(data.setCourseStatus).toHaveBeenCalledWith(USER, "course-1", "failed", expect.any(String));
    expect(extractText).not.toHaveBeenCalled();

    vi.mocked(data.setCourseStatus).mockClear();
    vi.mocked(data.getCourse).mockResolvedValue(course({ status: "ready" }));
    await ingestCourse(payload);
    expect(data.setCourseStatus).not.toHaveBeenCalled();
  });
});

describe("guide", () => {
  const entry = { conceptId: "c1", explanation: "## Idea" } as never;

  it("list returns entries without calling Gemini", async () => {
    vi.mocked(data.buildGuide).mockResolvedValue([entry]);
    expect(parse(await guide.list(makeEvent()))).toEqual({ entries: [entry] });
    expect(generateTutoring).not.toHaveBeenCalled();
  });

  it("get: generates on first view, reading the learner profile first", async () => {
    vi.mocked(data.getConceptContext).mockResolvedValue(context());
    vi.mocked(getLearnerProfile).mockResolvedValue("profile");
    const content = { summary: "S", explanation: "E", resources: [] };
    vi.mocked(generateTutoring).mockResolvedValue(content);
    vi.mocked(data.saveGuideContent).mockResolvedValue(entry);
    const res = await guide.get(makeEvent({ pathParameters: { conceptId: "c1" } }));
    expect(parse(res)).toEqual({ entry });
    expect(vi.mocked(getLearnerProfile).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(generateTutoring).mock.invocationCallOrder[0],
    );
    expect(generateTutoring).toHaveBeenCalledWith(expect.anything(), "profile");
    expect(data.saveGuideContent).toHaveBeenCalledWith(USER, "c1", content);
    expect(logLearningEvent).toHaveBeenCalledWith(USER, expect.objectContaining({ type: "explanation-viewed" }));
  });

  it("get: serves the cache unless refresh=true", async () => {
    vi.mocked(data.getConceptContext).mockResolvedValue(context({ explanation: "cached" }));
    vi.mocked(data.getGuideEntry).mockResolvedValue(entry);
    await guide.get(makeEvent({ pathParameters: { conceptId: "c1" } }));
    expect(generateTutoring).not.toHaveBeenCalled();

    vi.mocked(generateTutoring).mockResolvedValue({ summary: "S", explanation: "E", resources: [] });
    vi.mocked(data.saveGuideContent).mockResolvedValue(entry);
    await guide.get(makeEvent({ pathParameters: { conceptId: "c1" }, query: { refresh: "true" } }));
    expect(generateTutoring).toHaveBeenCalledTimes(1);
  });

  it("get: 404 for an unknown concept, 502 shape when Gemini fails", async () => {
    vi.mocked(data.getConceptContext).mockResolvedValue(null);
    expect((await guide.get(makeEvent({ pathParameters: { conceptId: "zzz" } }))).statusCode).toBe(404);
    vi.mocked(data.getConceptContext).mockResolvedValue(context());
    vi.mocked(generateTutoring).mockRejectedValue(new HttpError(502, "gemini_failed", "The AI service did not respond in time. Please try again."));
    const res = await guide.get(makeEvent({ pathParameters: { conceptId: "c1" } }));
    expect(res.statusCode).toBe(502);
    expect(parse(res)).toEqual({ error: { code: "gemini_failed", message: "The AI service did not respond in time. Please try again." } });
  });
});

describe("graph / decay / review / auth", () => {
  it("graph: serves both routes and 404s on null", async () => {
    const graph = { courses: [], nodes: [], edges: [], crossCourseLinks: [] };
    vi.mocked(data.buildGraph).mockResolvedValue(graph);
    expect(parse(await getGraph(makeEvent()))).toEqual(graph);
    expect(data.buildGraph).toHaveBeenLastCalledWith(USER, undefined);
    await getGraph(makeEvent({ pathParameters: { courseId: "course-1" } }));
    expect(data.buildGraph).toHaveBeenLastCalledWith(USER, "course-1");
    vi.mocked(data.buildGraph).mockResolvedValue(null);
    expect((await getGraph(makeEvent({ pathParameters: { courseId: "x" } }))).statusCode).toBe(404);
  });

  it("decay: passes recalculate through", async () => {
    vi.mocked(data.decayStatus).mockResolvedValue(null);
    const res = await getDecayStatus(makeEvent({ pathParameters: { courseId: "course-1" }, query: { recalculate: "true" } }));
    expect(res.statusCode).toBe(404);
    expect(data.decayStatus).toHaveBeenCalledWith(USER, "course-1", { recalculate: true });
  });

  it("review: applies the rating then logs it", async () => {
    vi.mocked(data.getConceptContext).mockResolvedValue(context());
    vi.mocked(data.applySelfReview).mockResolvedValue(node({ retention: 1 }));
    const res = await postReview(makeEvent({ body: { conceptId: "c1", rating: "got-it" } }));
    expect(parse(res)).toEqual({ node: node({ retention: 1 }) });
    expect(data.applySelfReview).toHaveBeenCalledWith(USER, "c1", "got-it");
    expect(logLearningEvent).toHaveBeenCalledWith(USER, expect.objectContaining({ type: "self-review", rating: "got-it" }));
    expect((await postReview(makeEvent({ body: { conceptId: "c1", rating: "meh" } }))).statusCode).toBe(400);
    vi.mocked(data.getConceptContext).mockResolvedValue(null);
    expect((await postReview(makeEvent({ body: { conceptId: "c1", rating: "got-it" } }))).statusCode).toBe(404);
  });

  it("auth.preSignUp leaves sign-ups unconfirmed by default and auto-confirms only when switched on", async () => {
    const event = () => ({ request: { userAttributes: { email: "a@b.co" } }, response: {} }) as never;
    delete process.env.AUTO_CONFIRM_SIGNUPS;
    expect((await preSignUp(event())).response).toEqual({});
    process.env.AUTO_CONFIRM_SIGNUPS = "true";
    try {
      expect((await preSignUp(event())).response).toEqual({ autoConfirmUser: true, autoVerifyEmail: true });
      const noEmail = await preSignUp({ request: { userAttributes: {} }, response: {} } as never);
      expect(noEmail.response).toEqual({ autoConfirmUser: true });
    } finally {
      delete process.env.AUTO_CONFIRM_SIGNUPS;
    }
  });
});
