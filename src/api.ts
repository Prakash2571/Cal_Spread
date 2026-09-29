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

import { StaleBrokerTokensError } from "./apiErrors.ts";
import type { EventSourceLike, TickStreamDeps } from "./tickStream.ts";

const API_BASE_URL = normalizeBaseUrl(
  import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3001",
);

/** The backend origin, exposed so diagnostics can report real request sizes. */
export const API_ORIGIN = API_BASE_URL;

export { StaleBrokerTokensError, StreamSessionExpiredError } from "./apiErrors.ts";

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
export interface AdminVerifyResult {
  success: boolean;
  token: string;
  /** The broker that is active after this verification. */
  broker?: BrokerId;
  /**
   * Set when the requested broker could NOT be activated because Box exposure or
   * in-flight work exists. The login still succeeds — otherwise the operator could
   * never reach the UI to clear whatever is blocking the switch — so the session
   * stays on the previous broker and this explains why.
   */
  brokerSwitchRefused?: boolean;
  brokerSwitchBlockers?: { reason: string; detail: string }[];
}

export async function verifyAdminSecret(
  secret: string,
  broker?: BrokerId,
): Promise<AdminVerifyResult> {
  const res = await fetch(`${API_BASE_URL}/api/admin/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // `broker` is omitted entirely when not chosen, so an older backend that does
    // not understand it behaves exactly as before.
    body: JSON.stringify(broker ? { secret, broker } : { secret }),
  });
  const body = (await res.json()) as {
    success?: boolean;
    token?: string;
    broker?: BrokerId;
    broker_switch_refused?: boolean;
    broker_switch_blockers?: { reason: string; detail: string }[];
    error?: string;
  };
  if (!res.ok) {
    throw new Error(body.error ?? `Admin verification failed (HTTP ${res.status}).`);
  }
  return {
    success: !!body.success,
    token: body.token ?? "",
    ...(body.broker ? { broker: body.broker } : {}),
    ...(body.broker_switch_refused ? { brokerSwitchRefused: true } : {}),
    ...(body.broker_switch_blockers ? { brokerSwitchBlockers: body.broker_switch_blockers } : {}),
  };
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
  /**
   * The ACTIVE broker. Reported to both roles: a trade-access user inherits it and
   * needs to know which broker they are looking at, they just cannot change it.
   *
   * NOTE `authenticated` here is the ADMIN session, never a broker session. Broker
   * connectivity comes from fetchBrokerStatus().
   */
  broker?: BrokerId;
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
/**
 * Runtime readiness of the ACTIVE broker.
 *
 * `authenticated` used to mean "Zerodha has a session", which made the whole app
 * unusable with Dhan active: the browser saw false, never opened SSE, and showed
 * `LTP -` behind a "Connect to Zerodha" banner. It now means THE ACTIVE BROKER can
 * serve market data.
 *
 * The separate fields exist so a single boolean is never overloaded again: a broker can
 * be authenticated but not data-ready, data-ready but not trading-ready, and connected
 * but with nothing subscribed.
 */
export interface RuntimeStatus {
  status: string;
  /** The ACTIVE broker's market data is usable. */
  authenticated: boolean;
  broker?: BrokerId;
  broker_authenticated?: boolean;
  market_data_ready?: boolean;
  feed_connected?: boolean;
  feed_state?: "DOWN" | "CONNECTING" | "CONNECTED_NO_SUBSCRIPTIONS" | "LIVE" | "STALE";
  trading_ready?: boolean;
  problems?: string[];
  generation?: number;
  /** Zerodha's OWN session. For the admin UI only — never gates market data. */
  zerodha_session?: boolean;
}

export async function getStatus(): Promise<RuntimeStatus> {
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

/**
 * URL for the live SSE tick stream, LEGACY query-string form.
 *
 * Only safe for SMALL token lists. A full board (~816 tokens x 10 digits) produces a
 * ~9 KB request line, and nginx rejects a request line larger than one header buffer
 * (8 KB by default) with 414 before the backend ever sees it — which is exactly why the
 * board showed no prices at all. Use `createStreamSession` + `sessionStreamUrl` for
 * anything board-sized; `chunkTokens` bounds this path when it is used as a fallback.
 */
export function streamUrl(tokens: number[]): string {
  const url = `${API_BASE_URL}/api/stream?tokens=${tokens.join(",")}`;
  return adminToken ? `${url}&x-admin-token=${encodeURIComponent(adminToken)}` : url;
}

export interface StreamSession {
  id: string;
  tokens: number;
  broker: BrokerId;
  generation: number;
}

/**
 * Exchange a token list for a short stream-session id.
 *
 * The tokens travel in a POST BODY, so the subsequent SSE URL is a constant ~60 bytes
 * no matter how large the board grows. `EventSource` cannot send a body itself, which
 * is why this is a separate round trip rather than one request.
 */
export async function createStreamSession(tokens: number[]): Promise<StreamSession> {
  const res = await fetch(`${API_BASE_URL}/api/stream/session`, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify({ tokens }),
  });
  const body = (await res.json().catch(() => ({}))) as Partial<StreamSession> & { error?: string };
  if (res.status === 409) {
    throw new StaleBrokerTokensError(body.error ?? "Board belongs to a previous broker.");
  }
  if (!res.ok || !body.id) {
    throw new Error(body.error ?? `Could not open a market-data session (HTTP ${res.status}).`);
  }
  return {
    id: body.id,
    tokens: body.tokens ?? tokens.length,
    broker: (body.broker ?? "zerodha") as BrokerId,
    generation: body.generation ?? 0,
  };
}

/** SSE URL for a stream session. Constant size, independent of the token count. */
export function sessionStreamUrl(id: string): string {
  return `${API_BASE_URL}/api/stream/session/${encodeURIComponent(id)}`;
}

/**
 * One-time snapshot of last price + close for the given tokens (REST).
 *
 * POSTs the token list: as a GET the full board exceeded nginx's request-line limit and
 * returned 414, so the price seed silently failed and cells stayed "-" even after
 * market hours, when the snapshot is the ONLY source of data.
 */
export async function fetchQuotes(tokens: number[]): Promise<Tick[]> {
  const res = await fetch(`${API_BASE_URL}/api/quotes`, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify({ tokens }),
  });
  const body = (await res.json().catch(() => ({}))) as { ticks?: Tick[]; error?: string };
  if (res.status === 409) {
    throw new StaleBrokerTokensError(body.error ?? "Board belongs to a previous broker.");
  }
  if (!res.ok) {
    throw new Error(body.error ?? `Failed to load quotes (HTTP ${res.status}).`);
  }
  return body.ticks ?? [];
}

/** Live market-data health. Public: it drives the banner every visitor sees. */
export interface MarketDataStatus {
  broker: BrokerId;
  generation: number;
  subscriptions: {
    browser: number;
    scanner: number;
    strategy: number;
    analytics: number;
    tokens: number;
    leases: number;
  };
  sessions: { sessions: number; connections: number; tokens: number };
  feed: {
    state: "DOWN" | "CONNECTING" | "CONNECTED_NO_SUBSCRIPTIONS" | "LIVE" | "STALE";
    connected: boolean;
    subscribed: number;
    universe: number | null;
    feed_age_ms: number | null;
    last_tick_at: number | null;
    detail: string;
  };
  upstream: {
    broker: BrokerId;
    wanted: number | null;
    subscribed: number | null;
    socket_connected: boolean;
    last_tick_at: number | null;
  };
}

export async function getMarketDataStatus(): Promise<MarketDataStatus> {
  const res = await fetch(`${API_BASE_URL}/api/market-data/status`);
  if (!res.ok) throw new Error(`Market-data status unavailable (HTTP ${res.status}).`);
  return res.json();
}

/**
 * The real browser transports for `TickStream`.
 *
 * Lives here, next to the transport code, so `tickStream.ts` needs no browser globals
 * and stays unit-testable with fakes.
 */
export function browserTickStreamDeps(): TickStreamDeps {
  return {
    createSession: createStreamSession,
    sessionUrl: sessionStreamUrl,
    legacyUrl: streamUrl,
    makeEventSource: (url) => new EventSource(url) as unknown as EventSourceLike,
  };
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

/* ============================================================================
 *  Box EXECUTION CONTROL
 *
 *  The backend is the authority for every value here. Nothing in this section may
 *  be treated as a source of truth by the UI: `deployment_live_capable` in
 *  particular is a STARTUP fact on the server, so no click can change it, and the
 *  UI's job is to report it honestly rather than to offer a control that cannot work.
 * ========================================================================== */

/** Which execution model is selected. `live` is not runtime-selectable. */
export type BoxExecutionSelection =
  | "paper_latency"
  | "paper_legging"
  | "paper_legging_live_parity"
  | "live";

/** One reason a mode transition or arming step is refused. */
export interface BoxExecutionBlocker {
  code: string;
  detail: string;
}

/** The session lifecycle state, mirroring the backend's BoxSessionState. */
export type BoxSessionState =
  | "IDLE"
  | "ARMED"
  | "ENTRY_IN_PROGRESS"
  | "POSITION_OPEN"
  | "EXIT_IN_PROGRESS"
  | "COMPLETED"
  | "BLOCKED"
  | "RECOVERY";

export interface BoxSessionView {
  /** False ⇒ the cycle budget is not being enforced (unlimited, or no durable persistence). */
  enforcing: boolean;
  /** True ⇒ a consumed cycle could not be persisted; entry is closed until it lands. */
  write_failed: boolean;
  state: BoxSessionState;
  session_id: string | null;
  armed: boolean;
  armed_at: number | null;
  /** An admin ROLE label ("full" / "trade"), never a token. */
  armed_by: string | null;
  /** 0 = unlimited. */
  max_completed_trades: number;
  completed_trades: number;
  /** Cycles CONSUMED at establishment. This is what gates new entry. */
  consumed_cycles: number;
  /** null when unlimited. */
  remaining_trades: number | null;
  current_trade_id: string | null;
  in_flight_trade_ids: string[];
  aborted_attempts: number;
  arm_count: number;
  block_reason: string | null;
  /** False when durable session state could not be READ. Entry fails closed. */
  readable: boolean;
}

/** One underlying carrying (or possibly carrying) Box exposure. */
export interface BoxActiveUnderlying {
  underlying: string;
  kinds: string[];
}

/**
 * The Box execution control surface.
 *
 * Mirrors `GET /api/box/execution-control`. Every field is a report, never a
 * request: the backend validates independently of anything the UI believes.
 */
export interface BoxExecutionControl {
  execution_mode: "paper_touch" | "paper_latency" | "paper_legging" | "live";
  paper_execution_profile: "standard" | "live_parity" | "stress";
  broker: BrokerId;
  /** IMMUTABLE for the server process. No UI action can make this true. */
  deployment_live_capable: boolean;
  live_capability_detail: string;
  /** Live exposure MANAGEMENT is armed (exits, cancels, flatten). */
  live_runtime_armed: boolean;
  /** NEW ENTRY is permitted. Independent of the above, deliberately. */
  entry_enabled: boolean;
  emergency_flatten_enabled: boolean;

  mode: {
    selection: BoxExecutionSelection;
    /** e.g. "LIVE · ZERODHA", "PAPER · LEGGING LIVE-PARITY". */
    label: string;
    runtime_selectable: BoxExecutionSelection[];
    live_requires_restart: boolean;
    transition_blockers: BoxExecutionBlocker[];
  };

  session: BoxSessionView;

  risk: {
    /** Per-Box GROSS ENTRY-ORDER NOTIONAL cap (₹). 0 = disabled. NOT broker margin. */
    /** The ENFORCED per-Box cap (₹). 0 = disabled. Live-only; paper does not enforce it. */
    max_box_capital_rupees: number;
    max_box_capital_metric: string;
    /** The paper mirror's configured value. Advisory: NOT enforced. */
    paper_max_box_capital_rupees: number;
    /** True only when a cap is both configured AND actually being enforced. */
    max_box_capital_enforced: boolean;
    capital: {
      enabled: boolean;
      configured_max_rupees: number;
      last_calculated_rupees: number | null;
      last_stage: string | null;
      last_allowed: boolean | null;
      last_at: number | null;
    };
    one_active_box_per_underlying: boolean;
    active_underlyings: BoxActiveUnderlying[];
    claimed_underlyings: string[];
    max_open_boxes: number;
    open_boxes: number;
    residual_legs: number;
    daily_loss_limit: number;
    realised_pnl_today: number | null;
  };

  execution: {
    live_entry_submit_concurrency: number;
    max_concurrent_executions: number;
    /** Poll/read pacing (ms). */
    effective_broker_min_interval_ms: number;
    /** ORDER-MUTATION pacing (ms). A real rate limit; never zero. */
    effective_broker_order_min_interval_ms: number;
    broker_order_interval_floor_ms: number;
    broker_order_interval_source: string;
    broker_pacing_rationale: string;
    pacing_source_of_truth: "adapter" | "config_projection";
    four_leg_burst_pacing_budget_ms: number;
    entry_burst: {
      configured_entry_submit_concurrency: number;
      base_concurrency: number;
      peak_entry_submissions_in_flight: number;
      burst_slot_grants: number;
      base_in_flight: number;
      burst_in_flight: number;
      entry_attempt_in_flight: string | null;
    } | null;
    queued: number;
    in_flight: number;
    circuit: string;
    /** Always false. Reported as data so it can be verified from the UI. */
    artificial_latency_applied_to_live: boolean;
    paper_only_simulated_decision_ms: number;
    paper_only_simulated_latency_ms: number;
  };

  arm: {
    preconditions: Record<string, boolean | number>;
    entry: { ok: boolean; blockers?: BoxExecutionBlocker[] };
    exposure_management: { ok: boolean; blockers?: BoxExecutionBlocker[] };
    emergency_flatten: { ok: boolean; blockers?: BoxExecutionBlocker[] };
  };

  block_reason: string | null;
  block_detail: string | null;
}

/** The verdict of a requested execution-mode change, WITHOUT applying it. */
export type BoxModeTransitionVerdict =
  | { outcome: "allowed"; from: BoxExecutionSelection; to: BoxExecutionSelection }
  | {
      outcome: "restart_required";
      from: BoxExecutionSelection;
      to: BoxExecutionSelection;
      detail: string;
      envChanges: string[];
      blockers: BoxExecutionBlocker[];
    }
  | {
      outcome: "refused";
      from: BoxExecutionSelection;
      to: BoxExecutionSelection;
      blockers: BoxExecutionBlocker[];
    };

export async function fetchBoxExecutionControl(): Promise<BoxExecutionControl> {
  const res = await fetch(`${API_BASE_URL}/api/box/execution-control`, { headers: getHeaders() });
  return readJson<BoxExecutionControl>(res, "Failed to load the box execution control state");
}

/**
 * Ask what a mode change WOULD do, without doing it.
 *
 * Used to render an honest answer — including "restart required" and the exact
 * environment variables involved — rather than offering a selector that fails.
 */
export async function previewBoxExecutionMode(
  selection: BoxExecutionSelection,
): Promise<BoxModeTransitionVerdict> {
  const res = await fetch(`${API_BASE_URL}/api/box/execution-mode/preview`, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify({ selection }),
  });
  return readJson<BoxModeTransitionVerdict>(res, "Failed to preview the execution mode change");
}

/**
 * Change the PAPER execution profile. FULL ADMIN.
 *
 * Only paper profiles are runtime-selectable. LIVE is unreachable from here at any
 * privilege level — `BOX_EXECUTION_MODE` is a startup-only construction boundary on
 * the server, which is what guarantees a paper deployment holds no object able to
 * place a real order.
 */
export async function setBoxPaperProfile(
  profile: "standard" | "live_parity" | "stress",
): Promise<BoxExecutionControl> {
  const res = await fetch(`${API_BASE_URL}/api/box/execution-mode/paper-profile`, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify({ profile }),
  });
  const body = await readJson<{ ok?: boolean; execution: BoxExecutionControl }>(
    res,
    "Failed to change the paper execution profile",
  );
  return body.execution;
}

/**
 * ARM a trading session. FULL ADMIN.
 *
 * `maxCompletedTrades` is optional; omitted, the server's configured
 * `BOX_SESSION_MAX_COMPLETED_TRADES` is used. The value is SNAPSHOTTED server-side,
 * so a later config change cannot widen a session already armed. The server refuses
 * (409) while any consumed cycle still has live exposure, and that message is
 * surfaced as-is.
 */
export async function armBoxSession(
  maxCompletedTrades?: number,
): Promise<{ session: BoxSessionView; execution: BoxExecutionControl }> {
  const res = await fetch(`${API_BASE_URL}/api/box/session/arm`, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify(
      maxCompletedTrades === undefined ? {} : { max_completed_trades: maxCompletedTrades },
    ),
  });
  return readJson<{ ok?: boolean; session: BoxSessionView; execution: BoxExecutionControl }>(
    res,
    "Failed to arm the box trading session",
  );
}

/** DISARM the session. Counters are preserved server-side, never cleared. */
export async function disarmBoxSession(): Promise<{
  session: BoxSessionView;
  execution: BoxExecutionControl;
}> {
  const res = await fetch(`${API_BASE_URL}/api/box/session/disarm`, {
    method: "POST",
    headers: getHeaders(),
  });
  return readJson<{ ok?: boolean; session: BoxSessionView; execution: BoxExecutionControl }>(
    res,
    "Failed to disarm the box trading session",
  );
}

/**
 * Toggle one live control. FULL ADMIN.
 *
 * The three are INDEPENDENT on purpose: `box_entry_enabled` opens NEW exposure,
 * `box_live_order_enabled` manages existing exposure, and `box_emergency_flatten`
 * is the emergency brake. Enabling one never implies another, and the server
 * enforces that regardless of what the UI sends.
 */
export async function setBoxLiveControl(
  control: "box_entry_enabled" | "box_live_order_enabled" | "box_emergency_flatten",
  enabled: boolean,
): Promise<BoxStatus> {
  const res = await fetch(`${API_BASE_URL}/api/box/controls/${control}`, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify({ enabled }),
  });
  const body = await readJson<{ ok?: boolean; status: BoxStatus }>(
    res,
    `Failed to set ${control}`,
  );
  return body.status;
}

/* ============================================================================
 *  Broker management + Dhan authentication
 *
 *  Only AUTHENTICATION/SETUP is broker-specific. Every data call (board, quotes,
 *  history, minute, Box) stays broker-agnostic: the backend routes it to whichever
 *  broker is active, so there are no dhanFetchBoard()/kiteFetchBoard() pairs.
 * ========================================================================== */

/** One reason a broker switch was refused. */
export interface BrokerSwitchBlocker {
  reason: string;
  detail: string;
}

/** Session state of one broker. Never contains a token. */
export interface BrokerSession {
  broker: BrokerId;
  /** The BROKER session is usable — not merely that the admin password was accepted. */
  authenticated: boolean;
  client_id: string | null;
  client_name: string | null;
  token_expires_at: number | null;
  token_expired: boolean;
  login_day: string | null;
  login_at: number | null;
}

/**
 * Capability readiness, split so data and trading fail independently.
 *
 * Dhan order placement needs static-IP whitelisting that market data does not, so a
 * deployment can legitimately be data-ready and trading-blocked.
 */
export interface BrokerHealth {
  broker: BrokerId;
  authenticated: boolean;
  token_expires_at: number | null;
  token_expired: boolean;
  data_ready: boolean;
  trading_ready: boolean;
  /** null for brokers with no such requirement (Zerodha) — not false. */
  static_ip_configured: boolean | null;
  feed_connected: boolean;
  feed_age_ms: number | null;
  problems: string[];
}

/** The full static-IP picture: what the operator declared vs what Dhan holds. */
export interface DhanStaticIpState {
  ready: boolean;
  declared: boolean;
  configured_ip: string | null;
  /** true (matched), false (mismatch/unreachable), null (never checked). */
  api_verified: boolean | null;
  primary_ip: string | null;
  secondary_ip: string | null;
  checked_at: number | null;
  error: string | null;
}

/** Truthful feed state — connection AND subscriptions AND data arrival. */
export interface FeedHealthView {
  state: "DOWN" | "CONNECTING" | "CONNECTED_NO_SUBSCRIPTIONS" | "LIVE" | "STALE";
  connected: boolean;
  subscribed: number;
  universe: number | null;
  feed_age_ms: number | null;
  last_tick_at: number | null;
  detail: string;
}

export interface BrokerStatus {
  broker: BrokerId;
  generation?: number;
  feed?: FeedHealthView;
  subscriptions?: {
    browser: number;
    scanner: number;
    strategy: number;
    analytics: number;
    tokens: number;
    leases: number;
  };
  instruments?: number;
  instruments_loaded_at?: number | null;
  session: BrokerSession;
  health: BrokerHealth;
  dhan_configured: boolean;
  dhan_instruments: number;
  dhan_instruments_loaded_at: number | null;
  dhan_static_ip?: DhanStaticIpState;
  last_margin_source?: string | null;
}

/** The active broker with its session and readiness. Any admin role may read it. */
export async function fetchBrokerStatus(): Promise<BrokerStatus> {
  const res = await fetch(`${API_BASE_URL}/api/broker/status`, { headers: getHeaders() });
  return readJson<BrokerStatus>(res, "Failed to load the broker status");
}

/** Why a switch would be refused, without attempting it. Lets the UI pre-warn. */
export async function fetchBrokerSwitchBlockers(
  broker: BrokerId,
): Promise<{ broker: BrokerId; blockers: BrokerSwitchBlocker[] }> {
  const res = await fetch(
    `${API_BASE_URL}/api/broker/switch-blockers?broker=${encodeURIComponent(broker)}`,
    { headers: getHeaders() },
  );
  return readJson(res, "Failed to check the broker switch");
}

/**
 * Switch the active broker. FULL ADMIN only.
 *
 * Throws with the backend's 409 message when Box exposure or in-flight work exists;
 * the blockers are attached so the UI can list every one instead of surfacing them a
 * single refusal at a time.
 */
export async function selectBroker(broker: BrokerId): Promise<BrokerStatus> {
  const res = await fetch(`${API_BASE_URL}/api/broker/select`, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify({ broker }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      blockers?: BrokerSwitchBlocker[];
    };
    const err = new Error(body.error ?? `Failed to select ${broker} (HTTP ${res.status}).`) as Error & {
      blockers?: BrokerSwitchBlocker[];
    };
    if (body.blockers) err.blockers = body.blockers;
    throw err;
  }
  return readJson<BrokerStatus>(res, "Failed to select the broker");
}

/** Dhan session + readiness. Never includes the access token or the API secret. */
export interface DhanStatus {
  broker: "dhan";
  active: boolean;
  configured: boolean;
  authenticated: boolean;
  token_expired: boolean;
  token_expires_at: number | null;
  data_ready: boolean;
  trading_ready: boolean;
  static_ip_configured: boolean | null;
  feed_connected: boolean;
  feed_age_ms: number | null;
  problems: string[];
  instruments: number;
  session: {
    client_id: string;
    client_name: string;
    client_ucc: string;
    power_of_attorney: boolean;
    token_expires_at: number | null;
    token_expired: boolean;
    login_date: string;
    login_at: string | null;
  } | null;
}

export async function fetchDhanStatus(): Promise<DhanStatus> {
  const res = await fetch(`${API_BASE_URL}/api/dhan/status`, { headers: getHeaders() });
  return readJson<DhanStatus>(res, "Failed to load the Dhan status");
}

/**
 * STEP 1 of the Dhan login: ask the backend for the browser login URL.
 *
 * The consent is generated server-side because it needs the API secret, which must
 * never reach the browser. The caller then navigates to `login_url`.
 */
export async function beginDhanLogin(): Promise<{ login_url: string; consent_app_id: string }> {
  const res = await fetch(`${API_BASE_URL}/api/dhan/login`, {
    method: "POST",
    headers: getHeaders(),
  });
  return readJson<{ login_url: string; consent_app_id: string }>(
    res,
    "Failed to start the Dhan login",
  );
}

/**
 * STEP 3: hand the redirect's `tokenId` to the backend, which exchanges it for a
 * session and keeps the token server-side.
 *
 * The tokenId is SINGLE-USE, so the caller must guard against React StrictMode's
 * double effect invocation — exactly as the Zerodha flow does.
 */
export async function createDhanSession(tokenId: string): Promise<{
  authenticated: boolean;
  broker: BrokerId;
  client_id: string | null;
  client_name: string | null;
  token_expires_at: number | null;
}> {
  const res = await fetch(`${API_BASE_URL}/api/dhan/session`, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify({ tokenId }),
  });
  return readJson(res, "Failed to complete the Dhan login");
}

/**
 * Re-verify the configured server IP against Dhan's whitelist.
 *
 * Exposed as an explicit action because the verdict is cached server-side: after
 * whitelisting an address in the Dhan dashboard, this is what picks it up without
 * waiting for a restart or a broker switch.
 */
export async function verifyDhanIp(): Promise<{
  ok: boolean;
  verified: boolean;
  configured_ip: string;
  primary_ip: string | null;
  secondary_ip: string | null;
  error: string | null;
}> {
  const res = await fetch(`${API_BASE_URL}/api/dhan/verify-ip`, {
    method: "POST",
    headers: getHeaders(),
  });
  return readJson(res, "Failed to verify the Dhan static IP");
}

export async function logoutDhan(): Promise<void> {
  // Mirrors `logout()`: never rejects, and never claims success on an error status.
  //
  // It used to neither catch nor check `res.ok`, so a network failure rejected out of the
  // header's `onClick` (an unhandled rejection) and the caller's `setAuthenticated(false)`
  // / token clear never ran — the user pressed Logout and nothing happened, with no error
  // shown. An HTTP 500 was worse: it resolved, so the UI reported a disconnect that had
  // not occurred.
  try {
    const res = await fetch(`${API_BASE_URL}/api/dhan/logout`, {
      method: "POST",
      headers: getHeaders(),
    });
    if (!res.ok) {
      console.warn(`[api] Dhan logout returned HTTP ${res.status}; clearing locally anyway.`);
    }
  } catch (err) {
    console.warn("[api] Dhan logout request failed; clearing locally anyway.", err);
  }
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


// ---------------- Futures vs synthetic futures (conversion / reversal) ----------------

/** CONVERSION = buy future + sell synthetic; REVERSAL = sell future + buy synthetic. */
export type SynthDirection = "CONVERSION" | "REVERSAL";
export type SynthLegRole = "fut" | "ce" | "pe";
/** OPEN = this exact strike/direction is held as a paper position right now. */
export type SynthStatus = "ELIGIBLE" | "OPEN" | "WATCHING" | "REJECTED" | "INDICATIVE";
/** Why an ELIGIBLE row is not being paper-entered right now. */
export type SynthEntryBlock =
  | "paper_off"
  | "no_db"
  | "feed_stale"
  | "position_open"
  | "entering"
  | "cooldown"
  | "expiry_cutoff"
  | "max_open"
  /** No room in the token budget for another position's three legs. */
  | "token_budget"
  | "confirming";
export type SynthRejectReason =
  | "no_quote"
  | "stale_quote"
  | "missing_bid"
  | "missing_ask"
  | "insufficient_qty"
  | "below_expected_net_profit"
  | "market_closed"
  | "no_close"
  /** Best bid ≥ best ask: an inconsistent snapshot, so its touch is not really available. */
  | "crossed_book";

export interface SynthLegEvaluation {
  role: SynthLegRole;
  side: BoxSide;
  token: number;
  tradingsymbol: string;
  strike: number;
  instrument_type: "FUT" | "CE" | "PE";
  price: number | null;
  qty_at_touch: number;
  bid: number;
  bid_qty: number;
  ask: number;
  ask_qty: number;
  last: number;
  age_ms: number | null;
  fresh: boolean;
  executable: boolean;
}

export interface SynthOpportunity {
  key: string;
  underlying: string;
  name: string;
  is_index: boolean;
  expiry: string;
  days_to_expiry: number;
  strike: number;
  atm_strike: number;
  /** Signed distance from ATM in listed strikes, −3..+3. */
  atm_offset: number;
  strike_step: number;
  lot_size: number;
  quantity: number;
  direction: SynthDirection;
  future_price: number | null;
  /** K + CE − PE at the option prices used. */
  synthetic_price: number | null;
  /** F_mid − (K + CE_mid − PE_mid); context only. */
  mid_basis: number | null;
  mispricing_per_unit: number | null;
  carry_per_unit: number;
  gross_per_unit: number | null;
  gross_edge: number | null;
  entry_charges: number | null;
  estimated_exit_charges: number | null;
  expected_slippage: number;
  safety_buffer: number;
  expected_net_profit: number | null;
  min_expected_net_profit: number;
  rf_pct: number;
  depth_ok: boolean;
  liquidity_ok: boolean;
  worst_age_ms: number | null;
  price_source: "touch" | "last_close";
  status: SynthStatus;
  reject: SynthRejectReason | null;
  /** Set on ELIGIBLE rows the backend is not entering, with the reason. */
  entry_blocked: SynthEntryBlock | null;
  /** The open paper position on this exact row (status OPEN). */
  position_id: string | null;
  legs: SynthLegEvaluation[];
  updated_at: number;
}

export interface SynthConfigView {
  strike_level: number;
  min_expected_net_profit: number;
  safety_buffer: number;
  expected_slippage: number;
  include_carry: boolean;
  default_rf_pct: number;
  quote_max_age_ms: number;
  feed_max_age_ms: number;
  max_tokens: number;
  share_box_budget: boolean;
  lane_token_limit: number;
  max_underlyings: number;
  max_published_opportunities: number;
  enable_conversion: boolean;
  enable_reversal: boolean;
  skip_expiry_day: boolean;
  paper_trading: boolean;
  /** Open paper positions at most; 0 = no limit (always one per underlying at most). */
  max_open_positions: number;
  /** The server's env default that a saved value overrides. */
  default_max_open_positions?: number;
  /** False when a settings change could not be saved yet (storage unavailable). */
  settings_persisted?: boolean;
  signal_confirmations: number;
  reentry_cooldown_ms: number;
  convergence_floor: number;
  convergence_pct: number;
  min_exit_net_pnl: number;
  profit_capture_pct: number;
  min_captured_pct: number;
  expiry_safety_minutes: number;
  option_rate_version: string;
  futures_rate_version: string;
  tunable: {
    min_expected_net_profit: { min: number; max: number };
    safety_buffer: { min: number; max: number };
    max_open_positions?: { min: number; max: number };
  };
}

export interface SynthStatusView {
  running: boolean;
  market_open: boolean;
  authenticated: boolean;
  broker: BrokerId;
  detection_only: boolean;
  execution_mode: "paper_touch";
  /** Paper entries are actually possible (enabled AND storage connected). */
  paper_trading: boolean;
  /** `unsafe_index`: the one-open-per-underlying index could not be verified. */
  paper_blocked_reason: "disabled" | "no_db" | "loading" | "unsafe_index" | null;
  db_enabled: boolean;
  strike_level: 1 | 2 | 3;
  paired_underlyings: number;
  monitored_underlyings: number;
  skipped_for_budget: number;
  unbuilt_windows: number;
  subscribed_tokens: number;
  ready_books: number;
  /** Tokens this scanner may hold now (base + what it borrows from an idle Box). */
  token_budget: number;
  base_token_budget: number;
  borrowed_from_box: number;
  box_scanner_running: boolean | null;
  box_lane_tokens: number | null;
  open_count: number;
  /** 0 = no limit. */
  max_open_positions: number;
  /** Whether trades get a margin figure (a basket-margin calculator is wired). */
  margin_enabled?: boolean;
  /** Open positions whose contracts are not resolved on the active broker yet. */
  unlinked_positions: number;
  day_pnl: SynthDayPnl;
  feed_age_ms: number | null;
  feed_healthy: boolean;
  universe_at: number | null;
  evaluated_at: number | null;
  close_session_day: string | null;
  eligible_count: number;
  opportunity_count: number;
  rf_pct: number;
  rf_source: "admin" | "default";
  last_error: string | null;
  config: SynthConfigView;
}

/** The payload of a `snapshot` frame on the synthetic stream. */
export interface SynthSnapshot {
  status: SynthStatusView;
  opportunities: SynthOpportunity[];
  open_trades: SynthOpenPosition[];
}

export type SynthExitReason =
  | "EDGE_CONVERGED"
  | "PROFIT_CAPTURE"
  | "EXPIRY_SAFETY"
  /** Still open at expiry: settled at the parity lock. */
  | "EXPIRED"
  | "MANUAL";

/** The top of a book at a fill: up to five levels a side, best first. */
export interface SynthDepth {
  bids: { price: number; qty: number }[];
  asks: { price: number; qty: number }[];
}

/**
 * One leg of a paper trade. Every leg is a LIMIT order at the touch (best ask to
 * buy, best bid to sell), sent only when a full lot rests there, so it fills at its
 * limit. The bid/ask, quantities, age and depth are the book it was priced on.
 * The optional fields are absent on trades stored before they were recorded.
 */
export interface SynthTradeLeg {
  role: SynthLegRole;
  /** The ENTRY side; the closing side is the opposite. */
  side: BoxSide;
  instrument_type: "FUT" | "CE" | "PE";
  strike: number;
  tradingsymbol: string;
  token: number;
  /** Entry fill = the limit price: best ask for a BUY, best bid for a SELL. */
  entry_price: number;
  entry_bid: number;
  entry_ask: number;
  entry_bid_qty?: number | null;
  entry_ask_qty?: number | null;
  /** Quantity resting at the entry limit price. */
  entry_qty_at_touch?: number | null;
  /** How long the book had been unchanged when the order was priced (ms). */
  entry_age_ms?: number | null;
  entry_depth?: SynthDepth | null;
  /** Exit fill = the closing limit: best bid to sell, best ask to buy back. */
  exit_price: number | null;
  exit_bid: number | null;
  exit_ask: number | null;
  exit_bid_qty?: number | null;
  exit_ask_qty?: number | null;
  exit_qty_at_touch?: number | null;
  exit_age_ms?: number | null;
  exit_depth?: SynthDepth | null;
}

/** Which calculator produced a margin figure. */
export type SynthMarginSource =
  | "kite_basket"
  | "dhan_multi"
  /** Dhan legs summed one by one: an UPPER bound that ignores the hedge. */
  | "dhan_per_leg_fallback"
  | "unavailable";

/** A paper trade, open or closed. */
export interface SynthTrade {
  id: string;
  status: "open" | "closed";
  key: string;
  broker: BrokerId;
  execution_mode: "paper_touch";
  /** Every leg is a limit order at the touch. Absent on older rows. */
  order_type?: "LIMIT";
  underlying: string;
  name: string;
  is_index: boolean;
  expiry: string;
  strike: number;
  atm_strike: number;
  atm_offset: number;
  direction: SynthDirection;
  lot_size: number;
  quantity: number;
  opened_at: string;
  opened_day: string;
  legs: SynthTradeLeg[];
  entry_future_price: number;
  entry_synthetic_price: number;
  entry_lock_per_unit: number;
  entry_carry_per_unit: number;
  /** Lock × quantity: the gross if held to expiry. */
  entry_edge: number;
  entry_gross_edge: number;
  entry_charges: number;
  estimated_exit_charges: number;
  entry_net_edge: number;
  expected_net_profit: number;
  min_expected_net_profit: number;
  safety_buffer: number;
  expected_slippage: number;
  rf_pct: number;
  option_rate_version: string;
  futures_rate_version: string;
  closed_at: string | null;
  closed_day: string | null;
  exit_reason: SynthExitReason | null;
  /** Price move only, before charges. Open: if closed now at the touch. */
  gross_pnl: number | null;
  exit_charges: number | null;
  /** Entry + exit charges. */
  total_charges: number | null;
  /** Gross − total charges ("after charges"). Open: if closed now. */
  net_pnl: number | null;
  exit_note: string | null;
  /**
   * Margin the three legs block together (₹), from the broker's basket-margin
   * calculator (hedge benefit included). Null until the broker answers, or when it
   * could not be obtained (see `margin_error`). Optional: absent on older rows.
   */
  margin?: number | null;
  margin_source?: SynthMarginSource | null;
  margin_hedge_benefit?: number | null;
  margin_at?: string | null;
  margin_error?: string | null;
}

/** One leg of an open position as it would be CLOSED now. */
export interface SynthExitLeg {
  role: SynthLegRole;
  /** The closing side. */
  side: BoxSide;
  tradingsymbol: string;
  token: number;
  entry_price: number;
  /** Closing touch: bid for a SELL, ask for a BUY. */
  price: number | null;
  qty_at_touch: number;
  bid: number;
  bid_qty: number;
  ask: number;
  ask_qty: number;
  ltp: number | null;
  age_ms: number | null;
  fresh: boolean;
  executable: boolean;
  /** Why this leg cannot be closed at the touch right now, or null. */
  reject?: SynthRejectReason | null;
}

/** An open paper position with the backend's live marks and exit arithmetic. */
export interface SynthOpenPosition extends SynthTrade {
  linked: boolean;
  closing: boolean;
  exit_legs: SynthExitLeg[];
  /** Open P&L marked to LTP, price move only (the broker-screen figure). */
  mtm_ltp: number | null;
  current_exit_charges: number | null;
  remaining_edge: number | null;
  captured_edge: number | null;
  captured_pct: number | null;
  convergence_threshold: number;
  profit_capture_target: number;
  min_exit_net_pnl: number;
  expiry_safety: boolean;
  exit_eligible: boolean;
  exit_rule_reason: SynthExitReason | null;
  exit_blocked_reason: "unpriced" | "net_below_floor" | "insufficient_exit_liquidity" | null;
}

/** The day's running P&L, computed by the backend. */
export interface SynthDayPnl {
  day: string;
  open_count: number;
  /** Σ open P&L at LTP, price move only. */
  open_mtm_ltp: number;
  open_unmarked_count: number;
  /** Σ closing-now gross at the touch. */
  open_running_gross_pnl: number;
  /** Σ closing-now net after entry + exit charges. */
  open_running_net_pnl: number;
  open_unpriced_count: number;
  closed_count: number;
  closed_realised_gross_pnl: number;
  closed_charges: number;
  closed_realised_net_pnl: number;
  /** Open running net + today's realised net. */
  total_net_pnl: number;
  total_gross_pnl: number;
  /** Σ margin the open positions block now (₹); those without a figure are excluded. */
  open_margin?: number;
  open_margin_unknown?: number;
  /** Σ margin of today's closed trades (₹): a day SUM, not a concurrent peak. */
  closed_margin?: number;
  closed_margin_unknown?: number;
}

export interface SynthHistoryResponse {
  db_enabled: boolean;
  scope: "today" | "all";
  trades: SynthTrade[];
}

export async function fetchSynthStatus(): Promise<SynthStatusView> {
  const res = await fetch(`${API_BASE_URL}/api/synthetic/status`, { headers: getHeaders() });
  return readJson<SynthStatusView>(res, "Failed to load synthetic scanner status");
}

export async function fetchSynthOpportunities(): Promise<{
  status: SynthStatusView;
  opportunities: SynthOpportunity[];
}> {
  const res = await fetch(`${API_BASE_URL}/api/synthetic/opportunities`, { headers: getHeaders() });
  return readJson<{ status: SynthStatusView; opportunities: SynthOpportunity[] }>(
    res,
    "Failed to load synthetic opportunities",
  );
}

/** Open paper positions with their live marks. */
export async function fetchSynthOpenTrades(): Promise<SynthOpenPosition[]> {
  const res = await fetch(`${API_BASE_URL}/api/synthetic/trades/open`, { headers: getHeaders() });
  const body = await readJson<{ db_enabled: boolean; open: SynthOpenPosition[] }>(
    res,
    "Failed to load open synthetic trades",
  );
  return body.open ?? [];
}

/** Closed paper trades, newest first. `today` is the fast in-memory path. */
export async function fetchSynthHistory(
  scope: "today" | "all" = "all",
  limit = 500,
): Promise<SynthHistoryResponse> {
  const qs = scope === "today" ? "?scope=today" : `?scope=all&limit=${encodeURIComponent(limit)}`;
  const res = await fetch(`${API_BASE_URL}/api/synthetic/trades/history${qs}`, {
    headers: getHeaders(),
  });
  return readJson<SynthHistoryResponse>(res, "Failed to load synthetic trade history");
}

/** Close one open paper position now, at the executable touch. */
export async function closeSynthTrade(id: string): Promise<{
  trade: SynthTrade;
  open: SynthOpenPosition[];
  status: SynthStatusView;
}> {
  const res = await fetch(
    `${API_BASE_URL}/api/synthetic/trades/${encodeURIComponent(id)}/close`,
    { method: "POST", headers: getHeaders() },
  );
  return readJson<{ trade: SynthTrade; open: SynthOpenPosition[]; status: SynthStatusView }>(
    res,
    "Failed to close the synthetic position",
  );
}

export interface SynthDeleteResult {
  ok: boolean;
  deleted_id: string;
  deleted_from: "open" | "closed";
  /** It had already been deleted (an earlier attempt, or another admin): nothing changed. */
  already_deleted?: boolean;
  status: SynthStatusView;
  open: SynthOpenPosition[];
  closed_today: SynthTrade[];
}

/**
 * FULL ADMIN: delete a PAPER trade, open or closed, from every list and P&L figure.
 * The backend keeps it as a soft-deleted audit row with the reason.
 *
 * `expectedStatus` is the status the confirmation showed. If the trade changed state
 * meanwhile (an open position that just closed), the backend refuses with 409
 * instead of deleting it together with the P&L it booked. Safe to retry.
 */
export async function deleteSynthTrade(
  id: string,
  expectedStatus: "open" | "closed",
  reason?: string,
): Promise<SynthDeleteResult> {
  const res = await fetch(`${API_BASE_URL}/api/synthetic/trades/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: getHeaders(),
    body: JSON.stringify(reason ? { reason, expected_status: expectedStatus } : { expected_status: expectedStatus }),
  });
  if (res.status === 404) throw new SynthTradeGoneError("That trade no longer exists on the server.");
  return readJson<SynthDeleteResult>(res, "Failed to delete the synthetic trade");
}

