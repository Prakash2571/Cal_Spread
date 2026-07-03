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


/** Percent-change text like "+0.74%" / "-0.95%", or a dash when unknown. */
export function pctText(
  last: number | null | undefined,
  close: number | null | undefined,
  dash = "—",
): string {
  if (last == null || !close) return dash;
  const p = ((last - close) / close) * 100;
  return `${p > 0 ? "+" : ""}${p.toFixed(2)}%`;
}

/** CSS class for a percent change: "pos" / "neg" / "". */
export function pctClass(
  last: number | null | undefined,
  close: number | null | undefined,
): string {
  if (last == null || !close) return "";
  const p = last - close;
  return p > 0 ? "pos" : p < 0 ? "neg" : "";
}

/** Compact Indian-style number for open interest, e.g. 1.2Cr / 3.4L / 12,345. */
export function fmtCompact(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value) || value <= 0) {
    return "—";
  }
  if (value >= 1e7) return `${(value / 1e7).toFixed(2)}Cr`;
  if (value >= 1e5) return `${(value / 1e5).toFixed(2)}L`;
  return value.toLocaleString("en-IN");
}

/** ₹ money with sign, e.g. +₹1,234.50 / −₹980. */
export function fmtMoney(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}₹${Math.abs(value).toLocaleString("en-IN", {
    maximumFractionDigits: 2,
  })}`;
}

/** CSS class for a premium/discount value: "prem" / "disc" / "muted". */
export function pdClass(premium: number | null): string {
  if (premium === null) return "muted";
  return premium > 0 ? "prem" : premium < 0 ? "disc" : "";
}


/**
 * Theoretical futures fair value (cost-of-carry):
 *   Fair = Spot * [ 1 + (rf - q) * (x/365) ]
 * where rf is the annual risk-free rate (%), q is the annual dividend yield (%),
 * and x is days to expiry. q defaults to 0 when no dividend data is available.
 */
export function fairPrice(
  spot: number | null | undefined,
  rfAnnualPct: number,
  days: number,
  divYieldAnnualPct = 0,
): number | null {
  if (spot == null || Number.isNaN(spot)) return null;
  const rf = (Number.isFinite(rfAnnualPct) ? rfAnnualPct : 0) / 100;
  const q = (Number.isFinite(divYieldAnnualPct) ? divYieldAnnualPct : 0) / 100;
  return spot * (1 + (rf - q) * (days / 365));
}
