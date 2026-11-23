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
  status: "live" | "capacity" | "closed" | "connecting" | "waiting" | "unavailable" | "pricing";
  recording_since: number;
  current: SpikeSample | null;
  points?: SpikeSample[];
}

export async function fetchStraddleUniverse(signal: AbortSignal) {
  const response = await fetch(`${API_ORIGIN}/api/straddle/universe`, { signal });
  if (!response.ok) throw new Error(`Could not load F&O stocks (HTTP ${response.status}).`);
  return response.json() as Promise<{ underlyings: StraddleUnderlying[] }>;
}

export interface StraddleCoverage {
  capacity_limited: number;
}

export function straddleStreamUrl(symbols: string[] = []) {
  const params = new URLSearchParams();
  for (const symbol of symbols) params.append("symbol", symbol);
  const query = params.toString();
  return `${API_ORIGIN}/api/straddle/stream${query ? `?${query}` : ""}`;
}

export function subscribeStraddle<T>(url: string, event: string, onData: (data: T) => void, onError: () => void) {
  let stream: EventSource | undefined;
  let retry: number | undefined;

  function connect() {
    const source = new EventSource(url);
    stream = source;
    source.addEventListener(event, (message) => {
      if (stream !== source) return;
      try {
        onData(JSON.parse((message as MessageEvent<string>).data) as T);
      } catch {
        onError();
      }
    });
    source.onerror = () => {
      if (stream !== source) return;
      onError();
      if (source.readyState === EventSource.CLOSED) {
        retry = window.setTimeout(connect, 5000);
      }
    };
  }

  connect();
  return () => {
    window.clearTimeout(retry);
    stream?.close();
    stream = undefined;
  };
}
