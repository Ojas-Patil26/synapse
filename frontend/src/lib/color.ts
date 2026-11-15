// Retention color scale: a continuous red (0) -> amber (0.5) -> green (1) ramp,
// interpolated in OKLCH so the in-between tones stay clean instead of going muddy.
// The three stops come from CSS variables (--ret-0, --ret-50, --ret-100) so the
// ramp is selected per theme, never hardcoded.

type Lab = [number, number, number];

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.trim().replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const toLinear = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const toSrgb = (v: number) => {
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, c)) * 255);
};

function hexToOklab(hex: string): Lab {
  const [r, g, b] = hexToRgb(hex).map(toLinear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function oklabToHex([L, a, b]: Lab): string {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const rgb = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map(toSrgb);
  return "#" + rgb.map((c) => c.toString(16).padStart(2, "0")).join("");
}

export type RetentionScale = (retention: number) => string;

export function makeRetentionScale(stops: [string, string, string]): RetentionScale {
  // Interpolate in OKLCH (lightness, chroma, hue) so the tones between the stops stay
  // saturated: orange between red and amber, yellow-green between amber and green.
  const lch = stops.map((hex) => {
    const [L, a, b] = hexToOklab(hex);
    return [L, Math.hypot(a, b), Math.atan2(b, a)] as Lab;
  });
  const cache = new Map<number, string>();
  return (retention: number) => {
    const t = Math.min(1, Math.max(0, Number.isFinite(retention) ? retention : 0));
    const key = Math.round(t * 200);
    const hit = cache.get(key);
    if (hit) return hit;
    const u = key / 200;
    const [from, to, k] = u < 0.5 ? [lch[0], lch[1], u / 0.5] : [lch[1], lch[2], (u - 0.5) / 0.5];
    let dh = to[2] - from[2];
    if (dh > Math.PI) dh -= 2 * Math.PI;
    if (dh < -Math.PI) dh += 2 * Math.PI;
    const L = from[0] + (to[0] - from[0]) * k;
    const C = from[1] + (to[1] - from[1]) * k;
    const h = from[2] + dh * k;
    const hex = oklabToHex([L, C * Math.cos(h), C * Math.sin(h)]);
    cache.set(key, hex);
    return hex;
  };
}

/** `#rrggbb` + alpha -> rgba() string, for canvas dimming. */
export function withAlpha(hex: string, alpha: number): string {
  if (!hex.startsWith("#")) return hex;
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
