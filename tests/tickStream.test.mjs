/**
 * The live-stream transport.
 *
 * The board must reach the backend with ONE small request, tolerate `EventSource`'s
 * automatic reconnects without reporting an outage, recover when the server declares a
 * session dead, and tear everything down on a broker switch so the previous broker's
 * tokens are never resubscribed.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { TickStream } from "../src/tickStream.ts";
import { StaleBrokerTokensError } from "../src/apiErrors.ts";
import { MAX_STREAM_URL_LENGTH } from "../src/marketData.ts";

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 2;

/** A fake EventSource that records what happened to it. */
class FakeEventSource {
  constructor(url) {
    this.url = url;
    this.readyState = CONNECTING;
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.listeners = new Map();
    this.closed = false;
    FakeEventSource.created.push(this);
  }
  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }
  emit(type) {
    this.listeners.get(type)?.({});
  }
  close() {
    this.closed = true;
    this.readyState = CLOSED;
  }
  open() {
    this.readyState = OPEN;
    this.onopen?.({});
  }
  message(ticks) {
    this.onmessage?.({ data: JSON.stringify(ticks) });
  }
  /** A transient drop: EventSource retries on its own. */
  transientError() {
    this.readyState = CONNECTING;
    this.onerror?.({});
  }
  /** A permanent failure (e.g. a 404 for an expired session). */
  fatalError() {
    this.readyState = CLOSED;
    this.onerror?.({});
  }
  static created = [];
  static reset() {
    FakeEventSource.created = [];
  }
}

function harness(overrides = {}) {
  FakeEventSource.reset();
  const ticks = [];
  const states = [];
  const errors = [];
  const fatals = [];
  let opened = 0;
  let firstTicks = 0;
  const timers = [];

  const deps = {
    createSession: async (tokens) => ({
      id: "sess-abc",
      tokens: tokens.length,
      broker: "dhan",
      generation: 3,
    }),
    sessionUrl: (id) => `https://api.calspread.online/api/stream/session/${id}`,
    legacyUrl: (list) => `https://api.calspread.online/api/stream?tokens=${list.join(",")}`,
    makeEventSource: (url) => new FakeEventSource(url),
    setTimeoutFn: (fn) => {
      timers.push(fn);
      return timers.length - 1;
    },
    clearTimeoutFn: () => {},
    ...overrides,
  };

  const hooks = {
    onTicks: (t) => ticks.push(...t),
    onState: (s) => states.push(s),
    onOpened: () => opened++,
    onFirstTick: () => firstTicks++,
    onFatal: (m) => fatals.push(m),
    onError: (m) => errors.push(m),
  };

  return {
    deps,
    hooks,
    ticks,
    states,
    errors,
    fatals,
    timers,
    get opened() {
      return opened;
    },
    get firstTicks() {
      return firstTicks;
    },
    sources: FakeEventSource.created,
  };
}

const tokens816 = Array.from({ length: 816 }, (_, i) => 2_000_000_000 + i);

/* ------------------------- one small request, not 816 ---------------------- */

test("816 tokens open exactly ONE stream with a tiny constant URL", async () => {
  const h = harness();
  const stream = new TickStream(tokens816, h.hooks, h.deps);
  await stream.start();

  assert.equal(h.sources.length, 1, "one connection, not one per chunk");
  assert.equal(stream.connectionCount, 1);
  const url = h.sources[0].url;
  assert.ok(url.length < 200, `session URL was ${url.length} bytes: ${url}`);
  assert.ok(url.length < MAX_STREAM_URL_LENGTH);
  assert.ok(!url.includes("tokens="), "the token list must NEVER appear in the URL");
});

test("the session receives the full deduplicated token list", async () => {
  let received = null;
  const h = harness({
    createSession: async (tokens) => {
      received = tokens;
      return { id: "s", tokens: tokens.length, broker: "dhan", generation: 1 };
    },
  });
  await new TickStream([5, 5, 6, 7, 7], h.hooks, h.deps).start();
  // TickStream forwards what it is given; App dedupes via boardMarketDataTokens. Assert
  // the transport does not mangle it.
  assert.deepEqual(received, [5, 5, 6, 7, 7]);
});

test("an empty token list opens nothing", async () => {
  const h = harness();
  await new TickStream([], h.hooks, h.deps).start();
  assert.equal(h.sources.length, 0);
});

/* ------------------------------ tick delivery ----------------------------- */

test("ticks from the stream reach the consumer, and first tick fires once", async () => {
  const h = harness();
  const stream = new TickStream(tokens816, h.hooks, h.deps);
  await stream.start();
  h.sources[0].open();
  h.sources[0].message([{ token: 2_000_000_001, last_price: 10, close_price: 9 }]);
  h.sources[0].message([{ token: 2_000_000_002, last_price: 20, close_price: 19 }]);

  assert.equal(h.ticks.length, 2);
  assert.equal(h.firstTicks, 1, "onFirstTick must fire exactly once");
  assert.equal(h.opened, 1);
});

test("all streams merge into ONE tick flow when chunking is used", async () => {
  // Fallback path: several connections, one consumer.
  const h = harness({
    createSession: async () => {
      throw new Error("no session endpoint");
    },
  });
  const stream = new TickStream(tokens816, h.hooks, h.deps);
  await stream.start();
  assert.ok(h.sources.length > 1, "chunked fallback opens several streams");

  h.sources.forEach((s, i) => {
    s.open();
    s.message([{ token: 1000 + i, last_price: i, close_price: i }]);
  });
  assert.equal(h.ticks.length, h.sources.length, "every stream's ticks land in one buffer");
  assert.equal(h.firstTicks, 1);
});

