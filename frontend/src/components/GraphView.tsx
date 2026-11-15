// The concept map. Encodings (all colors come from the theme palette, never hardcoded):
//   hub            large neutral node per course, sized by conceptCount, name inside
//   node fill      retention, continuous red (0) -> amber -> green (1)
//   node ring      confidence: dashed thin = not assessed, then thin / medium / thick
//   node size      connectionCount; sub-concepts are smaller and unlabeled until hover/click
//   dashed accent  cross-course links, plus one wide accent band per linked course pair
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ForceGraph2D, { type ForceGraphMethods } from "react-force-graph-2d";
import { forceCollide, forceX, forceY } from "d3-force";
import { confidenceLevel, type ConceptNode, type ConfidenceLevel, type Course, type GraphResponse, type RelationType } from "../contracts";
import { withAlpha } from "../lib/color";
import { confidenceText, pct } from "../lib/format";
import { usePalette, type Palette } from "../state/theme";

type LinkKind = RelationType | "hub" | "hubhub";

interface GNode {
  id: string;
  kind: "hub" | "concept";
  sub: boolean;
  courseId: string;
  r: number;
  label: string;
  lines: string[];
  data?: ConceptNode;
  course?: Course;
  x?: number;
  y?: number;
}

interface GLink {
  key: string;
  kind: LinkKind;
  source: string | GNode;
  target: string | GNode;
  a: string;
  b: string;
  desc?: string;
}

interface Built {
  sig: string;
  data: { nodes: GNode[]; links: GLink[] };
  adj: Map<string, Set<string>>;
}

type Hover =
  | { type: "node"; node: GNode }
  | { type: "link"; link: GLink }
  | null;

const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';
const hubId = (courseId: string) => `hub:${courseId}`;

function wrap(label: string, maxChars: number, maxLines: number): string[] {
  const words = label.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if (line && (line + " " + w).length > maxChars) {
      lines.push(line);
      line = w;
    } else line = line ? line + " " + w : w;
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = kept[maxLines - 1].replace(/.{0,2}$/, "…");
    return kept;
  }
  return lines;
}

export function ringSpec(level: ConfidenceLevel): { w: number; dash: number[] | null; strong: boolean } {
  switch (level) {
    case "unassessed":
      return { w: 0.9, dash: [2.1, 2.1], strong: false };
    case "low":
      return { w: 1.0, dash: null, strong: true };
    case "medium":
      return { w: 2.1, dash: null, strong: true };
    case "high":
      return { w: 3.4, dash: null, strong: true };
  }
}
const RING_GAP = 1.5;

function conceptRadius(n: ConceptNode, sub: boolean): number {
  const r = 5 + 1.5 * Math.min(8, n.connectionCount);
  return sub ? Math.max(3.8, r * 0.6) : r;
}

function outerRadius(n: GNode): number {
  if (n.kind === "hub" || !n.data) return n.r;
  const scale = n.sub ? 0.75 : 1;
  return n.r + (RING_GAP + ringSpec(confidenceLevel(n.data.confidence)).w) * scale;
}

