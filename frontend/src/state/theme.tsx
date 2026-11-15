// Theme: follows prefers-color-scheme until the user picks one with the toggle.
// Canvas-drawn graph colors come from the same CSS variables via usePalette().
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { makeRetentionScale, type RetentionScale } from "../lib/color";

export type ThemeName = "light" | "dark";

export interface Palette {
  theme: ThemeName;
  page: string;
  surface: string;
  ink: string;
  ink2: string;
  muted: string;
  edge: string;
  edgeStrong: string;
  accent: string;
  hubFill: string;
  hubStroke: string;
  hubText: string;
  retention: RetentionScale;
}

interface ThemeCtx {
  theme: ThemeName;
  toggle: () => void;
  palette: Palette;
}

const KEY = "synapse.theme";
const Ctx = createContext<ThemeCtx | null>(null);

const systemTheme = (): ThemeName =>
  typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";

function savedTheme(): ThemeName | null {
  try {
    const t = localStorage.getItem(KEY);
    return t === "light" || t === "dark" ? t : null;
  } catch {
    return null;
  }
}

function readPalette(theme: ThemeName): Palette {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    theme,
    page: v("--page", "#f4f8fa"),
    surface: v("--surface", "#ffffff"),
    ink: v("--ink", "#0a0a0a"),
    ink2: v("--ink-2", "#3d4a52"),
    muted: v("--muted", "#6a767e"),
    edge: v("--edge", "#c8d2d9"),
    edgeStrong: v("--edge-strong", "#87949c"),
    accent: v("--accent", "#007ba7"),
    hubFill: v("--hub-fill", "#e4ebf0"),
    hubStroke: v("--hub-stroke", "#8a969e"),
    hubText: v("--hub-text", "#0a0a0a"),
    retention: makeRetentionScale([v("--ret-0", "#a82d28"), v("--ret-50", "#d39218"), v("--ret-100", "#58b868")]),
  };
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [manual, setManual] = useState<ThemeName | null>(savedTheme);
  const [system, setSystem] = useState<ThemeName>(systemTheme);
  const theme = manual ?? system;

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setSystem(mq.matches ? "dark" : "light");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // Keep the attribute in sync during render so the palette below reads the right variables.
  if (typeof document !== "undefined") {
    if (manual) document.documentElement.setAttribute("data-theme", manual);
    else document.documentElement.removeAttribute("data-theme");
  }

  const toggle = useCallback(() => {
    const next: ThemeName = theme === "dark" ? "light" : "dark";
    try {
      localStorage.setItem(KEY, next);
    } catch {
      /* ignore */
    }
    document.documentElement.setAttribute("data-theme", next);
    setManual(next);
  }, [theme]);

  const palette = useMemo(() => readPalette(theme), [theme]);
  const value = useMemo(() => ({ theme, toggle, palette }), [theme, toggle, palette]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme(): ThemeCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useTheme outside ThemeProvider");
  return ctx;
}

export const usePalette = () => useTheme().palette;
