/** Whole days from today until an ISO expiry date (YYYY-MM-DD). */
export function daysToExpiry(expiry: string): number {
  const target = new Date(`${expiry}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const ms = target.getTime() - today.getTime();
  return Math.max(0, Math.round(ms / 86_400_000));
}

/** Format an ISO expiry as e.g. "26 Jul". */
export function formatExpiry(expiry: string): string {
  const d = new Date(`${expiry}T00:00:00`);
  if (Number.isNaN(d.getTime())) return expiry;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/** Percentage change of last vs close, or null when close is unknown. */
export function changePct(last: number, close: number): number | null {
  if (!close) return null;
  return ((last - close) / close) * 100;
}

/** Format a number to 2 decimals, or a dash placeholder when not yet known. */
export function fmt(value: number | null | undefined, dash = "—"): string {
  if (value === null || value === undefined || Number.isNaN(value)) return dash;
  return value.toFixed(2);
}

/** Signed 2-decimal string, e.g. "+9.40" / "-0.10". */
export function fmtSigned(value: number | null | undefined, dash = "—"): string {
  if (value === null || value === undefined || Number.isNaN(value)) return dash;
  const s = value.toFixed(2);
  return value > 0 ? `+${s}` : s;
}
