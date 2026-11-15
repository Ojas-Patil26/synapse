// One concept's Guide entry. Returns the cached GET /guide row at once (summary and
// stats), then swaps in the full entry from GET /guide/:conceptId when it arrives.
import { useEffect, useState } from "react";
import { api, ApiRequestError } from "../api";
import type { GuideEntry } from "../contracts";
import { useData } from "./data";

export function useGuideEntry(conceptId: string) {
  const { guide, loadGuide, applyEntry } = useData();
  const [full, setFull] = useState<GuideEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    void loadGuide().catch(() => undefined);
  }, [loadGuide]);

  useEffect(() => {
    let live = true;
    setFull(null);
    setLoading(true);
    setError(null);
    api
      .getGuideEntry(conceptId)
      .then(({ entry }) => {
        if (!live) return;
        setFull(entry);
        applyEntry(entry);
      })
      .catch((e) => live && setError(e instanceof ApiRequestError ? e.message : "Could not load this entry."))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [conceptId, attempt, applyEntry]);

  const cached = guide?.find((e) => e.conceptId === conceptId) ?? null;
  const entry: GuideEntry | null = cached
    ? {
        ...cached,
        explanation: cached.explanation ?? full?.explanation ?? null,
        resources: cached.resources.length ? cached.resources : (full?.resources ?? []),
      }
    : full;

  return { entry, loading, error, retry: () => setAttempt((a) => a + 1) };
}
