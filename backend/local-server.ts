// Local development only; never deployed. Maps every route in CONTRACTS.md section 3 to
// its Lambda handler by building an API Gateway HTTP API payload-2.0 event.
//   npm run dev   ->  http://localhost:3001

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import * as courses from "./lambda/handlers/courses";
import * as decay from "./lambda/handlers/decay";
import * as graph from "./lambda/handlers/graph";
import * as guide from "./lambda/handlers/guide";
import * as quiz from "./lambda/handlers/quiz";
import * as review from "./lambda/handlers/review";
import * as uploads from "./lambda/handlers/uploads";
import type { ApiEvent, ApiResult } from "./lambda/lib/http";

const PORT = Number(process.env.PORT ?? 3001);
const ALLOWED_ORIGIN = "http://localhost:5173";

type RouteHandler = (event: ApiEvent) => Promise<ApiResult>;
const ROUTES: [method: string, path: string, fn: RouteHandler][] = [
  ["GET", "/graph", graph.getGraph],
  ["GET", "/graph/{courseId}", graph.getGraph],
  ["POST", "/review", review.postReview],
  ["GET", "/decay-status/{courseId}", decay.getDecayStatus],
  ["POST", "/quiz/{conceptId}/generate", quiz.generate],
  ["POST", "/quiz/{conceptId}/submit", quiz.submit],
  ["POST", "/quiz/{conceptId}/upload", quiz.upload],
  ["POST", "/courses/{courseId}/link/{otherCourseId}", courses.link],
  ["GET", "/courses/{courseId}/skills", courses.skills],
  ["GET", "/guide", guide.list],
  ["GET", "/guide/{conceptId}", guide.get],
  ["POST", "/uploads/presign", uploads.presign],
  ["POST", "/courses", courses.create],
  ["GET", "/courses/{courseId}", courses.get],
];

function match(method: string, path: string) {
  const parts = path.split("/").filter(Boolean);
  for (const [routeMethod, template, fn] of ROUTES) {
    if (routeMethod !== method) continue;
    const templateParts = template.split("/").filter(Boolean);
    if (templateParts.length !== parts.length) continue;
    const pathParameters: Record<string, string> = {};
    const ok = templateParts.every((t, i) => {
      if (t.startsWith("{")) {
        try {
          pathParameters[t.slice(1, -1)] = decodeURIComponent(parts[i]);
        } catch {
          return false;
        }
        return true;
      }
      return t === parts[i];
    });
    if (ok) return { routeKey: `${routeMethod} ${template}`, pathParameters, fn };
  }
  return null;
}

/** Bearer token payload `sub` (decoded, not verified), else x-dev-user, else "dev-user". */
function userIdFrom(req: IncomingMessage): string {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) {
    try {
      const payload = JSON.parse(Buffer.from(auth.slice(7).split(".")[1] ?? "", "base64url").toString("utf8"));
      if (typeof payload?.sub === "string" && payload.sub) return payload.sub;
    } catch {
      // not a JWT; fall through
    }
  }
  const devUser = req.headers["x-dev-user"];
  return (Array.isArray(devUser) ? devUser[0] : devUser) || "dev-user";
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}) {
  res.writeHead(status, {
    "access-control-allow-origin": ALLOWED_ORIGIN,
    "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
    "access-control-allow-headers": "authorization,content-type,x-dev-user",
    "access-control-max-age": "600",
    vary: "Origin",
    ...headers,
  });
  res.end(body);
}

const server = createServer(async (req, res) => {
  const startedAt = Date.now();
  const method = (req.method ?? "GET").toUpperCase();
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const rawPath = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;

  if (method === "OPTIONS") return send(res, 204, "");

  const route = match(method, rawPath);
  if (!route) {
    return send(res, 404, JSON.stringify({ error: { code: "not_found", message: "No such route." } }), {
      "content-type": "application/json",
    });
  }

  try {
    const body = await readBody(req);
    const query = Object.fromEntries(url.searchParams.entries());
    const event = {
      version: "2.0",
      routeKey: route.routeKey,
      rawPath,
      rawQueryString: url.search.replace(/^\?/, ""),
      headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : v ?? ""])),
      queryStringParameters: Object.keys(query).length ? query : undefined,
      pathParameters: Object.keys(route.pathParameters).length ? route.pathParameters : undefined,
      body: body.length ? body : undefined,
      isBase64Encoded: false,
      requestContext: {
        accountId: "local",
        apiId: "local",
        domainName: "localhost",
        domainPrefix: "localhost",
        http: { method, path: rawPath, protocol: "HTTP/1.1", sourceIp: "127.0.0.1", userAgent: req.headers["user-agent"] ?? "" },
        requestId: `local-${startedAt}`,
        routeKey: route.routeKey,
        stage: "$default",
        time: new Date(startedAt).toISOString(),
        timeEpoch: startedAt,
        authorizer: {
          principalId: "",
          integrationLatency: 0,
          jwt: { claims: { sub: userIdFrom(req) }, scopes: [] },
        },
      },
    } as unknown as ApiEvent;

    const result = await route.fn(event);
    const headers = Object.fromEntries(Object.entries(result.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    send(res, result.statusCode ?? 200, result.body ?? "", headers);
    console.log(`${method} ${rawPath} -> ${result.statusCode ?? 200} (${Date.now() - startedAt} ms)`);
  } catch (err) {
    // Handlers catch their own errors; this only fires if the adapter itself breaks.
    console.error(`${method} ${rawPath} adapter error: ${err instanceof Error ? err.name : "unknown"}`);
    send(res, 500, JSON.stringify({ error: { code: "internal_error", message: "Something went wrong. Please try again." } }), {
      "content-type": "application/json",
    });
  }
});

server.listen(PORT, () => {
  console.log(`Synapse local API on http://localhost:${PORT} (CORS: ${ALLOWED_ORIGIN})`);
  if (!process.env.INGEST_FUNCTION_NAME) console.log("INGEST_FUNCTION_NAME not set: ingest runs in-process.");
});
