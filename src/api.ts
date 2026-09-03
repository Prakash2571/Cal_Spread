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
  | "below_expected_net_profit"
  | "execution_failed"
  | "unpriced_charges"
  | "duplicate_open"
  | "stale_underlying"
  | "market_closed"
  | "implausible_close";

/** Which way a box is traded. Absent on old data means a long box. */
export type BoxDirection = "LONG_BOX" | "SHORT_BOX";

/** How an entry is executed: three paper models, or real broker orders. */
export type BoxExecutionMode = "paper_touch" | "paper_latency" | "paper_legging" | "live";

/**
 * Which broker a record belongs to.
 *
 * Only ONE broker is ever active for new trades, but history from both coexists,
 * so every trade carries its own. Absent on data written before broker identity
 * existed, which means Zerodha — the only broker the app ever had.
 */
export type BrokerId = "zerodha" | "dhan";

/** Compact badge text for a broker. */
export function brokerLabel(broker: BrokerId | null | undefined): string {
  return broker === "dhan" ? "DHAN" : "ZERODHA";
}

/**
 * Where a charge figure came from.
 *
 * The `dhan` values exist because Dhan's brokerage differs from Zerodha's: a Dhan
 * trade's costs must never be displayed as if Zerodha had priced them.
 */
export type BoxChargeOrigin =
  | "local"
  | "kite"
  | "local_verified"
  | "dhan"
  | "dhan_estimate";

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
  /** Which way this box is traded. */
  direction: BoxDirection;
  entry_box_cost: number | null;
  gross_edge: number | null;
  entry_charges: number | null;
  estimated_exit_charges: number | null;
  /** Expected execution/slippage cost carried in the projection (₹). */
  execution_cost: number;
  safety_buffer: number;
  projected_net_edge: number | null;
  /** gross - entryFees - estExitFees - executionCost - buffer (the entry gate). */
  expected_net_profit: number | null;
  min_expected_net_profit: number;
  /** Whether the charge figures are locally computed or Zerodha-verified. */
  charge_origin: BoxChargeOrigin;
  /** The four entry orders, so the direction's sides are unambiguous. */
  entry_sides: { role: BoxLegRole; side: BoxSide; tradingsymbol: string }[];
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
  /** THE ENTRY GATE: minimum expected NET profit (₹) after every cost. */
  min_expected_net_profit: number;
  /** A cheap gross prefilter (₹) — never the decision. */
  min_gross_edge: number;
  /** Legacy additional net floor; 0 means it does not raise the gate. */
  min_net_edge: number;
  /** How an entry is executed, and its simulated delays (paper modes only). */
  execution_mode: BoxExecutionMode;
  simulated_decision_ms: number;
  simulated_latency_ms: number;
  expected_entry_slippage: number;
  expected_exit_slippage: number;
  enable_short_box: boolean;
  directions: BoxDirection[];
  min_captured_pct: number;
  reconcile_charges: boolean;
  charge_reconcile_warn_pct: number;
  require_priced_charges: boolean;
  safety_buffer: number;
  /** How long an UNCHANGED book is still trusted. */
  quote_max_age_ms: number;
  /** Feed-liveness limit: newest tick across the whole universe. */
  feed_max_age_ms: number;
  underlying_max_age_ms: number;
  /** The MAXIMUM strikes each side (the ATM ±3 cap). */
  strikes_each_side: number;
  /** The ACTIVE admin-selected level (1, 2 or 3), never above the cap. */
  strike_level: number;
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
  universe: string;
  /** paper_legging controls (present on newer backends). */
  leg_execution_mode?: "parallel" | "sequential";
  leg_timeout_ms?: number;
  /** Whether the exit floor is judged on realisable net pre-execution. */
  exit_use_realisable_net?: boolean;
  /** Whether the last-close view covers the whole universe with the scanner off. */
  indicative_discovery?: boolean;
  /** Whether today's closed trades are mirrored to Redis for a fast read. */
  closed_cache_enabled?: boolean;
  /** The thresholds an admin may change from the UI, with their bounds. */
  tunable?: {
    min_expected_net_profit: { min: number; max: number };
    safety_buffer: { min: number; max: number };
  };
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
  execution_mode: BoxExecutionMode;
  /** The broker that owns the feed, scanner and execution right now. */
  broker?: BrokerId;
  /** Distinct brokers holding open exposure — normally just the active one. */
  brokers_with_open_positions?: BrokerId[];
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
  /**
   * APPROXIMATE lag behind the exchange, from Kite's second-resolution
   * exchange_timestamp. Distinct from feed_age_ms (a liveness heartbeat): this
   * estimates how stale the data is versus NSE. null until a timestamped packet
   * has been seen.
   */
  exchange_lag_ms: {
    median_ms: number;
    p95_ms: number;
    last_ms: number;
    samples: number;
  } | null;
  /** The active strikes-each-side level (1, 2 or 3). */
  strike_level: number;
  open_positions: number;
  /**
   * Running day P&L: open positions' current net + trades closed today.
   * Optional — absent on a backend built before this field existed.
   */
  day_pnl?: BoxDayPnl;
  skipped_for_budget: number;
  skipped_symbols: string[];
  /**
   * Underlyings left out of the LAST-CLOSE PREVIEW by its own cap — a display
   * limit while the market is shut, NOT the live-feed token budget above.
   * Optional: absent on a backend built before the preview cap existed.
   */
  skipped_indicative_cap?: number;
  skipped_indicative_symbols?: string[];
  indicative_max_underlyings?: number;
  scanner: {
    ticksApplied: number;
    evaluations: number;
    prefilterPasses: number;
    qualifyAttempts: number;
    executionsAttempted: number;
    entriesOpened: number;
    rejectedStale: number;
    rejectedLiquidity: number;
    rejectedNetProfit: number;
    rejectedExecution: number;
    rejectedDuplicate: number;
    lastEvaluationAt: number | null;
    /** Execution-simulation headline figures. */
    simulated_entries_attempted: number;
    simulated_entries_filled: number;
    simulated_entries_failed: number;
    active_execution_pipelines: number;
  };
  monitor: {
    cycles: number;
    exitsTriggered: number;
    exitsSkippedLiquidity: number;
    exitsFailedExecution?: number;
    lastCycleAt: number | null;
    running: boolean;
  };
  charges: { calls: number; hits: number; misses: number; failures: number; inFlight: number };
  /** Asynchronous charge reconciliation against Zerodha. */
  reconciliation?: {
    queued: number;
    completed: number;
    failed: number;
    skipped: number;
    warnings: number;
    max_abs_diff: number;
    last_abs_diff: number | null;
    last_pct_diff: number | null;
    pending: number;
    in_flight: number;
    enabled: boolean;
    warn_pct: number;
  };
  /** Rolling latency / slippage / throughput distributions. */
  metrics?: BoxMetricsSnapshot;
  last_error: string | null;
  config: BoxConfigView;
}

