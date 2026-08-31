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

/**
 * Parse a JSON response, or throw an error that names what actually happened.
 *
 * `await res.json()` before checking `res.ok` looks harmless because the backend
 * always answers JSON - but a proxy does not. An nginx 502 or a gateway timeout
 * page is HTML, so `res.json()` threw FIRST and the carefully-worded
 * "… (HTTP 502)." message on the next line was unreachable; what surfaced instead
 * was `Unexpected token '<', "<html>"…`. Reading the body as text and parsing it
 * ourselves means a non-JSON failure still reports its status.
 *
 * `what` is the bare description ("Failed to load OI frame"); the status is
 * appended here so every endpoint phrases the failure the same way.
 */
async function readJson<T>(res: Response, what: string): Promise<T> {
  const text = await res.text().catch(() => "");
  let body: (T & { error?: string }) | null = null;
  try {
    body = text ? (JSON.parse(text) as T & { error?: string }) : null;
  } catch {
    // Not JSON - fall through to the status-based message below.
  }
  if (!res.ok) throw new Error(body?.error ?? `${what} (HTTP ${res.status}).`);
  // A 200 that isn't JSON is still a failure, and saying so beats handing the
  // caller `null` typed as if it were a valid payload.
  if (body === null) throw new Error(`${what}: the server sent an unreadable reply.`);
  return body;
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

/** One order's charges from Zerodha's virtual contract note. */
export interface TradeLegCharges {
  side: "BUY" | "SELL";
  tradingsymbol: string;
  quantity: number;
  price: number;
  value: number;
  brokerage: number;
  stt: number;
  stt_type: string;
  exchange_txn: number;
  sebi: number;
  stamp_duty: number;
  gst: number;
  total: number;
}

/**
 * Charges for one side of a trade (both legs), as billed by Zerodha.
 * `source` is "kite" for the real contract note and "kite_estimate" when the
 * exit is projected at the entry fills (an open trade, or a close where the
 * charges call failed).
 */
export interface TradeCharges {
  legs: TradeLegCharges[];
  value: number;
  brokerage: number;
  stt: number;
  exchange_txn: number;
  sebi: number;
  stamp_duty: number;
  gst: number;
  total: number;
  source: "kite" | "kite_estimate";
  at: string;
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
  /** Realized P&L from the price move (the fills are real bid/ask, so slippage
   *  is included). Charges are reported separately and NOT deducted. */
  close_pnl: number | null;
  buy_close: number | null;
  sell_close: number | null;
  margin: number | null;
  /** Real charges on the entry fills. Null for trades taken before charges
   *  were tracked, or when Zerodha couldn't price them. */
  entry_charges: TradeCharges | null;
  /** Real charges on the exit fills - set when the trade is closed. */
  exit_charges: TradeCharges | null;
  /** Exit charges projected at the entry fills, so an open trade can be shown
   *  net of the whole round trip. */
  est_exit_charges: TradeCharges | null;
  entry_value: number | null;
  exit_value: number | null;
  /** entry + exit charges, set on close. */
  total_charges: number | null;
  /** close_pnl - total_charges. */
  net_pnl: number | null;
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

/** Fetch ~3 months of daily closing price + open interest for a symbol's futures. */
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
  return readJson<OptionChain>(res, "Failed to load option chain");
}


/**
 * Per-token OI + LTP as of `minutes` ago, from the backend's Redis-backed chain
 * snapshots. Used as the baseline for the 1m/5m/15m/1h OI-change % and buildup
 * columns, so those values are correct immediately on load at any time of day.
 *
 * `tokens` is EMPTY when the cache doesn't reach back `minutes` - the server
 * returns nothing rather than a newer reading, so a 20-minute-old value can never
 * be presented as a 1-hour change.
 */
export interface OptionOiBaseline {
  day: string;
  expiry: string | null;
  minutes: number;
  /** Oldest/newest snapshot the cache holds (epoch ms), or null when empty. */
  oldest: number | null;
  newest: number | null;
  /** Timestamp of the snapshot actually used, or null when none was old enough. */
  baseT: number | null;
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
  return readJson<OptionOiBaseline>(res, "Failed to load OI baseline");
}

/**
 * Previous session's closing OI + LTP per option token - the baseline for the
 * chain's "Day" change column. `tokens` is empty until the server has a baseline
 * valid for today.
 */
export interface OptionPrevClose {
  forDay: string;
  closedOn: string | null;
  expiry: string | null;
  /** False while the server still has strikes left to reconstruct. */
  complete?: boolean;
  tokens: Record<number, { oi: number; ltp: number }>;
}

export async function fetchOptionPrevClose(
  underlying: string,
): Promise<OptionPrevClose> {
  const res = await fetch(
    `${API_BASE_URL}/api/option-prev-close/${encodeURIComponent(underlying)}`,
    { headers: getHeaders() },
  );
  return readJson<OptionPrevClose>(res, "Failed to load previous close");
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
  return readJson<OptionOiSeries>(res, "Failed to load OI series");
}


/**
 * Timeframe for the multi-frame OI history charts.
 *
 * Retention per frame on the server: 1m -> 1 day, 5m -> 3 days, 15m -> 7 days,
 * 1h -> 7 days. The longer frames are what make a 2-day or 1-week look-back
 * possible without holding every minute. 1h matches 15m deliberately: retention is
 * pruned against CALENDAR time, so anything shorter than a week is worth only two
 * or three sessions once a weekend falls inside it.
 */
export type OiFrame = "1m" | "5m" | "15m" | "1h";
/** Selectable frames, in display order. */
export const OI_FRAME_OPTIONS: OiFrame[] = ["1m", "5m", "15m", "1h"];

export interface OptionOiFramePoint {
  t: number;
  totalCe: number;
  totalPe: number;
  straddle: number;
  spot: number;
  /**
   * Inclusive strike bounds the totals were summed over.
   *
   * Two totals are only comparable when they cover the SAME strikes, so a change
   * histogram must check these before differencing - see sameWindow in Analytics.
   * The server pins the window per session, so within a session they are constant
   * and every delta survives; they differ across a re-pin (a new session, or a
   * backfill that started mid-session), and there the delta is correctly dropped.
   *
   * Absent on buckets the server wrote before it published them.
   */
  wLo?: number;
  wHi?: number;
  /**
   * Present when the server knows this bucket UNDERSTATES its window - a quote
   * response that missed strikes, or a reconstruction whose history for one of
   * them was unavailable. The server publishes it and keeps trying to rebuild it,
   * so a client must treat it as "no reading" rather than as a real dip.
   */
  partial?: 1;
}

export interface OptionOiFrameResponse {
  frame: OiFrame;
  intervalMin: number;
  retentionMs: number;
  points: OptionOiFramePoint[];
}

/**
 * Retained Call/Put total-OI (24↑/ATM/26↓) history for one timeframe:
 * 1m (last 1 day), 5m (last 3 days), 15m or 1h (last 1 week). Backed by the
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
  return readJson<OptionOiFrameResponse>(res, "Failed to load OI frame");
}

/** One NIFTY monthly futures contract tracked by the futures-OI frames. */
export interface FuturesOiContract {
  token: number;
  tradingsymbol: string;
  expiry: string;
  lot_size: number;
}

/** One contract's OI + price within a futures-OI point (keyed by expiry). */
export interface FuturesOiLeg {
  expiry: string;
  oi: number;
  ltp: number;
}

export interface FuturesOiPoint {
  t: number;
  legs: FuturesOiLeg[];
}

export interface FuturesOiFrameResponse {
  frame: OiFrame;
  intervalMin: number;
  retentionMs: number;
  contracts: FuturesOiContract[];
  points: FuturesOiPoint[];
}

/**
 * Retained NIFTY futures open-interest history for one timeframe: 1m (last 1
 * day), 5m (last 3 days), 15m or 1h (last 1 week). Each point carries one leg per
 * tracked monthly contract (current/next/far), so the client can plot all three
 * as separate series.
 */
export async function fetchFuturesOiFrame(
  underlying: string,
  frame: OiFrame,
): Promise<FuturesOiFrameResponse> {
  const res = await fetch(
    `${API_BASE_URL}/api/futures-oi-frame/${encodeURIComponent(underlying)}?frame=${frame}`,
    { headers: getHeaders() },
  );
  return readJson<FuturesOiFrameResponse>(res, "Failed to load futures OI frame");
}


// ============================================================================
//  Box arbitrage (PAPER trading)
//
//  A long box on strikes K1 < K2 is BUY K1 CE / SELL K2 CE / BUY K2 PE /
//  SELL K1 PE. It pays a fixed (K2 - K1) per unit at expiry, so the edge is the
//  difference between that width and what the four legs cost at the executable
//  touch.
//
//  These fills are SIMULATED. Nothing here places a real exchange order — see
//  execution_mode, which is always "paper_touch".
// ============================================================================

export type BoxLegRole = "k1_ce" | "k2_ce" | "k2_pe" | "k1_pe";
export type BoxSide = "BUY" | "SELL";
export type BoxExitReason =
  | "EDGE_CONVERGED"
  | "PROFIT_CAPTURE"
  | "MANUAL"
  | "EXPIRY_SAFETY";

/** Why a candidate was not eligible for an automatic paper entry. */
export type BoxRejectReason =
  | "no_quote"
  | "stale_quote"
  | "missing_bid"
  | "missing_ask"
  | "insufficient_qty"
  | "below_gross_prefilter"
  | "below_net_edge"
  | "unpriced_charges"
  | "duplicate_open"
  | "stale_underlying"
  | "market_closed";

/** Per-leg liquidity/freshness detail behind an opportunity. */
export interface BoxLegEvaluation {
  role: BoxLegRole;
  side: BoxSide;
  token: number;
  tradingsymbol: string;
  strike: number;
  instrument_type: "CE" | "PE";
  /** Executable price for this side: ask for BUY, bid for SELL. */
  price: number | null;
  /** Quantity resting at exactly that touch price. */
  qty_at_touch: number;
  bid: number;
  bid_qty: number;
  ask: number;
  ask_qty: number;
  quote_at: number | null;
  age_ms: number | null;
  fresh: boolean;
  executable: boolean;
}

export type BoxOpportunityStatus =
  | "WATCHING"
  /** Market shut: a last-close view only, never enterable. */
  | "INDICATIVE"
  | "UNPRICED"
  | "ELIGIBLE"
  | "PAPER_OPENED"
  | "OPEN"
  | "REJECTED";

export interface BoxOpportunity {
  key: string;
  underlying: string;
  name: string;
  is_index: boolean;
  expiry: string;
  lower_strike: number;
  upper_strike: number;
  box_width: number;
  lot_size: number;
  quantity: number;
  entry_box_cost: number | null;
  gross_edge: number | null;
  entry_charges: number | null;
  estimated_exit_charges: number | null;
  safety_buffer: number;
  projected_net_edge: number | null;
  /** Fresh AND one lot on all four legs. */
  liquidity_ok: boolean;
  /** One whole lot on all four legs, ignoring how quiet the book is. */
  depth_ok: boolean;
  worst_age_ms: number | null;
  /** "touch" = executable bid/ask (tradable). "last_close" = market shut. */
  price_source: "touch" | "last_close";
  status: BoxOpportunityStatus;
  reject: BoxRejectReason | null;
  legs: BoxLegEvaluation[];
  updated_at: number;
}

export interface BoxConfigView {
  /** THE ENTRY GATE: minimum GROSS edge (₹) from the spread alone. */
  min_gross_edge: number;
  /** Optional additional net floor; 0 means fees do not gate entry. */
  min_net_edge: number;
  require_priced_charges: boolean;
  safety_buffer: number;
  /** How long an UNCHANGED book is still trusted. */
  quote_max_age_ms: number;
  /** Feed-liveness limit: newest tick across the whole universe. */
  feed_max_age_ms: number;
  underlying_max_age_ms: number;
  strikes_each_side: number;
  max_strikes: number;
  max_candidates_per_underlying: number;
  prefilter_gross_threshold: number;
  convergence_floor: number;
  convergence_pct: number;
  min_exit_net_pnl: number;
  profit_capture_pct: number;
  expiry_safety_minutes: number;
  max_subscribed_tokens: number;
  lots: number;
  execution_mode: "paper_touch";
  universe: string;
}

export interface BoxStatus {
  running: boolean;
  state: "SCANNING" | "MARKET_CLOSED" | "STOPPED";
  /** Always true: open positions are managed by the backend regardless of RUN. */
  monitoring: boolean;
  /** False → prices shown are last-close and nothing can be entered. */
  market_open: boolean;
  indicative_at: number | null;
  indicative_priced: number;
  /** The trading day the last-close prices come from. */
  indicative_session_day: string | null;
  /** Legs discarded because they last traded in an earlier session. */
  indicative_stale_legs: number;
  execution_mode: "paper_touch";
  authenticated: boolean;
  db_enabled: boolean;
  started_at: number | null;
  stopped_at: number | null;
  universe_built_at: number | null;
  underlyings: number;
  candidates: number;
  monitored_tokens: number;
  subscribed_option_tokens: number;
  subscribed_spot_tokens: number;
  hub_subscribed: number;
  hub_connected: boolean;
  quotes: number;
  quote_updates: number;
  /** Age of the newest tick anywhere in the universe, and the verdict. */
  feed_age_ms: number | null;
  feed_healthy: boolean;
  open_positions: number;
  skipped_for_budget: number;
  skipped_symbols: string[];
  scanner: {
    ticksApplied: number;
    evaluations: number;
    prefilterPasses: number;
    chargeAttempts: number;
    entriesOpened: number;
    rejectedStale: number;
    rejectedLiquidity: number;
    rejectedFees: number;
    rejectedDuplicate: number;
    lastEvaluationAt: number | null;
  };
  monitor: {
    cycles: number;
    exitsTriggered: number;
    exitsSkippedLiquidity: number;
    lastCycleAt: number | null;
    running: boolean;
  };
  charges: { calls: number; hits: number; misses: number; failures: number; inFlight: number };
  last_error: string | null;
  config: BoxConfigView;
}

/** One live open box position with its current exit arithmetic. */
export interface BoxOpenPosition {
  id: string;
  key: string;
  execution_mode: "paper_touch";
  underlying: string;
  name: string;
  is_index: boolean;
  expiry: string;
  lower_strike: number;
  upper_strike: number;
  box_width: number;
  lot_size: number;
  quantity: number;
  opened_at: string;
  entry_box_cost: number;
  entry_gross_edge: number;
  entry_charges: number | null;
  estimated_exit_charges_at_entry: number | null;
  safety_buffer: number;
  entry_net_edge: number;
  entry_legs: {
    role: BoxLegRole;
    side: BoxSide;
    tradingsymbol: string;
    strike: number;
    instrument_type: "CE" | "PE";
    entry_price: number;
  }[];
  exit_legs: {
    role: BoxLegRole;
    side: BoxSide;
    tradingsymbol: string;
    price: number | null;
    bid: number;
    bid_qty: number;
    ask: number;
    ask_qty: number;
    age_ms: number | null;
    executable: boolean;
    fresh: boolean;
  }[];
  exit_box_value: number | null;
  gross_pnl: number | null;
  current_exit_charges: number | null;
  total_charges: number | null;
  net_pnl: number | null;
  remaining_edge: number | null;
  convergence_threshold: number;
  min_exit_net_pnl: number;
  profit_capture_target: number;
  liquidity_ok: boolean;
  worst_age_ms: number | null;
  exit_eligible: boolean;
  exit_reason: BoxExitReason | null;
  exit_rule_reason: BoxExitReason | null;
  exit_blocked_reason: string | null;
  expiry_safety: boolean;
  status: "open";
}

/** One leg of a persisted box trade. */
export interface BoxTradeLeg {
  role: BoxLegRole;
  token: number;
  tradingsymbol: string;
  exchange: string;
  strike: number;
  instrument_type: "CE" | "PE";
  side: BoxSide;
  entry_price: number;
  entry_bid: number;
  entry_bid_qty: number;
  entry_ask: number;
  entry_ask_qty: number;
  entry_quote_at: string | null;
  exit_price: number | null;
  exit_bid: number | null;
  exit_bid_qty: number | null;
  exit_ask: number | null;
  exit_ask_qty: number | null;
  exit_quote_at: string | null;
}

/** A persisted box paper trade (open or closed). */
export interface BoxTrade {
  id: string;
  execution_mode: "paper_touch";
  underlying: string;
  name: string;
  is_index: boolean;
  expiry: string;
  lower_strike: number;
  upper_strike: number;
  lot_size: number;
  quantity: number;
  status: "open" | "closed" | "error";
  legs: BoxTradeLeg[];
  box_width: number;
  entry_box_cost: number;
  entry_gross_edge: number;
  entry_charges: TradeCharges | null;
  estimated_exit_charges: TradeCharges | null;
  safety_buffer: number;
  entry_net_edge: number;
  opened_at: string;
  current_remaining_edge: number | null;
  exit_box_value: number | null;
  exit_charges: TradeCharges | null;
  gross_pnl: number | null;
  total_charges: number | null;
  net_pnl: number | null;
  closed_at: string | null;
  exit_reason: BoxExitReason | null;
  exit_blocked_reason: string | null;
  expiry_safety: boolean;
  error: string | null;
}

/** One side of a strike row in the ATM±3 box chain. */
export interface BoxChainSide {
  token: number;
  tradingsymbol: string;
  bid: number;
  bid_qty: number;
  ask: number;
  ask_qty: number;
  last: number;
  age_ms: number | null;
  /** e.g. ["BUY_CE"] — the box legs this contract takes part in. */
  marks: string[];
}

export interface BoxChain {
  underlying: string;
  name: string;
  is_index: boolean;
  expiry: string;
  lot_size: number;
  quantity: number;
  atm_strike: number;
  strike_step: number;
  spot: number;
  spot_age_ms: number;
  strikes: {
    strike: number;
    is_atm: boolean;
    ce: BoxChainSide | null;
    pe: BoxChainSide | null;
  }[];
}

export interface BoxChainSymbol {
  underlying: string;
  name: string;
  is_index: boolean;
  expiry: string;
}

export async function fetchBoxStatus(): Promise<BoxStatus> {
  const res = await fetch(`${API_BASE_URL}/api/box/status`, { headers: getHeaders() });
  return readJson<BoxStatus>(res, "Failed to load box scanner status");
}

export async function fetchBoxConfig(): Promise<BoxConfigView> {
  const res = await fetch(`${API_BASE_URL}/api/box/config`, { headers: getHeaders() });
  return readJson<BoxConfigView>(res, "Failed to load box configuration");
}

/** RUN: start discovering and auto-opening paper boxes. */
export async function startBoxScanner(): Promise<BoxStatus> {
  const res = await fetch(`${API_BASE_URL}/api/box/start`, {
    method: "POST",
    headers: getHeaders(),
  });
  const body = await readJson<{ ok?: boolean; status: BoxStatus }>(
    res,
    "Failed to start the box scanner",
  );
  return body.status;
}

/**
 * STOP: stop opening NEW paper boxes.
 *
 * Positions already open keep being monitored and can still auto-exit — that is
 * enforced on the backend, not here.
 */
export async function stopBoxScanner(): Promise<BoxStatus> {
  const res = await fetch(`${API_BASE_URL}/api/box/stop`, {
    method: "POST",
    headers: getHeaders(),
  });
  const body = await readJson<{ ok?: boolean; status: BoxStatus }>(
    res,
    "Failed to stop the box scanner",
  );
  return body.status;
}

export async function fetchBoxOpportunities(
  limit?: number,
): Promise<{ opportunities: BoxOpportunity[]; status: BoxStatus }> {
  const qs = limit ? `?limit=${limit}` : "";
  const res = await fetch(`${API_BASE_URL}/api/box/opportunities${qs}`, {
    headers: getHeaders(),
  });
  return readJson<{ opportunities: BoxOpportunity[]; status: BoxStatus }>(
    res,
    "Failed to load box opportunities",
  );
}

/** The underlyings that currently have a monitored ATM±3 window. */
export async function fetchBoxChainSymbols(): Promise<BoxChainSymbol[]> {
  const res = await fetch(`${API_BASE_URL}/api/box/chains`, { headers: getHeaders() });
  const body = await readJson<{ chains: BoxChainSymbol[] }>(res, "Failed to load box chains");
  return body.chains ?? [];
}

/** The ATM±3 option chain of one underlying, with box legs marked. */
export async function fetchBoxChain(underlying: string): Promise<BoxChain> {
  const res = await fetch(
    `${API_BASE_URL}/api/box/chains?underlying=${encodeURIComponent(underlying)}`,
    { headers: getHeaders() },
  );
  return readJson<BoxChain>(res, "Failed to load box option chain");
}

/** Live open box positions (in-memory on the server, so this is cheap). */
export async function fetchBoxOpenTrades(): Promise<{
  dbEnabled: boolean;
  open: BoxOpenPosition[];
}> {
  const res = await fetch(`${API_BASE_URL}/api/box/trades/open`, { headers: getHeaders() });
  return readJson<{ dbEnabled: boolean; open: BoxOpenPosition[] }>(
    res,
    "Failed to load open box trades",
  );
}

/** Open + closed box trades from the database, newest first. */
export async function fetchBoxTrades(): Promise<{
  dbEnabled: boolean;
  open: BoxOpenPosition[];
  trades: BoxTrade[];
}> {
  const res = await fetch(`${API_BASE_URL}/api/box/trades`, { headers: getHeaders() });
  return readJson<{ dbEnabled: boolean; open: BoxOpenPosition[]; trades: BoxTrade[] }>(
    res,
    "Failed to load box trades",
  );
}

export async function fetchBoxHistory(limit = 300): Promise<{
  dbEnabled: boolean;
  trades: BoxTrade[];
}> {
  const res = await fetch(`${API_BASE_URL}/api/box/trades/history?limit=${limit}`, {
    headers: getHeaders(),
  });
  return readJson<{ dbEnabled: boolean; trades: BoxTrade[] }>(
    res,
    "Failed to load box trade history",
  );
}

/**
 * Close an open box at the current executable touch.
 *
 * POST (not DELETE) to match the backend's CORS allow-list. The server REFUSES
 * with 409 when the four-leg one-lot market is unavailable rather than inventing
 * a price, and that message is surfaced to the user as-is.
 */
export async function closeBoxTrade(id: string): Promise<BoxOpenPosition[]> {
  const res = await fetch(`${API_BASE_URL}/api/box/trades/${encodeURIComponent(id)}/close`, {
    method: "POST",
    headers: getHeaders(),
  });
  const body = await readJson<{ ok?: boolean; open: BoxOpenPosition[] }>(
    res,
    "Failed to close the box position",
  );
  return body.open ?? [];
}

/** SSE URL for live box state (token in the query: EventSource cannot set headers). */
export function boxStreamUrl(): string {
  const url = `${API_BASE_URL}/api/box/stream`;
  return adminToken ? `${url}?x-admin-token=${encodeURIComponent(adminToken)}` : url;
}

/** The payload of a `snapshot` frame on the box stream. */
export interface BoxSnapshot {
  status: BoxStatus;
  opportunities: BoxOpportunity[];
  open_trades: BoxOpenPosition[];
}
