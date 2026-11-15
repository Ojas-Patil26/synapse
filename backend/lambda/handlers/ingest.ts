// Flow A in ARCHITECTURE.md. Invoked asynchronously (Lambda `Event` invocation, or
// in-process in local dev), so it never throws: every outcome ends in a course status.

import { assertOwnsKey } from "../lib/aws/s3";
import { extractText } from "../lib/aws/textract";
import type { Course, CrossCourseLink, Edge, IngestPayload } from "../lib/contracts";
import {
  getCourse,
  listConceptBriefs,
  listReadyCourses,
  replaceCrossCourseLinks,
  saveCourseSkills,
  saveExtractedGraph,
  setCourseStatus,
} from "../lib/data/service";
import { compareCourses, extractConcepts, tagSkills } from "../lib/gemini";
import { HttpError, describeError } from "../lib/http";
import { logLearningEvent } from "../lib/supermemory";

/** Time allowed for text extraction of each file (they run in parallel). */
const TEXT_DEADLINE_MS = 100_000;
/** Below this the notes cannot support a concept map. */
export const MIN_SOURCE_CHARS = 200;
/** Optional steps (skills, linking) are skipped once the 5-minute Lambda is this far in. */
const OPTIONAL_STEPS_CUTOFF_MS = 240_000;
const GENERIC_FAILURE = "Something went wrong while processing this course. Please try again.";

/**
 * Flow F for one pair of courses: compare their concept lists with Gemini and replace
 * the stored links. Shared by the end of ingest and POST /courses/{id}/link/{otherId}.
 */
export async function linkCoursePair(
  userId: string,
  courseA: Pick<Course, "id" | "name">,
  courseB: Pick<Course, "id" | "name">,
): Promise<{ links: CrossCourseLink[]; edges: Edge[] }> {
  const [conceptsA, conceptsB] = await Promise.all([
    listConceptBriefs(userId, courseA.id),
    listConceptBriefs(userId, courseB.id),
  ]);
  const links = await compareCourses(
    { id: courseA.id, name: courseA.name, concepts: conceptsA },
    { id: courseB.id, name: courseB.name, concepts: conceptsB },
  );
  return replaceCrossCourseLinks(userId, courseA.id, courseB.id, links);
}

async function tagAndSaveSkills(userId: string, course: Course, labels: string[]): Promise<void> {
  const skills = await tagSkills(course.name, labels);
  await saveCourseSkills(userId, course.id, skills.industrySkills, skills.skillsSummary);
}

async function linkWithOtherCourses(userId: string, course: Course): Promise<void> {
  const others = (await listReadyCourses(userId)).filter((c) => c.id !== course.id);
  const results = await Promise.allSettled(others.map((other) => linkCoursePair(userId, course, other)));
  results.forEach((r, i) => {
    if (r.status === "rejected") {
      console.warn(`[ingest] linking with course ${others[i].id} failed: ${describeError(r.reason)}`);
    }
  });
}

async function run(payload: IngestPayload, course: Course, startedAt: number): Promise<void> {
  const { userId, courseId, s3Keys } = payload;
  if (!Array.isArray(s3Keys) || s3Keys.length === 0) {
    throw new HttpError(400, "bad_request", "No files were uploaded for this course.");
  }
  for (const key of s3Keys) assertOwnsKey(userId, key);

  // 1. Text per file: pdf/png/jpg through Textract, txt/md read directly.
  const texts = await Promise.all(s3Keys.map((key) => extractText(key, undefined, { deadlineMs: TEXT_DEADLINE_MS })));
  const sourceText = texts
    .map((t) => t.trim())
    .filter(Boolean)
    .join("\n\n");
  if (sourceText.length < MIN_SOURCE_CHARS) {
    throw new HttpError(
      400,
      "not_enough_text",
      "We could not find enough readable text in those files to build a concept map. Try clearer or longer notes.",
    );
  }

  // 2. Concepts and dependencies -> Mongo + Tiger.
  const extracted = await extractConcepts(sourceText, course.name);
  await saveExtractedGraph(userId, courseId, { ...extracted, sourceText });

  // 3. Optional steps. Neither may fail the course.
  if (Date.now() - startedAt < OPTIONAL_STEPS_CUTOFF_MS) {
    const labels = extracted.concepts.filter((c) => !c.parentKey).map((c) => c.label);
    const [skills, linking] = await Promise.allSettled([
      tagAndSaveSkills(userId, course, labels),
      linkWithOtherCourses(userId, course),
    ]);
    if (skills.status === "rejected") console.warn(`[ingest] skills tagging failed: ${describeError(skills.reason)}`);
    if (linking.status === "rejected") console.warn(`[ingest] cross-course linking failed: ${describeError(linking.reason)}`);
  } else {
    console.warn("[ingest] skipping skills tagging and linking: out of time");
  }

  await logLearningEvent(userId, {
    type: "course-ingested",
    courseName: course.name,
    timestamp: new Date().toISOString(),
  });
}

export async function ingestCourse(payload: IngestPayload): Promise<void> {
  const startedAt = Date.now();
  const { userId, courseId } = payload ?? ({} as IngestPayload);
  if (typeof userId !== "string" || typeof courseId !== "string") {
    console.error("[ingest] invalid payload");
    return;
  }

  try {
    const course = await getCourse(userId, courseId);
    if (!course) {
      console.error(`[ingest] course ${courseId} not found`);
      return;
    }
    if (course.status !== "processing") {
      console.warn(`[ingest] course ${courseId} is already ${course.status}; nothing to do`);
      return;
    }
    await run(payload, course, startedAt);
    await setCourseStatus(userId, courseId, "ready");
    console.log(`[ingest] course ${courseId} ready in ${Date.now() - startedAt} ms`);
  } catch (err) {
    console.error(`[ingest] course ${courseId} failed: ${describeError(err)}`);
    const message = err instanceof HttpError ? err.message : GENERIC_FAILURE;
    try {
      await setCourseStatus(userId, courseId, "failed", message);
    } catch (statusErr) {
      console.error(`[ingest] could not record the failure: ${describeError(statusErr)}`);
    }
  }
}