test("a malformed frame does not kill the stream", async () => {
  const h = harness();
  const stream = new TickStream(tokens816, h.hooks, h.deps);
  await stream.start();
  h.sources[0].open();
  h.sources[0].onmessage({ data: "{not json" });
  h.sources[0].message([{ token: 1, last_price: 5, close_price: 5 }]);
  assert.equal(h.ticks.length, 1);
});

/* ------------------------------- resilience ------------------------------- */

test("a transient reconnect is NOT reported as a failure", async () => {
  const h = harness();
  const stream = new TickStream(tokens816, h.hooks, h.deps);
  await stream.start();
  h.sources[0].open();
  h.sources[0].transientError();

  const last = h.states.at(-1);
  assert.equal(last.failed, 0, "EventSource retrying on its own is not a failure");
  assert.equal(h.fatals.length, 0);
});

test("a permanent session failure re-mints a session instead of dying", async () => {
  // EventSource does NOT retry a 404, so without this live prices would stop forever.
  const h = harness();
  const stream = new TickStream(tokens816, h.hooks, h.deps);
  await stream.start();
  h.sources[0].open();
  h.sources[0].fatalError();

  assert.equal(h.states.at(-1).failed, 1, "reported as failed");
  assert.equal(h.timers.length, 1, "a recovery attempt was scheduled");
  h.timers[0](); // fire the backoff
  await new Promise((r) => setImmediate(r));
  assert.equal(h.sources.length, 2, "a new session/connection was opened");
  assert.ok(h.sources[0].closed, "the dead connection was closed");
});

test("falling back to chunked streams is REPORTED, not silent", async () => {
  const h = harness({
    createSession: async () => {
      throw new Error("HTTP 404");
    },
  });
  await new TickStream(tokens816, h.hooks, h.deps).start();
  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0], /session unavailable/i);
  assert.match(h.errors[0], /HTTP 404/);
});

test("every fallback chunk URL stays within the safe size bound", async () => {
  const h = harness({
    createSession: async () => {
      throw new Error("nope");
    },
  });
  await new TickStream(tokens816, h.hooks, h.deps).start();
  for (const source of h.sources) {
    assert.ok(
      source.url.length < MAX_STREAM_URL_LENGTH,
      `fallback URL was ${source.url.length} bytes`,
    );
    assert.ok(source.url.length < 8192, "and below nginx's 8 KB request-line limit");
  }
});

/* --------------------------- broker-switch safety -------------------------- */

test("a stale-broker board is fatal and is NOT retried", async () => {
  // Retrying would keep asking the new broker for the previous broker's tokens.
  const h = harness({
    createSession: async () => {
      throw new StaleBrokerTokensError("Board belongs to a previous broker.");
    },
  });
  await new TickStream(tokens816, h.hooks, h.deps).start();
  assert.equal(h.fatals.length, 1);
  assert.match(h.fatals[0], /previous broker/);
  assert.equal(h.sources.length, 0, "no connection is opened with stale tokens");
  assert.equal(h.timers.length, 0, "and no recovery is scheduled");
});

test("close() closes EVERY connection and blocks pending recovery", async () => {
  const h = harness({
    createSession: async () => {
      throw new Error("force chunked");
    },
  });
  const stream = new TickStream(tokens816, h.hooks, h.deps);
  await stream.start();
  const count = h.sources.length;
  assert.ok(count > 1);

  h.sources[0].open();
  h.sources[0].fatalError();
  stream.close();

  assert.ok(
    h.sources.every((s) => s.closed),
    `all ${count} connections must be closed`,
  );
  assert.equal(stream.connectionCount, 0);
  assert.deepEqual(h.states.at(-1), { total: 0, open: 0, failed: 0 });

  // Any recovery that had been scheduled must not resurrect a stream after close().
  for (const timer of h.timers) timer();
  await new Promise((r) => setImmediate(r));
  assert.equal(h.sources.length, count, "no new connection after close()");
});

test("close() is idempotent", async () => {
  const h = harness();
  const stream = new TickStream(tokens816, h.hooks, h.deps);
  await stream.start();
  stream.close();
  stream.close();
  assert.equal(stream.connectionCount, 0);
});

test("a session resolved AFTER close() opens nothing", async () => {
  // The board effect tears down synchronously while session creation is in flight.
  let release;
  const pending = new Promise((r) => (release = r));
  const h = harness({
    createSession: async () => {
      await pending;
      return { id: "late", tokens: 1, broker: "dhan", generation: 1 };
    },
  });
  const stream = new TickStream(tokens816, h.hooks, h.deps);
  const starting = stream.start();
  stream.close();
  release();
  await starting;
  assert.equal(h.sources.length, 0, "a late session must not open a stream");
});

test("an upstream session loss is fatal and closes the stream", async () => {
  const h = harness();
  const stream = new TickStream(tokens816, h.hooks, h.deps);
  await stream.start();
  h.sources[0].open();
  h.sources[0].emit("kite_error");

  assert.equal(h.fatals.length, 1);
  assert.match(h.fatals[0], /data provider session ended/);
  assert.ok(h.sources[0].closed);
});
