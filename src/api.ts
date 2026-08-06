/**
 * Base URL of the backend API.
 *
 * IMPORTANT: every endpoint below is prefixed with "/api/...". So
 * VITE_API_BASE_URL must be the backend ORIGIN only, WITHOUT a trailing
 * "/api" (e.g. "https://api.calspread.online" or "https://calspread.online").
 * As a safety net we strip a trailing slash and a trailing "/api" so a
 * misconfigured value like "https://calspread.online/api" can't produce
 * doubled "/api/api/..." request URLs.
 */
function normalizeBaseUrl(raw: string): string {
  return raw
    .trim()
    .replace(/\/+$/, "") // drop trailing slash(es)
    .replace(/\/api$/i, ""); // drop a trailing /api (endpoints add it themselves)
}

const API_BASE_URL = normalizeBaseUrl(
  import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3001",
);

let adminToken: string | null = localStorage.getItem("cal_spread_admin_token");

export function setAdminToken(token: string | null) {
  adminToken = token;
  if (token) {
    localStorage.setItem("cal_spread_admin_token", token);
  } else {
    localStorage.removeItem("cal_spread_admin_token");
  }
}

export function getAdminToken(): string | null {
  return adminToken;
}

function getHeaders(): HeadersInit {
  const headers: HeadersInit = {
    "Content-Type": "application/json",
  };
  if (adminToken) {
    headers["x-admin-token"] = adminToken;
  }
  return headers;
}

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

export type AdminRole = "full" | "trade" | null;

/** Verify the FULL admin secret (/admin/verify) and get an admin token. */
export async function verifyAdminSecret(
  secret: string,
): Promise<{ success: boolean; token: string }> {
  const res = await fetch(`${API_BASE_URL}/api/admin/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret }),
  });
  const body = (await res.json()) as {
    success?: boolean;
    token?: string;
    error?: string;
  };
  if (!res.ok) {
    throw new Error(body.error ?? `Admin verification failed (HTTP ${res.status}).`);
  }
  return { success: !!body.success, token: body.token ?? "" };
}

/** Verify the TRADE-ACCESS password (/admin/access) and get a trade token. */
export async function verifyAccessSecret(
  secret: string,
): Promise<{ success: boolean; token: string }> {
  const res = await fetch(`${API_BASE_URL}/api/access/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret }),
  });
  const body = (await res.json()) as {
    success?: boolean;
    token?: string;
    error?: string;
  };
  if (!res.ok) {
    throw new Error(body.error ?? `Access verification failed (HTTP ${res.status}).`);
  }
  return { success: !!body.success, token: body.token ?? "" };
}

/** Check admin authentication status + role. */
export async function getAdminStatus(): Promise<{
  authenticated: boolean;
  role: AdminRole;
}> {
  const headers: HeadersInit = {};
  if (adminToken) {
    headers["x-admin-token"] = adminToken;
  }
  const res = await fetch(`${API_BASE_URL}/api/admin/status`, { headers });
  if (!res.ok) return { authenticated: false, role: null };
  return res.json();
}

/** Logout admin session */
export function logoutAdmin(): void {
  setAdminToken(null);
}

// ---------------- Calendar-spread trades (admin only) ----------------

export interface TradeLeg {
  token: number;
  expiry: string;
  entry: number;
}

export interface Trade {
  id: string;
  symbol: string;
  name: string;
  is_index: boolean;
  lot_size: number;
  buy: TradeLeg;
  sell: TradeLeg;
  status: "open" | "closed";
  opened_at: string;
  closed_at: string | null;
  close_pnl: number | null;
  buy_close: number | null;
  sell_close: number | null;
  margin: number | null;
}

/** Take a 1-lot calendar-spread trade for a symbol (buy discount / sell premium). */
export async function createTrade(symbol: string): Promise<Trade> {
  const res = await fetch(`${API_BASE_URL}/api/trades`, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify({ symbol }),
  });
  const body = (await res.json()) as { trade?: Trade; error?: string };
  if (!res.ok || !body.trade) {
    throw new Error(body.error ?? `Failed to take trade (HTTP ${res.status}).`);
  }
  return body.trade;
}

