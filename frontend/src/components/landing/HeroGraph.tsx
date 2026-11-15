// The landing page's live graph. Concepts drift, fade from green to red along a forgetting
// curve while you watch, and clicking one reviews it: it turns green again and, as in the app,
// fades more slowly next time. Hovering a concept shows what Synapse knows about it.
// Colors come from the active palette, so it follows light and dark mode. With
// prefers-reduced-motion nothing drifts or fades on its own, but hover and click still work.
import { useEffect, useRef, useState } from "react";
import type { ConfidenceLevel } from "../../contracts";
import { usePalette, type Palette } from "../../state/theme";

interface Spec {
  label: string;
  hub: 0 | 1;
  level: ConfidenceLevel;
  r: number;
  stab: number; // days
  age0: number; // days since last review at the start
  ang: number; // degrees around the hub
  dist: number; // 1 = one orbit unit from the hub
  parent?: number; // index of the concept this one is a sub-concept of
}

const SPECS: Spec[] = [
  // hub 0: Algorithms (generic demo course — no real course codes)
  { label: "State-Space Search", hub: 0, level: "high", r: 10, stab: 9, age0: 1.5, ang: 200, dist: 1.0 },
  { label: "A* Search", hub: 0, level: "medium", r: 9, stab: 5, age0: 5, ang: 245, dist: 1.25 },
  { label: "Minimax", hub: 0, level: "medium", r: 8, stab: 5, age0: 9, ang: 300, dist: 1.05 },
  { label: "Alpha-Beta Pruning", hub: 0, level: "low", r: 7, stab: 3.2, age0: 8, ang: 340, dist: 1.4 },
  { label: "Markov Decision Processes", hub: 0, level: "low", r: 9, stab: 7, age0: 0.8, ang: 20, dist: 1.15 },
  { label: "Q-Learning", hub: 0, level: "medium", r: 7, stab: 4, age0: 6.5, ang: 70, dist: 1.3 },
  { label: "Bayes' Rule", hub: 0, level: "high", r: 9, stab: 14, age0: 3, ang: 125, dist: 1.1 },
  { label: "Constraint Satisfaction", hub: 0, level: "unassessed", r: 8, stab: 4, age0: 7.5, ang: 160, dist: 1.4 },
  // hub 1: Machine Learning
  { label: "Linear Regression", hub: 1, level: "high", r: 10, stab: 12, age0: 2, ang: 340, dist: 1.0 },
  { label: "Gradient Descent", hub: 1, level: "medium", r: 11, stab: 6, age0: 2.4, ang: 20, dist: 1.2 },
  { label: "Logistic Regression", hub: 1, level: "medium", r: 8, stab: 6, age0: 6, ang: 75, dist: 1.1 },
  { label: "Overfitting", hub: 1, level: "low", r: 8, stab: 5, age0: 9.5, ang: 115, dist: 1.3 },
  { label: "Cross-Validation", hub: 1, level: "unassessed", r: 7, stab: 3, age0: 8.5, ang: 160, dist: 1.05 },
  { label: "Naive Bayes", hub: 1, level: "high", r: 8, stab: 9, age0: 4, ang: 205, dist: 1.25 },
  { label: "Neural Networks", hub: 1, level: "low", r: 10, stab: 4, age0: 0.4, ang: 250, dist: 1.1 },
  { label: "Decision Trees", hub: 1, level: "medium", r: 7, stab: 6, age0: 5.5, ang: 295, dist: 1.35 },
  // sub-concepts (small, unlabeled until hovered)
  { label: "Admissible Heuristics", hub: 0, level: "unassessed", r: 4.5, stab: 3, age0: 6, ang: 235, dist: 0.5, parent: 1 },
  { label: "Policy Iteration", hub: 0, level: "low", r: 4.5, stab: 4, age0: 3, ang: 35, dist: 0.5, parent: 4 },
  { label: "Value Iteration", hub: 0, level: "unassessed", r: 4, stab: 3, age0: 8, ang: 0, dist: 0.5, parent: 4 },
  { label: "Backpropagation", hub: 1, level: "unassessed", r: 5, stab: 2.6, age0: 4.2, ang: 270, dist: 0.5, parent: 14 },
  { label: "Regularization", hub: 1, level: "low", r: 4.5, stab: 4, age0: 7, ang: 100, dist: 0.5, parent: 11 },
  { label: "Gini Impurity", hub: 1, level: "unassessed", r: 4, stab: 3, age0: 6.5, ang: 320, dist: 0.5, parent: 15 },
];

