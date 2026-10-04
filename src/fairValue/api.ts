import { API_ORIGIN, getAdminToken } from "../api.ts";
import type { CalculatorResult, ConfigResponse, HistorySummary, Independent, OptionSide, Snapshot, SnapshotResponse, Status } from "./types.ts";

async function request<T>(path: string, method = "GET", body?: unknown, signal?: AbortSignal): Promise<T> {
  const token = getAdminToken();
  if (!token) {
    if (typeof window !== "undefined") window.dispatchEvent(new Event("calspread:fair-value-access-denied"));
    throw new Error("Full admin authentication required.");
  }
  const response = await fetch(`${API_ORIGIN}/api/fair-value${path}`, {
    method, headers: { "Content-Type": "application/json", "x-admin-token": token },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal,
  });
  const text = await response.text();
  let data: T & { error?: string };
  try { data = JSON.parse(text) as T & { error?: string }; }
  catch { throw new Error(`Fair Value returned an unreadable response (HTTP ${response.status}).`); }
  if (!response.ok) {
    if (response.status === 403 && typeof window !== "undefined") window.dispatchEvent(new Event("calspread:fair-value-access-denied"));
    throw new Error(data.error ?? `Fair Value request failed (HTTP ${response.status}).`);
  }
  return data;
}

export const getFairValueStatus = (signal?: AbortSignal) => request<Status>("/status", "GET", undefined, signal);
export const getFairValueConfig = () => request<ConfigResponse>("/config");
export const setFairValueConfig = (config: unknown) => request<{ version: string; persisted: boolean; status: Status }>("/config", "PATCH", config);
export const getFairValueUnderlyings = () => request<{ underlyings: { symbol: string; name: string; expiries: string[] }[]; status: Status }>("/underlyings");
export const getFairValueSnapshot = (symbol: string, signal?: AbortSignal) => request<SnapshotResponse>(`/snapshot/${encodeURIComponent(symbol)}`, "GET", undefined, signal);
export const refreshFairValue = (underlying: string) => request<{ snapshot: Snapshot | null; pending: boolean; status: Status }>("/refresh", "POST", { underlying });
export const pauseFairValue = (paused: boolean) => request<{ status: Status }>("/pause", "POST", { paused });
export const calculateFairValue = (input: { underlying: string; strike: number; expiry_timestamp: string; side: OptionSide; research_mode: boolean; input_snapshot_id?: string }) => request<CalculatorResult>("/calculate", "POST", input);
export const independentFairValue = (underlying: string, expiry: string, strike: number, input_snapshot_id: string) => request<Independent>("/independent", "POST", { underlying, expiry, strike, input_snapshot_id });
export const getFairValueHistory = (symbol: string) => request<{ snapshots: HistorySummary[]; historical: true; storage: string }>(`/history/${encodeURIComponent(symbol)}`);
export const getFairValueHistoricalSnapshot = (symbol: string, id: string) => request<{ snapshot: Snapshot; historical: true }>(`/history/${encodeURIComponent(symbol)}/${encodeURIComponent(id)}`);
export const exportFairValue = (symbol: string) => request<SnapshotResponse>(`/export/${encodeURIComponent(symbol)}`);