/** List all trades (open + closed), newest first. */
export async function listTrades(): Promise<{ dbEnabled: boolean; trades: Trade[] }> {
  const res = await fetch(`${API_BASE_URL}/api/trades`, { headers: getHeaders() });
  const body = (await res.json()) as {
    dbEnabled?: boolean;
    trades?: Trade[];
    error?: string;
  };
  if (!res.ok) {
    throw new Error(body.error ?? `Failed to load trades (HTTP ${res.status}).`);
  }
  return { dbEnabled: !!body.dbEnabled, trades: body.trades ?? [] };
}

// ---------------- Historical open interest ----------------

export interface OiPoint {
  date: string; // YYYY-MM-DD
  oi: number;
  close: number; // daily close price
}

export interface OiFutureSeries {
  token: number;
  expiry: string;
  points: OiPoint[];
}

export interface OiHistory {
  symbol: string;
  name: string;
  is_index: boolean;
  futures: OiFutureSeries[];
}

/** Fetch ~1 month of daily closing open interest for a symbol's futures. */
export async function fetchOiHistory(symbol: string): Promise<OiHistory> {
  const res = await fetch(
    `${API_BASE_URL}/api/history/${encodeURIComponent(symbol)}`,
    { headers: getHeaders() },
  );
  const body = (await res.json()) as OiHistory & { error?: string };
  if (!res.ok) {
    throw new Error(body.error ?? `Failed to load history (HTTP ${res.status}).`);
  }
  return body;
}

export interface IntradayPoint {
  t: string; // full ISO timestamp
  close: number;
}

export interface IntradayFutureSeries {
  token: number;
  expiry: string;
  points: IntradayPoint[];
}

export interface IntradayHistory {
  symbol: string;
  name: string;
  is_index: boolean;
  futures: IntradayFutureSeries[];
}

/** Fetch ~1 week of hourly closing price for a symbol's futures. */
export async function fetchIntradayHistory(symbol: string): Promise<IntradayHistory> {
  const res = await fetch(
    `${API_BASE_URL}/api/intraday/${encodeURIComponent(symbol)}`,
    { headers: getHeaders() },
  );
  const body = (await res.json()) as IntradayHistory & { error?: string };
  if (!res.ok) {
    throw new Error(body.error ?? `Failed to load intraday (HTTP ${res.status}).`);
  }
  return body;
}

/** Fetch the last 2 hours of minute-by-minute closing price (same shape). */
export async function fetchMinuteHistory(symbol: string): Promise<IntradayHistory> {
  const res = await fetch(
    `${API_BASE_URL}/api/minute/${encodeURIComponent(symbol)}`,
    { headers: getHeaders() },
  );
  const body = (await res.json()) as IntradayHistory & { error?: string };
  if (!res.ok) {
    throw new Error(body.error ?? `Failed to load minute data (HTTP ${res.status}).`);
  }
  return body;
}

/** Fetch today's 5-minute closing price (same shape). */
export async function fetchFiveMinHistory(symbol: string): Promise<IntradayHistory> {
  const res = await fetch(
    `${API_BASE_URL}/api/fivemin/${encodeURIComponent(symbol)}`,
    { headers: getHeaders() },
  );
  const body = (await res.json()) as IntradayHistory & { error?: string };
  if (!res.ok) {
    throw new Error(body.error ?? `Failed to load 5-min data (HTTP ${res.status}).`);
  }
  return body;
}

/** Close a trade (locks in final P&L). */
export async function closeTrade(id: string): Promise<Trade> {
  const res = await fetch(`${API_BASE_URL}/api/trades/${id}/close`, {
    method: "POST",
    headers: getHeaders(),
  });
  const body = (await res.json()) as { trade?: Trade; error?: string };
  if (!res.ok || !body.trade) {
    throw new Error(body.error ?? `Failed to close trade (HTTP ${res.status}).`);
  }
  return body.trade;
}

