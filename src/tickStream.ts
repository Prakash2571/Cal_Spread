/**
 * The browser's live market-data connection.
 *
 * WHAT WENT WRONG BEFORE
 * The board opened `new EventSource("/api/stream?tokens=" + 816 ids)`. That URL is 9022
 * characters, and nginx refuses a request line larger than one header buffer (8 KB by
 * default) with 414 — before the backend runs. `EventSource` cannot surface an HTTP
 * status, and the only handler was `onerror = () => setLive(false)`, so the failure was
 * completely silent: no lease was acquired, nothing was subscribed upstream, no tick
 * ever arrived, and the UI sat on "Connecting…" with "-" in every cell.
 *
 * HOW THIS WORKS NOW
 * Tokens are POSTed once in exchange for a session id, then ONE `EventSource` reads
 * `/api/stream/session/<id>`. The URL is a constant ~60 bytes, so the board can grow
 * without ever reintroducing the fault.
 *
 * ONE connection, not several. A browser allows only ~6 concurrent HTTP/1.1 connections
 * per origin and an SSE connection is long-lived, so splitting the board into 9 chunked
 * streams would leave three permanently unopened and starve every other request to the
 * origin — including the Box stream. Chunking survives only as a FALLBACK for a browser
 * talking to a backend that predates the session endpoint, where a partly-working board
 * beats a blank one.
 *
 * RECONNECTS ARE EXPECTED, NOT FAILURES. `EventSource` retries transient drops by
 * itself. It gives up only when the response is unusable (a 404 for an expired
 * session), which is the one case this class has to handle, by minting a new session.
 */

import type { StreamSession, Tick } from "./api.ts";
import { StaleBrokerTokensError } from "./apiErrors.ts";
import { chunkTokens, type StreamState } from "./marketData.ts";

/** The slice of `EventSource` used here, so tests can supply a fake. */
export interface EventSourceLike {
  readyState: number;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  addEventListener(type: string, listener: (ev: unknown) => void): void;
}

const CLOSED = 2;

/** Backoff for re-minting a session after the server declared it unusable. */
const RECOVER_DELAY_MS = 3000;

export interface TickStreamHooks {
  onTicks: (ticks: Tick[]) => void;
  onState: (state: StreamState) => void;
  /** First successful open, and first tick. Used to refresh the status banner. */
  onOpened?: () => void;
  onFirstTick?: () => void;
  /**
   * The board is unusable and the caller must refetch it: the broker changed under us,
   * or the upstream session died.
   */
  onFatal: (message: string) => void;
  /** Non-fatal, but must be visible rather than swallowed. */
  onError?: (message: string) => void;
}

/**
 * Transports, injected rather than imported.
 *
 * The concrete browser implementations live in `api.ts` (see `browserTickStreamDeps`).
 * Inverting the dependency is what lets this whole class be exercised under plain Node
 * with fakes, instead of needing `EventSource`, `fetch` and `localStorage` to exist.
 */
export interface TickStreamDeps {
  createSession: (tokens: number[]) => Promise<StreamSession>;
  sessionUrl: (id: string) => string;
  legacyUrl: (tokens: number[]) => string;
  makeEventSource: (url: string) => EventSourceLike;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

export class TickStream {
  private sources: EventSourceLike[] = [];
  private openCount = 0;
  private failedCount = 0;
  private stopped = false;
  private sawTick = false;
  private sawOpen = false;
  private recoverHandle: unknown = null;
  // Explicit fields rather than constructor parameter properties: those are a
  // TypeScript-only transform, and avoiding them lets Node execute this module directly
  // for tests with no build step.
  private readonly tokens: number[];
  private readonly hooks: TickStreamHooks;
  private readonly deps: Required<TickStreamDeps>;

