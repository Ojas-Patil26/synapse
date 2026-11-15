// An interactive forgetting curve. Drag the day (or press play), review at any moment, and
// watch the curve reset and flatten: the spacing effect. Same math as the app: R = e^(-t/S),
// and a review sets S = S * (1 + 1 * (2 - R_before)) starting from S0 = 2 days.
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { FORGET_THRESHOLD, S0, S_MAX } from "../../contracts";
import { usePalette } from "../../state/theme";

const DAYS = 30;
const W = 620;
const H = 290;
const M = { l: 46, r: 18, t: 16, b: 38 };
const px = (d: number) => M.l + (d / DAYS) * (W - M.l - M.r);
const py = (r: number) => M.t + (1 - r) * (H - M.t - M.b);

interface Segment {
  start: number;
  stab: number;
}

function segmentsFor(reviews: number[]): Segment[] {
  const out: Segment[] = [];
  let stab = S0;
  reviews.forEach((day, i) => {
    if (i > 0) {
      const prev = out[i - 1];
      const before = Math.exp(-(day - prev.start) / prev.stab);
      stab = Math.min(S_MAX, stab * (1 + (2 - before)));
    }
    out.push({ start: day, stab });
  });
  return out;
}

function retentionAtDay(segments: Segment[], day: number): number {
  let seg = segments[0];
  for (const s of segments) if (s.start <= day) seg = s;
  return Math.exp(-(day - seg.start) / seg.stab);
}

function status(r: number): { title: string; body: string } {
  if (r >= 0.8) return { title: "Fresh", body: "You still remember almost all of it." };
  if (r >= FORGET_THRESHOLD) return { title: "Fading", body: "It is slipping, but a quick review will hold it." };
  return { title: "Below the line", body: "This is the moment Synapse flags a concept for review." };
}

