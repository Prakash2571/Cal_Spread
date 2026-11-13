import { API_ORIGIN, getAdminToken } from "./api.ts";

export type SpikeFrame = "1m" | "5m" | "30m" | "1h";
export interface SpikeSample {
  t: number;
  premium: number;
  vwap: number;
  strike: number;
  expiry: string;
  ce_token: number;
  pe_token: number;
}
export type SpikeDirection = "SHORT_PE_LONG_CE" | "SHORT_CE_LONG_PE";
export interface SpikeSignal {
  direction: SpikeDirection;
  t: number;
  reference: number;
  reference_at: number;
  move_pct: number;
  premium: number;
  vwap: number;
}
export interface SpikeLeg {
  token: number;
  symbol: string;
  strike: number;
  entry: number;
  exit?: number;
}
export interface SpikeTrade {
  id: string;
  symbol: string;
  status: "open" | "closed";
  direction: SpikeDirection;
  expiry: string;
  lot_size: number;
  quantity: number;
  opened_at: number;
  closed_at?: number;
  short: SpikeLeg;
  hedge: SpikeLeg;
  signal: SpikeSignal;
  entry_credit: number;
  mark_short?: number;
  mark_hedge?: number;
  mark_at?: number;
  pnl?: number;
  peak_pnl?: number;
  peak_at?: number;
  mark_stale: boolean;
}
export interface SpikeIndex {
  symbol: "NIFTY" | "SENSEX";
  expiry: string;
  pairs: number;
  lot_size: number;
  current: SpikeSample | null;
  signal: SpikeSignal | null;
  note: string;
  recording_since: number | null;
}
export interface SpikeSnapshot {
  mode: "PAPER_ONLY";
  day: string;
  active: boolean;
  connected: boolean;
  database: boolean;
  paper_enabled: boolean;
  wanted_tokens: number;
  window_minutes: number;
  move_pct: number;
  hedge_steps: number;
  vwap_method: string;
  indexes: SpikeIndex[];
  open: SpikeTrade[];
  closed: SpikeTrade[];
  error: string;
}

async function request<T>(path: string, method = "GET", data?: unknown): Promise<T> {
  const token = getAdminToken();
  const response = await fetch(`${API_ORIGIN}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { "x-admin-token": token } : {}) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  const text = await response.text();
  let body: (T & { error?: string }) | null = null;
  try { body = JSON.parse(text) as T & { error?: string }; } catch { /* status below reports proxy failures */ }
  if (!response.ok) throw new Error(body?.error ?? `Spike request failed (HTTP ${response.status}).`);
  if (body === null) throw new Error("Spike returned an unreadable reply.");
  return body;
}

export const fetchSpikeStatus = () => request<SpikeSnapshot>("/api/spike/status");
export const setSpikePaper = (enabled: boolean) => request<SpikeSnapshot>("/api/spike/paper", "POST", { enabled });
export const closeSpikeTrade = (id: string) => request<SpikeTrade>(`/api/spike/trades/${encodeURIComponent(id)}/close`, "POST");
export const deleteSpikeTrade = (id: string) => request<SpikeTrade>(`/api/spike/trades/${encodeURIComponent(id)}/delete`, "POST");
export const fetchSpikeSeries = (symbol: string, frame: SpikeFrame) =>
  request<{ symbol: string; frame: SpikeFrame; points: SpikeSample[] }>(`/api/spike/series?${new URLSearchParams({ symbol, frame })}`);
export function spikeStreamUrl(): string {
  const query = new URLSearchParams();
  const token = getAdminToken();
  if (token) query.set("x-admin-token", token);
  return `${API_ORIGIN}/api/spike/stream?${query}`;
}
