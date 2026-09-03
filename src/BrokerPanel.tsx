/**
 * The broker control panel — switch broker, connect, disconnect.
 *
 * WHY THIS EXISTS
 * Broker selection used to live ONLY on `/admin/verify`, which an already-signed-in
 * admin is redirected away from. That made the choice effectively one-shot: after the
 * first login there was no way to reach the picker, so selecting Dhan appeared to do
 * nothing and the UI kept showing ZERODHA. Broker is a runtime decision an operator
 * needs to revisit, so it belongs in the app, not only on the login screen.
 *
 * WHAT IT REFUSES TO DO
 * It never switches optimistically. The backend owns the decision and answers 409 with
 * the full list of blockers when Box exposure or in-flight work exists; this panel
 * renders that list verbatim rather than retrying or hiding it. The displayed broker
 * always comes from the server's own status, so it cannot drift from reality.
 */

import { useCallback, useEffect, useState } from "react";
import {
  beginDhanLogin,
  fetchBrokerStatus,
  fetchDhanStatus,
  loginUrl,
  logout as logoutZerodha,
  logoutDhan,
  selectBroker,
  verifyDhanIp,
  type BrokerId,
  type BrokerStatus,
  type BrokerSwitchBlocker,
  type DhanStatus,
} from "./api.ts";
import { BrokerBadge } from "./BoxBroker.tsx";

interface Props {
  /** Full admin only: switching broker moves the whole system. */
  isFullAdmin: boolean;
  onClose: () => void;
  /** Lets the app refresh its own broker badge after a change. */
  onBrokerChanged?: (broker: BrokerId) => void;
}

