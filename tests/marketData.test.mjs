/**
 * The blank board: ~816 tokens in one GET URL.
 *
 * The board asked for prices with `GET /api/stream?tokens=<816 ten-digit ids>`, a
 * 9022-character URL. nginx caps a request LINE at one header buffer
 * (`large_client_header_buffers` defaults to `4 8k` = 8192 bytes) and rejects it with
 * 414 during parsing of that first line, so the backend handler never ran. No
 * subscription lease was acquired, nothing was subscribed upstream, no tick arrived, and
 * every cell rendered "-" with no error shown — `EventSource` cannot report an HTTP
 * status and the failure was being swallowed.
 *
 * These tests pin the properties that make that impossible to reintroduce.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  boardMarketDataTokens,
  chunkTokens,
  describeTokenRequest,
  marketDataPhase,
  MAX_TOKENS_PER_STREAM,
  MAX_STREAM_URL_LENGTH,
  IDLE_STREAM_STATE,
} from "../src/marketData.ts";

const ORIGIN = "https://api.calspread.online";

/**
 * A realistic Dhan-token board. A Dhan internal token is
 * `segmentCode * 1e9 + securityId` (NSE_EQ=1, NSE_FNO=2), so every one is 10 digits —
 * which is what made the URL so large.
 */
function dhanBoard(stocks = 204) {
  return Array.from({ length: stocks }, (_, i) => ({
    symbol: `SYM${i}`,
    name: `Name ${i}`,
    spot_token: 1_000_000_000 + 400 + i * 53,
    futures: [0, 1, 2].map((k) => ({
      token: 2_000_000_000 + 35_000 + i * 7 + k,
      expiry: "2026-09-29",
      lot_size: 250,
    })),
  }));
}

/* --------------------------- the measured failure -------------------------- */

test("a 204-stock board yields 816 unique tokens", () => {
  const board = dhanBoard(204);
  const tokens = boardMarketDataTokens(board);
  assert.equal(tokens.length, 816, "204 x (1 spot + 3 futures)");
  assert.ok(
    tokens.every((t) => String(t).length === 10),
    "every Dhan internal token is 10 digits",
  );
});

test("the OLD single-URL shape exceeds nginx's 8 KB request-line limit", () => {
  // The regression this whole change exists for. Documented as a hard number so nobody
  // reintroduces "just put the tokens in the query string".
  const diag = describeTokenRequest(dhanBoard(204), ORIGIN);
  assert.equal(diag.uniqueTokens, 816);
  assert.ok(
    diag.singleUrlLength > 8192,
    `a single URL was ${diag.singleUrlLength} bytes, which nginx rejects with 414`,
  );
  assert.ok(diag.singleUrlLength > 9000, `expected ~9022, got ${diag.singleUrlLength}`);
});

test("every fallback chunk URL stays far below the proxy limit", () => {
  const diag = describeTokenRequest(dhanBoard(204), ORIGIN);
  assert.ok(diag.withinUrlLimit, "chunked URLs must be within the safe bound");
  assert.ok(
    diag.maxChunkUrlLength < MAX_STREAM_URL_LENGTH,
    `max chunk URL ${diag.maxChunkUrlLength} must be < ${MAX_STREAM_URL_LENGTH}`,
  );
  assert.ok(diag.maxChunkUrlLength < 8192, "and comfortably below nginx's 8 KB");
});

test("816 tokens chunk into a SMALL number of streams", () => {
  const chunks = chunkTokens(boardMarketDataTokens(dhanBoard(204)));
  assert.equal(chunks.length, Math.ceil(816 / MAX_TOKENS_PER_STREAM));
  // A browser allows only ~6 concurrent HTTP/1.1 connections per origin, and an SSE
  // connection is long-lived. More chunks than that is its own outage: the extras never
  // open AND they starve every other request to the origin.
  assert.ok(chunks.length <= 5, `${chunks.length} streams must stay under the ~6 cap`);
  assert.equal(chunks.flat().length, 816, "chunking loses no token");
});

test("the design holds for 2000 tokens", () => {
  // Today's board is not the maximum; adding stocks must never resurrect the 414.
  const chunks = chunkTokens(Array.from({ length: 2000 }, (_, i) => 2_000_000_000 + i));
  assert.equal(chunks.flat().length, 2000);
  for (const chunk of chunks) {
    const url = `${ORIGIN}/api/stream?tokens=${chunk.join(",")}`;
    assert.ok(url.length < MAX_STREAM_URL_LENGTH, `chunk URL ${url.length} too long`);
  }
});

/* ------------------------------ deduplication ----------------------------- */

test("tokens are deduplicated before any request is built", () => {
  const board = [
    { symbol: "A", name: "A", spot_token: 111, futures: [{ token: 222, expiry: "", lot_size: 1 }] },
    // Same underlying repeated: a duplicate would be counted twice in a lease.
    { symbol: "A", name: "A", spot_token: 111, futures: [{ token: 222, expiry: "", lot_size: 1 }] },
    { symbol: "B", name: "B", spot_token: 333, futures: [{ token: 222, expiry: "", lot_size: 1 }] },
  ];
  assert.deepEqual(boardMarketDataTokens(board), [111, 222, 333]);
});

test("raw and unique counts are both reported, so duplication is visible", () => {
  const row = {
    symbol: "A",
    name: "A",
    spot_token: 111,
    futures: [{ token: 222, expiry: "", lot_size: 1 }],
  };
  const diag = describeTokenRequest([row, row], ORIGIN);
  assert.equal(diag.rawTokens, 4);
  assert.equal(diag.uniqueTokens, 2);
});

test("malformed board rows cannot inject junk tokens", () => {
  const board = [
    { symbol: "A", name: "A", spot_token: 0, futures: [{ token: -5, expiry: "", lot_size: 1 }] },
    { symbol: "B", name: "B", spot_token: Number.NaN, futures: [] },
    { symbol: "C", name: "C", spot_token: 777, futures: [] },
  ];
  assert.deepEqual(boardMarketDataTokens(board), [777]);
});

test("chunking an empty token list produces no streams at all", () => {
  assert.deepEqual(chunkTokens([]), []);
  assert.equal(describeTokenRequest([], ORIGIN).chunks, 0);
});

/* ------------------------------ status phases ----------------------------- */

test("status distinguishes connecting from open-but-silent", () => {
  // A single boolean could not, which is why the banner stuck on "Connecting…".
  assert.equal(marketDataPhase(IDLE_STREAM_STATE, false, true), "connecting");
  assert.equal(marketDataPhase({ total: 4, open: 0, failed: 0 }, false, true), "connecting");
  assert.equal(marketDataPhase({ total: 4, open: 4, failed: 0 }, false, true), "awaiting-ticks");
  assert.equal(marketDataPhase({ total: 4, open: 4, failed: 0 }, true, true), "live");
});

test("one reconnecting stream does not mark the whole feed dead", () => {
  // EventSource reconnects by itself; ticks still arriving means the feed IS live.
  assert.equal(marketDataPhase({ total: 4, open: 3, failed: 1 }, true, true), "degraded");
  assert.equal(marketDataPhase({ total: 4, open: 4, failed: 0 }, true, true), "live");
});

test("not authenticated is idle regardless of stream counts", () => {
  assert.equal(marketDataPhase({ total: 4, open: 4, failed: 0 }, true, false), "idle");
});
