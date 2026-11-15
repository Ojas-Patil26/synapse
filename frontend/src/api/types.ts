// The one data-layer interface. Every route in CONTRACTS.md section 3 has a method
// here; `fixtureApi` and `httpApi` both implement it and pages only ever see `Api`.
import type {
  CourseResponse,
  CourseSkillsResponse,
  CreateCourseRequest,
  DecayStatus,
  GraphResponse,
  GuideEntryResponse,
  GuideListResponse,
  LinkCoursesResponse,
  PresignRequest,
  PresignResponse,
  QuizGenerateResponse,
  QuizMode,
  QuizSubmitRequest,
  QuizSubmitResponse,
  QuizUploadRequest,
  QuizUploadResponse,
  ReviewRequest,
  ReviewResponse,
  UploadPurpose,
} from "../contracts";

export interface Api {
  /** GET /graph (no id) or GET /graph/:courseId */
  getGraph(courseId?: string): Promise<GraphResponse>;
  /** POST /review */
  postReview(req: ReviewRequest): Promise<ReviewResponse>;
  /** GET /decay-status/:courseId[?recalculate=true] */
  getDecayStatus(courseId: string, opts?: { recalculate?: boolean }): Promise<DecayStatus>;
  /** POST /quiz/:conceptId/generate */
  generateQuiz(conceptId: string, mode: QuizMode): Promise<QuizGenerateResponse>;
  /** POST /quiz/:conceptId/submit */
  submitQuiz(conceptId: string, req: QuizSubmitRequest): Promise<QuizSubmitResponse>;
  /** POST /quiz/:conceptId/upload */
  uploadQuiz(conceptId: string, req: QuizUploadRequest): Promise<QuizUploadResponse>;
  /** POST /courses/:courseId/link/:otherCourseId */
  linkCourses(courseId: string, otherCourseId: string): Promise<LinkCoursesResponse>;
  /** GET /courses/:courseId/skills */
  getCourseSkills(courseId: string): Promise<CourseSkillsResponse>;
  /** GET /guide */
  getGuide(): Promise<GuideListResponse>;
  /** GET /guide/:conceptId[?refresh=true] */
  getGuideEntry(conceptId: string, opts?: { refresh?: boolean }): Promise<GuideEntryResponse>;
  /** POST /uploads/presign */
  presign(req: PresignRequest): Promise<PresignResponse>;
  /** PUT the file to the presigned URL with the same Content-Type. */
  putFile(uploadUrl: string, file: Blob, contentType: string): Promise<void>;
  /** POST /courses */
  createCourse(req: CreateCourseRequest): Promise<CourseResponse>;
  /** GET /courses/:courseId */
  getCourse(courseId: string): Promise<CourseResponse>;
  /** DELETE /account: removes the signed-in user's data and login. */
  deleteAccount(): Promise<{ deleted: boolean }>;
}

/** Thrown by both implementations; mirrors the error shape in CONTRACTS.md section 0. */
export class ApiRequestError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
  }
}

const EXT_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
};

/** Browsers often report "" for .md files, so fall back to the extension. */
export function contentTypeOf(file: File): string {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  return EXT_TYPES[ext] ?? file.type ?? "";
}

/** presign -> PUT -> s3Key. Shared by the notes upload and the quiz upload. */
export async function uploadFile(api: Api, file: File, purpose: UploadPurpose): Promise<string> {
  const contentType = contentTypeOf(file);
  const { uploadUrl, s3Key } = await api.presign({ fileName: file.name, contentType, purpose });
  await api.putFile(uploadUrl, file, contentType);
  return s3Key;
}