// Pairs of concepts that depend on each other, and ideas shared across the two courses.
const PREREQS: [number, number][] = [[0, 1], [0, 2], [2, 3], [4, 5], [6, 4], [8, 9], [9, 10], [10, 14], [8, 11]];
const CROSS: [number, number][] = [[5, 9], [6, 13], [6, 10]];
const HUB_LABELS = ["Algorithms", "Machine Learning"];
const FONT = '"Geist Sans", Geist, system-ui, sans-serif';
const KEYBOARD_NODES = SPECS.map((_, i) => i).filter((i) => SPECS[i].parent === undefined);

const RING: Record<ConfidenceLevel, { w: number; dash: number[] }> = {
  unassessed: { w: 1.2, dash: [2.6, 2.4] },
  low: { w: 1.2, dash: [] },
  medium: { w: 2.4, dash: [] },
  high: { w: 3.7, dash: [] },
};
const LEVEL_TEXT: Record<ConfidenceLevel, string> = {
  unassessed: "not quizzed yet",
  low: "low confidence",
  medium: "medium confidence",
  high: "high confidence",
};
const GAP = 1.8;
const DAYS_PER_SECOND = 0.2; // how fast simulated time runs
const START_AGE = 0.4; // share of each concept's listed age it starts with, so the scene opens mostly green
const AUTO_REVIEW_BELOW = 0.18; // keeps the scene alive when nobody interacts

interface Runtime {
  spec: Spec;
  x: number;
  y: number;
  vx: number;
  vy: number;
  hx: number;
  hy: number;
  age: number;
  stab: number;
  phase: number;
  freq: number;
  amp: number;
  reviewed: boolean;
}
interface Ripple {
  x: number;
  y: number;
  t0: number;
  color: string;
}

function rng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const retentionOf = (n: Runtime) => Math.exp(-n.age / n.stab);

