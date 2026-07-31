/* ================================================================
   Theme — dark (default) / light (day) mode.

   The stylesheet is the single source of truth for colour: dark
   tokens live in :root, and [data-theme="light"] overrides them.
   This module only flips the `data-theme` attribute + persists the
   choice, plus resolves the token values SVG charts need (SVG
   presentation attributes can't read CSS var(), so charts read the
   resolved hex from getComputedStyle).
   ================================================================ */

export type Theme = "dark" | "light";

const STORAGE_KEY = "cal_spread_theme";

/** The saved theme, or "dark" as the default. */
export function getInitialTheme(): Theme {
  try {
    return localStorage.getItem(STORAGE_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

/** Apply a theme to the document + persist it. Synchronous, so a following
 *  React render sees the updated tokens via getComputedStyle. */
export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* storage disabled — theme still applies for this session */
  }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", theme === "light" ? "#f2f4f7" : "#0f1216");
}

export interface ChartColors {
  /** Per-contract line colours (near / next / far). */
  series: [string, string, string];
  /** Muted colour for an expired contract. */
  expired: string;
  /** Calendar-spread line colour. */
  spread: string;
  /** Positive / negative value colours (markers, entry/exit). */
  pos: string;
  neg: string;
  /** Neutral/muted value colour. */
  muted: string;
}

/** Resolve chart colours from the live CSS tokens for the active theme.
 *  Reads the current computed styles, so call after the theme attribute is
 *  set. The `theme` argument is only used as a memo/dependency key. */
export function resolveChartColors(_theme: Theme): ChartColors {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) =>
    cs.getPropertyValue(name).trim() || fallback;
  return {
    series: [
      v("--series-1", "#58a6ff"),
      v("--series-2", "#3fb950"),
      v("--series-3", "#d29922"),
    ],
    expired: v("--series-expired", "#6e7681"),
    spread: v("--series-1", "#58a6ff"),
    pos: v("--pos", "#3fb950"),
    neg: v("--neg", "#f85149"),
    muted: v("--text-2", "#9ba3af"),
  };
}
