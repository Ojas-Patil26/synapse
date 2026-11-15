// Full-viewport WebGL backdrop: "Slide and Shift" halftone mosaic.
// A true-square grid of cells that smoothly slide and shift between open gradient,
// crisp 10x10 halftone dot-matrix patterns, and solid architectural tiles.
// Reads brand tokens (--page, --accent, --signal) and interpolates smoothly on
// theme changes. Respects prefers-reduced-motion and pauses when tab is hidden.
import { useEffect, useRef } from "react";
import { useTheme } from "../../state/theme";

const VERT = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

const FRAG = `
precision highp float;

uniform vec2 uRes;
uniform float uTime;
uniform vec2 uMouse;
uniform float uMouseOn;
uniform float uScroll;
uniform float uIntensity;
uniform float uIntro;
uniform vec3 uPage;
uniform vec3 uAccent;
uniform vec3 uSignal;
uniform float uDark;
uniform float uCellPx;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 uv = frag / uRes;

  // Scroll gently shifts the whole field vertically
  vec2 scrolledFrag = frag + vec2(0.0, -uScroll * 0.38);

  // True square cells
  vec2 grid = scrolledFrag / uCellPx;
  vec2 cell = floor(grid);
  vec2 local = fract(grid);

  // Smoothly drifting field that drives which state each cell is in
  float t = uTime * 0.22;
  vec2 fieldP = cell * 0.24 + vec2(t * 0.65, -t * 0.35);
  float n1 = vnoise(fieldP);
  float n2 = vnoise(fieldP * 1.9 - vec2(t * 0.4, t * 0.5));
  float field = n1 * 0.65 + n2 * 0.35;

  // Subtle pointer shift: cells near cursor gently shift phase
  vec2 mCell = (uMouse + vec2(0.0, -uScroll * 0.38)) / uCellPx;
  float mDist = length(cell + 0.5 - mCell);
  float mInfluence = exp(-mDist * mDist * 0.14) * uMouseOn;
  field = clamp(field + mInfluence * 0.22, 0.0, 1.0);

  // Intro sweep: cells settle in from left to right
  float introEdge = mix(-0.15, 1.25, uIntro);
  float introMask = smoothstep(introEdge, introEdge - 0.3, uv.x);
  field *= (0.35 + 0.65 * introMask);

  // Base atmospheric gradient across the viewport (no corner balls of light)
  vec3 skyLight = mix(vec3(0.56, 0.71, 0.84), uAccent, 0.22);
  vec3 creamTile = vec3(0.87, 0.86, 0.80);
  vec3 dotBlueLight = mix(vec3(0.42, 0.59, 0.75), uAccent, 0.35);

  vec3 skyDark = mix(uPage, uAccent, 0.20);
  vec3 solidDark = mix(uPage, vec3(0.11, 0.14, 0.17), 0.85);
  vec3 dotBlueDark = mix(uPage, uAccent, 0.46);
  vec3 dotRoseDark = mix(uPage, uSignal, 0.34);

  vec3 baseGrad = uDark > 0.5
    ? mix(uPage, skyDark, smoothstep(0.0, 1.0, uv.y * 0.6 + uv.x * 0.4))
    : mix(skyLight, mix(uPage, skyLight, 0.55), smoothstep(0.15, 0.85, uv.x * 0.5 + (1.0 - uv.y) * 0.5));

  vec3 tileCol = uDark > 0.5 ? solidDark : creamTile;
  vec3 dotCol  = uDark > 0.5 ? dotBlueDark : dotBlueLight;

  // Occasional subtle Neon Rose tint on select shifting cells (keeps Synapse identity)
  float rosePick = smoothstep(0.76, 0.92, vnoise(cell * 0.37 + vec2(3.1, t * 0.25)));
  if (uDark > 0.5) {
    dotCol = mix(dotCol, dotRoseDark, rosePick * 0.65);
    tileCol = mix(tileCol, mix(uPage, uSignal, 0.14), rosePick * 0.45);
  } else {
    dotCol = mix(dotCol, mix(dotBlueLight, uSignal, 0.28), rosePick * 0.4);
  }

  // Crisp 10x10 halftone dot matrix inside each square cell
  const float DOTS = 10.0;
  vec2 sub = fract(local * DOTS) - 0.5;
  float d = length(sub);
  float aa = 1.15 * DOTS / uCellPx;

  // Quantized-but-smoothly-transitioning cell states ("Slide and Shift"):
  // 0.00 - 0.34: open base gradient
  // 0.34 - 0.56: dots on base gradient
  // 0.56 - 0.74: dots on solid tile
  // 0.74 - 1.00: solid tile
  float toTile = smoothstep(0.50, 0.62, field);
  float bgMix = mix(0.0, 1.0, toTile);
  vec3 cellBg = mix(baseGrad, tileCol, bgMix);

  // Dot radius peaks in the middle states and shrinks to 0 in pure open / pure solid
  float dotBand = smoothstep(0.26, 0.38, field) * (1.0 - smoothstep(0.68, 0.80, field));
  float dotRadius = 0.27 * dotBand;
  float dotMask = (1.0 - smoothstep(dotRadius - aa, dotRadius + aa, d)) * step(0.02, dotRadius);

  vec3 activeDotCol = mix(dotCol, tileCol, toTile * 0.35);
  if (uDark < 0.5 && toTile > 0.5) {
    activeDotCol = dotCol;
  }

  vec3 col = mix(cellBg, activeDotCol, dotMask);

  // Very gentle edge vignette so the frame feels grounded without dark/light balls
  vec2 vUv = uv - 0.5;
  float vig = 1.0 - dot(vUv, vUv) * (uDark > 0.5 ? 0.35 : 0.16);
  col *= vig;

  // Intensity modulation on scroll (hero & closing CTA feel crispest)
  col = mix(uPage, col, 0.84 + 0.16 * uIntensity);

  // Subtle dither to prevent banding
  float dither = (hash(frag + fract(uTime)) + hash(frag + 13.7 + fract(uTime)) - 1.0);
  col += dither * (uDark > 0.5 ? 0.009 : 0.006);

  gl_FragColor = vec4(col, 1.0);
}
`;

