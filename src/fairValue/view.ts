import type { Slice } from "./types.ts";

export function displayNumber(value: number | null | undefined, decimals = 2): string {
  return value === null || value === undefined || !Number.isFinite(value) ? "—" : value.toLocaleString("en-IN", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}
export function displayIv(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(value) ? "—" : `${(100 * value).toFixed(2)}%`;
}
export function localTimestamp(value: string | null | undefined): string {
  if (!value) return "unverified";
  return new Date(value).toLocaleString("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }) + " IST";
}
/** datetime-local is explicitly IST, independent of the browser machine timezone. */
export function localInputToUtc(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value)) return null;
  const date = new Date(value + (value.length === 16 ? ":00" : "") + "+05:30");
  if (!Number.isFinite(date.getTime())) return null;
  const normalized = new Date(date.getTime() + 19800000).toISOString().slice(0, value.length);
  return normalized === value ? date.toISOString() : null;
}
export function utcToLocalInput(value: string): string {
  return new Date(Date.parse(value) + 19800000).toISOString().slice(0, 19);
}
export function fittedPoints(slice: Slice): { x: number; iv: number; w: number }[] {
  if (!slice.smile.valid || slice.t === null || slice.t <= 0 || !slice.smile.support) return [];
  const { min_k, max_k } = slice.smile.support;
  const p = slice.smile.parameters;
  if (slice.smile.method === "svi" && p) return Array.from({ length: 121 }, (_, i) => {
    const x = min_k + (max_k - min_k) * i / 120;
    const w = p.a + p.b * (p.rho * (x - p.m) + Math.hypot(x - p.m, p.eta));
    return { x, w, iv: Math.sqrt(w / slice.t!) };
  });
  return slice.smile.nodes.map((n) => ({ x: n.k, w: n.w, iv: Math.sqrt(n.w / slice.t!) }));
}
export function reasonText(reasons: string[]): string { return reasons.length ? reasons.map((r) => r.replace(/_/g, " ")).join(" · ") : "Eligible quotes and validated model support"; }
