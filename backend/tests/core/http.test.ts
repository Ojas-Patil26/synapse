import { describe, expect, it, vi } from "vitest";
import { HttpError, getUserId, handler, json, parseBody, redact } from "../../lambda/lib/http";
import { makeEvent, parse } from "./helpers";

describe("lib/http", () => {
  it("returns the contract error shape for an HttpError", async () => {
    const res = await handler(async () => {
      throw new HttpError(409, "conflict", "Already submitted.");
    })(makeEvent());
    expect(res.statusCode).toBe(409);
    expect(parse(res)).toEqual({ error: { code: "conflict", message: "Already submitted." } });
  });

  it("hides unknown errors behind a generic 500 with no upstream text", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await handler(async () => {
      throw new Error("connect failed mongodb+srv://user:hunter2@cluster.example.net/?key=AIzaSECRET");
    })(makeEvent());
    expect(res.statusCode).toBe(500);
    const body = parse(res);
    expect(Object.keys(body)).toEqual(["error"]);
    expect(Object.keys(body.error).sort()).toEqual(["code", "message"]);
    expect(body.error.code).toBe("internal_error");
    expect(res.body).not.toMatch(/hunter2|AIzaSECRET|mongodb|stack|at /);
    expect(log.mock.calls.flat().join(" ")).not.toMatch(/hunter2|AIzaSECRET/);
    log.mockRestore();
  });

  it("passes a successful result through", async () => {
    const res = await handler(async () => json(200, { ok: true }))(makeEvent());
    expect(res.statusCode).toBe(200);
    expect(parse(res)).toEqual({ ok: true });
    expect(res.headers).toEqual({ "content-type": "application/json" });
  });

  it("rejects a missing, malformed or non-object body with 400", () => {
    for (const rawBody of [undefined, "", "{nope", "[1,2]", '"text"', "null"]) {
      try {
        parseBody(makeEvent({ rawBody }));
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(HttpError);
        expect((err as HttpError).status).toBe(400);
      }
    }
    expect(parseBody(makeEvent({ body: { a: 1 } }))).toEqual({ a: 1 });
  });

  it("reads the user id from the JWT sub claim and 401s without one", () => {
    expect(getUserId(makeEvent({ userId: "abc" }))).toBe("abc");
    expect(() => getUserId(makeEvent({ userId: null }))).toThrowError(HttpError);
  });

  it("redacts URLs and key-like values", () => {
    const out = redact("GET https://host/path?key=abc123 failed, token: xyz789");
    expect(out).not.toMatch(/abc123|xyz789|host/);
  });
});
