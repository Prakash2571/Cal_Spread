import { useState } from "react";
import { setAdminToken, type AdminVerifyResult, type BrokerId } from "./api.ts";
import ThemeToggle from "./ThemeToggle.tsx";
import BrandMark from "./BrandMark.tsx";

interface AdminProps {
  onAuthenticated: (result: AdminVerifyResult) => void;
  /** The verify call for this route (full admin or trade access). */
  verify: (secret: string, broker?: BrokerId) => Promise<AdminVerifyResult>;
  title?: string;
  subtitle?: string;
  placeholder?: string;
  /**
   * Whether to offer the broker choice.
   *
   * TRUE only on /admin/verify. Trade-access users INHERIT the active broker and must
   * not be able to move the whole system onto a different one — so /admin/access
   * renders no picker at all rather than a disabled one, which would imply the
   * capability exists for them.
   */
  chooseBroker?: boolean;
  /**
   * Broker preselected by the URL (e.g. /admin/verify/dhan).
   *
   * Only a starting value — the operator can still change it before submitting, so a
   * bookmarked URL is a convenience rather than a hidden commitment.
   */
  initialBroker?: BrokerId;
}

const BROKERS: { id: BrokerId; label: string; hint: string }[] = [
  {
    id: "zerodha",
    label: "Zerodha",
    hint: "Kite market data, orders and charges",
  },
  {
    id: "dhan",
    label: "Dhan",
    hint: "DhanHQ v2 — requires a separate Dhan login",
  },
];

export default function Admin({
  onAuthenticated,
  verify,
  title = "Admin Verification",
  subtitle = "Enter the admin secret to access management features",
  placeholder = "Enter admin secret",
  chooseBroker = false,
  initialBroker,
}: AdminProps) {
  const [secret, setSecret] = useState("");
  const [broker, setBroker] = useState<BrokerId>(initialBroker ?? "zerodha");
  const [error, setError] = useState<string | null>(null);
  /** A refused broker switch: the login still worked, so it is a warning not an error. */
  const [blockers, setBlockers] = useState<{ reason: string; detail: string }[] | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBlockers(null);
    setLoading(true);

    try {
      const result = await verify(secret, chooseBroker ? broker : undefined);
      if (result.success && result.token) {
        setAdminToken(result.token);
        // A refused switch is surfaced rather than swallowed: the session is valid but
        // it is on the PREVIOUS broker, and the operator needs to know that before
        // they start trading against data they did not expect.
        if (result.brokerSwitchRefused) {
          setBlockers(result.brokerSwitchBlockers ?? []);
          setLoading(false);
          // Still authenticate — otherwise the operator could never reach the UI to
          // clear whatever exposure is blocking the switch.
          onAuthenticated(result);
          return;
        }
        onAuthenticated(result);
      } else {
        setError("Invalid code");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verification failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="admin-page">
      <ThemeToggle />
      <div className="admin-card">
        <BrandMark />
        <h1>{title}</h1>
        <p className="admin-subtitle">{subtitle}</p>

        <form onSubmit={handleVerify}>
          {chooseBroker && (
            <fieldset className="admin-broker" disabled={loading}>
              <legend className="admin-label">Choose broker</legend>
              <div className="admin-broker-options">
                {BROKERS.map((b) => (
                  <label
                    key={b.id}
                    className={`admin-broker-option${broker === b.id ? " is-selected" : ""}`}
                  >
                    <input
                      type="radio"
                      name="broker"
                      value={b.id}
                      checked={broker === b.id}
                      onChange={() => setBroker(b.id)}
                    />
                    <span className="admin-broker-name">{b.label.toUpperCase()}</span>
                    <span className="admin-broker-hint">{b.hint}</span>
                  </label>
                ))}
              </div>
              <p className="admin-broker-note">
                Only one broker is active at a time. Switching is refused while any Box
                position, working order or unresolved reconciliation exists.
              </p>
            </fieldset>
          )}

          <label className="admin-field">
            <span className="admin-label">{placeholder}</span>
            <input
              type="password"
              className="admin-input"
              placeholder={placeholder}
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              disabled={loading}
              autoFocus
            />
          </label>

          {error && <div className="admin-error">{error}</div>}

          {blockers && (
            <div className="admin-warn">
              <strong>Signed in, but the broker was not changed.</strong>
              <ul>
                {blockers.length > 0 ? (
                  blockers.map((b) => <li key={b.reason}>{b.detail}</li>)
                ) : (
                  <li>Box exposure or in-flight work is preventing the switch.</li>
                )}
              </ul>
              Clear these, then change broker from the Box page.
            </div>
          )}

          <button
            type="submit"
            className="btn btn--primary btn--full"
            disabled={loading || !secret.trim()}
          >
            {loading
              ? "Verifying…"
              : chooseBroker
                ? `Verify & use ${broker === "dhan" ? "Dhan" : "Zerodha"}`
                : "Verify"}
          </button>
        </form>
      </div>
    </div>
  );
}