/** Delete a closed trade from history. */
export async function deleteTrade(id: string): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/api/trades/${id}`, {
    method: "DELETE",
    headers: getHeaders(),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Failed to delete trade (HTTP ${res.status}).`);
  }
}

/** URL the user clicks to start the Zerodha login flow (handled by backend). */
export function loginUrl(): string {
  const url = `${API_BASE_URL}/api/login`;
  return adminToken ? `${url}?x-admin-token=${encodeURIComponent(adminToken)}` : url;
}

/**
 * Exchange the request_token (received at the /zerodha/verify redirect) for an
 * access token. The backend performs the secret-checksum exchange with Kite.
 */
export async function createSession(
  requestToken: string,
): Promise<{ authenticated: boolean; user_name?: string }> {
  const res = await fetch(`${API_BASE_URL}/api/session`, {
    method: "POST",
    headers: getHeaders(),
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

export interface KiteAccessToken {
  api_key: string;
  access_token: string;
  login_date: string;
}

/**
 * Fetch the current Zerodha access token (full admin only). Requires an active
 * Zerodha session on the backend. Throws with the server error message on 409
 * (no session) or 403 (not a full admin).
 */
export async function fetchKiteAccessToken(): Promise<KiteAccessToken> {
  const res = await fetch(`${API_BASE_URL}/api/kite/access-token`, {
    headers: getHeaders(),
  });
  const body = (await res.json()) as Partial<KiteAccessToken> & { error?: string };
  if (!res.ok || !body.access_token) {
    throw new Error(
      body.error ?? `Failed to fetch access token (HTTP ${res.status}).`,
    );
  }
  return {
    api_key: body.api_key ?? "",
    access_token: body.access_token,
    login_date: body.login_date ?? "",
  };
}

/**
 * Read the current admin-set risk-free rate (%) from the backend (public).
 * Returns null when the admin hasn't set one yet, so callers keep their default.
 */
export async function getRfRate(): Promise<number | null> {
  try {
    const res = await fetch(`${API_BASE_URL}/api/rf/current`);
    if (!res.ok) return null;
    const body = (await res.json()) as { rf?: number | null };
    return typeof body.rf === "number" ? body.rf : null;
  } catch {
    return null;
  }
}

/**
 * Sync the admin's risk-free rate (%) to the backend (full admin only) so it
 * can be read back over the API. Best-effort: callers typically ignore errors.
 */
export async function setRfRate(rf: number): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/api/rf`, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify({ rf }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Failed to sync rf (HTTP ${res.status}).`);
  }
}

/** Backend health/auth status. */
export async function getStatus(): Promise<{ authenticated: boolean }> {
  const res = await fetch(`${API_BASE_URL}/api/status`);
  if (!res.ok) throw new Error(`Backend not reachable (HTTP ${res.status}).`);
  return res.json();
}

