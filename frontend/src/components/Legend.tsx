import { useState } from "react";
import { NodeGlyph } from "./NodeGlyph";

/** Compact key for the map: retention gradient, the four confidence outlines, link styles, size. */
export function Legend({ showCross }: { showCross: boolean }) {
  const [open, setOpen] = useState(() => typeof window === "undefined" || window.innerWidth >= 720);
  return (
    <aside className="legend" aria-label="Map legend">
      <button className="legend-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open} title={open ? "Hide legend" : "Show legend"}>
        Legend <span aria-hidden="true">{open ? "–" : "+"}</span>
      </button>
      {open && (
        <div className="legend-body">
          <div className="legend-group">
            <div className="legend-title">Fill: retention</div>
            <div className="ret-bar" role="img" aria-label="Retention scale from 0 percent, red, to 100 percent, green" />
            <div className="ret-scale">
              <span>0%</span>
              <span>50%</span>
              <span>100%</span>
            </div>
          </div>
          <div className="legend-group">
            <div className="legend-title">Outline: confidence</div>
            <div className="legend-rings">
              <span><NodeGlyph retention={null} level="unassessed" r={6} /> Not assessed</span>
              <span><NodeGlyph retention={null} level="low" r={6} /> Low</span>
              <span><NodeGlyph retention={null} level="medium" r={6} /> Medium</span>
              <span><NodeGlyph retention={null} level="high" r={6} /> High</span>
            </div>
          </div>
          <div className="legend-group">
            <div className="legend-title">Links</div>
            <div className="legend-links">
              <span>
                <svg width="30" height="10" viewBox="0 0 30 10" aria-hidden="true">
                  <line x1="1" y1="5" x2="22" y2="5" className="lk lk-strong" />
                  <path d="M29 5 21 1.6 21 8.4Z" className="lk-arrow" />
                </svg>
                Prerequisite
              </span>
              <span>
                <svg width="30" height="10" viewBox="0 0 30 10" aria-hidden="true">
                  <line x1="1" y1="5" x2="29" y2="5" className="lk lk-dotted" />
                </svg>
                Related
              </span>
              {showCross && (
                <span>
                  <svg width="30" height="10" viewBox="0 0 30 10" aria-hidden="true">
                    <line x1="1" y1="5" x2="29" y2="5" className="lk lk-cross" />
                  </svg>
                  Cross-course
                </span>
              )}
            </div>
          </div>
          <div className="legend-group">
            <div className="legend-title">Size: connections</div>
            <div className="legend-size">
              <span>
                <i style={{ width: 7, height: 7 }} />
                <i style={{ width: 11, height: 11 }} />
                <i style={{ width: 16, height: 16 }} />
                more
              </span>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
