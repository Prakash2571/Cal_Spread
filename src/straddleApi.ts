import { API_ORIGIN } from "./api.ts";
import type { SpikeSample } from "./spikeApi.ts";

export interface StraddleUnderlying {
  symbol: string;
  name: string;
  expiry: string;
}

export interface StraddleSnapshot {
  day: string;
  symbol: string;
  expiry: string;
  status: "live" | "capacity" | "closed" | "connecting" | "waiting" | "unavailable";
  recording_since: number;
  current: SpikeSample | null;
  points?: SpikeSample[];
}

export async function fetchStraddleUniverse(signal: AbortSignal) {
  const response = await fetch(`${API_ORIGIN}/api/straddle/universe`, { signal });
  if (!response.ok) throw new Error(`Could not load F&O stocks (HTTP ${response.status}).`);
  return response.json() as Promise<{ underlyings: StraddleUnderlying[]; max_live: number }>;
}

export function straddleStreamUrl(symbols: string) {
  return `${API_ORIGIN}/api/straddle/stream?${new URLSearchParams({ symbols })}`;
}
