/**
 * The header's primary auth button.
 *
 * Reported symptom: "i am logined with dhan why in ui its showing connect to dhan" —
 * with Dhan active, connected, and streaming 204 stocks live, the header still offered
 * "Connect to Dhan". The branch never consulted the session.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { primaryAuthAction } from "../src/brokerAction.ts";

test("a CONNECTED Dhan session offers logout, never connect", () => {
  // The exact reported bug.
  const action = primaryAuthAction("dhan", true);
  assert.equal(action.kind, "logout");
  assert.equal(action.label, "Logout");
  assert.notEqual(action.label, "Connect to Dhan");
});

test("a connected session logs out of the ACTIVE broker", () => {
  // The latent half of the bug: logout always called Zerodha's endpoint, so with Dhan
  // active it cleared an irrelevant Kite session and left Dhan connected.
  assert.equal(primaryAuthAction("dhan", true).broker, "dhan");
  assert.equal(primaryAuthAction("zerodha", true).broker, "zerodha");
});

test("a DISCONNECTED broker offers the right connect flow", () => {
  // Dhan is an app-consent flow through the panel; Zerodha is a redirect.
  assert.equal(primaryAuthAction("dhan", false).kind, "connect-dhan");
  assert.equal(primaryAuthAction("dhan", false).label, "Connect to Dhan");
  assert.equal(primaryAuthAction("zerodha", false).kind, "connect-zerodha");
  assert.equal(primaryAuthAction("zerodha", false).label, "Connect to Zerodha");
});

test("connectedness is decided BEFORE any broker-specific branch", () => {
  // The property that prevents this regressing a third time: for every broker, being
  // connected produces logout. No per-broker path can skip the session check.
  for (const broker of ["dhan", "zerodha", null]) {
    assert.equal(
      primaryAuthAction(broker, true).kind,
      "logout",
      `${broker} connected must offer logout`,
    );
  }
});

test("an unknown broker falls back to Zerodha, matching the backend default", () => {
  assert.equal(primaryAuthAction(null, false).kind, "connect-zerodha");
});