export default function BrokerPanel({ isFullAdmin, onClose, onBrokerChanged }: Props) {
  const [status, setStatus] = useState<BrokerStatus | null>(null);
  const [dhan, setDhan] = useState<DhanStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [blockers, setBlockers] = useState<BrokerSwitchBlocker[] | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await fetchBrokerStatus();
      setStatus(next);
      onBrokerChanged?.(next.broker);
      // Dhan detail is best-effort: a Zerodha-only deployment has none, and that must
      // not surface as an error on this panel.
      setDhan(await fetchDhanStatus().catch(() => null));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load the broker status.");
    }
  }, [onBrokerChanged]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleSelect(broker: BrokerId) {
    setBusy(`select:${broker}`);
    setError(null);
    setBlockers(null);
    try {
      const next = await selectBroker(broker);
      setStatus(next);
      onBrokerChanged?.(next.broker);
      await refresh();
    } catch (err) {
      // A 409 carries the blocker list. Show every one — an operator with three
      // problems should see three, not discover them one refusal at a time.
      const withBlockers = err as Error & { blockers?: BrokerSwitchBlocker[] };
      if (withBlockers.blockers) setBlockers(withBlockers.blockers);
      setError(withBlockers.message);
    } finally {
      setBusy(null);
    }
  }

  async function handleConnectDhan() {
    setBusy("connect:dhan");
    setError(null);
    try {
      // The consent is generated server-side (it needs the API secret), and the
      // browser then completes Dhan's own login.
      const { login_url } = await beginDhanLogin();
      window.location.href = login_url;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start the Dhan login.");
      setBusy(null);
    }
  }

  async function handleVerifyIp() {
    setBusy("verify:ip");
    setError(null);
    try {
      const result = await verifyDhanIp();
      // Surface Dhan's own answer rather than a generic failure: "no IP whitelisted"
      // and "does not match" need different actions from the operator.
      if (!result.verified && result.error) setError(result.error);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to verify the static IP.");
    } finally {
      setBusy(null);
    }
  }

  async function handleDisconnect(broker: BrokerId) {
    setBusy(`disconnect:${broker}`);
    setError(null);
    try {
      if (broker === "dhan") await logoutDhan();
      else await logoutZerodha();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to disconnect.");
    } finally {
      setBusy(null);
    }
  }

  const active = status?.broker ?? null;
  const health = status?.health ?? null;

  /** Per-broker connection state, so each row can be judged on its own. */
  const connected = (broker: BrokerId): boolean =>
    broker === active
      ? (health?.authenticated ?? false)
      : broker === "dhan"
        ? (dhan?.authenticated ?? false)
        : false;

  return (
    <div className="modal-overlay" onClick={busy ? undefined : onClose}>
      <div className="modal modal--sm" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <div>
            <h2>Broker</h2>
            <p className="modal-sub">
              Only one broker is active at a time for data, the scanner and new trades.
            </p>
          </div>
          <button type="button" className="modal-x" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <div className="modal-body">
          {/* ---- what is live right now ---- */}
          <div className="broker-live">
            <div className="metric-row">
              <span className="metric-label">Active</span>
              <span className="metric-value">
                {active ? <BrokerBadge broker={active} /> : "…"}
              </span>
            </div>
            <div className="metric-row">
              <span className="metric-label">Session</span>
              <span className={`metric-value ${health?.authenticated ? "pos" : "neg"}`}>
                {health?.authenticated ? "Connected" : "Not connected"}
              </span>
            </div>
            <div className="metric-row">
              <span className="metric-label">Feed</span>
              <span className={`metric-value ${health?.feed_connected ? "pos" : "neg"}`}>
                {health?.feed_connected ? "Live" : "Down"}
              </span>
            </div>
            <div className="metric-row">
              <span className="metric-label">Trading</span>
              <span className={`metric-value ${health?.trading_ready ? "pos" : "neg"}`}>
                {health?.trading_ready ? "Ready" : "Blocked"}
              </span>
            </div>
          </div>

          {/* Operator-facing reasons, e.g. an unverified static IP. */}
          {health?.problems && health.problems.length > 0 && (
            <ul className="broker-problems">
              {health.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}

          {/* ---- switch + connect, per broker ---- */}
          <div className="broker-rows">
            {(["zerodha", "dhan"] as BrokerId[]).map((broker) => {
              const isActive = broker === active;
              const isConnected = connected(broker);
              const configured = broker === "zerodha" || (status?.dhan_configured ?? false);
              return (
                <div key={broker} className={`broker-row${isActive ? " is-active" : ""}`}>
                  <div className="broker-row-head">
                    <BrokerBadge broker={broker} />
                    {isActive && <span className="broker-tag">ACTIVE</span>}
                    <span className={`broker-tag ${isConnected ? "is-ok" : "is-off"}`}>
                      {isConnected ? "session live" : "no session"}
                    </span>
                  </div>

                  {!configured && (
                    <p className="broker-row-note">
                      Not configured on the server — set DHAN_CLIENT_ID, DHAN_API_KEY and
                      DHAN_API_SECRET.
                    </p>
                  )}

                  <div className="broker-row-actions">
                    {!isActive && (
                      <button
                        className="btn btn--sm btn--primary"
                        disabled={!isFullAdmin || !configured || busy !== null}
                        title={
                          isFullAdmin
                            ? `Make ${broker} the active broker`
                            : "Full administrator access required"
                        }
                        onClick={() => void handleSelect(broker)}
                      >
                        {busy === `select:${broker}` ? "Switching…" : "Make active"}
                      </button>
                    )}

                    {/* Connect is broker-specific: Zerodha is a redirect to Kite,
                        Dhan needs a server-side consent first. */}
                    {broker === "zerodha" ? (
                      <a
                        className="btn btn--sm"
                        href={loginUrl()}
                        aria-disabled={!isFullAdmin}
                      >
                        {isConnected ? "Reconnect Zerodha" : "Connect Zerodha"}
                      </a>
                    ) : (
                      <button
                        className="btn btn--sm"
                        disabled={!isFullAdmin || !configured || busy !== null}
                        onClick={() => void handleConnectDhan()}
                      >
                        {busy === "connect:dhan"
                          ? "Opening Dhan…"
                          : isConnected
                            ? "Reconnect Dhan"
                            : "Connect Dhan"}
                      </button>
                    )}

                    {isConnected && (
                      <button
                        className="btn btn--sm btn--danger"
                        disabled={!isFullAdmin || busy !== null}
                        title={`Drop the ${broker} session`}
                        onClick={() => void handleDisconnect(broker)}
                      >
                        {busy === `disconnect:${broker}` ? "…" : "Disconnect"}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Static-IP verification is cached server-side, so after whitelisting an
              address in the Dhan dashboard this is what picks it up. Offered only when
              Dhan is active and its IP check is what is blocking trading. */}
          {active === "dhan" && status?.dhan_static_ip?.ready === false && (
            <div className="broker-ip">
              <div className="broker-row-note">
                Configured IP: <code>{status.dhan_static_ip.configured_ip ?? "not set"}</code>
                {status.dhan_static_ip.primary_ip && (
                  <> · Dhan holds: <code>{status.dhan_static_ip.primary_ip}</code></>
                )}
                {status.dhan_static_ip.secondary_ip && (
                  <>, <code>{status.dhan_static_ip.secondary_ip}</code></>
                )}
              </div>
              <button
                className="btn btn--sm"
                disabled={!isFullAdmin || busy !== null}
                title="Re-check this server's IP against Dhan's whitelist"
                onClick={() => void handleVerifyIp()}
              >
                {busy === "verify:ip" ? "Verifying…" : "Verify static IP"}
              </button>
            </div>
          )}

          {/* A refused switch is the expected, meaningful case — never hidden. */}
          {blockers && (
            <div className="broker-blockers">
              <strong>Cannot switch broker yet:</strong>
              <ul>
                {blockers.length > 0 ? (
                  blockers.map((b) => <li key={b.reason}>{b.detail}</li>)
                ) : (
                  <li>Box exposure or in-flight work is preventing the switch.</li>
                )}
              </ul>
              Clear these from the Box page, then try again.
            </div>
          )}

          {error && !blockers && <div className="admin-error">{error}</div>}

          {!isFullAdmin && (
            <p className="broker-row-note">
              You are signed in with trade access, which inherits the active broker.
              Changing it needs full administrator access.
            </p>
          )}

          <div className="modal-actions">
            <button className="btn modal-action" onClick={() => void refresh()} disabled={busy !== null}>
              Refresh
            </button>
            <button className="btn modal-action" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
