import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { assertOwnsKey } from "../lib/aws/s3";
import {
  MAX_FILES_PER_COURSE,
  MAX_SEMESTER_LENGTH,
  type CourseResponse,
  type CourseSkillsResponse,
  type IngestPayload,
  type LinkCoursesResponse,
} from "../lib/contracts";
import {
  createCourse,
  getCourse,
  listConceptBriefs,
  saveCourseSkills,
  setCourseStatus,
} from "../lib/data/service";
import { tagSkills } from "../lib/gemini";
import {
  HttpError,
  badRequest,
  conflict,
  describeError,
  getUserId,
  handler,
  json,
  notFound,
  parseBody,
  pathParam,
} from "../lib/http";
import { consume } from "../lib/usage";
import { ingestCourse, linkCoursePair } from "./ingest";

const MAX_NAME_CHARS = 80;
let lambdaClient: LambdaClient | null = null;

/**
 * Deployed: async-invoke the ingest Lambda. Local dev (no INGEST_FUNCTION_NAME): run the
 * ingest in this process without waiting for it.
 */
async function startIngest(payload: IngestPayload): Promise<void> {
  const functionName = process.env.INGEST_FUNCTION_NAME;
  if (!functionName) {
    void ingestCourse(payload).catch((err) => console.error(`[courses] local ingest crashed: ${describeError(err)}`));
    return;
  }
  lambdaClient ??= new LambdaClient({});
  await lambdaClient.send(
    new InvokeCommand({
      FunctionName: functionName,
      InvocationType: "Event",
      Payload: Buffer.from(JSON.stringify(payload)),
    }),
  );
}

/** POST /courses */
export const create = handler(async (event) => {
  const userId = getUserId(event);
  const body = parseBody(event);

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) throw badRequest('"name" is required.');
  if (name.length > MAX_NAME_CHARS) throw badRequest(`"name" must be ${MAX_NAME_CHARS} characters or fewer.`);

  // Optional label such as "Fall 2026"; empty or missing means none.
  let semester: string | null = null;
  if (body.semester !== undefined && body.semester !== null) {
    if (typeof body.semester !== "string") throw badRequest('"semester" must be text.');
    semester = body.semester.trim().replace(/\s+/g, " ") || null;
    if (semester && semester.length > MAX_SEMESTER_LENGTH) {
      throw badRequest(`"semester" must be ${MAX_SEMESTER_LENGTH} characters or fewer.`);
    }
  }

  const rawKeys: unknown[] | null = Array.isArray(body.s3Keys) ? body.s3Keys : null;
  if (!rawKeys || rawKeys.length < 1 || rawKeys.length > MAX_FILES_PER_COURSE) {
    throw badRequest(`"s3Keys" must list 1 to ${MAX_FILES_PER_COURSE} uploaded files.`);
  }
  const s3Keys: string[] = [];
  for (const key of rawKeys) {
    assertOwnsKey(userId, key);
    if (!s3Keys.includes(key)) s3Keys.push(key);
  }

  await consume(userId, "ingest");
  const course = await createCourse(userId, name, semester);
  try {
    await startIngest({ userId, courseId: course.id, s3Keys });
  } catch (err) {
    console.error(`[courses] could not start ingest: ${describeError(err)}`);
    const message = "Processing could not be started. Please try again.";
    await setCourseStatus(userId, course.id, "failed", message).catch(() => undefined);
    throw new HttpError(500, "ingest_not_started", message);
  }

  const response: CourseResponse = { course };
  return json(202, response);
});

/** GET /courses/{courseId} */
export const get = handler(async (event) => {
  const userId = getUserId(event);
  const course = await getCourse(userId, pathParam(event, "courseId"));
  if (!course) throw notFound("That course does not exist.");
  const response: CourseResponse = { course };
  return json(200, response);
});

/** POST /courses/{courseId}/link/{otherCourseId} */
export const link = handler(async (event) => {
  const userId = getUserId(event);
  const courseId = pathParam(event, "courseId");
  const otherCourseId = pathParam(event, "otherCourseId");
  if (courseId === otherCourseId) throw badRequest("A course cannot be linked to itself.");

  const [course, other] = await Promise.all([getCourse(userId, courseId), getCourse(userId, otherCourseId)]);
  if (!course || !other) throw notFound("That course does not exist.");
  await consume(userId, "ai");
  if (course.status !== "ready" || other.status !== "ready") {
    throw conflict("Both courses must finish processing before they can be linked.");
  }

  const response: LinkCoursesResponse = await linkCoursePair(userId, course, other);
  return json(200, response);
});

/** GET /courses/{courseId}/skills. Generated at ingest; generated here and cached if missing. */
export const skills = handler(async (event) => {
  const userId = getUserId(event);
  const courseId = pathParam(event, "courseId");
  const course = await getCourse(userId, courseId);
  if (!course) throw notFound("That course does not exist.");

  let { industrySkills, skillsSummary } = course;
  if (industrySkills.length === 0) {
    if (course.status !== "ready") throw conflict("This course has not finished processing yet.");
    await consume(userId, "ai");
    const briefs = await listConceptBriefs(userId, courseId);
    const generated = await tagSkills(
      course.name,
      briefs.map((b) => b.label),
    );
    await saveCourseSkills(userId, courseId, generated.industrySkills, generated.skillsSummary);
    ({ industrySkills, skillsSummary } = generated);
  }

  const response: CourseSkillsResponse = { courseId, industrySkills, skillsSummary };
  return json(200, response);
});
