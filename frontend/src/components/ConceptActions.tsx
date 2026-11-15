// "Mark reviewed" (Got it / Still shaky) and "Take quiz". Shared by the node popup
// and the Guide entry page. Copy is verbatim from COPY.md.
import { useState } from "react";
import { api, ApiRequestError } from "../api";
import type { Rating } from "../contracts";
import { useData } from "../state/data";

export function ConceptActions({ conceptId }: { conceptId: string }) {
  const { applyNode, openQuiz } = useData();
  const [busy, setBusy] = useState<Rating | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  const review = async (rating: Rating) => {
    setBusy(rating);
    setNote(null);
    try {
      const { node } = await api.postReview({ conceptId, rating });
      applyNode(node);
      setNote({
        ok: true,
        text:
          rating === "got-it"
            ? "Reviewed. Retention is back to 100% and it will now fade more slowly."
            : `Marked as shaky. Retention is ${Math.round(node.retention * 100)}%, so this concept stays on your review list.`,
      });
    } catch (e) {
      setNote({ ok: false, text: e instanceof ApiRequestError ? e.message : "Could not save that review. Try again." });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="actions">
      <div className="actions-row">
        <span className="actions-label">Mark reviewed</span>
        <div className="btn-pair">
          <button className="btn btn-small" disabled={busy !== null} onClick={() => review("got-it")}>
            {busy === "got-it" ? "Saving…" : "Got it"}
          </button>
          <button className="btn btn-small" disabled={busy !== null} onClick={() => review("still-shaky")}>
            {busy === "still-shaky" ? "Saving…" : "Still shaky"}
          </button>
        </div>
      </div>
      <button className="btn btn-primary btn-block" onClick={() => openQuiz(conceptId)}>
        Take quiz
      </button>
      {note && (
        <p className={note.ok ? "note note-ok" : "note note-error"} role="status">
          {note.text}
        </p>
      )}
    </div>
  );
}
