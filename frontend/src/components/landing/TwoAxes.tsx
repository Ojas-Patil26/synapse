// "Two signals, one node": a node you can play with. The fill is how well you still remember
// the concept; the ring is how well you understood it. The two are independent.
import { useState } from "react";
import type { ConfidenceLevel } from "../../contracts";
import { usePalette } from "../../state/theme";

const LEVELS: { level: ConfidenceLevel; label: string }[] = [
  { level: "unassessed", label: "Not tested" },
  { level: "low", label: "Low" },
  { level: "medium", label: "Medium" },
  { level: "high", label: "High" },
];
const RING: Record<ConfidenceLevel, { w: number; dash?: string }> = {
  unassessed: { w: 1.2, dash: "3 3" },
  low: { w: 1.2 },
  medium: { w: 3 },
  high: { w: 5 },
};
const PRESETS: { name: string; retention: number; level: ConfidenceLevel }[] = [
  { name: "Just crammed", retention: 96, level: "low" },
  { name: "Faded, but understood", retention: 22, level: "high" },
  { name: "Never tested", retention: 55, level: "unassessed" },
  { name: "Solid", retention: 92, level: "high" },
];

function verdict(retention: number, level: ConfidenceLevel): { title: string; body: string } {
  const fresh = retention >= 50;
  if (level === "unassessed") {
    return fresh
      ? { title: "Fresh, but unproven", body: "You saw it recently, but no quiz has measured whether you understood it. Take a short quiz." }
      : { title: "Fading and never tested", body: "It is slipping and you have not checked your understanding yet. Start with the key points, then quiz yourself." };
  }
  if (fresh && (level === "high" || level === "medium"))
    return { title: "Remembered and understood", body: "Nothing to do here. Synapse will tell you when it starts to slip." };
  if (fresh) return { title: "Remembered, not understood", body: "It is fresh in your mind, but the quiz says it has not clicked. Re-read the explanation instead of just rereading notes." };
  if (level === "high" || level === "medium") return { title: "Understood, but fading", body: "You grasped it once. A quick review should bring it right back." };
  return { title: "Fading and shaky", body: "This is the top priority: it is both slipping and not well understood." };
}

export function TwoAxes() {
  const p = usePalette();
  const [retention, setRetention] = useState(88);
  const [level, setLevel] = useState<ConfidenceLevel>("low");
  const ring = RING[level];
  const fill = p.retention(retention / 100);
  const v = verdict(retention, level);
  const R = 46;
  const gap = 8;

  return (
    <div className="axes-card">
      <div className="axes-stage">
        <svg viewBox="-110 -110 220 220" className="axes-node" role="img" aria-label={`A concept node, ${retention} percent remembered, ${level === "unassessed" ? "never tested" : `${level} confidence`}`}>
          <circle r={R + gap + 7} fill={p.page} />
          <circle r={R} style={{ fill, transition: "fill .35s ease" }} />
          <circle
            r={R + gap + ring.w / 2}
            fill="none"
            style={{
              stroke: level === "unassessed" ? p.ink2 : p.ink,
              strokeWidth: ring.w,
              strokeDasharray: ring.dash ?? "0",
              transition: "stroke-width .35s ease, stroke .35s ease, stroke-dasharray .35s ease",
            }}
          />
          <text y="6" textAnchor="middle" fontSize="24" fontWeight="700" style={{ fill: retention > 38 && retention < 72 ? p.ink : p.page, transition: "fill .35s" }}>
            {retention}%
          </text>
        </svg>
        <div className="axes-callouts" aria-hidden="true">
          <span className="axes-callout axes-callout-fill">
            <i /> Fill: how well you still remember it
          </span>
          <span className="axes-callout axes-callout-ring">
            <i /> Ring: how well you understood it
          </span>
        </div>
      </div>

      <div className="axes-controls">
        <label className="axes-field">
          <span>
            Remembered <strong>{retention}%</strong>
          </span>
          <input type="range" min={0} max={100} value={retention} onChange={(e) => setRetention(Number(e.target.value))} aria-label="How much you still remember" />
          <span className="axes-scale" aria-hidden="true">
            <em style={{ background: `linear-gradient(to right, ${p.retention(0)}, ${p.retention(0.5)}, ${p.retention(1)})` }} />
          </span>
        </label>

        <div className="axes-field" role="group" aria-label="How well you understood it">
          <span>Understood</span>
          <div className="seg">
            {LEVELS.map((l) => (
              <button key={l.level} type="button" className={`seg-btn${level === l.level ? " is-on" : ""}`} aria-pressed={level === l.level} onClick={() => setLevel(l.level)}>
                {l.label}
              </button>
            ))}
          </div>
        </div>

        <div className="axes-verdict" aria-live="polite">
          <strong>{v.title}</strong>
          <p>{v.body}</p>
        </div>

        <div className="chips" role="group" aria-label="Try an example">
          {PRESETS.map((x) => (
            <button
              key={x.name}
              type="button"
              className={`chip${retention === x.retention && level === x.level ? " is-on" : ""}`}
              onClick={() => {
                setRetention(x.retention);
                setLevel(x.level);
              }}
            >
              {x.name}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