/**
 * The day's running P&L, as computed by the backend: the sum of open positions'
 * current net P&L plus the realised net of trades closed today. When the Redis
 * cache is enabled this figure is also mirrored to Upstash and archived nightly.
 */
export interface BoxDayPnl {
  day: string;
  open_count: number;
  open_running_net_pnl: number;
  open_running_gross_pnl: number;
  closed_count: number;
  closed_realised_net_pnl: number;
  closed_realised_gross_pnl: number;
  /** Open running net + today's realised net — the day's running total (₹). */
  total_net_pnl: number;
  total_gross_pnl: number;
  /**
   * MARGIN DEPLOYED TODAY (₹): the Zerodha basket margin these boxes blocked.
   *
   * `total_margin_used` is a SUM over the day, not a peak: boxes that opened and
   * closed at different times never held their margin at the same moment, so it is
   * an upper bound on what was blocked at any one instant. Optional — absent on a
   * backend built before these fields existed.
   */
  open_margin_used?: number;
  closed_margin_used?: number;
  /** @deprecated Identical to `cumulative_trade_margin`; kept for older dashboards. */
  total_margin_used?: number;
  /** Explicit SUM over the day (open + closed) — never a concurrent/peak figure. */
  cumulative_trade_margin?: number;
  /**
   * Highest OPEN margin actually observed at a sampled instant since the backend
   * process started. `null` until a first sample exists — NEVER back-filled or
   * estimated for time before the process was running.
   */
  peak_concurrent_margin?: number | null;
  /** Boxes whose margin call never returned, so they are missing from the sums. */
  margin_unknown_count?: number;
  /** Whether the Redis (Upstash) P&L cache is actively mirroring this figure. */
  cache_enabled: boolean;
  /** ISO time the cache was last written, or null. */
  last_cached_at: string | null;
}

/** A rolling distribution summary from a bounded ring buffer. */
export interface RingSummary {
  samples: number;
  count: number;
  last: number | null;
  mean: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
}

