import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AuthError, auth } from "../auth";
import { AuthShell } from "../components/AuthShell";

/** Reset a forgotten password: email a code, then set a new password with it. */
export function ForgotPage() {
  const navigate = useNavigate();
  const [step, setStep] = useState<"request" | "reset">("request");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fail = (err: unknown) => setError(err instanceof AuthError ? err.message : "Something went wrong. Try again.");

  const onRequest = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!email.trim()) return setError("Enter your email.");
    setBusy(true);
    try {
      await auth.forgotPassword(email);
      setStep("reset");
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const onReset = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!/^\d{6}$/.test(code.trim())) return setError("Enter the 6-digit code from the email.");
    if (password.length < 8) return setError("Use a password of at least 8 characters.");
    setBusy(true);
    try {
      await auth.resetPassword(email, code, password);
      navigate("/login", { replace: true, state: { notice: "Password updated. Log in with your new password." } });
    } catch (err) {
      fail(err);
      setBusy(false);
    }
  };

  return (
    <AuthShell>
      {step === "request" ? (
        <form className="auth-card" onSubmit={onRequest} noValidate>
          <h1>Reset your password</h1>
          <p className="muted">Enter your email and we will send you a code.</p>
          <label className="field">
            <span>Email</span>
            <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
          </label>
          {error && (
            <p className="note note-error" role="alert">
              {error}
            </p>
          )}
          <button className="btn btn-primary btn-block" type="submit" disabled={busy}>
            {busy ? "One moment…" : "Send code"}
          </button>
          <p className="auth-switch">
            <Link to="/login">Back to log in</Link>
          </p>
        </form>
      ) : (
        <form className="auth-card" onSubmit={onReset} noValidate>
          <h1>Choose a new password</h1>
          <p className="note note-info">If {email.trim()} has an account, a 6-digit code is on its way.</p>
          <label className="field">
            <span>Code</span>
            <input
              className="code-input"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              autoFocus
            />
          </label>
          <label className="field">
            <span>New password</span>
            <input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          {error && (
            <p className="note note-error" role="alert">
              {error}
            </p>
          )}
          <button className="btn btn-primary btn-block" type="submit" disabled={busy}>
            {busy ? "One moment…" : "Update password"}
          </button>
          <p className="auth-switch">
            <button type="button" className="text-link" onClick={() => setStep("request")}>
              Send a new code
            </button>
          </p>
        </form>
      )}
    </AuthShell>
  );
}
