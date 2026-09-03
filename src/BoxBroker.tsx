/**
 * Broker presentation for the Box page.
 *
 * Kept in its own module for the same reason as BoxDirection.tsx: the broker
 * vocabulary must be identical across the opportunities, open and closed views, and
 * a badge that reads "ZERODHA" on one tab and "Zerodha" on another erodes trust in
 * a screen whose whole job is to say which venue owns a trade.
 *
 * Historical trades from both brokers coexist forever, so EVERY trade shows its own
 * badge — never the currently-active broker, which would silently relabel history.
 */

import type { BrokerId } from "./api";

/**
 * Compact "ZERODHA" / "DHAN" pill for one trade.
 *
 * `broker` is optional because rows written before broker identity existed have no
 * such field. Those are Zerodha trades — it was the only broker the application
 * ever had — so an absent value renders as ZERODHA rather than as "unknown".
 */
export function BrokerBadge({ broker }: { broker?: BrokerId | null }) {
  const isDhan = broker === "dhan";
  return (
    <span
      className={`box-broker ${isDhan ? "box-broker--dhan" : "box-broker--zerodha"}`}
      title={
        isDhan
          ? "This trade was created by the Dhan broker: Dhan market data priced it and Dhan's fee schedule costed it."
          : "This trade was created by the Zerodha broker: Zerodha market data priced it and Zerodha's fee schedule costed it."
      }
    >
      {isDhan ? "DHAN" : "ZERODHA"}
    </span>
  );
}

/** The closed-history broker filter. */
export type BrokerFilter = "all" | BrokerId;

/**
 * Filter closed trades by broker.
 *
 * Shown only when history actually contains more than one broker: offering a filter
 * with a single possible answer is noise, and on a Zerodha-only deployment it would
 * imply Dhan trades exist somewhere.
 */
export function BrokerHistoryFilter({
  value,
  onChange,
  counts,
}: {
  value: BrokerFilter;
  onChange: (next: BrokerFilter) => void;
  counts: { all: number; zerodha: number; dhan: number };
}) {
  if (counts.zerodha === 0 || counts.dhan === 0) return null;
  const options: { key: BrokerFilter; label: string; count: number }[] = [
    { key: "all", label: "All", count: counts.all },
    { key: "zerodha", label: "Zerodha", count: counts.zerodha },
    { key: "dhan", label: "Dhan", count: counts.dhan },
  ];
  return (
    <span className="box-broker-filter" role="group" aria-label="Filter closed trades by broker">
      {options.map((opt) => (
        <button
          key={opt.key}
          type="button"
          className={`btn btn--sm${value === opt.key ? " btn--primary" : ""}`}
          aria-pressed={value === opt.key}
          onClick={() => onChange(opt.key)}
        >
          {opt.label} <span className="pill-count">{opt.count}</span>
        </button>
      ))}
    </span>
  );
}

/**
 * The active broker, its session and its feed — the header strip on the Box page.
 *
 * Deliberately reports SESSION and FEED separately, and neither is derived from
 * admin authentication. "Connected" must mean the broker session is usable; showing
 * it because an operator typed the admin password would be the most misleading thing
 * this panel could do.
 */
export function BrokerStatusPanel({
  broker,
  sessionOk,
  feedLive,
  tradingReady,
  problems,
}: {
  broker?: BrokerId | null;
  /** The BROKER session is authenticated — not the admin password. */
  sessionOk: boolean;
  feedLive: boolean;
  /** Whether live order placement is currently possible. */
  tradingReady?: boolean | null;
  /** Operator-facing failures, e.g. "Static IP not configured". */
  problems?: string[];
}) {
  return (
    <div className="box-broker-status">
      <div className="box-broker-status-row">
        <span className="box-dim">Broker</span>
        <BrokerBadge broker={broker} />
      </div>
      <div className="box-broker-status-row">
        <span className="box-dim">Session</span>
        <span className={sessionOk ? "box-ok" : "box-bad"}>
          {sessionOk ? "Connected" : "Not connected"}
        </span>
      </div>
      <div className="box-broker-status-row">
        <span className="box-dim">Feed</span>
        {/* A feed cannot be live without a session, so this never contradicts the row above. */}
        <span className={feedLive ? "box-ok" : "box-bad"}>{feedLive ? "Live" : "Down"}</span>
      </div>
      {tradingReady !== undefined && tradingReady !== null && (
        <div className="box-broker-status-row">
          <span className="box-dim">Trading</span>
          <span className={tradingReady ? "box-ok" : "box-bad"}>
            {tradingReady ? "Ready" : "Blocked"}
          </span>
        </div>
      )}
      {problems && problems.length > 0 && (
        <ul className="box-broker-problems">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
