import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, ApiRequestError } from "../api";
import { useSession } from "../state/session";

/** The signed-in user's account: who they are, what is stored, and deleting all of it. */
export function Account() {
  const { session, signOut } = useSession();
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onDelete = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.deleteAccount();
      signOut();
      navigate("/login", { replace: true, state: { notice: "Your account and all of its data were deleted." } });
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : "Could not delete the account. Try again.");
      setBusy(false);
    }
  };

  return (
    <div className="page narrow">
      <h1>Account</h1>
      <dl className="account-facts">
        <dt>Signed in as</dt>
        <dd>{session?.email}</dd>
      </dl>
      <p className="muted">
        Synapse stores your notes, the concepts extracted from them and your review history. See <Link to="/privacy">Privacy</Link> for exactly what and where.
      </p>

      <section className="danger-zone" aria-labelledby="delete-title">
        <h2 id="delete-title">Delete account and data</h2>
        <p>
          This permanently removes your courses, concepts, quiz and review history, uploaded files, learner profile and your login. It cannot be undone.
        </p>
        {!confirming ? (
          <button className="btn btn-danger" onClick={() => setConfirming(true)}>
            Delete account and data
          </button>
        ) : (
          <div className="danger-confirm">
            <label className="field">
              <span>Type DELETE to confirm</span>
              <input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" autoFocus />
            </label>
            {error && (
              <p className="note note-error" role="alert">
                {error}
              </p>
            )}
            <div className="btn-row">
              <button className="btn btn-danger" disabled={typed !== "DELETE" || busy} onClick={onDelete}>
                {busy ? "Deleting…" : "Permanently delete"}
              </button>
              <button
                className="btn btn-quiet"
                disabled={busy}
                onClick={() => {
                  setConfirming(false);
                  setTyped("");
                  setError(null);
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
