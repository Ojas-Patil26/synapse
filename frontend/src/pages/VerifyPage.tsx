import { useEffect, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { AuthError, auth } from "../auth";
import { AuthShell } from "../components/AuthShell";
import { useSession } from "../state/session";

interface VerifyState {
  email?: string;
  password?: string;
  notice?: string;
}

const RESEND_WAIT_S = 30;

/** Confirm a new account with the code that was emailed. */
export function VerifyPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { signIn } = useSession();
  const st = (location.state ?? {}) as VerifyState;
  const [email, setEmail] = useState(st.email ?? "");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(st.notice ?? (st.email ? `We sent a 6-digit code to ${st.email}.` : null));
  const [wait, setWait] = useState(0);

  useEffect(() => {
    if (wait <= 0) return;
    const t = window.setTimeout(() => setWait((w) => w - 1), 1000);
    return () => window.clearTimeout(t);
  }, [wait]);

  const fail = (err: unknown) => setError(err instanceof AuthError ? err.message : "Something went wrong. Try again.");

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!email.trim()) return setError("Enter your email.");
    if (!/^\d{6}$/.test(code.trim())) return setError("Enter the 6-digit code from the email.");
    setBusy(true);
    try {
      await auth.confirmSignUp(email, code);
      if (st.password) {
        await signIn(email, st.password);
        navigate("/app", { replace: true });
      } else {
        navigate("/login", { replace: true, state: { notice: "Email confirmed. Log in to continue." } });
      }
    } catch (err) {
      fail(err);
      setBusy(false);
    }
  };

  const onResend = async () => {
    setError(null);
    if (!email.trim()) return setError("Enter your email first.");
    try {
      await auth.resendCode(email);
      setInfo(`A new code is on its way to ${email.trim()}.`);
      setWait(RESEND_WAIT_S);
    } catch (err) {
      fail(err);
    }
  };

  return (
    <AuthShell>
      <form className="auth-card" onSubmit={onSubmit} noValidate>
        <h1>Confirm your email</h1>
        {info && <p className="note note-info">{info}</p>}
        {!st.email && (
          <label className="field">
            <span>Email</span>
            <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
        )}
        <label className="field">
          <span>Confirmation code</span>
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
        {error && (
          <p className="note note-error" role="alert">
            {error}
          </p>
        )}
        <button className="btn btn-primary btn-block" type="submit" disabled={busy}>
          {busy ? "One moment…" : "Confirm email"}
        </button>
        <p className="auth-switch">
          <button type="button" className="text-link" onClick={onResend} disabled={wait > 0}>
            {wait > 0 ? `Send a new code in ${wait}s` : "Send a new code"}
          </button>
          {" · "}
          <Link to="/signup">Use a different email</Link>
        </p>
      </form>
    </AuthShell>
  );
}
