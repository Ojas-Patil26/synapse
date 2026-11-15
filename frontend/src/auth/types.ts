export interface Session {
  email: string;
  /** Cognito ID token (a placeholder string in fixture mode). */
  idToken: string;
}

/** One auth interface, two implementations: real Cognito and a fixture-mode mock. */
export interface AuthClient {
  /** The current session, restored from storage and refreshed if needed. */
  getSession(): Promise<Session | null>;
  signIn(email: string, password: string): Promise<Session>;
  /**
   * Creates the account. Resolves with a session when the account is already confirmed (the server can be
   * set to auto-confirm), or "confirm" when an emailed code must be entered first (confirmSignUp).
   */
  signUp(email: string, password: string): Promise<Session | "confirm">;
  /** Confirms an account with the code that was emailed. */
  confirmSignUp(email: string, code: string): Promise<void>;
  /** Emails a new confirmation code. */
  resendCode(email: string): Promise<void>;
  /** Emails a password-reset code. */
  forgotPassword(email: string): Promise<void>;
  /** Sets a new password using the emailed reset code. */
  resetPassword(email: string, code: string, newPassword: string): Promise<void>;
  signOut(): void;
  getIdToken(): Promise<string | null>;
}

export class AuthError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "AuthError";
    this.code = code;
  }
}
