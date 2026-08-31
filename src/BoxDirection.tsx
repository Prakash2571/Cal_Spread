/**
 * Presentational helpers for a box's direction and the charge origin.
 *
 * Kept as their own small module rather than inlined in the (already large)
 * Box page, so the direction vocabulary lives in exactly one place and the
 * long/short styling cannot drift between the opportunities, open and history
 * views.
 */

import type { BoxChargeOrigin, BoxDirection } from "./api";

/** "LONG BOX" / "SHORT BOX" pill. */
export function DirectionBadge({ direction }: { direction: BoxDirection }) {
  const isShort = direction === "SHORT_BOX";
  return (
    <span
      className={`box-dir ${isShort ? "box-dir--short" : "box-dir--long"}`}
      title={
        isShort
          ? "SHORT / reverse box: SELL K1 CE, BUY K2 CE, SELL K2 PE, BUY K1 PE — profits when the box trades ABOVE its width"
          : "LONG box: BUY K1 CE, SELL K2 CE, BUY K2 PE, SELL K1 PE — profits when the box trades BELOW its width"
      }
    >
      {isShort ? "SHORT BOX" : "LONG BOX"}
    </span>
  );
}

/** Short human label for a direction. */
export function directionLabel(direction: BoxDirection): string {
  return direction === "SHORT_BOX" ? "SHORT BOX" : "LONG BOX";
}

/**
 * A small marker showing whether a charge figure was computed locally or has
 * been confirmed against Zerodha's virtual contract note.
 */
export function ChargeOriginTag({ origin }: { origin: BoxChargeOrigin }) {
  const label =
    origin === "local_verified" ? "verified" : origin === "kite" ? "zerodha" : "local";
  const title =
    origin === "local_verified"
      ? "Computed locally and since confirmed by Zerodha's virtual contract note"
      : origin === "kite"
        ? "Priced directly by Zerodha's virtual contract note"
        : "Computed locally by the deterministic charge calculator (not yet verified against Zerodha)";
  return (
    <span className={`box-charge-origin box-charge-origin--${origin}`} title={title}>
      {label}
    </span>
  );
}
