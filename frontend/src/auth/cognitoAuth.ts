// Real auth: Cognito user pool, email + password (SRP). New accounts confirm their email with an
// emailed code; forgotten passwords are reset with an emailed code. Tokens are kept by the SDK in localStorage.
import {
  AuthenticationDetails,
  CognitoUser,
  CognitoUserAttribute,
  CognitoUserPool,
  type CognitoUserSession,
} from "amazon-cognito-identity-js";
import { AuthError, type AuthClient, type Session } from "./types";

const FRIENDLY: Record<string, string> = {
  NotAuthorizedException: "Incorrect email or password.",
  UserNotFoundException: "Incorrect email or password.",
  UsernameExistsException: "An account with that email already exists. Log in instead.",
  InvalidPasswordException: "That password is too weak. Use at least 8 characters.",
  InvalidParameterException: "Check the email and password and try again.",
  UserNotConfirmedException: "Confirm your email first. We can send you a new code.",
  CodeMismatchException: "That code is not right. Check the email and try again.",
  ExpiredCodeException: "That code has expired. Request a new one.",
  CodeDeliveryFailureException: "We could not send the email. Check the address and try again.",
  TooManyRequestsException: "Too many attempts. Wait a moment and try again.",
  LimitExceededException: "Too many attempts. Wait a moment and try again.",
  NetworkError: "Could not reach the sign-in service. Check your connection.",
};

function toAuthError(err: unknown): AuthError {
  const e = err as { code?: string; name?: string; message?: string } | null;
  const code = e?.code ?? e?.name ?? "Unknown";
  return new AuthError(code, FRIENDLY[code] ?? e?.message ?? "Something went wrong. Try again.");
}

export function createCognitoAuth(userPoolId: string, clientId: string): AuthClient {
  let pool: CognitoUserPool | null = null;
  const getPool = (): CognitoUserPool => {
    if (!userPoolId || !clientId) {
      throw new AuthError("Config", "Sign-in is not configured: set VITE_COGNITO_USER_POOL_ID and VITE_COGNITO_CLIENT_ID.");
    }
    pool ??= new CognitoUserPool({ UserPoolId: userPoolId, ClientId: clientId });
    return pool;
  };

  const toSession = (email: string, s: CognitoUserSession): Session => ({
    email: (s.getIdToken().payload.email as string | undefined) ?? email,
    idToken: s.getIdToken().getJwtToken(),
  });

  /** Reads the stored session; the SDK refreshes an expired ID token with the refresh token. */
  const currentSession = (): Promise<Session | null> =>
    new Promise((resolve) => {
      let user: CognitoUser | null;
      try {
        user = getPool().getCurrentUser();
      } catch {
        return resolve(null);
      }
      if (!user) return resolve(null);
      const u = user;
      u.getSession((err: Error | null, s: CognitoUserSession | null) => {
        if (err || !s || !s.isValid()) return resolve(null);
        resolve(toSession(u.getUsername(), s));
      });
    });

  const signIn = (email: string, password: string): Promise<Session> =>
    new Promise((resolve, reject) => {
      let user: CognitoUser;
      try {
        user = new CognitoUser({ Username: email.trim().toLowerCase(), Pool: getPool() });
      } catch (e) {
        return reject(e instanceof AuthError ? e : toAuthError(e));
      }
      user.authenticateUser(new AuthenticationDetails({ Username: email.trim().toLowerCase(), Password: password }), {
        onSuccess: (s) => resolve(toSession(email.trim().toLowerCase(), s)),
        onFailure: (err) => reject(toAuthError(err)),
        newPasswordRequired: () => reject(new AuthError("NewPasswordRequired", "This account needs a new password. Contact support.")),
      });
    });

  const userFor = (email: string): CognitoUser => new CognitoUser({ Username: email.trim().toLowerCase(), Pool: getPool() });

  const signUp = (email: string, password: string): Promise<Session | "confirm"> =>
    new Promise<boolean>((resolve, reject) => {
      const username = email.trim().toLowerCase();
      let p: CognitoUserPool;
      try {
        p = getPool();
      } catch (e) {
        return reject(e);
      }
      p.signUp(username, password, [new CognitoUserAttribute({ Name: "email", Value: username })], [], (err, result) =>
        err ? reject(toAuthError(err)) : resolve(result?.userConfirmed === true),
      );
    }).then((confirmed): Promise<Session | "confirm"> => (confirmed ? signIn(email, password) : Promise.resolve("confirm")));

  const confirmSignUp = (email: string, code: string): Promise<void> =>
    new Promise((resolve, reject) => {
      try {
        userFor(email).confirmRegistration(code.trim(), true, (err) => (err ? reject(toAuthError(err)) : resolve()));
      } catch (e) {
        reject(e instanceof AuthError ? e : toAuthError(e));
      }
    });

  const resendCode = (email: string): Promise<void> =>
    new Promise((resolve, reject) => {
      try {
        userFor(email).resendConfirmationCode((err) => (err ? reject(toAuthError(err)) : resolve()));
      } catch (e) {
        reject(e instanceof AuthError ? e : toAuthError(e));
      }
    });

  const forgotPassword = (email: string): Promise<void> =>
    new Promise((resolve, reject) => {
      try {
        userFor(email).forgotPassword({
          onSuccess: () => resolve(),
          onFailure: (err) => reject(toAuthError(err)),
          // Called once the code has been emailed; this is the success path for a pool that asks for a code.
          inputVerificationCode: () => resolve(),
        });
      } catch (e) {
        reject(e instanceof AuthError ? e : toAuthError(e));
      }
    });

  const resetPassword = (email: string, code: string, newPassword: string): Promise<void> =>
    new Promise((resolve, reject) => {
      try {
        userFor(email).confirmPassword(code.trim(), newPassword, {
          onSuccess: () => resolve(),
          onFailure: (err) => reject(toAuthError(err)),
        });
      } catch (e) {
        reject(e instanceof AuthError ? e : toAuthError(e));
      }
    });

  return {
    getSession: currentSession,
    signIn,
    signUp,
    confirmSignUp,
    resendCode,
    forgotPassword,
    resetPassword,
    signOut() {
      try {
        getPool().getCurrentUser()?.signOut();
      } catch {
        /* not configured: nothing to sign out of */
      }
    },
    getIdToken: async () => (await currentSession())?.idToken ?? null,
  };
}
