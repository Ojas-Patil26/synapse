import { useEffect, useState } from "react";
import { NavLink, Navigate, Outlet, useLocation, useNavigate } from "react-router-dom";
import { ApiRequestError, setUnauthorizedHandler } from "../api";
import { Brand } from "../components/Brand";
import { QuizDrawer } from "../components/QuizDrawer";
import { ThemeToggle } from "../components/ThemeToggle";
import { ALL, DataProvider, useData } from "../state/data";
import { useSession } from "../state/session";

export function AppShell() {
  const { session, loading, signOut } = useSession();
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    setUnauthorizedHandler(() => {
      signOut();
      navigate("/login", { replace: true });
    });
    return () => setUnauthorizedHandler(null);
  }, [signOut, navigate]);

  if (loading) return <div className="page-center muted">Loading…</div>;
  if (!session) return <Navigate to="/login" replace state={{ from: location.pathname }} />;

  return (
    <DataProvider>
      <div className="app">
        <header className="topnav">
          <Brand to="/app/home" />
          <nav className="navlinks" aria-label="Main">
            <NavLink to="/app/home">Home</NavLink>
            <NavLink to="/app/upload">Upload Course</NavLink>
            <NavLink to="/app/guide">Guide</NavLink>
          </nav>
          <div className="nav-right">
            <NavLink className="nav-account" to="/app/account" title="Account and data">
              <span className="nav-email">{session.email}</span>
              <span className="nav-account-label">Account</span>
            </NavLink>
            <ThemeToggle />
            <button
              className="btn btn-small btn-quiet"
              onClick={() => {
                signOut();
                navigate("/", { replace: true });
              }}
            >
              Sign out
            </button>
          </div>
        </header>
        <main className="app-main">
          <Outlet />
        </main>
        <QuizHost />
      </div>
    </DataProvider>
  );
}

function QuizHost() {
  const { quizConceptId, closeQuiz, graphs, guide } = useData();
  if (!quizConceptId) return null;
  const label =
    guide?.find((e) => e.conceptId === quizConceptId)?.label ??
    Object.values(graphs)
      .flatMap((g) => g.nodes)
      .find((n) => n.id === quizConceptId)?.label ??
    "Concept";
  return <QuizDrawer key={quizConceptId} conceptId={quizConceptId} label={label} onClose={closeQuiz} />;
}

/** /app: zero courses -> Upload, otherwise Home. */
export function AppIndex() {
  const { loadGraph } = useData();
  const [target, setTarget] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setError(null);
    loadGraph(ALL, true)
      .then((g) => live && setTarget(g.courses.length === 0 ? "/app/upload" : "/app/home"))
      .catch((e) => live && setError(e instanceof ApiRequestError ? e.message : "Could not load your courses."));
    return () => {
      live = false;
    };
  }, [loadGraph, attempt]);

  if (target) return <Navigate to={target} replace />;
  if (error)
    return (
      <div className="page-center">
        <p className="note note-error">{error}</p>
        <button className="btn" onClick={() => setAttempt((a) => a + 1)}>
          Try again
        </button>
      </div>
    );
  return (
    <div className="page-center muted" role="status">
      <span className="spinner" aria-hidden="true" /> Loading your map…
    </div>
  );
}