export interface BoxMetricsSnapshot {
  execution: {
    /**
     * PARENT strategy-attempt lifecycle: one entry per detected candidate that
     * actually entered an order pipeline. Internal leg/order retries never
     * change this number — see `retries` below.
     */
    attempted: number;
    /** completed = successful + failed + partial_recovered + partial_unresolved + aborted. */
    completed: number;
    successful: number;
    partial_recovered: number;
    partial_unresolved: number;
    failed: number;
    aborted: number;
    /** Internal leg/order retries inside an attempt — never a new attempt. */
    retries: number;
    /** @deprecated Alias for `successful`, kept for older dashboards. */
    filled: number;
    /** (failed + partial_unresolved) / completed. */
    failure_rate: number;
    /** successful / completed. */
    success_rate: number;
    /** Fixed rejection taxonomy (stale/depth/edge/latency/etc.), keyed by reason. */
    rejection_categories: Record<string, number>;
    /** @deprecated Alias for `rejection_categories`. */
    failures_by_reason: Record<string, number>;
    /**
     * Detection expected net − realised expected net at actual fill prices (₹).
     * Positive means the mispricing decayed/worsened between detection and fill.
     */
    decision_deterioration: RingSummary | null;
    /**
     * Arrival-book execution slippage (₹): fill vs. the ARRIVAL reference book
     * (BUY: fill−arrival, SELL: arrival−fill), × filled quantity. Zero is a valid,
     * meaningful reading when the fill matched the captured arrival book exactly
     * — it is not the same as "unmeasured" (see `samples` on the ring summary).
     */
    execution_slippage: RingSummary | null;
    /** @deprecated Legacy detection-touch comparison; prefer `execution_slippage`. */
    entry_slippage: RingSummary | null;
    exit_slippage: RingSummary | null;
    decision_to_fill_ms: RingSummary | null;
    qualification_to_fill_ms: RingSummary | null;
    /** Latency broken into its components; a component absent for this mode is null. */
    latency: {
      detection_to_decision_ms: RingSummary | null;
      decision_to_order_send_ms: RingSummary | null;
      simulated_or_real_order_latency_ms: RingSummary | null;
      /** live-only. */
      order_send_to_ack_ms: RingSummary | null;
      /** live-only. */
      ack_to_fill_ms: RingSummary | null;
      detection_to_fill_ms: RingSummary | null;
    };
    /** Terminal calls that conflicted with an already-resolved attempt (diagnostic only). */
    terminal_conflicts: number;
  };
  latency: {
    receive_to_evaluation_ms: RingSummary | null;
    event_loop_lag_ms: RingSummary | null;
  };
  throughput: {
    evaluations_per_sec: number;
    ws_updates_per_sec: number;
    ticks_per_sec: number;
    evaluations_total: number;
    ws_updates_total: number;
  };
  charges: {
    reconciliations: number;
    failed_reconciliations: number;
    warnings: number;
    discrepancy_rupees: RingSummary | null;
    discrepancy_pct: RingSummary | null;
  };
  /** paper_legging execution-health rollup (present once the mode has run). */
  legging?: {
    outcomes: {
      "4_of_4": number;
      "3_of_4": number;
      "2_of_4": number;
      "1_of_4": number;
      "0_of_4": number;
      total: number;
      aborts: number;
    };
    fill_rate_4_of_4: number;
    failure_rate_3_of_4: number;
    failure_rate_2_of_4: number;
    failure_rate_1_of_4: number;
    legging_net_loss: RingSummary | null;
    first_to_last_fill_ms: RingSummary | null;
    most_failing_role: { role: string; count: number } | null;
    failing_roles: Record<string, number>;
    expected_vs_realised_net: RingSummary | null;
  };
}

/** A paper_legging execution attempt that did not open a box. */
export interface BoxExecutionAttempt {
  candidate_key: string;
  direction: BoxDirection;
  underlying: string;
  name: string;
  is_index: boolean;
  expiry: string;
  lower_strike: number;
  upper_strike: number;
  lot_size: number;
  quantity: number;
  execution_mode: BoxExecutionMode;
  leg_execution_mode: "parallel" | "sequential" | null;
  detected_at: string;
  resolved_at: string;
  detected_gross_edge: number | null;
  expected_net_profit: number | null;
  filled_leg_count: number;
  failed_legs: string[];
  failure_reason: string | null;
  failure_detail: string | null;
  partial_entry_charges: number | null;
  unwind_charges: number | null;
  gross_abort_pnl: number | null;
  net_abort_pnl: number | null;
}

