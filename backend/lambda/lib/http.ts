// Helpers for API Gateway HTTP API (payload format 2.0) behind a JWT authorizer.
// API Gateway adds the CORS headers itself; handlers never set them.

import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";

export type ApiEvent = APIGatewayProxyEventV2WithJWTAuthorizer;
export type ApiResult = APIGatewayProxyStructuredResultV2;
export type JsonObject = Record<string, unknown>;

/** An error whose status, code and message are safe to send to the client as-is. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

export const badRequest = (message: string) => new HttpError(400, "bad_request", message);
export const notFound = (message: string) => new HttpError(404, "not_found", message);
export const conflict = (message: string) => new HttpError(409, "conflict", message);
export const upstreamFailed = (message: string) => new HttpError(502, "upstream_failed", message);

export function json(status: number, body: unknown): ApiResult {
  return {
    statusCode: status,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

export function errorResponse(status: number, code: string, message: string): ApiResult {
  return json(status, { error: { code, message } });
}

export function getUserId(event: ApiEvent): string {
  const sub = event.requestContext?.authorizer?.jwt?.claims?.sub;
  if (typeof sub !== "string" || sub.length === 0) {
    throw new HttpError(401, "unauthorized", "Sign in to continue.");
  }
  return sub;
}

/** Parses the request body as a JSON object. Throws a 400 HttpError on anything else. */
export function parseBody(event: ApiEvent): JsonObject {
  let raw = event.body;
  if (raw === undefined || raw === null || raw === "") {
    throw badRequest("A JSON request body is required.");
  }
  if (event.isBase64Encoded) {
    raw = Buffer.from(raw, "base64").toString("utf8");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw badRequest("The request body is not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw badRequest("The request body must be a JSON object.");
  }
  return parsed as JsonObject;
}

/** Reads a required, non-empty string field from a parsed body. */
export function requireString(body: JsonObject, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw badRequest(`"${field}" is required and must be a non-empty string.`);
  }
  return value;
}

export function pathParam(event: ApiEvent, name: string): string {
  const value = event.pathParameters?.[name];
  if (typeof value !== "string" || value.length === 0) {
    throw badRequest(`Missing path parameter "${name}".`);
  }
  return value;
}

export function queryFlag(event: ApiEvent, name: string): boolean {
  const value = event.queryStringParameters?.[name];
  return value === "true" || value === "1";
}

/** Strips anything that could carry a credential before a message reaches the logs. */
export function redact(text: string): string {
  return text
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, "[url]")
    .replace(/\b(key|token|secret|password|authorization|signature)\b\s*[=:]\s*[^\s"'&,}]+/gi, "$1=[redacted]")
    .slice(0, 500);
}

export function describeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${redact(err.message)}`;
  return redact(String(err));
}

/**
 * Wraps a route function. Anything thrown becomes the CONTRACTS.md section 0 error
 * shape. Only HttpError messages reach the client; every other error is a generic 500,
 * so stack traces and upstream error text never leak.
 */
export function handler(fn: (event: ApiEvent) => Promise<ApiResult>) {
  return async (event: ApiEvent): Promise<ApiResult> => {
    try {
      return await fn(event);
    } catch (err) {
      if (err instanceof HttpError) {
        if (err.status >= 500) {
          console.error(`[http] ${event.routeKey ?? event.rawPath} -> ${err.status} ${err.code}`);
        }
        return errorResponse(err.status, err.code, err.message);
      }
      // The data layer signals an unknown course or concept with name = "NotFoundError".
      if (err instanceof Error && err.name === "NotFoundError") {
        return errorResponse(404, "not_found", "That course or concept was not found.");
      }
      console.error(`[http] ${event.routeKey ?? event.rawPath} failed: ${describeError(err)}`);
      return errorResponse(500, "internal_error", "Something went wrong. Please try again.");
    }
  };
}
