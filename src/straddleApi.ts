import { API_ORIGIN, getAdminToken } from "./api.ts";
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
  points?: StraddlePoint[];
}

export type StraddlePoint = SpikeSample & { gap?: boolean };

export async function fetchStraddleUniverse(signal: AbortSignal) {
  const token = getAdminToken();
  const response = await fetch(`${API_ORIGIN}/api/straddle/universe`, {
    signal,
    headers: token ? { "x-admin-token": token } : undefined,
  });
  if (!response.ok) throw new Error(`Could not load F&O stocks (HTTP ${response.status}).`);
  return response.json() as Promise<{ underlyings: StraddleUnderlying[] }>;
}

export interface StraddleCoverage {
  capacity_limited: number;
  dhan_over_limit: boolean;
}

export function straddleStreamUrl(symbols: string[] = []) {
  const params = new URLSearchParams();
  const token = getAdminToken();
  if (token) params.set("x-admin-token", token);
  for (const symbol of symbols) params.append("symbol", symbol);
  const query = params.toString();
  return `${API_ORIGIN}/api/straddle/stream${query ? `?${query}` : ""}`;
}

export type StraddleStreamError = "capacity" | "connection";

export function subscribeStraddle<T>(url: string, event: string, onData: (data: T) => void, onError: (error: StraddleStreamError) => void) {
  const controller = new AbortController();
  const { signal } = controller;
  const prefix = `event: ${event}\ndata: `;
  let retry: number | undefined;
  let backoff = 5000;

  async function connect() {
    let error: StraddleStreamError = "connection";
    let retryAfter = 0;
    try {
      // Fetch exposes the HTTP admission response as well as the SSE frames.
      const response = await fetch(url, { signal, headers: { Accept: "text/event-stream" } });
      if (response.status === 503) {
        const refusal = await response.json().catch(() => null);
        if (refusal?.code === "straddle_stream_capacity") error = "capacity";
        const seconds = Number(response.headers.get("Retry-After") ?? refusal?.retry_after);
        if (Number.isFinite(seconds) && seconds > 0) retryAfter = seconds * 1000;
      } else if (response.ok && response.headers.get("Content-Type")?.startsWith("text/event-stream") && response.body) {
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = "";
        try {
          while (!signal.aborted) {
            const { value, done } = await reader.read();
            if (done || signal.aborted) break;
            buffer = (buffer + value).replace(/\r\n/g, "\n");
            let end: number;
            while ((end = buffer.indexOf("\n\n")) >= 0) {
              const frame = buffer.slice(0, end);
              buffer = buffer.slice(end + 2);
              if (frame.startsWith(prefix)) {
                const data = JSON.parse(frame.slice(prefix.length)) as T;
                backoff = 5000;
                onData(data);
              }
            }
          }
        } finally {
          void reader.cancel().catch(() => {});
        }
      } else {
        void response.body?.cancel().catch(() => {});
      }
    } catch {
      // Network failures and malformed frames share the transport retry.
    }
    if (signal.aborted) return;
    onError(error);
    retry = window.setTimeout(() => { void connect(); }, Math.max(retryAfter, backoff) + Math.random() * 1000);
    backoff = Math.min(30_000, backoff * 2);
  }

  void connect();
  return () => {
    window.clearTimeout(retry);
    controller.abort();
  };
}