/** One live open box position with its current exit arithmetic. */
export interface BoxOpenPosition {
  id: string;
  key: string;
  execution_mode: BoxExecutionMode;
  /** Which broker created this position. Absent on legacy rows ⇒ zerodha. */
  broker?: BrokerId;
  underlying: string;
  name: string;
  is_index: boolean;
  expiry: string;
  direction: BoxDirection;
  lower_strike: number;
  upper_strike: number;
  box_width: number;
  lot_size: number;
  quantity: number;
  opened_at: string;
  /** Net basket margin the four legs block, captured at entry (₹), or null. */
  margin: number | null;
  entry_box_cost: number;
  entry_gross_edge: number;
  entry_charges: number | null;
  estimated_exit_charges_at_entry: number | null;
  safety_buffer: number;
  entry_net_edge: number;
  expected_net_profit: number | null;
  entry_execution_cost: number | null;
  charge_origin: BoxChargeOrigin;
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
  /** Net P&L after the execution/slippage allowance — what an exit realistically nets. */
  realisable_net_pnl: number | null;
  estimated_execution_cost: number;
  remaining_edge: number | null;
  /** Convergence progress. */
  entry_edge: number;
  captured_edge: number | null;
  captured_pct: number | null;
  time_in_trade_ms: number | null;
  convergence_threshold: number;
  min_exit_net_pnl: number;
  profit_capture_target: number;
  min_captured_pct: number;
  liquidity_ok: boolean;
  worst_age_ms: number | null;
  exit_eligible: boolean;
  exit_reason: BoxExitReason | null;
  exit_rule_reason: BoxExitReason | null;
  /** Why it is being held, or why an eligible exit is blocked. */
  blocked_reason: string | null;
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
  detected_price?: number | null;
  entry_slippage?: number | null;
  exit_price: number | null;
  exit_bid: number | null;
  exit_bid_qty: number | null;
  exit_ask: number | null;
  exit_ask_qty: number | null;
  exit_quote_at: string | null;
  exit_detected_price?: number | null;
  exit_slippage?: number | null;
}

/** The verdict of an asynchronous Zerodha charge reconciliation. */
export interface BoxChargeReconciliation {
  status: "pending" | "verified" | "failed";
  local_total: number | null;
  reconciled_total: number | null;
  abs_diff: number | null;
  pct_diff: number | null;
  at: string | null;
  error: string | null;
}

