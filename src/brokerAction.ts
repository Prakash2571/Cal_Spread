/**
 * Which primary auth action the header offers.
 *
 * Extracted and tested because this one button has now been wrong twice, both times in
 * the same way — a broker-specific branch that forgot to consult the session:
 *
 *   1. It hard-coded "Connect to Zerodha", so a Dhan session looked impossible to
 *      establish.
 *   2. The Dhan branch that fixed it rendered "Connect to Dhan" UNCONDITIONALLY, never
 *      checking whether Dhan was already connected. A live, streaming Dhan account
 *      still showed a connect button.
 *
 * The shape of the fix is what matters: CONNECTEDNESS IS TESTED FIRST, once, for
 * whichever broker is active. Adding a third broker cannot reintroduce the asymmetry,
 * because there is no per-broker branch on the connected path at all.
 */

import type { BrokerId } from "./api";

export type PrimaryAuthAction =
  /** A session exists on the active broker: offer to disconnect + sign out. */
  | { kind: "logout"; broker: BrokerId; label: "Logout" }
  /** Dhan connects through the broker panel (an app-consent flow, not a redirect). */
  | { kind: "connect-dhan"; broker: "dhan"; label: "Connect to Dhan" }
  /** Zerodha connects by redirecting to Kite's login. */
  | { kind: "connect-zerodha"; broker: "zerodha"; label: "Connect to Zerodha" };

/**
 * @param activeBroker  the broker the backend says is active
 * @param brokerConnected  whether THAT broker has a session (not whether market data
 *   is ready — a connected broker awaiting static-IP verification is still connected)
 */
export function primaryAuthAction(
  activeBroker: BrokerId | null,
  brokerConnected: boolean,
): PrimaryAuthAction {
  if (brokerConnected) {
    // Deliberately broker-agnostic: the only difference is which session gets cleared,
    // and that is the caller's concern, not the label's.
    return { kind: "logout", broker: activeBroker ?? "zerodha", label: "Logout" };
  }
  if (activeBroker === "dhan") {
    return { kind: "connect-dhan", broker: "dhan", label: "Connect to Dhan" };
  }
  // Unknown/absent broker falls back to Zerodha, matching the backend's own default.
  return { kind: "connect-zerodha", broker: "zerodha", label: "Connect to Zerodha" };
}