  constructor(tokens: number[], hooks: TickStreamHooks, deps: TickStreamDeps) {
    this.tokens = tokens;
    this.hooks = hooks;
    this.deps = {
      ...deps,
      setTimeoutFn: deps.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms)),
      clearTimeoutFn:
        deps.clearTimeoutFn ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)),
    };
  }

  /** Open the stream. Safe to call once per instance. */
  async start(): Promise<void> {
    if (this.stopped || this.tokens.length === 0) return;
    try {
      const session = await this.deps.createSession(this.tokens);
      if (this.stopped) return;
      this.attach([this.deps.sessionUrl(session.id)], true);
    } catch (err) {
      if (this.stopped) return;
      if (err instanceof StaleBrokerTokensError) {
        // Not recoverable by retrying: the board itself is from the previous broker.
        this.hooks.onFatal(err.message);
        return;
      }
      // A backend without the session endpoint, or a transient failure. Fall back to
      // bounded chunked URLs so the board still gets prices.
      const message = err instanceof Error ? err.message : String(err);
      this.hooks.onError?.(
        `Market-data session unavailable (${message}); falling back to chunked streams.`,
      );
      const chunks = chunkTokens(this.tokens);
      this.attach(chunks.map((chunk) => this.deps.legacyUrl(chunk)), false);
    }
  }

  private attach(urls: string[], recoverable: boolean): void {
    this.failedCount = 0;
    this.openCount = 0;
    this.sources = [];

    for (const url of urls) {
      const source = this.deps.makeEventSource(url);
      this.sources.push(source);

      source.onopen = () => {
        this.openCount = Math.min(this.openCount + 1, urls.length);
        this.publish(urls.length);
        if (!this.sawOpen) {
          this.sawOpen = true;
          this.hooks.onOpened?.();
        }
      };

      source.onmessage = (ev) => {
        let incoming: Tick[];
        try {
          incoming = JSON.parse(ev.data) as Tick[];
        } catch {
          return; // a malformed frame must not kill the stream
        }
        if (!Array.isArray(incoming) || incoming.length === 0) return;
        this.hooks.onTicks(incoming);
        if (!this.sawTick) {
          this.sawTick = true;
          this.hooks.onFirstTick?.();
        }
      };

      // The backend emits this when the UPSTREAM broker session dies; the stream will
      // never produce data again, so it is fatal rather than a reconnect.
      source.addEventListener("kite_error", () => {
        this.hooks.onFatal("Live feed disconnected — the data provider session ended.");
        this.close();
      });

      source.onerror = () => {
        // readyState CLOSED means EventSource has GIVEN UP (an unusable response, e.g.
        // an expired session 404). Anything else is its own retry in progress, which is
        // normal and must not be reported as a failure.
        if (source.readyState !== CLOSED) {
          this.openCount = Math.max(0, this.openCount - 1);
          this.publish(urls.length);
          return;
        }
        this.failedCount = Math.min(this.failedCount + 1, urls.length);
        this.openCount = Math.max(0, this.openCount - 1);
        this.publish(urls.length);
        if (recoverable) this.scheduleRecovery();
      };
    }

    this.publish(urls.length);
  }

  /**
   * Re-mint a session after the server refused the old one.
   *
   * Without this an expired session would end live prices permanently, since
   * `EventSource` does not retry a 404.
   */
  private scheduleRecovery(): void {
    if (this.stopped || this.recoverHandle !== null) return;
    this.recoverHandle = this.deps.setTimeoutFn(() => {
      this.recoverHandle = null;
      if (this.stopped) return;
      for (const source of this.sources) source.close();
      this.sources = [];
      this.sawOpen = false;
      void this.start();
    }, RECOVER_DELAY_MS);
  }

  private publish(total: number): void {
    this.hooks.onState({ total, open: this.openCount, failed: this.failedCount });
  }

  /** Close every connection. Idempotent, and blocks any pending recovery. */
  close(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.recoverHandle !== null) {
      this.deps.clearTimeoutFn(this.recoverHandle);
      this.recoverHandle = null;
    }
    for (const source of this.sources) {
      try {
        source.close();
      } catch {
        /* already gone */
      }
    }
    this.sources = [];
    this.openCount = 0;
    this.hooks.onState({ total: 0, open: 0, failed: 0 });
  }

  /** Live connection count, for assertions and diagnostics. */
  get connectionCount(): number {
    return this.sources.length;
  }
}
