// Shared app data: cached graphs (merged + per course) and the Guide list.
// Every mutation response that returns a node goes through applyNode(), which is
// what makes a node's fill (retention) and border (confidence) change live on the
// graph, in the popup and in the Guide without a reload.
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "../api";
import type { ConceptNode, GraphResponse, GuideEntry } from "../contracts";
import { predictedForgetAt, startRetentionOf } from "../lib/learning";

export const ALL = "all";

interface DataCtx {
  graphs: Record<string, GraphResponse>;
  /** Loads GET /graph (key "all") or GET /graph/:courseId, using the cache unless forced. */
  loadGraph(key: string, force?: boolean): Promise<GraphResponse>;
  guide: GuideEntry[] | null;
  loadGuide(force?: boolean): Promise<GuideEntry[]>;
  applyNode(node: ConceptNode): void;
  /** Stores a full entry from GET /guide/:conceptId in the Guide cache. */
  applyEntry(entry: GuideEntry): void;
  /** Drops every cache (after a new course is built). */
  reset(): void;
  quizConceptId: string | null;
  openQuiz(conceptId: string): void;
  closeQuiz(): void;
}

const Ctx = createContext<DataCtx | null>(null);

export function DataProvider({ children }: { children: ReactNode }) {
  const [graphs, setGraphs] = useState<Record<string, GraphResponse>>({});
  const [guide, setGuide] = useState<GuideEntry[] | null>(null);
  const [quizConceptId, setQuizConceptId] = useState<string | null>(null);
  const graphsRef = useRef(graphs);
  graphsRef.current = graphs;
  const guideRef = useRef(guide);
  guideRef.current = guide;
  const inflight = useRef(new Map<string, Promise<GraphResponse>>());
  const guideInflight = useRef<Promise<GuideEntry[]> | null>(null);
  const epoch = useRef(0);

  const loadGraph = useCallback((key: string, force = false): Promise<GraphResponse> => {
    const cached = graphsRef.current[key];
    if (cached && !force) return Promise.resolve(cached);
    const pending = inflight.current.get(key);
    if (pending) return pending;
    const at = epoch.current;
    const p = api
      .getGraph(key === ALL ? undefined : key)
      .then((g) => {
        if (at === epoch.current) setGraphs((prev) => ({ ...prev, [key]: g }));
        return g;
      })
      .finally(() => inflight.current.delete(key));
    inflight.current.set(key, p);
    return p;
  }, []);

  const loadGuide = useCallback((force = false): Promise<GuideEntry[]> => {
    if (guideRef.current && !force) return Promise.resolve(guideRef.current);
    if (guideInflight.current) return guideInflight.current;
    const at = epoch.current;
    const p = api
      .getGuide()
      .then(({ entries }) => {
        if (at === epoch.current) {
          // GET /guide makes no Gemini calls, so keep any explanation already fetched this session.
          setGuide((prev) => {
            const known = new Map((prev ?? []).map((e) => [e.conceptId, e]));
            return entries.map((e) => {
              const old = known.get(e.conceptId);
              return old?.explanation && !e.explanation ? { ...e, explanation: old.explanation, resources: old.resources, generatedAt: old.generatedAt } : e;
            });
          });
        }
        return entries;
      })
      .finally(() => {
        guideInflight.current = null;
      });
    guideInflight.current = p;
    return p;
  }, []);

  const applyNode = useCallback(
    (node: ConceptNode) => {
      setGraphs((prev) => {
        const next: Record<string, GraphResponse> = {};
        for (const [key, g] of Object.entries(prev)) {
          next[key] = g.nodes.some((n) => n.id === node.id)
            ? // connectionCount is graph-wide and unchanged by a review, so keep the cached one.
              { ...g, nodes: g.nodes.map((n) => (n.id === node.id ? { ...node, connectionCount: node.connectionCount ?? n.connectionCount } : n)) }
            : g;
        }
        return next;
      });
      setGuide((prev) =>
        prev
          ? prev.map((e) =>
              e.conceptId === node.id
                ? {
                    ...e,
                    retention: node.retention,
                    stability: node.stability,
                    lastReviewed: node.lastReviewed,
                    confidence: node.confidence,
                    confidenceSource: node.confidenceSource,
                    predictedForgetAt: predictedForgetAt(node.lastReviewed, node.stability, startRetentionOf(node)),
                  }
                : e,
            )
          : prev,
      );
      // Then pull the authoritative list (new order, z-score, anomaly flag) in the background.
      void loadGuide(true).catch(() => undefined);
    },
    [loadGuide],
  );

  const applyEntry = useCallback((entry: GuideEntry) => {
    setGuide((prev) => (prev ? prev.map((e) => (e.conceptId === entry.conceptId ? entry : e)) : prev));
  }, []);

  const reset = useCallback(() => {
    epoch.current += 1;
    inflight.current.clear();
    guideInflight.current = null;
    graphsRef.current = {};
    guideRef.current = null;
    setGraphs({});
    setGuide(null);
  }, []);

  const openQuiz = useCallback((id: string) => setQuizConceptId(id), []);
  const closeQuiz = useCallback(() => setQuizConceptId(null), []);

  const value = useMemo(
    () => ({ graphs, loadGraph, guide, loadGuide, applyNode, applyEntry, reset, quizConceptId, openQuiz, closeQuiz }),
    [graphs, loadGraph, guide, loadGuide, applyNode, applyEntry, reset, quizConceptId, openQuiz, closeQuiz],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useData(): DataCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useData outside DataProvider");
  return ctx;
}
