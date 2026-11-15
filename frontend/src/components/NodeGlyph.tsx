// The node mark from the graph, as an SVG: fill = retention, ring = confidence.
// Used in the legend, the popup and the Guide so the encoding reads the same everywhere.
import { confidenceLevel, type ConfidenceLevel } from "../contracts";
import { usePalette } from "../state/theme";

const RING: Record<ConfidenceLevel, { w: number; dash?: string }> = {
  unassessed: { w: 1.2, dash: "2.6 2.4" },
  low: { w: 1.2 },
  medium: { w: 2.4 },
  high: { w: 3.7 },
};
const GAP = 1.8;

interface Props {
  /** Retention 0-1, or null for a neutral fill (legend swatches). */
  retention: number | null;
  /** Pass a level directly for legend swatches, or a confidence value. */
  confidence?: number | null;
  level?: ConfidenceLevel;
  r?: number;
}

export function NodeGlyph({ retention, confidence = null, level, r = 7 }: Props) {
  const p = usePalette();
  const lv = level ?? confidenceLevel(confidence);
  const ring = RING[lv];
  const half = r + GAP + RING.high.w + 0.5;
  return (
    <svg className="glyph" width={half * 2} height={half * 2} viewBox={`${-half} ${-half} ${half * 2} ${half * 2}`} aria-hidden="true">
      <circle r={r} fill={retention === null ? p.edge : p.retention(retention)} />
      <circle
        r={r + GAP + ring.w / 2}
        fill="none"
        stroke={lv === "unassessed" ? p.ink2 : p.ink}
        strokeWidth={ring.w}
        strokeDasharray={ring.dash}
      />
    </svg>
  );
}
