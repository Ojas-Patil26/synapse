import { Link } from "react-router-dom";
import type { ConceptNode } from "../contracts";
import { confidenceText, forgetDate, forgetVerb, pct } from "../lib/format";
import { predictedForgetAt, startRetentionOf } from "../lib/learning";
import { useGuideEntry } from "../state/useGuideEntry";
import { ConceptActions } from "./ConceptActions";
import { NodeGlyph } from "./NodeGlyph";

interface Props {
  node: ConceptNode;
  courseName: string;
  onClose: () => void;
}

export function NodePopup({ node, courseName, onClose }: Props) {
  const { entry, loading } = useGuideEntry(node.id);
  // Stats come from the live node so they change the moment a review or quiz lands.
  const forgetAt = predictedForgetAt(node.lastReviewed, node.stability, startRetentionOf(node));

  return (
    <section className="popup" aria-label={`${node.label} details`}>
      <header className="popup-head">
        <NodeGlyph retention={node.retention} confidence={node.confidence} r={9} />
        <div className="popup-title">
          <h2>{node.label}</h2>
          <p>{courseName}</p>
        </div>
        <button className="icon-btn icon-btn-small" onClick={onClose} aria-label="Close">
          <svg width="14" height="14" viewBox="0 0 14 14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
            <path d="M2 2l10 10M12 2 2 12" />
          </svg>
        </button>
      </header>

      <dl className="stats">
        <div>
          <dt>Retention</dt>
          <dd>{pct(node.retention)}</dd>
        </div>
        <div>
          <dt>Confidence</dt>
          <dd>{confidenceText(node.confidence)}</dd>
        </div>
        <div className="stats-wide">
          <dt>{forgetVerb(forgetAt)}</dt>
          <dd>{forgetDate(forgetAt)}</dd>
        </div>
      </dl>

      <div className="popup-summary" aria-live="polite">
        {entry?.summary ? <p>{entry.summary}</p> : <div className="skeleton-lines"><span /><span /><span /></div>}
        {loading && entry?.summary && <span className="tiny-status">Personalizing…</span>}
      </div>

      <ConceptActions conceptId={node.id} />

      <Link className="text-link" to={`/app/guide/${encodeURIComponent(node.id)}`}>
        View full guide entry
      </Link>
    </section>
  );
}
