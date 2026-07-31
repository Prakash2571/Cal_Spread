import type { Theme } from "./theme.ts";

interface Props {
  theme: Theme;
  onToggle: () => void;
}

/** Day/night switch. Shows the icon of the mode you'll switch TO:
 *  a sun while in dark mode, a moon while in day mode. */
export default function ThemeToggle({ theme, onToggle }: Props) {
  const isDark = theme === "dark";
  const label = isDark ? "Switch to day mode" : "Switch to dark mode";
  return (
    <button
      className="btn btn--icon"
      onClick={onToggle}
      title={label}
      aria-label={label}
    >
      {isDark ? (
        // Sun
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
      ) : (
        // Moon
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
        </svg>
      )}
    </button>
  );
}