function build(graph: GraphResponse, cache: Map<string, GNode>): Built {
  const present = new Set(graph.nodes.map((n) => n.id));
  const edges = graph.edges.filter((e) => present.has(e.source) && present.has(e.target));
  const parentOf = new Map<string, string>();
  for (const e of edges) if (e.relationType === "subconcept") parentOf.set(e.source, e.target);

  const nodes: GNode[] = [];
  const hubCount = graph.courses.length;
  graph.courses.forEach((c, i) => {
    const id = hubId(c.id);
    let n = cache.get(id);
    if (!n) {
      const angle = Math.PI + (i * 2 * Math.PI) / Math.max(1, hubCount);
      n = { id, kind: "hub", sub: false, courseId: c.id, r: 0, label: "", lines: [] };
      if (hubCount > 1) {
        n.x = Math.cos(angle) * 210;
        n.y = Math.sin(angle) * 130;
      } else {
        n.x = 0;
        n.y = 0;
      }
      cache.set(id, n);
    }
    n.course = c;
    n.label = c.name;
    n.lines = wrap(c.name, 11, 3);
    n.r = 16 + 3.4 * Math.sqrt(Math.max(1, c.conceptCount));
    nodes.push(n);
  });

  const perCourse = new Map<string, ConceptNode[]>();
  for (const n of graph.nodes) {
    if (parentOf.has(n.id)) continue;
    perCourse.set(n.courseId, [...(perCourse.get(n.courseId) ?? []), n]);
  }
  const place = (n: ConceptNode, sub: boolean) => {
    let g = cache.get(n.id);
    if (!g) {
      g = { id: n.id, kind: "concept", sub, courseId: n.courseId, r: 0, label: "", lines: [] };
      const hub = cache.get(hubId(n.courseId));
      const hx = hub?.x ?? 0;
      const hy = hub?.y ?? 0;
      if (sub) {
        const parent = cache.get(parentOf.get(n.id) ?? "");
        const px = parent?.x ?? hx;
        const py = parent?.y ?? hy;
        const len = Math.hypot(px - hx, py - hy) || 1;
        g.x = px + ((px - hx) / len) * 26;
        g.y = py + ((py - hy) / len) * 26;
      } else {
        const siblings = perCourse.get(n.courseId) ?? [n];
        const angle = (siblings.indexOf(n) / siblings.length) * 2 * Math.PI + 0.4;
        g.x = hx + Math.cos(angle) * 88;
        g.y = hy + Math.sin(angle) * 88;
      }
      cache.set(n.id, g);
    }
    g.sub = sub;
    g.data = n;
    g.label = n.label;
    g.lines = wrap(n.label, 18, 3);
    g.r = conceptRadius(n, sub);
    nodes.push(g);
  };
  for (const n of graph.nodes) if (!parentOf.has(n.id)) place(n, false);
  for (const n of graph.nodes) if (parentOf.has(n.id)) place(n, true);

  const links: GLink[] = [];
  const add = (kind: LinkKind, a: string, b: string, desc?: string) =>
    links.push({ key: `${kind}:${a}>${b}`, kind, source: a, target: b, a, b, desc });

  const courseIds = new Set(graph.courses.map((c) => c.id));
  for (const n of graph.nodes) if (!parentOf.has(n.id) && courseIds.has(n.courseId)) add("hub", hubId(n.courseId), n.id);
  for (const e of edges) {
    if (e.relationType === "cross-course") {
      const descs = graph.crossCourseLinks
        .filter((l) => l.sharedConceptIds.includes(e.source) && l.sharedConceptIds.includes(e.target))
        .map((l) => l.description);
      add("cross-course", e.source, e.target, descs.join(" ") || undefined);
    } else add(e.relationType, e.source, e.target);
  }
  const pairs = new Map<string, string[]>();
  for (const l of graph.crossCourseLinks) {
    if (!courseIds.has(l.sourceCourseId) || !courseIds.has(l.targetCourseId)) continue;
    const key = [l.sourceCourseId, l.targetCourseId].sort().join("|");
    pairs.set(key, [...(pairs.get(key) ?? []), l.description]);
  }
  for (const [key, descs] of pairs) {
    const [a, b] = key.split("|");
    add("hubhub", hubId(a), hubId(b), descs.join("\n"));
  }

  const adj = new Map<string, Set<string>>();
  for (const l of links) {
    if (l.kind === "hubhub") continue;
    if (!adj.has(l.a)) adj.set(l.a, new Set());
    if (!adj.has(l.b)) adj.set(l.b, new Set());
    adj.get(l.a)!.add(l.b);
    adj.get(l.b)!.add(l.a);
  }

  const sig = nodes.map((n) => n.id).sort().join(",") + "#" + links.map((l) => l.key).sort().join(",");
  return { sig, data: { nodes, links }, adj };
}

const end = (v: string | GNode): GNode | null => (typeof v === "object" ? v : null);

