// Real implementation of `Api`: fetch against VITE_API_BASE_URL with the Cognito
// ID token as a bearer token. Error bodies follow CONTRACTS.md section 0:
//   { "error": { "code": string, "message": string } }
import type { ApiError } from "../contracts";
import { ApiRequestError, type Api } from "./types";

export interface HttpApiOptions {
  baseUrl: string;
  /** Returns a current Cognito ID token (refreshing it if needed) or null when signed out. */
  getIdToken: () => Promise<string | null>;
  /** Called on any 401 so the app can drop the session and send the user to /login. */
  onUnauthorized?: () => void;
}

export function createHttpApi({ baseUrl, getIdToken, onUnauthorized }: HttpApiOptions): Api {
  const base = baseUrl.replace(/\/+$/, "");

  async function request<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
    if (!base) throw new ApiRequestError(0, "config", "VITE_API_BASE_URL is not set.");
    const token = await getIdToken();
    if (!token) {
      onUnauthorized?.();
      throw new ApiRequestError(401, "unauthorized", "You are signed out. Log in again.");
    }
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    let res: Response;
    try {
      res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      throw new ApiRequestError(0, "network", "Could not reach the server. Check your connection and try again.");
    }

    const text = await res.text();
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }

    if (!res.ok) {
      if (res.status === 401) onUnauthorized?.();
      const err = (json as Partial<ApiError> | null)?.error;
      // API Gateway's own errors (authorizer, throttling) use { "message": ... } instead.
      const gatewayMessage = (json as { message?: string } | null)?.message;
      throw new ApiRequestError(
        res.status,
        err?.code ?? `http_${res.status}`,
        err?.message ?? gatewayMessage ?? `Request failed (${res.status}).`,
      );
    }
    if (json === null) throw new ApiRequestError(res.status, "bad_response", "The server sent an unreadable response.");
    return json as T;
  }

  const seg = encodeURIComponent;

  return {
    getGraph: (courseId) => request("GET", courseId ? `/graph/${seg(courseId)}` : "/graph"),
    postReview: (req) => request("POST", "/review", req),
    getDecayStatus: (courseId, opts) =>
      request("GET", `/decay-status/${seg(courseId)}${opts?.recalculate ? "?recalculate=true" : ""}`),
    generateQuiz: (conceptId, mode) => request("POST", `/quiz/${seg(conceptId)}/generate`, { mode }),
    submitQuiz: (conceptId, req) => request("POST", `/quiz/${seg(conceptId)}/submit`, req),
    uploadQuiz: (conceptId, req) => request("POST", `/quiz/${seg(conceptId)}/upload`, req),
    linkCourses: (courseId, otherCourseId) => request("POST", `/courses/${seg(courseId)}/link/${seg(otherCourseId)}`),
    getCourseSkills: (courseId) => request("GET", `/courses/${seg(courseId)}/skills`),
    getGuide: () => request("GET", "/guide"),
    getGuideEntry: (conceptId, opts) => request("GET", `/guide/${seg(conceptId)}${opts?.refresh ? "?refresh=true" : ""}`),
    presign: (req) => request("POST", "/uploads/presign", req),

    // The presigned URL carries its own signature: no Authorization header, and the
    // Content-Type must match the one sent to /uploads/presign.
    async putFile(uploadUrl, file, contentType) {
      let res: Response;
      try {
        res = await fetch(uploadUrl, { method: "PUT", headers: { "Content-Type": contentType }, body: file });
      } catch {
        throw new ApiRequestError(0, "network", "The upload was interrupted. Try again.");
      }
      if (!res.ok) throw new ApiRequestError(res.status, "upload_failed", `The upload failed (${res.status}).`);
    },

    createCourse: (req) => request("POST", "/courses", req),
    getCourse: (courseId) => request("GET", `/courses/${seg(courseId)}`),
    deleteAccount: () => request("DELETE", "/account"),
  };
}