export function HeroGraph() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const palette = usePalette();
  const paletteRef = useRef<Palette>(palette);
  paletteRef.current = palette;
  const stats = useRef({ fading: 0, reviewed: 0 });
  const [hud, setHud] = useState({ fading: 0, reviewed: 0 });

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const rand = rng(471475);
    const nodes: Runtime[] = SPECS.map((spec) => ({
      spec,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      hx: 0,
      hy: 0,
      age: spec.age0 * START_AGE,
      stab: spec.stab * 1.4,
      phase: rand() * Math.PI * 2,
      freq: 0.25 + rand() * 0.35,
      amp: spec.parent !== undefined ? 3 : 5 + rand() * 4,
      reviewed: false,
    }));
    const hubs = [{ x: 0, y: 0 }, { x: 0, y: 0 }];
    const ripples: Ripple[] = [];
    let w = 0;
    let h = 0;
    let scale = 1;
    let dpr = 1;
    let pointer: { x: number; y: number } | null = null;
    let hover = -1;
    let t = 0;
    let last = performance.now();
    let visible = true;
    let raf = 0;
    let placed = false;

    const layout = () => {
      const unit = Math.min(w * 0.17, h * 0.37);
      hubs[0] = { x: w * 0.26, y: h * 0.53 };
      hubs[1] = { x: w * 0.74, y: h * 0.49 };
      const place = (n: Runtime) => {
        const base = n.spec.parent !== undefined ? nodes[n.spec.parent] : null;
        const origin = base ? { x: base.hx, y: base.hy } : hubs[n.spec.hub];
        const a = (n.spec.ang * Math.PI) / 180;
        n.hx = origin.x + Math.cos(a) * n.spec.dist * unit;
        n.hy = origin.y + Math.sin(a) * n.spec.dist * unit * 0.92;
        // keep everything inside the frame
        const padX = n.spec.parent !== undefined ? 22 : 58 * scale;
        n.hx = Math.min(w - padX, Math.max(padX, n.hx));
        n.hy = Math.min(h - 40 * scale, Math.max(26, n.hy));
      };
      nodes.filter((n) => n.spec.parent === undefined).forEach(place);
      nodes.filter((n) => n.spec.parent !== undefined).forEach(place);
      if (!placed) {
        nodes.forEach((n) => {
          n.x = n.hx;
          n.y = n.hy;
        });
        placed = true;
      }
    };

    const resize = () => {
      const rect = wrap.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = Math.max(280, rect.width);
      h = Math.max(300, Math.min(440, rect.width * 0.72));
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      scale = Math.min(1.25, Math.max(0.72, w / 520));
      layout();
    };

    const nodeRadius = (n: Runtime, i: number) => n.spec.r * scale * (i === hover ? 1.22 : 1);

    const review = (i: number) => {
      const n = nodes[i];
      n.age = 0;
      n.stab = Math.min(40, n.stab * 1.55); // the spacing effect: it will fade more slowly next time
      n.reviewed = true;
      stats.current.reviewed += 1;
      ripples.push({ x: n.x, y: n.y, t0: t, color: paletteRef.current.retention(1) });
    };

    const hit = (x: number, y: number): number => {
      let best = -1;
      let bestD = Infinity;
      nodes.forEach((n, i) => {
        const d = Math.hypot(n.x - x, n.y - y);
        const reach = nodeRadius(n, i) + RING.high.w + GAP + 7;
        if (d < reach && d < bestD) {
          best = i;
          bestD = d;
        }
      });
      return best;
    };

    const step = (dt: number) => {
      t += dt;
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        if (!reduce) {
          n.age += dt * DAYS_PER_SECOND;
          if (retentionOf(n) < AUTO_REVIEW_BELOW) {
            n.age = 0;
            ripples.push({ x: n.x, y: n.y, t0: t, color: paletteRef.current.retention(0.2) });
          }
          const tx = n.hx + Math.sin(t * n.freq + n.phase) * n.amp;
          const ty = n.hy + Math.cos(t * n.freq * 0.83 + n.phase * 1.7) * n.amp;
          n.vx += (tx - n.x) * 0.06;
          n.vy += (ty - n.y) * 0.06;
        } else {
          n.vx += (n.hx - n.x) * 0.1;
          n.vy += (n.hy - n.y) * 0.1;
        }
        if (pointer) {
          const dx = n.x - pointer.x;
          const dy = n.y - pointer.y;
          const d = Math.hypot(dx, dy);
          const range = 70 * scale;
          if (d > 0.01 && d < range && i !== hover) {
            const push = ((range - d) / range) * 1.3;
            n.vx += (dx / d) * push;
            n.vy += (dy / d) * push;
          }
        }
        n.vx *= 0.82;
        n.vy *= 0.82;
        n.x += n.vx;
        n.y += n.vy;
      }
      for (let i = ripples.length - 1; i >= 0; i--) if (t - ripples[i].t0 > 0.9) ripples.splice(i, 1);
    };

    const roundRect = (x: number, y: number, rw: number, rh: number, r: number) => {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + rw, y, x + rw, y + rh, r);
      ctx.arcTo(x + rw, y + rh, x, y + rh, r);
      ctx.arcTo(x, y + rh, x, y, r);
      ctx.arcTo(x, y, x + rw, y, r);
      ctx.closePath();
    };

    const draw = () => {
      const p = paletteRef.current;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      // hub-to-hub band: the courses are linked
      ctx.save();
      ctx.globalAlpha = 0.12;
      ctx.strokeStyle = p.ink2;
      ctx.lineWidth = 6 * scale;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(hubs[0].x, hubs[0].y);
      ctx.lineTo(hubs[1].x, hubs[1].y);
      ctx.stroke();
      ctx.restore();

      // spokes and prerequisite lines
      ctx.lineWidth = 1;
      ctx.strokeStyle = p.edge;
      ctx.globalAlpha = hover >= 0 ? 0.55 : 0.9;
      ctx.beginPath();
      nodes.forEach((n) => {
        const from = n.spec.parent !== undefined ? nodes[n.spec.parent] : hubs[n.spec.hub];
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(n.x, n.y);
      });
      PREREQS.forEach(([a, b]) => {
        ctx.moveTo(nodes[a].x, nodes[a].y);
        ctx.lineTo(nodes[b].x, nodes[b].y);
      });
      ctx.stroke();
      ctx.globalAlpha = 1;

      // cross-course links (static dashes — no looping motion)
      ctx.strokeStyle = p.ink2;
      ctx.lineWidth = 1.4;
      ctx.setLineDash([5, 4.5]);
      ctx.lineDashOffset = 0;
      CROSS.forEach(([a, b]) => {
        const A = nodes[a];
        const B = nodes[b];
        const mx = (A.x + B.x) / 2;
        const my = (A.y + B.y) / 2 - 26 * scale;
        ctx.beginPath();
        ctx.moveTo(A.x, A.y);
        ctx.quadraticCurveTo(mx, my, B.x, B.y);
        ctx.stroke();
      });
      ctx.setLineDash([]);

      // hubs
      hubs.forEach((hb, i) => {
        const r = 27 * scale;
        ctx.beginPath();
        ctx.arc(hb.x, hb.y, r, 0, Math.PI * 2);
        ctx.fillStyle = p.hubFill;
        ctx.fill();
        ctx.lineWidth = 1.2;
        ctx.strokeStyle = p.hubStroke;
        ctx.stroke();
        ctx.fillStyle = p.hubText;
        ctx.font = `600 ${Math.round(10.5 * scale)}px ${FONT}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const hubLabel = HUB_LABELS[i];
        if (hubLabel.includes(" ")) {
          const [a, b] = hubLabel.split(" ");
          ctx.fillText(a, hb.x, hb.y - 5 * scale);
          ctx.fillText(b, hb.x, hb.y + 7 * scale);
        } else {
          ctx.fillText(hubLabel, hb.x, hb.y + 1);
        }
      });

      // ripples from reviews
      ripples.forEach((rp) => {
        const k = (t - rp.t0) / 0.9;
        ctx.beginPath();
        ctx.arc(rp.x, rp.y, 10 + k * 54 * scale, 0, Math.PI * 2);
        ctx.strokeStyle = rp.color;
        ctx.globalAlpha = Math.max(0, 0.7 * (1 - k));
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.globalAlpha = 1;
      });

      // concept nodes
      let fading = 0;
      const order = nodes.map((_, i) => i).sort((a, b) => (a === hover ? 1 : b === hover ? -1 : 0));
      for (const i of order) {
        const n = nodes[i];
        const r = nodeRadius(n, i);
        const ret = retentionOf(n);
        if (ret < 0.5) fading += 1;
        const ring = RING[n.spec.level];
        const dim = hover >= 0 && i !== hover ? 0.55 : 1;
        ctx.globalAlpha = dim;
        if (ret < 0.3 && !reduce) {
          // a gentle pulse on concepts that need another look
          const pulse = (Math.sin(t * 3 + n.phase) + 1) / 2;
          ctx.beginPath();
          ctx.arc(n.x, n.y, r + GAP + ring.w + 4 + pulse * 4, 0, Math.PI * 2);
          ctx.strokeStyle = p.retention(0);
          ctx.globalAlpha = dim * (0.18 + pulse * 0.22);
          ctx.lineWidth = 1.5;
          ctx.stroke();
          ctx.globalAlpha = dim;
        }
        ctx.beginPath();
        ctx.arc(n.x, n.y, r + GAP + ring.w + 0.8, 0, Math.PI * 2);
        ctx.fillStyle = p.page;
        ctx.fill();
        ctx.beginPath();
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        ctx.fillStyle = p.retention(ret);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(n.x, n.y, r + GAP + ring.w / 2, 0, Math.PI * 2);
        ctx.strokeStyle = n.spec.level === "unassessed" ? p.ink2 : p.ink;
        ctx.lineWidth = ring.w;
        ctx.setLineDash(ring.dash);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
        if (n.spec.parent === undefined && n.spec.r >= 7.5) {
          ctx.fillStyle = p.ink2;
          ctx.globalAlpha = dim;
          ctx.font = `500 ${Math.round(10.5 * scale)}px ${FONT}`;
          ctx.textAlign = "center";
          ctx.textBaseline = "top";
          const label = n.spec.label.length > 16 ? `${n.spec.label.slice(0, 15)}…` : n.spec.label;
          ctx.fillText(label, n.x, n.y + r + GAP + ring.w + 4);
          ctx.globalAlpha = 1;
        }
      }
      stats.current.fading = fading;

      // tooltip for the hovered / keyboard-focused concept
      if (hover >= 0) {
        const n = nodes[hover];
        const ret = retentionOf(n);
        const lines = [n.spec.label, `${Math.round(ret * 100)}% remembered · ${LEVEL_TEXT[n.spec.level]}`, ret < 0.5 ? "Fading. Enter to review" : "Enter to review"];
        ctx.font = `600 ${Math.round(12 * scale)}px ${FONT}`;
        const w1 = ctx.measureText(lines[0]).width;
        ctx.font = `400 ${Math.round(11 * scale)}px ${FONT}`;
        const w2 = Math.max(ctx.measureText(lines[1]).width, ctx.measureText(lines[2]).width);
        const bw = Math.max(w1, w2) + 20;
        const bh = 58 * scale;
        let bx = n.x + 16;
        let by = n.y - bh - 12;
        if (bx + bw > w - 6) bx = n.x - bw - 16;
        if (by < 6) by = n.y + 16;
        roundRect(bx, by, bw, bh, 8);
        ctx.fillStyle = p.surface;
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = p.edge;
        roundRect(bx, by, bw, bh, 8);
        ctx.stroke();
        ctx.textAlign = "left";
        ctx.textBaseline = "alphabetic";
        ctx.fillStyle = p.ink;
        ctx.font = `600 ${Math.round(12 * scale)}px ${FONT}`;
        ctx.fillText(lines[0], bx + 10, by + 18 * scale);
        ctx.fillStyle = p.ink2;
        ctx.font = `400 ${Math.round(11 * scale)}px ${FONT}`;
        ctx.fillText(lines[1], bx + 10, by + 33 * scale);
        ctx.fillStyle = p.ink;
        ctx.fillText(lines[2], bx + 10, by + 48 * scale);
        // a small color chip for the retention
        ctx.beginPath();
        ctx.arc(bx + bw - 14, by + 14, 5, 0, Math.PI * 2);
        ctx.fillStyle = p.retention(ret);
        ctx.fill();
      }
    };

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (!visible || document.hidden) return;
      step(dt);
      draw();
    };

    const local = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };
    const onMove = (e: PointerEvent) => {
      pointer = local(e);
      hover = hit(pointer.x, pointer.y);
      canvas.style.cursor = hover >= 0 ? "pointer" : "default";
    };
    const onLeave = () => {
      pointer = null;
      hover = -1;
      canvas.style.cursor = "default";
    };
    const onDown = (e: PointerEvent) => {
      pointer = local(e);
      const i = hit(pointer.x, pointer.y);
      hover = i;
      if (i >= 0) review(i);
    };
    const onKey = (e: KeyboardEvent) => {
      const idx = hover >= 0 ? KEYBOARD_NODES.indexOf(hover) : -1;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        const next = idx < 0 ? 0 : (idx + 1) % KEYBOARD_NODES.length;
        hover = KEYBOARD_NODES[next];
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        const next = idx < 0 ? 0 : (idx - 1 + KEYBOARD_NODES.length) % KEYBOARD_NODES.length;
        hover = KEYBOARD_NODES[next];
      } else if ((e.key === "Enter" || e.key === " ") && hover >= 0) {
        e.preventDefault();
        review(hover);
      } else if (e.key === "Escape") {
        hover = -1;
      }
    };

    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    const io = new IntersectionObserver((entries) => {
      visible = entries.some((e) => e.isIntersecting);
    });
    io.observe(wrap);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerleave", onLeave);
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("keydown", onKey);
    raf = requestAnimationFrame(frame);
    const hudTimer = window.setInterval(() => setHud({ ...stats.current }), 250);

    return () => {
      cancelAnimationFrame(raf);
      window.clearInterval(hudTimer);
      ro.disconnect();
      io.disconnect();
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("keydown", onKey);
    };
  }, []);

  return (
    <figure className="hero-graph">
      <div className="hero-graph-hud" aria-hidden="true">
        <span className="hud-pill">
          <i className="hud-dot hud-dot-bad" /> {hud.fading} fading
        </span>
        <span className="hud-pill">
          <i className="hud-dot hud-dot-good" /> {hud.reviewed} reviewed by you
        </span>
      </div>
      <div className="hero-graph-legend" aria-hidden="true">
        <span>
          <i className="legend-swatch" /> Colour: retention (red fading → green fresh)
        </span>
        <span>
          <i className="legend-ring" /> Ring: quiz confidence
        </span>
      </div>
      <div ref={wrapRef} className="hero-graph-canvas">
        <canvas
          ref={canvasRef}
          tabIndex={0}
          role="application"
          aria-label="Interactive concept map with Algorithms and Machine Learning hubs. Nodes fade from green to red as retention drops; outline thickness shows quiz confidence. Use arrow keys to move between concepts, Enter to review, or click a node."
        />
      </div>
      <figcaption>
        <span className="hero-graph-hint">Hover or arrow-key a concept. Click or press Enter to review it before it fades.</span>
      </figcaption>
    </figure>
  );
}
