import { useState, type FormEvent } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { USE_FIXTURES } from "../api";
import { AuthError } from "../auth";
import { Brand } from "../components/Brand";
import { ThemeToggle } from "../components/ThemeToggle";
import { useSession } from "../state/session";

export function AuthPage({ mode }: { mode: "login" | "signup" }) {
  const { session, loading, signIn, signUp } = useSession();
  const navigate = useNavigate();
  const notice = ((useLocation().state ?? {}) as { notice?: string }).notice;
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isLogin = mode === "login";
  const title = isLogin ? "Log in" : "Sign up";

  if (!loading && session && !busy) return <Navigate to="/app" replace />;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!email.trim() || !password) return setError("Enter your email and password.");
    if (!isLogin && password.length < 8) return setError("Use a password of at least 8 characters.");
    setBusy(true);
    try {
      const outcome = isLogin ? await signIn(email, password).then(() => "signed-in" as const) : await signUp(email, password);
      if (outcome === "confirm") {
        navigate("/verify", { state: { email: email.trim().toLowerCase(), password } });
        return;
      }
      navigate("/app", { replace: true });
    } catch (err) {
      if (err instanceof AuthError && err.code === "UserNotConfirmedException") {
        navigate("/verify", {
          state: { email: email.trim().toLowerCase(), password, notice: "Your email is not confirmed yet. Enter the code we sent, or ask for a new one." },
        });
        return;
      }
      setError(err instanceof AuthError ? err.message : "Something went wrong. Try again.");
      setBusy(false);
    }
  };

  return (
    <div className="auth-page">
      <header className="topnav topnav-plain">
        <Brand to="/" />
        <div className="nav-right">
          <ThemeToggle />
        </div>
      </header>
      <form className="auth-card" onSubmit={onSubmit} noValidate>
        <h1>{title}</h1>
        {notice && <p className="note note-info">{notice}</p>}
        {USE_FIXTURES && <p className="note note-info">Demo mode: any email and password will work.</p>}
        <label className="field">
          <span>Email</span>
          <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        </label>
        <label className="field">
          <span>Password</span>
          <input
            type="password"
            autoComplete={isLogin ? "current-password" : "new-password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && (
          <p className="note note-error" role="alert">
            {error}
          </p>
        )}
        <button className="btn btn-primary btn-block" type="submit" disabled={busy}>
          {busy ? "One moment…" : title}
        </button>
        {isLogin && (
          <p className="auth-switch">
            <Link to="/forgot">Forgot your password?</Link>
          </p>
        )}
        <p className="auth-switch">
          {isLogin ? (
            <>
              New to Synapse? <Link to="/signup">Sign up</Link>
            </>
          ) : (
            <>
              Already have an account? <Link to="/login">Log in</Link>
            </>
          )}
        </p>
      </form>
    </div>
  );
}