function hexToRgb(value: string, fallback: [number, number, number]): [number, number, number] {
  const v = value.trim();
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v);
  if (!m) return fallback;
  let h = m[1];
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function compile(gl: WebGLRenderingContext, type: number, src: string) {
  const s = gl.createShader(type);
  if (!s) return null;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    console.warn("SlideShiftField shader:", gl.getShaderInfoLog(s));
    gl.deleteShader(s);
    return null;
  }
  return s;
}

interface Props {
  /** Element whose visibility gently enriches the field (the closing CTA). */
  flareRef?: React.RefObject<HTMLElement | null>;
}

export function SlideShiftField({ flareRef }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { theme } = useTheme();
  const targetColorsRef = useRef({
    page: [0.04, 0.04, 0.04] as [number, number, number],
    accent: [0.1, 0.62, 0.82] as [number, number, number],
    signal: [1, 0.18, 0.58] as [number, number, number],
    dark: 1,
  });
  const kickRef = useRef<() => void>(() => {});

  useEffect(() => {
    const id = requestAnimationFrame(() => {
      const css = getComputedStyle(document.documentElement);
      targetColorsRef.current = {
        page: hexToRgb(css.getPropertyValue("--page"), theme === "dark" ? [0.04, 0.04, 0.04] : [0.957, 0.973, 0.98]),
        accent: hexToRgb(css.getPropertyValue("--accent"), [0, 0.48, 0.65]),
        signal: hexToRgb(css.getPropertyValue("--signal"), [1, 0.18, 0.58]),
        dark: theme === "dark" ? 1 : 0,
      };
      kickRef.current();
    });
    return () => cancelAnimationFrame(id);
  }, [theme]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext("webgl", {
      antialias: false,
      alpha: false,
      powerPreference: "low-power",
      preserveDrawingBuffer: false,
    });
    if (!gl) return;

    const vs = compile(gl, gl.VERTEX_SHADER, VERT);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) return;
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return;
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "aPos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    const u = (name: string) => gl.getUniformLocation(prog, name);
    const U = {
      res: u("uRes"),
      time: u("uTime"),
      mouse: u("uMouse"),
      mouseOn: u("uMouseOn"),
      scroll: u("uScroll"),
      intensity: u("uIntensity"),
      intro: u("uIntro"),
      page: u("uPage"),
      accent: u("uAccent"),
      signal: u("uSignal"),
      dark: u("uDark"),
      cellPx: u("uCellPx"),
    };

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");

    let w = 0;
    let h = 0;
    let scale = 1;
    let cellPx = 96;
    const resize = () => {
      // Render at full DPR (capped at 2) so the 10x10 halftone dots stay razor-sharp
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      scale = dpr;
      const cw = canvas.clientWidth || window.innerWidth;
      const ch = canvas.clientHeight || window.innerHeight;
      w = Math.max(1, Math.floor(cw * scale));
      h = Math.max(1, Math.floor(ch * scale));
      const cssCell = cw < 640 ? 64 : 96;
      cellPx = cssCell * scale;
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    window.addEventListener("resize", resize);

    const target = { x: w * 0.5, y: h * 0.5, on: 0 };
    const cur = { x: target.x, y: target.y, on: 0 };
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return;
      target.x = e.clientX * scale;
      target.y = (window.innerHeight - e.clientY) * scale;
      target.on = 1;
    };
    const onLeave = () => {
      target.on = 0;
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    document.documentElement.addEventListener("pointerleave", onLeave);

    const curColors = {
      page: [...targetColorsRef.current.page] as [number, number, number],
      accent: [...targetColorsRef.current.accent] as [number, number, number],
      signal: [...targetColorsRef.current.signal] as [number, number, number],
      dark: targetColorsRef.current.dark,
    };

    let raf = 0;
    let running = true;
    let intensity = 1;
    let smoothScroll = window.scrollY;
    const start = performance.now();
    const introMs = 1400;

    const lerp3 = (a: [number, number, number], b: [number, number, number], k: number) => {
      a[0] += (b[0] - a[0]) * k;
      a[1] += (b[1] - a[1]) * k;
      a[2] += (b[2] - a[2]) * k;
    };

    const frame = (now: number) => {
      const still = reduce.matches;
      const elapsed = now - start;
      const time = still ? 6 : elapsed / 1000;
      const introT = still ? 1 : Math.min(1, elapsed / introMs);
      const intro = 1 - Math.pow(1 - introT, 3);

      const vh = window.innerHeight;
      const sy = window.scrollY;
      smoothScroll = still ? sy : smoothScroll + (sy - smoothScroll) * 0.1;

      const hero = 1 - Math.min(1, sy / (vh * 0.95));
      let flare = 0;
      const fl = flareRef?.current;
      if (fl) {
        const r = fl.getBoundingClientRect();
        const c = r.top + r.height / 2;
        flare = Math.max(0, 1 - Math.abs(c - vh * 0.55) / (vh * 0.8));
      }
      const goal = Math.max(0.4 + 0.6 * hero, flare);
      intensity = still ? goal : intensity + (goal - intensity) * 0.06;

      const ease = still ? 1 : 0.08;
      cur.x += (target.x - cur.x) * ease;
      cur.y += (target.y - cur.y) * ease;
      cur.on += ((still ? 0 : target.on) - cur.on) * 0.05;

      const tc = targetColorsRef.current;
      const ck = still ? 1 : 0.1;
      lerp3(curColors.page, tc.page, ck);
      lerp3(curColors.accent, tc.accent, ck);
      lerp3(curColors.signal, tc.signal, ck);
      curColors.dark += (tc.dark - curColors.dark) * ck;

      gl.uniform2f(U.res, w, h);
      gl.uniform1f(U.time, time);
      gl.uniform2f(U.mouse, cur.x, cur.y);
      gl.uniform1f(U.mouseOn, cur.on);
      gl.uniform1f(U.scroll, smoothScroll * scale);
      gl.uniform1f(U.intensity, intensity);
      gl.uniform1f(U.intro, intro);
      gl.uniform3fv(U.page, curColors.page);
      gl.uniform3fv(U.accent, curColors.accent);
      gl.uniform3fv(U.signal, curColors.signal);
      gl.uniform1f(U.dark, curColors.dark);
      gl.uniform1f(U.cellPx, cellPx);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      canvas.dataset.ready = "true";
      if (running && !still) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    const kick = () => {
      if (!reduce.matches || document.hidden) return;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(frame);
    };
    kickRef.current = kick;
    window.addEventListener("scroll", kick, { passive: true });
    window.addEventListener("resize", kick);
    const onReduceChange = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(frame);
    };
    reduce.addEventListener("change", onReduceChange);

    const onVis = () => {
      if (document.hidden) {
        running = false;
        cancelAnimationFrame(raf);
      } else if (!running) {
        running = true;
        raf = requestAnimationFrame(frame);
      }
    };
    document.addEventListener("visibilitychange", onVis);

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("resize", resize);
      window.removeEventListener("scroll", kick);
      window.removeEventListener("resize", kick);
      reduce.removeEventListener("change", onReduceChange);
      kickRef.current = () => {};
      window.removeEventListener("pointermove", onMove);
      document.documentElement.removeEventListener("pointerleave", onLeave);
      document.removeEventListener("visibilitychange", onVis);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    };
  }, [flareRef]);

  return <canvas ref={canvasRef} className="lp-field" aria-hidden="true" />;
}
