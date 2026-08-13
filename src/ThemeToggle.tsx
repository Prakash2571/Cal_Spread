import { useEffect, useState } from "react";

export type Theme = "dark" | "light";

const THEME_STORAGE_KEY = "cal_spread_theme";

export function readStoredTheme(): Theme {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", theme === "light" ? "#ffffff" : "#0f1216");
}

export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(readStoredTheme);
  const isLight = theme === "light";
  const nextTheme = isLight ? "dark" : "light";

  useEffect(() => {
    applyTheme(theme);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // The active theme still works when storage is unavailable.
    }
  }, [theme]);

  return (
    <button
      type="button"
      className="btn theme-toggle"
      aria-label="Light mode"
      aria-pressed={isLight}
      title={`Switch to ${nextTheme} mode`}
      onClick={() => setTheme(nextTheme)}
    >
      {isLight ? (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="3.5" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M20.5 14.6A8.2 8.2 0 0 1 9.4 3.5 8.5 8.5 0 1 0 20.5 14.6Z" />
        </svg>
      )}
      <span>{isLight ? "Light" : "Dark"}</span>
    </button>
  );
}
