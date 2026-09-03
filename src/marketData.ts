/**
 * Market-data token plumbing: how the board's instruments become subscription requests.
 *
 * THE BUG THIS MODULE EXISTS TO PREVENT
 * The board asked for live prices by listing every token in a query string. With ~204
 * underlyings x (1 spot + 3 futures) = 816 tokens, and a Dhan internal token being 10
 * digits, that produced a 9022-character URL:
 *
 *     GET /api/stream?tokens=<816 ids>   -> 9022 chars, request line 9007 bytes
 *
 * nginx caps a request LINE at one header buffer (`large_client_header_buffers`
 * defaults to `4 8k` = 8192 bytes) and rejects it with 414 while parsing that first
 * line, so the request never reached the backend at all. The browser therefore never
 * acquired a subscription lease, nothing was subscribed upstream, no ticks arrived, and
 * every cell showed "-" — with no error anywhere, because `EventSource` cannot report
 * an HTTP status and the failure was being swallowed.
 *
 * The lesson encoded here: A TOKEN LIST MUST NEVER TRAVEL IN A URL. REST quotes POST a
 * body, and the live stream POSTs its tokens once in exchange for a short session id.
 * The helpers below exist so the remaining URL-shaped path (a small legacy fallback)
 * has an explicit, tested size bound instead of an accidental one.
 */

import type { BoardItem } from "./api";

/**
 * Tokens per stream on the LEGACY `?tokens=` fallback path.
 *
 * 250 rather than a smaller number on purpose. A browser permits only ~6 concurrent
 * HTTP/1.1 connections per origin, and an SSE connection is long-lived, so chunking too
 * finely is its own outage: at 100 tokens an 816-token board needs 9 streams, three of
 * which would never open while the rest starved every other request to the origin —
 * including the Box stream. At 250 the same board needs 4 streams, each URL ~2.8 KB,
 * comfortably inside the 8 KB limit.
 *
 * The primary path uses a server-side session and needs no chunking at all.
 */
export const MAX_TOKENS_PER_STREAM = 250;

/**
 * Defensive ceiling on a generated URL.
 *
 * Well below nginx's 8192-byte single-buffer limit, leaving room for the origin, the
 * path and any query parameters that get added later.
 */
export const MAX_STREAM_URL_LENGTH = 4000;

/**
 * Every instrument the board needs prices for: each underlying's spot plus its futures.
 *
 * DEDUPLICATED. Two board rows can legitimately reference the same token (an index and
 * its own spot, or a repeated symbol from a stale merge). A duplicate would be counted
 * twice in a subscription lease and inflate every request for no benefit.
 */
export function boardMarketDataTokens(board: BoardItem[]): number[] {
  const seen = new Set<number>();
  for (const row of board) {
    if (Number.isFinite(row.spot_token) && row.spot_token > 0) seen.add(row.spot_token);
    for (const future of row.futures) {
      if (Number.isFinite(future.token) && future.token > 0) seen.add(future.token);
    }
  }
  return [...seen];
}

/** Split a token list into chunks for the legacy URL-based stream path. */
export function chunkTokens(
  tokens: number[],
  maxPerChunk: number = MAX_TOKENS_PER_STREAM,
): number[][] {
  const unique = [...new Set(tokens)];
  if (unique.length === 0) return [];
  const size = Math.max(1, maxPerChunk);
  const chunks: number[][] = [];
  for (let i = 0; i < unique.length; i += size) chunks.push(unique.slice(i, i + size));
  return chunks;
}

/** Aggregated health of a set of streams, so one reconnect is not read as an outage. */
export interface StreamState {
  total: number;
  open: number;
  failed: number;
}

export const IDLE_STREAM_STATE: StreamState = { total: 0, open: 0, failed: 0 };

export type MarketDataPhase = "idle" | "connecting" | "awaiting-ticks" | "live" | "degraded";

/**
 * Turn stream counts plus tick arrival into the label the UI shows.
 *
 * The old logic was a single boolean, which is why the banner could sit on "Connecting…"
 * forever: nothing distinguished "no stream yet" from "streams open, no data".
 *
 * `hasTicks` wins over a partial failure deliberately. `EventSource` reconnects on its
 * own, so one chunk cycling is normal; reporting the whole feed dead because of it
 * would be less truthful than reporting it live.
 */
export function marketDataPhase(
  state: StreamState,
  hasTicks: boolean,
  authenticated: boolean,
): MarketDataPhase {
  if (!authenticated) return "idle";
  if (hasTicks) return state.failed > 0 && state.open < state.total ? "degraded" : "live";
  if (state.total === 0) return "connecting";
  if (state.open === 0) return state.failed > 0 ? "degraded" : "connecting";
  return "awaiting-ticks";
}

/** Diagnostics for the token plumbing. Logged once per board load, never per tick. */
export interface TokenRequestDiagnostics {
  board: number;
  rawTokens: number;
  uniqueTokens: number;
  /** What a single legacy GET would have produced — the shape that broke. */
  singleUrlLength: number;
  chunks: number;
  maxChunkUrlLength: number;
  withinUrlLimit: boolean;
}

export function describeTokenRequest(
  board: BoardItem[],
  baseUrl: string,
  maxPerChunk: number = MAX_TOKENS_PER_STREAM,
): TokenRequestDiagnostics {
  const raw = board.flatMap((b) => [b.spot_token, ...b.futures.map((f) => f.token)]);
  const unique = boardMarketDataTokens(board);
  const urlFor = (list: number[]): string => `${baseUrl}/api/stream?tokens=${list.join(",")}`;
  const chunks = chunkTokens(unique, maxPerChunk);
  const maxChunkUrlLength = chunks.reduce((max, c) => Math.max(max, urlFor(c).length), 0);
  return {
    board: board.length,
    rawTokens: raw.length,
    uniqueTokens: unique.length,
    singleUrlLength: urlFor(unique).length,
    chunks: chunks.length,
    maxChunkUrlLength,
    withinUrlLimit: maxChunkUrlLength <= MAX_STREAM_URL_LENGTH,
  };
}
