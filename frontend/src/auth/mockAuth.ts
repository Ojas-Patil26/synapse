// Fixture-mode auth: accepts any email and password. Nothing leaves the browser.
import { AuthError, type AuthClient, type Session } from "./types";

const KEY = "synapse.mockSession";
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function read(): Session | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

export function createMockAuth(): AuthClient {
  let current = read();

  const start = async (email: string, password: string): Promise<Session> => {
    await wait(350);
    if (!email.trim() || !password) throw new AuthError("InvalidParameter", "Enter an email and a password.");
    current = { email: email.trim(), idToken: "fixture-id-token" };
    try {
      sessionStorage.setItem(KEY, JSON.stringify(current));
    } catch {
      /* storage blocked: the session lasts until reload */
    }
    return current;
  };

  const accept = async (): Promise<void> => {
    await wait(300);
  };

  return {
    getSession: async () => current,
    signIn: start,
    signUp: start,
    confirmSignUp: accept,
    resendCode: accept,
    forgotPassword: accept,
    resetPassword: accept,
    signOut() {
      current = null;
      try {
        sessionStorage.removeItem(KEY);
      } catch {
        /* ignore */
      }
    },
    getIdToken: async () => current?.idToken ?? null,
  };
}
