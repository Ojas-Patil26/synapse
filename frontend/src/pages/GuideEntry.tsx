import ReactMarkdown from "react-markdown";
import { Link, useParams } from "react-router-dom";
import { ConceptActions } from "../components/ConceptActions";
import { NodeGlyph } from "../components/NodeGlyph";
import type { Resource } from "../contracts";
import { confidenceText, forgetDate, forgetVerb, pct } from "../lib/format";
import { useGuideEntry } from "../state/useGuideEntry";

const TYPE_LABEL: Record<Resource["type"], string> = { video: "Video", article: "Article", practice: "Practice" };

export function GuideEntryPage() {
  const { conceptId = "" } = useParams();
  return <EntryView key={conceptId} conceptId={conceptId} />;
}

function EntryView({ conceptId }: { conceptId: string }) {
  const { entry, loading, error, retry } = useGuideEntry(conceptId);

  return (
    <div className="page entry">
      <Link to="/app/guide" className="back-link">
        ← Guide
      </Link>

      {!entry && loading && (
        <div className="page-center muted" role="status">
          <span className="spinner" aria-hidden="true" /> Loading…
        </div>
      )}
      {!entry && error && (
        <div className="page-center">
          <p className="note note-error">{error}</p>
          <button className="btn" onClick={retry}>
            Try again
          </button>
        </div>
      )}

      {entry && (
        <div className="entry-grid">
          <article className="entry-main">
            <header className="entry-head">
              <NodeGlyph retention={entry.retention} confidence={entry.confidence} r={12} />
              <div>
                <h1>{entry.label}</h1>
                <p className="muted">{entry.courseName}</p>
              </div>
            </header>
            {entry.anomalous && <p className="badge-anomaly badge-block">Fading faster than expected</p>}
            <p className="entry-summary">{entry.summary}</p>

            <section className="explanation" aria-live="polite">
              {entry.explanation ? (
                <ReactMarkdown
                  components={{
                    a: ({ href, children }) => (
                      <a href={href} target="_blank" rel="noopener noreferrer">
                        {children}
                      </a>
                    ),
                  }}
                >
                  {entry.explanation}
                </ReactMarkdown>
              ) : loading ? (
                <div className="generating" role="status">
                  <p>
                    <span className="spinner" aria-hidden="true" /> Writing an explanation for you. This can take a few seconds the first time.
                  </p>
                  <div className="skeleton-lines">
                    <span /><span /><span /><span /><span /><span />
                  </div>
                </div>
              ) : (
                <div>
                  <p className="note note-error">{error ?? "The explanation is not available right now."}</p>
                  <button className="btn" onClick={retry}>
                    Try again
                  </button>
                </div>
              )}
            </section>
          </article>

          <aside className="entry-side">
            <div className="card">
              <dl className="stats">
                <div>
                  <dt>Retention</dt>
                  <dd>{pct(entry.retention)}</dd>
                </div>
                <div>
                  <dt>Confidence</dt>
                  <dd>{confidenceText(entry.confidence)}</dd>
                </div>
                <div className="stats-wide">
                  <dt>{forgetVerb(entry.predictedForgetAt)}</dt>
                  <dd>{forgetDate(entry.predictedForgetAt)}</dd>
                </div>
              </dl>
              <ConceptActions conceptId={entry.conceptId} />
            </div>

            <div className="card">
              <h2>Resources</h2>
              {entry.resources.length > 0 ? (
                <ul className="resources">
                  {entry.resources.map((r) => (
                    <li key={r.url}>
                      <a href={r.url} target="_blank" rel="noopener noreferrer">
                        <span className="res-type">{TYPE_LABEL[r.type] ?? r.type}</span>
                        <span>{r.title}</span>
                        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
                          <path d="M4.5 2.5h5v5M9.5 2.5 2.5 9.5" />
                        </svg>
                      </a>
                    </li>
                  ))}
                </ul>
              ) : loading ? (
                <div className="skeleton-lines"><span /><span /><span /></div>
              ) : (
                <p className="muted">No resources yet.</p>
              )}
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
