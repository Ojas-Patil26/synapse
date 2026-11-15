import { createCognitoAuth } from "./cognitoAuth";
import { createMockAuth } from "./mockAuth";
import type { AuthClient } from "./types";

// VITE_MOCK_AUTH=true keeps the mock login while talking to a real API. Local dev only:
// backend/local-server.ts treats the mock token as user "dev-user". The deployed API
// rejects it, because API Gateway verifies the Cognito JWT.
export const auth: AuthClient =
  import.meta.env.VITE_USE_FIXTURES === "true" || import.meta.env.VITE_MOCK_AUTH === "true"
    ? createMockAuth()
    : createCognitoAuth(import.meta.env.VITE_COGNITO_USER_POOL_ID ?? "", import.meta.env.VITE_COGNITO_CLIENT_ID ?? "");

export { AuthError } from "./types";
export type { AuthClient, Session } from "./types";