/** The trade is not on the server at all, so any row showing it is stale. */
export class SynthTradeGoneError extends Error {}

async function postSynth(path: string, what: string, body?: unknown): Promise<SynthStatusView> {
  const res = await fetch(`${API_BASE_URL}/api/synthetic/${path}`, {
    method: "POST",
    headers: getHeaders(),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const out = await readJson<{ status: SynthStatusView }>(res, what);
  return out.status;
}

export function startSynthScanner(): Promise<SynthStatusView> {
  return postSynth("start", "Failed to start the synthetic scanner");
}

export function stopSynthScanner(): Promise<SynthStatusView> {
  return postSynth("stop", "Failed to stop the synthetic scanner");
}

/** The synthetic is only built from ATM ± level strikes (1, 2 or 3). */
export function setSynthStrikeLevel(level: 1 | 2 | 3): Promise<SynthStatusView> {
  return postSynth("strike-level", "Failed to set the synthetic strike level", { level });
}

/**
 * Change the entry gate, safety buffer and/or max open positions (0 = no limit).
 * Saved on the server, so they survive a restart; `persisted: false` means storage
 * was unavailable and the change applies to the running server only for now.
 */
export async function saveSynthSettings(settings: {
  min_expected_net_profit?: number;
  safety_buffer?: number;
  max_open_positions?: number;
}): Promise<{ status: SynthStatusView; persisted: boolean }> {
  const res = await fetch(`${API_BASE_URL}/api/synthetic/settings`, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify(settings),
  });
  const out = await readJson<{ status: SynthStatusView; persisted?: boolean }>(
    res,
    "Failed to save synthetic settings",
  );
  return { status: out.status, persisted: out.persisted !== false };
}

/** SSE URL for live scanner state (token in the query: EventSource cannot set headers). */
export function synthStreamUrl(): string {
  const url = `${API_BASE_URL}/api/synthetic/stream`;
  return adminToken ? `${url}?x-admin-token=${encodeURIComponent(adminToken)}` : url;
}
