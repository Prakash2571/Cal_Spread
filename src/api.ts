const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3001";

export interface Instrument {
  instrument_token: number;
  exchange_token: number;
  tradingsymbol: string;
  name: string;
  last_price: number;
  expiry: string;
  strike: number;
  tick_size: number;
  lot_size: number;
  instrument_type: string;
  segment: string;
  exchange: string;
  /** Present only on F&O-stock responses: the futures lot size. */
  fno_lot_size?: number;
}

export interface InstrumentsResponse {
  count: number;
  instruments: Instrument[];
}

/** URL the user clicks to start the Zerodha login flow (handled by backend). */
export const loginUrl = `${API_BASE_URL}/login`;

/**
 * Exchange the request_token (received at the /zerodha/verify redirect) for an
 * access token. The backend performs the secret-checksum exchange with Kite.
 */
export async function createSession(
  requestToken: string,
): Promise<{ authenticated: boolean; user_name?: string }> {
  const res = await fetch(`${API_BASE_URL}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ request_token: requestToken }),
  });
  const body = (await res.json()) as {
    authenticated?: boolean;
    user_name?: string;
    error?: string;
  };
  if (!res.ok) {
    throw new Error(body.error ?? `Login failed (HTTP ${res.status}).`);
  }
  return { authenticated: !!body.authenticated, user_name: body.user_name };
}

/** Backend health/auth status. */
export async function getStatus(): Promise<{ authenticated: boolean }> {
  const res = await fetch(`${API_BASE_URL}/`);
  if (!res.ok) throw new Error(`Backend not reachable (HTTP ${res.status}).`);
  return res.json();
}

/** Forget the Kite session on the backend (logout). */
export async function logout(): Promise<void> {
  await fetch(`${API_BASE_URL}/api/logout`, { method: "POST" }).catch(() => {
    /* ignore network errors on logout */
  });
}

/** Fetch only F&O stocks (NSE underlyings that have stock futures). */
export async function fetchFnoStocks(params?: {
  q?: string;
}): Promise<InstrumentsResponse> {
  const search = new URLSearchParams();
  if (params?.q) search.set("q", params.q);
  const qs = search.toString();
  const res = await fetch(
    `${API_BASE_URL}/api/fno-stocks${qs ? `?${qs}` : ""}`,
  );

  const body = (await res.json()) as InstrumentsResponse & { error?: string };
  if (!res.ok) {
    throw new Error(body.error ?? `Failed to load F&O stocks (HTTP ${res.status}).`);
  }
  return body;
}

/** A single futures contract on an underlying. */
export interface FnoContract {
  instrument_token: number;
  tradingsymbol: string;
  expiry: string; // YYYY-MM-DD
  lot_size: number;
}

/** Detail for one F&O stock: the spot instrument + its nearest futures. */
export interface FnoDetail {
  symbol: string;
  spot: {
    instrument_token: number;
    tradingsymbol: string;
    name: string;
  };
  futures: FnoContract[];
}

/** A live tick relayed from the backend SSE stream. */
export interface Tick {
  token: number;
  last_price: number;
  close_price: number;
}

/** Fetch the spot + 3 nearest futures for a single F&O stock. */
export async function fetchFnoDetail(symbol: string): Promise<FnoDetail> {
  const res = await fetch(
    `${API_BASE_URL}/api/fno-stocks/${encodeURIComponent(symbol)}`,
  );
  const body = (await res.json()) as FnoDetail & { error?: string };
  if (!res.ok) {
    throw new Error(body.error ?? `Failed to load ${symbol} (HTTP ${res.status}).`);
  }
  return body;
}

/** URL for the live SSE tick stream for the given instrument tokens. */
export function streamUrl(tokens: number[]): string {
  return `${API_BASE_URL}/api/stream?tokens=${tokens.join(",")}`;
}

/** Fetch the list of stocks (defaults to NSE equities on the backend). */
export async function fetchInstruments(params?: {
  exchange?: string;
  type?: string;
  q?: string;
}): Promise<InstrumentsResponse> {
  const search = new URLSearchParams();
  if (params?.exchange !== undefined) search.set("exchange", params.exchange);
  if (params?.type !== undefined) search.set("type", params.type);
  if (params?.q) search.set("q", params.q);

  const qs = search.toString();
  const res = await fetch(
    `${API_BASE_URL}/api/instruments${qs ? `?${qs}` : ""}`,
  );

  const body = (await res.json()) as InstrumentsResponse & { error?: string };
  if (!res.ok) {
    throw new Error(body.error ?? `Failed to load stocks (HTTP ${res.status}).`);
  }
  return body;
}
