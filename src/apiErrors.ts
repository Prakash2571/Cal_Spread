/**
 * Transport errors that callers branch on.
 *
 * Kept in their own module, free of browser globals, so the market-data logic that
 * uses `instanceof` on them can be unit-tested under plain Node without dragging in
 * `localStorage` or `import.meta.env`.
 */

/** The backend rejected a token list as belonging to a previous broker (HTTP 409). */
export class StaleBrokerTokensError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaleBrokerTokensError";
  }
}

/** A stream session is unknown or expired and must be re-created (HTTP 404). */
export class StreamSessionExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StreamSessionExpiredError";
  }
}
