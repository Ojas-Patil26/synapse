// Guide: every concept across courses in the order GET /guide returns (worst first),
// plus each course's industry skills. This is also the table view of the map.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiRequestError } from "../api";
import { NodeGlyph } from "../components/NodeGlyph";
import type { CourseSkillsResponse } from "../contracts";
import { confidenceText, forgetDate, pct } from "../lib/format";
import { ALL, useData } from "../state/data";

export function Guide() {
  const { guide, loadGuide, graphs, loadGraph } = useData();
  const [error, setError] = useState<string | null>(null);
  const [skills, setSkills] = useState<Record<string, CourseSkillsResponse>>({});
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    setError(null);
    // Force a refresh so retention and order are current each time the Guide opens.
    loadGuide(true).catch((e) => setError(e instanceof ApiRequestError ? e.message : "Could not load the Guide."));
    void loadGraph(ALL).catch(() => undefined);
  }, [loadGuide, loadGraph, attempt]);

  const courses = graphs[ALL]?.courses;
  const courseKey = courses?.map((c) => c.id).join(",") ?? "";
  useEffect(() => {
    if (!courses) return;
    let live = true;
    for (const c of courses) {
      api
        .getCourseSkills(c.id)
        .then((s) => live && setSkills((prev) => ({ ...prev, [c.id]: s })))
        .catch(() => undefined); // the course card falls back to what GET /graph returned
    }
    return () => {
      live = false;
    };
  }, [courseKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="page">
      <h1>Guide</h1>
      <p className="lede">Every concept across your courses, most urgent first.</p>

      {courses && courses.length > 0 && (
        <section className="skills" aria-label="Industry skills by course">
          {courses.map((c) => {
            const s = skills[c.id];
            const list = s?.industrySkills ?? c.industrySkills;
            const summary = s?.skillsSummary ?? c.skillsSummary;
            return (
              <article key={c.id} className="skill-card">
                <p className="eyebrow">Industry skills</p>
                <h2>{c.name}</h2>
                <ul className="chips">
                  {list.map((sk) => (
                    <li key={sk}>{sk}</li>
                  ))}
                </ul>
                {summary && <p>{summary}</p>}
              </article>
            );
          })}
        </section>
      )}

      {error && !guide && (
        <div className="page-center">
          <p className="note note-error">{error}</p>
          <button className="btn" onClick={() => setAttempt((a) => a + 1)}>
            Try again
          </button>
        </div>
      )}
      {!guide && !error && (
        <div className="page-center muted" role="status">
          <span className="spinner" aria-hidden="true" /> Loading the Guide…
        </div>
      )}

      {guide && guide.length === 0 && <p className="muted">No concepts yet. Upload a course to get started.</p>}

      {guide && guide.length > 0 && (
        <div className="guide-table" role="table" aria-label="Concepts, most urgent first">
          <div className="guide-head" role="row">
            <span role="columnheader">Concept</span>
            <span role="columnheader">Retention</span>
            <span role="columnheader">Confidence</span>
            <span role="columnheader">Predicted to forget</span>
          </div>
          {guide.map((e) => (
            <Link key={e.conceptId} to={`/app/guide/${encodeURIComponent(e.conceptId)}`} className="guide-row" role="row">
              <span className="g-concept" role="cell">
                <NodeGlyph retention={e.retention} confidence={e.confidence} r={7} />
                <span>
                  <strong>{e.label}</strong>
                  <small>{e.courseName}</small>
                  {e.anomalous && (
                    <em className="badge-anomaly">
                      <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M1 2.5 4.5 6l2-2L11 9.5M11 6v3.5H7.5" />
                      </svg>
                      Fading faster than expected
                    </em>
                  )}
                </span>
              </span>
              <span className="g-ret" role="cell" data-label="Retention">
                <span className="g-num">{pct(e.retention)}</span>
                <span className="meter" aria-hidden="true">
                  <i style={{ width: `${Math.max(2, Math.round(e.retention * 100))}%` }} />
                </span>
              </span>
              <span role="cell" data-label="Confidence">
                {confidenceText(e.confidence)}
              </span>
              <span role="cell" data-label="Predicted to forget">
                {forgetDate(e.predictedForgetAt)}
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
