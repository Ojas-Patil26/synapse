import { auth } from "../auth";
import { createFixtureApi } from "./fixtureApi";
import { createHttpApi } from "./httpApi";
import type { Api } from "./types";

export const USE_FIXTURES = import.meta.env.VITE_USE_FIXTURES === "true";

/** Set by the app shell so a 401 from the real API drops the session and returns to /login. */
let unauthorizedHandler: (() => void) | null = null;
export function setUnauthorizedHandler(fn: (() => void) | null) {
  unauthorizedHandler = fn;
}

export const api: Api = USE_FIXTURES
  ? createFixtureApi()
  : createHttpApi({
      baseUrl: import.meta.env.VITE_API_BASE_URL ?? "",
      getIdToken: () => auth.getIdToken(),
      onUnauthorized: () => unauthorizedHandler?.(),
    });

export { ApiRequestError, uploadFile, contentTypeOf } from "./types";
export type { Api } from "./types";
