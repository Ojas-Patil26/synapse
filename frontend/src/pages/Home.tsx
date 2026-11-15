import { useEffect, useMemo, useState } from "react";
import { Navigate } from "react-router-dom";
import { ApiRequestError } from "../api";
import { GraphView } from "../components/GraphView";
import { NodeGlyph } from "../components/NodeGlyph";
import { Legend } from "../components/Legend";
import { NodePopup } from "../components/NodePopup";
import { FORGET_THRESHOLD } from "../contracts";
import { forgetDate, pct } from "../lib/format";
import { ALL_SEMESTERS, filterGraphBySemester, semestersOf } from "../lib/semester";
import { ALL, useData } from "../state/data";

export function Home() {
  const { graphs, guide, loadGraph, loadGuide } = useData();
  const [filter, setFilter] = useState<string>(ALL);
  const [semester, setSemester] = useState<string>(ALL_SEMESTERS);
  const [shown, setShown] = useState<string>(ALL); // the key currently drawn (holds the old view while the next loads)
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  // The merged graph supplies the dropdown; the Guide list supplies instant popup summaries.
  useEffect(() => {
    void loadGraph(ALL).catch(() => undefined);
    void loadGuide().catch(() => undefined);
  }, [loadGraph, loadGuide]);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    loadGraph(filter)
      .then(() => {
        if (!live) return;
        setShown(filter);
        setLoading(false);
      })
      .catch((e) => {
        if (!live) return;
        setError(e instanceof ApiRequestError ? e.message : "Could not load the map.");
        setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [filter, loadGraph, attempt]);

  const merged = graphs[ALL];
  const base = graphs[shown];
  // The semester filter narrows the merged view client-side; a single-course view is already narrow.
  const graph = useMemo(() => (base && shown === ALL ? filterGraphBySemester(base, semester) : base), [base, shown, semester]);
  const semesters = useMemo(() => semestersOf(merged?.courses ?? []), [merged]);
  const visibleCourses = useMemo(
    () => (merged?.courses ?? []).filter((c) => semester === ALL_SEMESTERS || c.semester === semester),
    [merged, semester],
  );
  const selected = useMemo(() => graph?.nodes.find((n) => n.id === selectedId) ?? null, [graph, selectedId]);
  // The three concepts most worth reviewing now (the Guide's worst-first order), limited to what is on screen.
  const reviewNext = useMemo(() => {
    if (!guide || !graph) return [];
    const onScreen = new Set(graph.nodes.map((n) => n.id));
    return guide
      .filter((e) => onScreen.has(e.conceptId))
      .sort((a, b) => b.urgency - a.urgency)
      .slice(0, 3);
  }, [guide, graph]);
  const atRisk = graph ? graph.nodes.filter((n) => n.retention < FORGET_THRESHOLD).length : 0;

  // Changing the semester must not leave a course from another semester selected.
  const changeSemester = (next: string) => {
    setSemester(next);
    if (filter !== ALL && next !== ALL_SEMESTERS && merged?.courses.find((c) => c.id === filter)?.semester !== next) setFilter(ALL);
  };

  useEffect(() => {
    if (selectedId && graph && !graph.nodes.some((n) => n.id === selectedId)) setSelectedId(null);
  }, [graph, selectedId]);

  if (merged && merged.courses.length === 0) return <Navigate to="/app/upload" replace />;

  return (
    <div className="home">
      <div className="home-bar">
        <div className="home-summary" aria-live="polite">
          {graph && (
            <>
              <strong>{graph.nodes.length} concepts</strong>
              <span>
                {shown === ALL && semester !== ALL_SEMESTERS ? `${semester} · ` : ""}
                {graph.courses.length === 1 ? graph.courses[0].name : `${graph.courses.length} courses`} · {atRisk} below 50% retention
              </span>
            </>
          )}
        </div>
        <div className="home-filters">
          {semesters.length > 0 && (
            <label className="course-filter">
              <span className="sr-only">Show semester</span>
              <select value={semester} onChange={(e) => changeSemester(e.target.value)} disabled={!merged}>
                <option value={ALL_SEMESTERS}>All semesters</option>
                {semesters.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="course-filter">
            <span className="sr-only">Show course</span>
            <select value={filter} onChange={(e) => setFilter(e.target.value)} disabled={!merged}>
              <option value={ALL}>All courses</option>
              {visibleCourses.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {reviewNext.length > 0 && (
        <aside className="review-next" aria-label="Review next">
          <h2>Review next</h2>
          <ol>
            {reviewNext.map((e) => (
              <li key={e.conceptId}>
                <button type="button" className="review-row" onClick={() => setSelectedId(e.conceptId)}>
                  <NodeGlyph retention={e.retention} confidence={e.confidence} r={5} />
                  <span className="review-text">
                    <span className="review-label">{e.label}</span>
                    <span className="review-meta">
                      {pct(e.retention)} remembered ·{" "}
                      {e.retention < 0.5 || Date.parse(e.predictedForgetAt) < Date.now() ? "review now" : `fades ${forgetDate(e.predictedForgetAt)}`}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </aside>
      )}

      {graph ? (
        <div className={`graph-stage${loading ? " is-loading" : ""}`}>
          <GraphView
            graph={graph}
            selectedId={selectedId}
            onSelect={setSelectedId}
            popup={
              selected ? (
                <NodePopup
                  key={selected.id}
                  node={selected}
                  courseName={graph.courses.find((c) => c.id === selected.courseId)?.name ?? ""}
                  onClose={() => setSelectedId(null)}
                />
              ) : null
            }
          />
          <Legend showCross={graph.crossCourseLinks.length > 0} />
        </div>
      ) : error ? (
        <div className="page-center">
          <p className="note note-error">{error}</p>
          <button className="btn" onClick={() => setAttempt((a) => a + 1)}>
            Try again
          </button>
        </div>
      ) : (
        <div className="page-center muted" role="status">
          <span className="spinner" aria-hidden="true" /> Loading your map…
        </div>
      )}
      {graph && error && (
        <p className="note note-error toast" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