/** Forget the Kite session on the backend (logout; full admin only). */
export async function logout(): Promise<void> {
  await fetch(`${API_BASE_URL}/api/logout`, {
    method: "POST",
    headers: getHeaders(),
  }).catch(() => {
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

/** One row of the F&O board: a stock with its spot token + nearest futures. */
export interface BoardFuture {
  token: number;
  expiry: string; // YYYY-MM-DD
  lot_size: number;
}

export interface BoardItem {
  symbol: string;
  name: string;
  spot_token: number;
  futures: BoardFuture[];
  is_index?: boolean;
}

/** Fetch the full F&O board (every stock + its spot + 3 nearest futures). */
export async function fetchFnoBoard(
  q?: string,
): Promise<{ count: number; board: BoardItem[] }> {
  const qs = q ? `?q=${encodeURIComponent(q)}` : "";
  const res = await fetch(`${API_BASE_URL}/api/fno-board${qs}`);
  const body = (await res.json()) as {
    count: number;
    board: BoardItem[];
    error?: string;
  };
  if (!res.ok) {
    throw new Error(body.error ?? `Failed to load board (HTTP ${res.status}).`);
  }
  return body;
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
  oi?: number; // open interest (F&O only)
  bid?: number; // best bid
  ask?: number; // best ask
  bids?: { price: number; qty: number; orders: number }[];
  asks?: { price: number; qty: number; orders: number }[];
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
  const url = `${API_BASE_URL}/api/stream?tokens=${tokens.join(",")}`;
  return adminToken ? `${url}&x-admin-token=${encodeURIComponent(adminToken)}` : url;
}

/**
 * One-time snapshot of last price + close for the given tokens (REST).
 * Works regardless of market hours, so values/premiums show even after close.
 */
export async function fetchQuotes(tokens: number[]): Promise<Tick[]> {
  const headers: HeadersInit = {};
  if (adminToken) {
    headers["x-admin-token"] = adminToken;
  }
  const res = await fetch(`${API_BASE_URL}/api/quotes?tokens=${tokens.join(",")}`, { headers });
  const body = (await res.json()) as { ticks: Tick[]; error?: string };
  if (!res.ok) {
    throw new Error(body.error ?? `Failed to load quotes (HTTP ${res.status}).`);
  }
  return body.ticks;
}

// ---------------- Historical spread (2-year daily) ----------------

export interface SpreadHistoryPoint {
  date: string;
  spread: number;
}

export interface SpreadHistoryStats {
  mean: number;
  max: number;
  min: number;
  count: number;
}

export interface SpreadHistory {
  symbol: string;
  name: string;
  is_index: boolean;
  dataRange: { from: string; to: string };
  points: SpreadHistoryPoint[];
  stats: SpreadHistoryStats;
}

/** Fetch up to 2 years of daily spread history for a symbol. */
export async function fetchSpreadHistory(symbol: string): Promise<SpreadHistory> {
  const res = await fetch(
    `${API_BASE_URL}/api/spread-history/${encodeURIComponent(symbol)}`,
    { headers: getHeaders() },
  );
  const body = (await res.json()) as SpreadHistory & { error?: string };
  if (!res.ok) {
    throw new Error(body.error ?? `Failed to load spread history (HTTP ${res.status}).`);
  }
  return body;
}

// ---------------- Spread summary statistics ----------------

export interface SpreadStats {
  symbol: string;
  observations: number;
  first_date: string;
  last_date: string;
  mean_spread: number;
  std_dev_spread: number;
  max_spread: number;
  min_spread: number;
  mean_deviation: number;
  max_abs_spread: number;
  percentile_95: number;
  mean_reversion_probability: number;
}

/** Fetch spread summary statistics for a symbol. Returns null on 404. */
export async function fetchSpreadStats(symbol: string): Promise<SpreadStats | null> {
  const res = await fetch(
    `${API_BASE_URL}/api/spread-stats/${encodeURIComponent(symbol)}`,
    { headers: getHeaders() },
  );
  if (res.status === 404) return null;
  const body = (await res.json()) as SpreadStats & { error?: string };
  if (!res.ok) {
    throw new Error(body.error ?? `Failed to load spread stats (HTTP ${res.status}).`);
  }
  return body;
}

/** Annual dividend yield (%) per stock symbol, from Yahoo Finance (cached). */
export async function fetchDividends(): Promise<Record<string, number>> {
  const res = await fetch(`${API_BASE_URL}/api/dividends`);
  const body = (await res.json()) as {
    yields?: Record<string, number>;
    error?: string;
  };
  if (!res.ok) {
    throw new Error(body.error ?? `Failed to load dividends (HTTP ${res.status}).`);
  }
  return body.yields ?? {};
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


// ---------------- Options analytics: live option chain ----------------

/** One strike row of the option chain (CE + PE instrument tokens). */
export interface OptionChainStrike {
  strike: number;
  ce_token: number;
  pe_token: number;
  ce_symbol: string;
  pe_symbol: string;
}

/** ATM-centered option-chain band returned by GET /api/option-chain/:underlying. */
export interface OptionChain {
  underlying: string;
  name: string;
  spot_token: number;
  spot: number;
  atm_strike: number;
  expiry: string;
  expiries: string[];
  lot_size: number;
  strikes: OptionChainStrike[];
}

/**
 * Fetch the ATM-centered option chain (CE/PE tokens per strike) for an index
 * or stock. The band is generous (ATM ± ~40) so the frontend can recompute the
 * live ATM from the streamed spot tick and still show ATM ± 30.
 */
export async function fetchOptionChain(
  underlying: string,
  expiry?: string,
): Promise<OptionChain> {
  const qs = expiry ? `?expiry=${encodeURIComponent(expiry)}` : "";
  const res = await fetch(
    `${API_BASE_URL}/api/option-chain/${encodeURIComponent(underlying)}${qs}`,
    { headers: getHeaders() },
  );
  const body = (await res.json()) as OptionChain & { error?: string };
  if (!res.ok) {
    throw new Error(
      body.error ?? `Failed to load option chain (HTTP ${res.status}).`,
    );
  }
  return body;
}


/**
 * Per-token OI + LTP as of `minutes` ago, from the backend's per-day intraday
 * cache. Used as the baseline for 5m/15m OI-change % and OI-buildup, so those
 * values are correct immediately on load at any time of day.
 */
export interface OptionOiBaseline {
  day: string;
  expiry: string | null;
  minutes: number;
  tokens: Record<number, { oi: number; ltp: number; t: number }>;
}

export async function fetchOptionOiBaseline(
  underlying: string,
  minutes: number,
): Promise<OptionOiBaseline> {
  const res = await fetch(
    `${API_BASE_URL}/api/option-oi-baseline/${encodeURIComponent(underlying)}?minutes=${minutes}`,
    { headers: getHeaders() },
  );
  const body = (await res.json()) as OptionOiBaseline & { error?: string };
  if (!res.ok) {
    throw new Error(body.error ?? `Failed to load OI baseline (HTTP ${res.status}).`);
  }
  return body;
}

/** One captured minute of aggregate intraday option-OI data. */
export interface OptionOiSeriesPoint {
  t: number;
  totalCe: number;
  totalPe: number;
  straddle: number;
}

export interface OptionOiSeries {
  day: string;
  expiry: string | null;
  points: OptionOiSeriesPoint[];
}

/** Full-day per-minute aggregates (total Call/Put OI + ATM straddle) for charts. */
export async function fetchOptionOiSeries(underlying: string): Promise<OptionOiSeries> {
  const res = await fetch(
    `${API_BASE_URL}/api/option-oi-series/${encodeURIComponent(underlying)}`,
    { headers: getHeaders() },
  );
  const body = (await res.json()) as OptionOiSeries & { error?: string };
  if (!res.ok) {
    throw new Error(body.error ?? `Failed to load OI series (HTTP ${res.status}).`);
  }
  return body;
}


/** Timeframe for the multi-frame Call/Put OI history chart. */
export type OiFrame = "1m" | "5m" | "15m";

export interface OptionOiFramePoint {
  t: number;
  totalCe: number;
  totalPe: number;
}

export interface OptionOiFrameResponse {
  frame: OiFrame;
  intervalMin: number;
  retentionMs: number;
  points: OptionOiFramePoint[];
}

/**
 * Retained Call/Put total-OI (24↑/ATM/26↓) history for one timeframe:
 * 1m (last 1 day), 5m (last 3 days) or 15m (last 1 week). Backed by the
 * server's per-frame caches (filled live + backfilled from Kite on downtime).
 */
export async function fetchOptionOiFrame(
  underlying: string,
  frame: OiFrame,
): Promise<OptionOiFrameResponse> {
  const res = await fetch(
    `${API_BASE_URL}/api/option-oi-frame/${encodeURIComponent(underlying)}?frame=${frame}`,
    { headers: getHeaders() },
  );
  const body = (await res.json()) as OptionOiFrameResponse & { error?: string };
  if (!res.ok) {
    throw new Error(body.error ?? `Failed to load OI frame (HTTP ${res.status}).`);
  }
  return body;
}