/** A persisted box paper trade (open or closed). */
export interface BoxTrade {
  id: string;
  execution_mode: BoxExecutionMode;
  /** Which broker created this trade. Absent on legacy rows ⇒ zerodha. */
  broker?: BrokerId;
  underlying: string;
  name: string;
  is_index: boolean;
  expiry: string;
  direction: BoxDirection;
  lower_strike: number;
  upper_strike: number;
  lot_size: number;
  quantity: number;
  status: "open" | "closed" | "error";
  legs: BoxTradeLeg[];
  box_width: number;
  margin: number | null;
  entry_box_cost: number;
  entry_gross_edge: number;
  entry_charges: TradeCharges | null;
  estimated_exit_charges: TradeCharges | null;
  safety_buffer: number;
  entry_net_edge: number;
  expected_net_profit: number | null;
  entry_execution_cost: number | null;
  charge_origin: BoxChargeOrigin;
  entry_charge_reconciliation: BoxChargeReconciliation | null;
  exit_charge_reconciliation: BoxChargeReconciliation | null;
  opened_at: string;
  current_remaining_edge: number | null;
  current_captured_edge: number | null;
  current_captured_pct: number | null;
  exit_box_value: number | null;
  exit_charges: TradeCharges | null;
  gross_pnl: number | null;
  total_charges: number | null;
  net_pnl: number | null;
  /** Realised net of a closed trade (actual fills, no forward allowance). */
  realised_net_pnl?: number | null;
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

/** paper_legging execution attempts that aborted (partial fill + emergency unwind). */
export async function fetchBoxExecutionAttempts(limit = 100): Promise<BoxExecutionAttempt[]> {
  const res = await fetch(`${API_BASE_URL}/api/box/execution-attempts?limit=${limit}`, {
    headers: getHeaders(),
  });
  const body = await readJson<{ attempts: BoxExecutionAttempt[] }>(
    res,
    "Failed to load box execution attempts",
  );
  return body.attempts ?? [];
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

/**
 * ADMIN: set how many strikes each side of ATM are monitored/traded (1, 2 or 3).
 *
 * From when it is set, only boxes within ATM ±level are discovered and entered.
 * Positions already open are NOT affected — the backend keeps monitoring and
 * exiting them on their own rules regardless of the new width.
 */
export async function setBoxStrikeLevel(level: 1 | 2 | 3): Promise<BoxStatus> {
  const res = await fetch(`${API_BASE_URL}/api/box/strike-level`, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify({ level }),
  });
  const body = await readJson<{ ok?: boolean; strike_level: number; status: BoxStatus }>(
    res,
    "Failed to set the box strike level",
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

/** Which tier of the backend's closed-trade store answered a history request. */
export type BoxHistorySource = "memory" | "redis" | "mongo" | "none";

export interface BoxHistoryResponse {
  dbEnabled: boolean;
  trades: BoxTrade[];
  /** "today" for the fast path, "all" for the full book. Older backends omit it. */
  scope?: "today" | "all";
  /** Where the rows came from, so a slow path is visible rather than mysterious. */
  source?: BoxHistorySource;
  /** The IST day a "today" response covers. */
  day?: string;
  /** Whether the Redis accelerator for today's trades is configured. */
  cacheEnabled?: boolean;
  /**
   * True when the execution-audit blobs (`entry_execution`, `entry_legging`,
   * `exit_execution`, per-leg depth) have been stripped from these rows.
   *
   * The fast "today" path serves stripped rows — the Closed-trades table renders
   * none of that, and caching depth ladders would be wasteful. It matters on merge:
   * a stripped row must not overwrite a full one already held.
   */
  lite?: boolean;
}

/**
 * Closed box trades.
 *
 * `scope: "today"` is the FAST path — the backend answers it from memory, or from
 * Redis after a restart, never with a full-book Mongo sort. The page asks for that
 * first so the current session appears immediately, then fetches the whole book in
 * the background where a slower load does not matter.
 */
export async function fetchBoxHistory(
  limit = 300,
  scope: "today" | "all" = "all",
): Promise<BoxHistoryResponse> {
  const qs =
    scope === "today" ? "?scope=today" : `?scope=all&limit=${encodeURIComponent(limit)}`;
  const res = await fetch(`${API_BASE_URL}/api/box/trades/history${qs}`, {
    headers: getHeaders(),
  });
  return readJson<BoxHistoryResponse>(res, "Failed to load box trade history");
}

/**
 * ADMIN: set the live entry gate (₹ expected net) and/or safety buffer (₹).
 *
 * Persisted server-side, so it survives a restart and is shared by every browser.
 * Applies to NEW boxes only — positions already open are never re-judged against a
 * changed threshold.
 */
export async function saveBoxSettings(patch: {
  min_expected_net_profit?: number;
  safety_buffer?: number;
}): Promise<{ config: BoxConfigView; status: BoxStatus }> {
  const res = await fetch(`${API_BASE_URL}/api/box/settings`, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify(patch),
  });
  return readJson<{ ok?: boolean; config: BoxConfigView; status: BoxStatus }>(
    res,
    "Failed to save the box settings",
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

/** What the backend returns after a successful Box trade deletion. */
export interface BoxDeleteResult {
  deleted_id: string;
  /** The corrected status — counts, day P&L and margin already recomputed. */
  status: BoxStatus;
  /** The corrected open-position list. */
  open: BoxOpenPosition[];
  /** The corrected closed-today list, so the Closed tab updates at once. */
  closed_today: {
    trades: BoxTrade[];
    source?: BoxHistorySource;
    day?: string;
    lite?: boolean;
  };
}

/**
 * PERMANENTLY delete a PAPER box trade (open, closed or errored).
 *
 * FULL ADMIN ONLY and irreversible. The backend REFUSES a live trade with 409 —
 * an open one because real broker exposure may still exist, a closed one because
 * it is the audit record of real executed orders — and that message is surfaced
 * to the user as-is rather than reworded.
 *
 * The response carries the already-recomputed status, open positions and
 * closed-today list, so the caller can apply corrected numbers immediately
 * without a reload or a second round trip.
 */
export async function deleteBoxTrade(
  id: string,
  reason?: string,
): Promise<BoxDeleteResult> {
  const res = await fetch(`${API_BASE_URL}/api/box/trades/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: getHeaders(),
    ...(reason ? { body: JSON.stringify({ reason }) } : {}),
  });
  return readJson<BoxDeleteResult>(res, "Failed to delete the box trade");
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