export function ForgettingCurve() {
  const p = usePalette();
  const [day, setDay] = useState(0.3);
  const [reviews, setReviews] = useState<number[]>([0]);
  const [playing, setPlaying] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);
  const dragging = useRef(false);
  const reduce = useMemo(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches, []);

  const segments = useMemo(() => segmentsFor(reviews), [reviews]);
  const current = retentionAtDay(segments, day);
  const last = segments[segments.length - 1];
  const nextReview = last.start + last.stab * Math.log(1 / FORGET_THRESHOLD);
  const s = status(current);

  // The curve and its shaded area, one closed shape per segment: each decays, a review jumps back to 100%.
  const { path, area } = useMemo(() => {
    let line = "";
    let fill = "";
    segments.forEach((seg, i) => {
      const end = i + 1 < segments.length ? segments[i + 1].start : DAYS;
      let d = `M${px(seg.start).toFixed(1)} ${py(1).toFixed(1)}`;
      for (let x = seg.start + 0.25; x < end; x += 0.25) d += ` L${px(x).toFixed(1)} ${py(Math.exp(-(x - seg.start) / seg.stab)).toFixed(1)}`;
      d += ` L${px(end).toFixed(1)} ${py(Math.exp(-(end - seg.start) / seg.stab)).toFixed(1)}`;
      line += d;
      fill += `${d} L${px(end).toFixed(1)} ${py(0).toFixed(1)} L${px(seg.start).toFixed(1)} ${py(0).toFixed(1)} Z `;
    });
    return { path: line, area: fill };
  }, [segments]);

  // play: days advance on their own
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let prev = performance.now();
    const tick = (now: number) => {
      const dt = (now - prev) / 1000;
      prev = now;
      setDay((d) => {
        const next = d + dt * 3;
        if (next >= DAYS) {
          setPlaying(false);
          return DAYS;
        }
        return next;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const setFromPointer = useCallback((e: ReactPointerEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * W;
    setDay(Math.min(DAYS, Math.max(0, ((x - M.l) / (W - M.l - M.r)) * DAYS)));
  }, []);

  const reviewNow = () => {
    setPlaying(false);
    setReviews((rs) => [...rs.filter((x) => x < day - 0.05), day]);
  };
  const reset = () => {
    setPlaying(false);
    setReviews([0]);
    setDay(0.3);
  };

  const dot = p.retention(current);
  const zoneTop = py(FORGET_THRESHOLD);

  return (
    <div className="curve-card">
      <div className="curve-chart">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          className="curve-svg"
          role="img"
          aria-label={`Forgetting curve. On day ${Math.round(day)} retention is ${Math.round(current * 100)} percent after ${reviews.length - 1} reviews.`}
          onPointerDown={(e) => {
            dragging.current = true;
            (e.currentTarget as Element).setPointerCapture(e.pointerId);
            setPlaying(false);
            setFromPointer(e);
          }}
          onPointerMove={(e) => dragging.current && setFromPointer(e)}
          onPointerUp={() => (dragging.current = false)}
          onPointerCancel={() => (dragging.current = false)}
        >
          <defs>
            <linearGradient id="curveFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={p.retention(1)} stopOpacity="0.26" />
              <stop offset="55%" stopColor={p.retention(0.5)} stopOpacity="0.12" />
              <stop offset="100%" stopColor={p.retention(0)} stopOpacity="0.1" />
            </linearGradient>
          </defs>
          {/* the zone below the forgetting line */}
          <rect x={M.l} y={zoneTop} width={W - M.l - M.r} height={py(0) - zoneTop} fill={p.retention(0)} opacity="0.07" />
          {[0, 0.25, 0.5, 0.75, 1].map((v) => (
            <g key={v}>
              <line x1={M.l} x2={W - M.r} y1={py(v)} y2={py(v)} stroke={p.edge} strokeOpacity={v === FORGET_THRESHOLD ? 0 : 0.5} strokeWidth="1" />
              <text x={M.l - 8} y={py(v) + 4} textAnchor="end" fontSize="11" fill={p.muted}>
                {Math.round(v * 100)}%
              </text>
            </g>
          ))}
          <line x1={M.l} x2={W - M.r} y1={zoneTop} y2={zoneTop} stroke={p.retention(0)} strokeWidth="1.4" strokeDasharray="5 4" />
          <text x={W - M.r - 4} y={zoneTop - 6} textAnchor="end" fontSize="11" fontWeight="600" fill={p.retention(0)}>
            forgotten below here
          </text>
          {[0, 5, 10, 15, 20, 25, 30].map((d) => (
            <text key={d} x={px(d)} y={H - 14} textAnchor="middle" fontSize="11" fill={p.muted}>
              {d === 0 ? "day 0" : d}
            </text>
          ))}
          {/* area under the curve up to today */}
          <path d={area} fill="url(#curveFill)" stroke="none" opacity="0.9" />
          <path d={path} fill="none" stroke={p.accent} strokeWidth="2.4" strokeLinejoin="round" strokeLinecap="round" />
          {/* review markers */}
          {reviews.map((d, i) => (
            <g key={`${d}-${i}`}>
              <line x1={px(d)} x2={px(d)} y1={py(1)} y2={py(0)} stroke={p.accent} strokeOpacity="0.28" strokeDasharray="2 4" />
              <circle cx={px(d)} cy={py(1)} r="4.5" fill={p.page} stroke={p.accent} strokeWidth="2" />
            </g>
          ))}
          {/* suggested next review */}
          {nextReview <= DAYS && (
            <g>
              <line x1={px(nextReview)} x2={px(nextReview)} y1={zoneTop} y2={py(0)} stroke={p.ink2} strokeOpacity="0.5" strokeDasharray="3 3" />
              <text x={px(nextReview) + (nextReview > 22 ? -6 : 6)} y={py(0) - 8} textAnchor={nextReview > 22 ? "end" : "start"} fontSize="10.5" fill={p.ink2}>
                review by day {nextReview < 10 ? nextReview.toFixed(1) : Math.round(nextReview)}
              </text>
            </g>
          )}
          {/* today */}
          <line x1={px(day)} x2={px(day)} y1={M.t} y2={py(0)} stroke={p.ink} strokeOpacity="0.5" strokeWidth="1.2" />
          <circle cx={px(day)} cy={py(current)} r="9" fill={dot} stroke={p.ink} strokeWidth="2" style={reduce ? undefined : { transition: "fill .2s" }} />
        </svg>
      </div>

      <div className="curve-side">
        <div className="curve-readout" aria-live="polite">
          <span className="curve-pct" style={{ color: dot }}>
            {Math.round(current * 100)}%
          </span>
          <div>
            <strong>
              {s.title} · day {Math.round(day)}
            </strong>
            <p>{s.body}</p>
          </div>
        </div>

        <label className="curve-slider">
          <span>Day {Math.round(day)}</span>
          <input
            type="range"
            min={0}
            max={DAYS}
            step={0.1}
            value={day}
            onChange={(e) => {
              setPlaying(false);
              setDay(Number(e.target.value));
            }}
            aria-label="Days since the first study session"
          />
        </label>

        <div className="curve-actions">
          <button type="button" className="btn btn-primary btn-small" onClick={reviewNow}>
            Review now
          </button>
          <button
            type="button"
            className="btn btn-small"
            onClick={() => {
              if (playing) setPlaying(false);
              else {
                if (day >= DAYS) setDay(0);
                setPlaying(true);
              }
            }}
          >
            {playing ? "Pause" : day >= DAYS ? "Replay" : "Play"}
          </button>
          <button type="button" className="btn btn-small btn-quiet" onClick={reset} disabled={reviews.length === 1 && day <= 0.35}>
            Reset
          </button>
        </div>
        <p className="curve-note">
          {reviews.length === 1
            ? "Press Review now when the curve nears the line. Every review resets it, and the next fade is slower."
            : `${reviews.length - 1} ${reviews.length === 2 ? "review" : "reviews"} so far. The memory now holds for about ${Math.round(last.stab)} days before dropping to 50%.`}
        </p>
      </div>
    </div>
  );
}