interface Props {
  graph: GraphResponse;
  selectedId: string | null;
  onSelect: (conceptId: string | null) => void;
  /** Rendered inside a box that follows the selected node. */
  popup?: ReactNode;
}

export function GraphView({ graph, selectedId, onSelect, popup }: Props) {
  const palette = usePalette();
  const wrapRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const fgRef = useRef<ForceGraphMethods<any, any> | undefined>(undefined);
  const cache = useRef(new Map<string, GNode>());
  const builtRef = useRef<Built | null>(null);
  const needsFit = useRef(true);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hover, setHover] = useState<Hover>(null);
  const hoverRef = useRef<Hover>(null);
  hoverRef.current = hover;
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const paletteRef = useRef<Palette>(palette);
  paletteRef.current = palette;

  const built = useMemo(() => {
    const next = build(graph, cache.current);
    // Same structure: the cached node objects were updated in place, so keep the
    // same graphData identity and the simulation (and every position) is untouched.
    if (builtRef.current && builtRef.current.sig === next.sig) return builtRef.current;
    builtRef.current = next;
    needsFit.current = true;
    return next;
  }, [graph]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setSize({ w: el.clientWidth, h: el.clientHeight });
      needsFit.current = true;
    });
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // Frame the whole map inside the area not covered by the top bar and the legend.
  const fit = useCallback((ms: number) => {
    const el = wrapRef.current;
    const fg = fgRef.current;
    const b = builtRef.current;
    if (!el || !fg || !b) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of b.data.nodes) {
      if (n.x == null || n.y == null) continue;
      const r = outerRadius(n);
      minX = Math.min(minX, n.x - r);
      maxX = Math.max(maxX, n.x + r);
      minY = Math.min(minY, n.y - r);
      maxY = Math.max(maxY, n.y + r);
    }
    if (!Number.isFinite(minX)) return;
    const W = el.clientWidth;
    const H = el.clientHeight;
    const legendH = (el.parentElement?.querySelector(".legend") as HTMLElement | null)?.offsetHeight ?? 0;
    const side = W < 640 ? 46 : 76; // room for labels that are wider than their node
    const inset = { top: 74, bottom: legendH + 62, left: side, right: side };
    const availW = Math.max(120, W - inset.left - inset.right);
    const availH = Math.max(120, H - inset.top - inset.bottom);
    const k = Math.min(2.5, Math.max(0.35, Math.min(availW / Math.max(1, maxX - minX), availH / Math.max(1, maxY - minY))));
    const dx = (inset.left + availW / 2 - W / 2) / k;
    const dy = (inset.top + availH / 2 - H / 2) / k;
    fg.zoom(k, ms);
    fg.centerAt((minX + maxX) / 2 - dx, (minY + maxY) / 2 - dy, ms);
  }, []);

  // Forces: clusters hang off their hub, sub-concepts hug their parent, and
  // cross-course links are nearly slack so the two clusters stay separate.
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg || size.w === 0) return;
    const wide = size.w >= size.h;
    fg.d3Force("charge")?.strength((n: GNode) => (n.kind === "hub" ? -1100 : n.sub ? -70 : -300)).distanceMax(520);
    fg.d3Force("link")
      ?.distance((l: GLink) => {
        const s = end(l.source);
        switch (l.kind) {
          case "hub":
            return (s?.r ?? 26) + 62;
          case "subconcept":
            return 30;
          case "hubhub":
            return 400;
          case "cross-course":
            return 230;
          default:
            return 78;
        }
      })
      .strength((l: GLink) => {
        switch (l.kind) {
          case "hub":
            return 0.75;
          case "subconcept":
            return 1;
          case "hubhub":
            return 0.2;
          case "cross-course":
            return 0.012;
          default:
            return 0.16;
        }
      });
    fg.d3Force("center", null);
    fg.d3Force("collide", forceCollide<GNode>((n) => outerRadius(n) + (n.kind === "hub" ? 12 : n.sub ? 7 : 17)).strength(0.95).iterations(2) as any);
    fg.d3Force("x", forceX<GNode>(0).strength(wide ? 0.022 : 0.06) as any);
    fg.d3Force("y", forceY<GNode>(0).strength(wide ? 0.06 : 0.022) as any);
    fg.d3ReheatSimulation();
    const t1 = window.setTimeout(() => fit(0), 60);
    const t2 = window.setTimeout(() => fit(500), 900);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [built, size.w === 0, size.w >= size.h, fit]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-frame when the container is resized (window resize, orientation change).
  useEffect(() => {
    if (!size.w || !size.h) return;
    const t = window.setTimeout(() => fit(300), 250);
    return () => window.clearTimeout(t);
  }, [size.w, size.h, fit]);

  const focusId = () => {
    const h = hoverRef.current;
    if (h?.type === "node") return h.node.id;
    return selectedRef.current;
  };
  const isLit = (id: string, focus: string | null) => !focus || id === focus || (builtRef.current?.adj.get(focus)?.has(id) ?? false);

  const paintNode = useCallback((n: GNode, ctx: CanvasRenderingContext2D, k: number) => {
    if (n.x == null || n.y == null) return;
    const p = paletteRef.current;
    const focus = focusId();
    const h = hoverRef.current;
    const linkLit = h?.type === "link" && (h.link.a === n.id || h.link.b === n.id);
    const lit = h?.type === "link" ? linkLit : isLit(n.id, focus);
    ctx.save();
    ctx.globalAlpha = lit ? 1 : 0.14;

    if (n.kind === "hub") {
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r, 0, 2 * Math.PI);
      ctx.fillStyle = p.hubFill;
      ctx.fill();
      ctx.lineWidth = Math.max(1, 1.2 / k);
      ctx.strokeStyle = p.hubStroke;
      ctx.stroke();
      // Course name inside the hub, sized to fit.
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = `600 10px ${FONT}`;
      const widest = Math.max(...n.lines.map((l) => ctx.measureText(l).width), 1);
      const fs = Math.min(7.2, (10 * n.r * 1.62) / widest, (n.r * 1.5) / (n.lines.length * 1.18));
      ctx.font = `600 ${fs}px ${FONT}`;
      ctx.fillStyle = p.hubText;
      const lh = fs * 1.18;
      n.lines.forEach((line, i) => ctx.fillText(line, n.x!, n.y! + (i - (n.lines.length - 1) / 2) * lh));
      ctx.restore();
      return;
    }

    const d = n.data!;
    const scale = n.sub ? 0.75 : 1;
    const spec = ringSpec(confidenceLevel(d.confidence));
    const gap = Math.max(RING_GAP * scale, 1.4 / k);
    const w = Math.max(spec.w * scale, (spec.dash ? 1.1 : 1.2) / k);
    const selected = selectedRef.current === n.id;
    const hovered = h?.type === "node" && h.node.id === n.id;

    if (selected || hovered) {
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r + gap + w + 2.6, 0, 2 * Math.PI);
      ctx.fillStyle = withAlpha(p.accent, selected ? 0.3 : 0.16);
      ctx.fill();
    }
    // Surface-colored plate under the node so links never show through the ring gap.
    ctx.beginPath();
    ctx.arc(n.x, n.y, n.r + gap + w, 0, 2 * Math.PI);
    ctx.fillStyle = p.page;
    ctx.fill();
    // Fill = retention.
    ctx.beginPath();
    ctx.arc(n.x, n.y, n.r, 0, 2 * Math.PI);
    ctx.fillStyle = p.retention(d.retention);
    ctx.fill();
    // Ring = confidence.
    ctx.beginPath();
    ctx.arc(n.x, n.y, n.r + gap + w / 2, 0, 2 * Math.PI);
    ctx.lineWidth = w;
    ctx.strokeStyle = spec.strong ? p.ink : p.ink2;
    if (spec.dash) ctx.setLineDash(spec.dash.map((v) => Math.max(v * scale, 2.4 / k)));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }, []);

  const paintNodeArea = useCallback((n: GNode, color: string, ctx: CanvasRenderingContext2D, k: number) => {
    if (n.x == null || n.y == null) return;
    ctx.fillStyle = color;
    ctx.beginPath();
    // Hit target is larger than the mark: at least ~14px radius on screen.
    ctx.arc(n.x, n.y, Math.max(outerRadius(n) + 2, 14 / k), 0, 2 * Math.PI);
    ctx.fill();
  }, []);

  const linkPath = (l: GLink, ctx: CanvasRenderingContext2D): { ex: number; ey: number; ang: number } | null => {
    const s = end(l.source);
    const t = end(l.target);
    if (!s || !t || s.x == null || s.y == null || t.x == null || t.y == null) return null;
    const dx = t.x - s.x;
    const dy = t.y - s.y;
    const len = Math.hypot(dx, dy);
    const rs = outerRadius(s) + 1;
    const rt = outerRadius(t) + 1;
    if (len <= rs + rt) return null;
    const ux = dx / len;
    const uy = dy / len;
    const sx = s.x + ux * rs;
    const sy = s.y + uy * rs;
    const ex = t.x - ux * rt;
    const ey = t.y - uy * rt;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    if (l.kind === "cross-course") {
      const bend = (l.a < l.b ? 1 : -1) * Math.min(46, len * 0.16);
      const cx = (sx + ex) / 2 - uy * bend;
      const cy = (sy + ey) / 2 + ux * bend;
      ctx.quadraticCurveTo(cx, cy, ex, ey);
      return { ex, ey, ang: Math.atan2(ey - cy, ex - cx) };
    }
    ctx.lineTo(ex, ey);
    return { ex, ey, ang: Math.atan2(uy, ux) };
  };

  const paintLink = useCallback((l: GLink, ctx: CanvasRenderingContext2D, k: number) => {
    const p = paletteRef.current;
    const focus = focusId();
    const h = hoverRef.current;
    const hovered = h?.type === "link" && h.link.key === l.key;
    const touches = !!focus && (l.a === focus || l.b === focus);
    const dim = h?.type === "link" ? !hovered : !!focus && !touches;
    ctx.save();
    ctx.globalAlpha = dim ? 0.1 : 1;
    ctx.lineCap = "round";
    const px = (n: number) => Math.max(n / k, n * 0.45);
    const tip = linkPath(l, ctx);
    if (!tip) {
      ctx.restore();
      return;
    }
    switch (l.kind) {
      case "hubhub":
        ctx.strokeStyle = withAlpha(p.accent, hovered ? 0.42 : 0.2);
        ctx.lineWidth = Math.max(5, 6 / k);
        break;
      case "cross-course":
        ctx.strokeStyle = p.accent;
        ctx.lineWidth = px(hovered || touches ? 2.4 : 1.7);
        ctx.setLineDash([px(5), px(4.5)]);
        break;
      case "hub":
        ctx.strokeStyle = p.edge;
        ctx.lineWidth = px(1);
        break;
      case "prerequisite":
        ctx.strokeStyle = touches ? p.ink2 : p.edgeStrong;
        ctx.lineWidth = px(touches ? 1.7 : 1.3);
        break;
      default:
        ctx.strokeStyle = touches ? p.ink2 : p.edgeStrong;
        ctx.lineWidth = px(touches ? 1.4 : 1);
        if (l.kind === "related") ctx.setLineDash([px(1.2), px(3.4)]);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    if (l.kind === "prerequisite") {
      // Arrowhead at the concept that depends on the source.
      const a = Math.max(3.4, 6.5 / k);
      ctx.beginPath();
      ctx.moveTo(tip.ex, tip.ey);
      ctx.lineTo(tip.ex - a * Math.cos(tip.ang - 0.42), tip.ey - a * Math.sin(tip.ang - 0.42));
      ctx.lineTo(tip.ex - a * Math.cos(tip.ang + 0.42), tip.ey - a * Math.sin(tip.ang + 0.42));
      ctx.closePath();
      ctx.fillStyle = ctx.strokeStyle;
      ctx.fill();
    }
    ctx.restore();
  }, []);

  const paintLinkArea = useCallback((l: GLink, color: string, ctx: CanvasRenderingContext2D, k: number) => {
    if (l.kind !== "cross-course" && l.kind !== "hubhub") return; // only these carry a description
    if (!linkPath(l, ctx)) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(9, 14 / k);
    ctx.stroke();
  }, []);

  // Labels are drawn after everything else so no node or link ever covers them,
  // and the popup anchor is moved here so it tracks the node through zoom and pan.
  const afterFrame = useCallback((ctx: CanvasRenderingContext2D, k: number) => {
    const p = paletteRef.current;
    const b = builtRef.current;
    if (!b) return;
    const focus = focusId();
    const h = hoverRef.current;
    const fs = Math.min(6.4, Math.max(3.1, 11.5 / k));
    const screenPx = fs * k;
    const fade = Math.min(1, Math.max(0, (screenPx - 6.5) / 2.5));
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.lineJoin = "round";
    for (const n of b.data.nodes) {
      if (n.kind !== "concept" || n.x == null || n.y == null) continue;
      const isFocus = n.id === focus || (h?.type === "link" && (h.link.a === n.id || h.link.b === n.id));
      if (n.sub && !isFocus && n.id !== selectedRef.current) continue; // sub-concepts: label on hover/click only
      const lit = h?.type === "link" ? isFocus : isLit(n.id, focus);
      const alpha = isFocus ? 1 : lit ? fade : fade * 0.12;
      if (alpha <= 0.02) continue;
      const size = isFocus ? Math.max(fs, 12.5 / k) : fs;
      ctx.globalAlpha = alpha;
      ctx.font = `${isFocus ? 650 : 500} ${size}px ${FONT}`;
      const top = n.y + outerRadius(n) + size * 0.42;
      n.lines.forEach((line, i) => {
        const y = top + i * size * 1.16;
        ctx.lineWidth = size * 0.36;
        ctx.strokeStyle = p.page;
        ctx.strokeText(line, n.x!, y);
        ctx.fillStyle = isFocus ? p.ink : p.ink2;
        ctx.fillText(line, n.x!, y);
      });
    }
    ctx.globalAlpha = 1;

    const box = popupRef.current;
    const wrapEl = wrapRef.current;
    const sel = selectedRef.current ? cache.current.get(selectedRef.current) : null;
    if (box && wrapEl && sel && sel.x != null && sel.y != null && fgRef.current) {
      const W = wrapEl.clientWidth;
      const H = wrapEl.clientHeight;
      if (W < 640) {
        box.style.transform = ""; // narrow screens: CSS docks the popup to the bottom
      } else {
        const s = fgRef.current.graph2ScreenCoords(sel.x, sel.y);
        const off = outerRadius(sel) * k + 16;
        const bw = box.offsetWidth;
        const bh = box.offsetHeight;
        let left = s.x + off;
        if (left + bw > W - 10) left = s.x - off - bw;
        left = Math.min(W - bw - 10, Math.max(10, left));
        const topPx = Math.min(H - bh - 10, Math.max(10, s.y - 44));
        box.style.transform = `translate(${Math.round(left)}px, ${Math.round(topPx)}px)`;
      }
      box.style.visibility = "visible";
    }
  }, []);

  // Dev-only hook so automated checks (scripts/screenshots.mjs) can find a node on the canvas.
  useEffect(() => {
    // Also available in a production build when a test sets localStorage "synapse.e2e" = "1".
    let e2e = false;
    try {
      e2e = localStorage.getItem("synapse.e2e") === "1";
    } catch {
      /* storage blocked */
    }
    if (!import.meta.env.DEV && !e2e) return;
    (window as unknown as Record<string, unknown>).__synapseGraph = {
      ids: () => [...cache.current.values()].filter((n) => n.kind === "concept" && !n.sub).map((n) => n.id),
      coords: (id: string) => {
        const n = cache.current.get(id);
        const rect = wrapRef.current?.getBoundingClientRect();
        if (!n || n.x == null || n.y == null || !fgRef.current || !rect) return null;
        const s = fgRef.current.graph2ScreenCoords(n.x, n.y);
        return { x: rect.left + s.x, y: rect.top + s.y };
      },
    };
  }, []);

  const pointer = useRef({ x: 0, y: 0 });
  const placeTip = useCallback(() => {
    const tipEl = tipRef.current;
    const el = wrapRef.current;
    if (!tipEl || !el) return;
    const { x, y } = pointer.current;
    const tw = tipEl.offsetWidth;
    const th = tipEl.offsetHeight;
    const left = Math.min(el.clientWidth - tw - 8, Math.max(8, x + 14));
    const top = y + 18 + th > el.clientHeight ? y - th - 12 : y + 18;
    tipEl.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }, []);
  const onMove = (e: React.MouseEvent) => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    pointer.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    placeTip();
  };
  useLayoutEffect(placeTip, [hover, placeTip]);

  const tip = (() => {
    if (!hover) return null;
    if (hover.type === "node") {
      const n = hover.node;
      if (n.kind === "hub") {
        return (
          <>
            <strong>{n.label}</strong>
            <span>{n.course?.conceptCount ?? 0} concepts</span>
          </>
        );
      }
      if (n.id === selectedId) return null;
      return (
        <>
          <strong>{n.label}</strong>
          <span>
            Retention {pct(n.data!.retention)} · {n.data!.confidence === null ? confidenceText(null) : `Confidence ${confidenceText(n.data!.confidence)}`}
          </span>
          <span className="tip-hint">{n.sub ? "Sub-concept · click for details" : "Click for details"}</span>
        </>
      );
    }
    const l = hover.link;
    return (
      <>
        <strong>{l.kind === "hubhub" ? "These courses connect" : "Cross-course link"}</strong>
        {(l.desc ?? "").split("\n").map((d, i) => (
          <span key={i}>{d}</span>
        ))}
      </>
    );
  })();

  return (
    <div className="graph-wrap" ref={wrapRef} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      {size.w > 0 && size.h > 0 && (
        <ForceGraph2D
          ref={fgRef}
          width={size.w}
          height={size.h}
          graphData={built.data}
          backgroundColor="rgba(0,0,0,0)"
          nodeRelSize={1}
          nodeVal={(n: GNode) => n.r * n.r}
          nodeLabel={() => ""}
          nodeCanvasObjectMode={() => "replace"}
          nodeCanvasObject={paintNode as any}
          nodePointerAreaPaint={paintNodeArea as any}
          linkCanvasObjectMode={() => "replace"}
          linkCanvasObject={paintLink as any}
          linkPointerAreaPaint={paintLinkArea as any}
          linkLabel={() => ""}
          onRenderFramePost={afterFrame}
          autoPauseRedraw={false}
          minZoom={0.35}
          maxZoom={9}
          cooldownTicks={260}
          d3AlphaDecay={0.028}
          d3VelocityDecay={0.38}
          onEngineStop={() => {
            if (needsFit.current) {
              needsFit.current = false;
              fit(450);
            }
          }}
          onNodeHover={(n: any) => setHover(n ? { type: "node", node: n as GNode } : null)}
          onLinkHover={(l: any) => setHover(l ? { type: "link", link: l as GLink } : null)}
          onNodeClick={(n: any) => {
            const g = n as GNode;
            if (g.kind === "concept") onSelect(g.id === selectedRef.current ? null : g.id);
          }}
          onNodeDragEnd={() => {
            needsFit.current = false; // keep the user's framing after they rearrange the map
          }}
          onBackgroundClick={() => onSelect(null)}
        />
      )}
      {tip && (
        <div className="graph-tip" ref={tipRef} role="tooltip">
          {tip}
        </div>
      )}
      {popup && (
        <div className="graph-popup" ref={popupRef} style={{ visibility: "hidden" }}>
          {popup}
        </div>
      )}
    </div>
  );
}
