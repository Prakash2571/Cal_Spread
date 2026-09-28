/**
 * Paper-trading views for the Futures vs Synthetic page: the day P&L strip, the
 * open-position cards and the closed-trade history.
 *
 * Every figure comes from the backend, which is the sole authority for marks, exit
 * decisions and P&L; this only renders them. Following trade-realism.md:
 *   - open positions are marked to LTP (price move, before charges),
 *   - "if closed now" figures are priced at the executable touch,
 *   - charges are shown beside P&L, and every netted figure says "after charges".
 *
 * Laid out with Box's classes so the two paper books read the same way.
 */

import { useCallback, useMemo, useState } from "react";
import type {
  SynthDayPnl,
  SynthDirection,
  SynthExitReason,
  SynthOpenPosition,
  SynthTrade,
} from "./api.ts";
import { fmt, formatExpiry } from "./format.ts";
import { BrokerBadge } from "./BoxBroker.tsx";

/* --------------------------------- helpers -------------------------------- */

/** Money with no decimals: these figures are rupees, not paise. */
export function rupees(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "-";
  const sign = v < 0 ? "-" : "";
  return `${sign}₹${Math.abs(Math.round(v)).toLocaleString("en-IN")}`;
}

export function signed(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "-";
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}`;
}

export function pnlClass(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "muted";
  if (v > 0) return "pnl-pos";
  if (v < 0) return "pnl-neg";
  return "";
}

export function offsetLabel(off: number): string {
  return off === 0 ? "ATM" : `ATM${off > 0 ? "+" : "−"}${Math.abs(off)}`;
}

const DIRECTION_TITLE: Record<SynthDirection, string> = {
  CONVERSION: "Future cheap vs synthetic: BUY FUT, SELL CE, BUY PE",
  REVERSAL: "Future rich vs synthetic: SELL FUT, BUY CE, SELL PE",
};

export function SynthDirectionBadge({ direction }: { direction: SynthDirection }) {
  return (
    <span
      className={`box-badge sf-dir sf-dir--${direction.toLowerCase()}`}
      title={DIRECTION_TITLE[direction]}
    >
      {direction}
    </span>
  );
}

/** How long ago a leg's book last changed, against the trust window. */
export function Freshness({
  ageMs,
  limit,
  closed = false,
}: {
  ageMs: number | null;
  limit: number;
  closed?: boolean;
}) {
  if (closed) return <span className="box-fresh box-fresh--warn">close</span>;
  if (ageMs === null) return <span className="box-fresh box-fresh--bad">no book</span>;
  const text = ageMs < 1000 ? `${ageMs}ms` : `${(ageMs / 1000).toFixed(1)}s`;
  return <span className={`box-fresh box-fresh--${ageMs <= limit ? "ok" : "bad"}`}>{text}</span>;
}

const EXIT_REASON_LABEL: Record<SynthExitReason, string> = {
  EDGE_CONVERGED: "Converged",
  PROFIT_CAPTURE: "Profit capture",
  EXPIRY_SAFETY: "Expiry safety",
  EXPIRED: "Settled at expiry",
  MANUAL: "Manual",
};

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function istDayKey(iso: string): string {
  const at = new Date(iso).getTime();
  return Number.isFinite(at) ? new Date(at + IST_OFFSET_MS).toISOString().slice(0, 10) : "unknown";
}

function istTodayKey(): string {
  return new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function istDayLabel(key: string): string {
  if (key === "unknown") return "Unknown date";
  return new Date(`${key}T00:00:00+05:30`).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "long",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  });
}

function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
    timeZone: "Asia/Kolkata",
  });
}

function duration(fromIso: string, toIso: string | null): string {
  const a = new Date(fromIso).getTime();
  const b = toIso ? new Date(toIso).getTime() : Date.now();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return "-";
  const secs = Math.max(0, Math.round((b - a) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ${mins % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function Metric({
  label,
  value,
  cls,
  title,
}: {
  label: string;
  value: string;
  cls?: string;
  title?: string;
}) {
  return (
    <div className={`box-metric ${cls ?? ""}`} title={title}>
      <span className="box-metric-k">{label}</span>
      <span className="box-metric-v">{value}</span>
    </div>
  );
}

/* --------------------------------- day P&L -------------------------------- */

function DayItem({
  label,
  value,
  title,
  sub,
  total,
}: {
  label: string;
  value: number;
  title: string;
  sub?: string;
  total?: boolean;
}) {
  const cls = value > 0 ? "is-pos" : value < 0 ? "is-neg" : "";
  return (
    <div className={`box-daypnl-item${total ? " box-daypnl-total" : ""}`} title={title}>
      <span className="box-daypnl-k">{label}</span>
      <span className={`box-daypnl-v ${cls}`}>{rupees(value)}</span>
      {sub && <span className="box-daypnl-sub">{sub}</span>}
    </div>
  );
}

/** "How is today going", from the backend's day summary. */
export function SynthDayPnlStrip({ dayPnl }: { dayPnl: SynthDayPnl | undefined }) {
  if (!dayPnl) return null;
  return (
    <section className="box-daypnl" aria-label="Running day P&L">
      <DayItem
        label={`Open P&L @ LTP (${dayPnl.open_count})`}
        value={dayPnl.open_mtm_ltp}
        title="Every open position's price move marked to LTP, before charges: what a broker screen shows"
        {...(dayPnl.open_unmarked_count > 0
          ? { sub: `${dayPnl.open_unmarked_count} not marked yet` }
          : {})}
      />
      <DayItem
        label="Open net if closed now"
        value={dayPnl.open_running_net_pnl}
        title="Closing every open position at the executable touch now, after entry and exit charges"
        sub={
          dayPnl.open_unpriced_count > 0
            ? `${dayPnl.open_unpriced_count} unpriced, excluded`
            : `gross ${rupees(dayPnl.open_running_gross_pnl)} at the touch`
        }
      />
      <DayItem
        label={`Closed today net (${dayPnl.closed_count})`}
        value={dayPnl.closed_realised_net_pnl}
        title="Realised P&L of positions closed today, after charges"
        sub={`gross ${rupees(dayPnl.closed_realised_gross_pnl)} · fees ${rupees(dayPnl.closed_charges)}`}
      />
      <DayItem
        label="Day net P&L (after charges)"
        value={dayPnl.total_net_pnl}
        title="Open net if closed now + today's realised net"
        total
      />
    </section>
  );
}

/* ------------------------------- open cards ------------------------------- */

/** Why an open position is not closing, so the page never looks asleep. */
function whyHeld(p: SynthOpenPosition): string {
  if (!p.linked) {
    return "Held: this position's contracts are not resolved on the active broker yet, so it cannot be priced. It re-links on the next universe refresh and still settles at expiry.";
  }
  // Liquidity first: inside the expiry-safety window a LOSING position is being
  // force-closed, so "waiting to converge" would be the wrong explanation.
  if (p.exit_blocked_reason === "insufficient_exit_liquidity") {
    return p.expiry_safety
      ? "Held: expiry safety is closing this position whatever its P&L, but not every leg shows one lot at the touch. It closes as soon as they do."
      : "Held: the exit rules are met, but not every leg shows one lot at the touch. It closes once they do.";
  }
  if (p.net_pnl === null) {
    return "Held: a leg has no closing price (no book yet, or the market is shut), so the exit cannot be priced. No fill is invented.";
  }
  if (p.net_pnl <= 0) {
    return `Held: closing now would realise ${rupees(p.net_pnl)} after charges. The lock pays at expiry, so it waits for the basis to converge in profit.`;
  }
  const converged = p.remaining_edge !== null && p.remaining_edge <= p.convergence_threshold;
  if (!converged && p.net_pnl < p.profit_capture_target) {
    return `Held: in profit at ${rupees(p.net_pnl)} after charges, but the edge has not converged (remaining ${rupees(p.remaining_edge)} > ${rupees(p.convergence_threshold)}) and profit is below the ${rupees(p.profit_capture_target)} capture level.`;
  }
  if (p.net_pnl < p.min_exit_net_pnl) {
    return `Held: net ${rupees(p.net_pnl)} after charges is below the ${rupees(p.min_exit_net_pnl)} minimum for an early exit.`;
  }
  return "Held: exit conditions met, confirming on the next evaluation.";
}

export function SynthOpenCard({
  p,
  freshLimit,
  closing,
  onClose,
}: {
  p: SynthOpenPosition;
  freshLimit: number;
  closing: boolean;
  onClose: () => void;
}) {
  const exitByRole = new Map(p.exit_legs.map((l) => [l.role, l]));
  const busy = closing || p.closing;
  return (
    <div className={`box-card${p.exit_eligible ? " box-card--exiting" : ""}`}>
      <div className="box-card-head">
        <div>
          <span className="box-sym">{p.underlying}</span>
          {p.is_index && <span className="badge-index">INDEX</span>}
          <SynthDirectionBadge direction={p.direction} />
          <BrokerBadge broker={p.broker} />
          <span className="box-card-strikes">
            K {p.strike} <span className="sf-muted">{offsetLabel(p.atm_offset)}</span>
          </span>
          <span className="box-chain-meta">
            {formatExpiry(p.expiry)} · {p.quantity} qty (1 lot) · held {duration(p.opened_at, null)}
          </span>
        </div>
        <div className="box-card-actions">
          {p.exit_eligible && <span className="box-badge box-badge--exit">AUTO EXIT ELIGIBLE</span>}
          {p.expiry_safety && <span className="box-badge box-badge--warn">EXPIRY SAFETY</span>}
          {!p.linked && <span className="box-badge box-badge--warn">NOT LINKED</span>}
          <button
            className="btn btn--sm"
            onClick={onClose}
            disabled={busy}
            title="Close now at the current executable touch (refused, never faked, if a leg has no book)"
          >
            {busy ? "Closing…" : "Close now"}
          </button>
        </div>
      </div>

      <div className="box-legs">
        {p.legs.map((leg) => {
          const ex = exitByRole.get(leg.role);
          return (
            <div className="box-leg-row" key={leg.role}>
              <span className={`leg-tag ${leg.side === "BUY" ? "tag-buy" : "tag-sell"}`}>
                {leg.side}
              </span>
              <span className="box-leg-name" title={leg.tradingsymbol}>
                {leg.instrument_type === "FUT" ? "FUT" : `${leg.strike} ${leg.instrument_type}`}
              </span>
              <span className="box-leg-cell">
                @ {fmt(leg.entry_price)}
                <span className="box-leg-side">{leg.side === "BUY" ? "ask" : "bid"}</span>
              </span>
              <span className="box-leg-cell" title="Last traded price: what the open P&L is marked to">
                LTP {ex?.ltp ? fmt(ex.ltp) : "-"}
              </span>
              <span className={`leg-tag ${ex?.side === "BUY" ? "tag-buy" : "tag-sell"}`}>
                {ex?.side ?? "-"}
              </span>
              <span className="box-leg-cell">
                {ex?.price ? fmt(ex.price) : "-"}
                <span className="box-leg-side">{ex?.side === "BUY" ? "ask" : "bid"}</span>
              </span>
              <span className="box-leg-cell box-dim">
                {ex ? `${ex.side === "BUY" ? ex.ask_qty : ex.bid_qty} @ touch` : "-"}
              </span>
              <Freshness ageMs={ex?.age_ms ?? null} limit={freshLimit} />
              {ex && ex.price !== null && !ex.executable && (
                <span className="box-liq box-liq--bad">thin</span>
              )}
            </div>
          );
        })}
      </div>

      <div className="box-card-grid">
        <Metric
          label="Locked at entry"
          value={rupees(p.entry_edge)}
          title={`Lock ${signed(p.entry_lock_per_unit)}/unit × ${p.quantity}: the gross if held to expiry`}
        />
        <Metric label="Expected net (entry)" value={rupees(p.expected_net_profit)} />
        <Metric
          label="Open P&L @ LTP"
          value={rupees(p.mtm_ltp)}
          cls={`box-metric--strong ${pnlClass(p.mtm_ltp)}`}
          title="Price move marked to LTP, before charges: what a broker screen shows. It still owes the exit spread."
        />
        <Metric
          label="Gross if closed now"
          value={rupees(p.gross_pnl)}
          cls={pnlClass(p.gross_pnl)}
          title="Closing all three legs at the executable touch now"
        />
        <Metric label="Entry fees" value={rupees(p.entry_charges)} />
        <Metric label="Est. exit fees" value={rupees(p.current_exit_charges)} />
        <Metric label="Total charges" value={rupees(p.total_charges)} />
        <Metric
          label="Net if closed now (after charges)"
          value={rupees(p.net_pnl)}
          cls={`box-metric--strong ${pnlClass(p.net_pnl)}`}
        />
        <Metric
          label="Remaining edge"
          value={rupees(p.remaining_edge)}
          title="What holding to expiry would still add over closing now"
        />
        <Metric
          label="Captured %"
          value={p.captured_pct === null ? "—" : `${Math.round(p.captured_pct * 100)}%`}
        />
        <Metric label="Exit threshold" value={rupees(p.convergence_threshold)} />
        <Metric label="Min exit profit" value={rupees(p.min_exit_net_pnl)} />
        <Metric label="Profit capture at" value={rupees(p.profit_capture_target)} />
      </div>

      {!p.exit_eligible && <p className="box-held">{whyHeld(p)}</p>}
    </div>
  );
}

/* ------------------------------ closed history ---------------------------- */

export function SynthClosedHistory({
  trades,
  loading,
  error,
  dbEnabled,
  closedTodayCount,
}: {
  trades: SynthTrade[];
  loading: boolean;
  error: string | null;
  dbEnabled: boolean;
  /** What the day summary says was closed today, to catch a failed list load. */
  closedTodayCount: number;
}) {
  const todayKey = istTodayKey();
  // Today stays expanded until the user toggles a day; tracked here because the
  // frequent snapshot re-renders would reset an uncontrolled <details>.
  const [dayOverrides, setDayOverrides] = useState<Record<string, boolean>>({});
  const isDayOpen = useCallback(
    (key: string) => dayOverrides[key] ?? key === todayKey,
    [dayOverrides, todayKey],
  );
  const setDayOpen = useCallback((key: string, next: boolean) => {
    setDayOverrides((prev) => (prev[key] === next ? prev : { ...prev, [key]: next }));
  }, []);

  const days = useMemo(() => {
    const groups = new Map<string, SynthTrade[]>();
    for (const t of trades) {
      const key = istDayKey(t.closed_at ?? t.opened_at);
      const group = groups.get(key);
      if (group) group.push(t);
      else groups.set(key, [t]);
    }
    return [...groups]
      .sort(([a], [b]) => (a === "unknown" ? 1 : b === "unknown" ? -1 : b.localeCompare(a)))
      .map(([key, list]) => ({
        key,
        label: istDayLabel(key),
        trades: list,
        gross: list.reduce((sum, t) => sum + (t.gross_pnl ?? 0), 0),
        fees: list.reduce((sum, t) => sum + (t.total_charges ?? 0), 0),
        net: list.reduce((sum, t) => sum + (t.net_pnl ?? 0), 0),
      }));
  }, [trades]);

  return (
    <section className="box-section">
      <h2 className="box-section-title">
        Closed synthetic trades <span className="pill-count">{trades.length}</span>
        {loading && (
          <span className="box-chain-meta">
            <span className="spinner" /> loading earlier days…
          </span>
        )}
      </h2>
      {error && <div className="banner banner--warn">{error}</div>}
      {!dbEnabled && (
        <div className="banner banner--warn">
          Paper-trade storage (MongoDB) is not connected on the server, so the closed-trade log
          cannot be read. Trades closed in this session may still be listed from memory.
        </div>
      )}
      {trades.length === 0 ? (
        <p className="box-empty">
          {error
            ? "The closed-trade log could not be loaded — see the message above."
            : loading
              ? "Loading closed paper trades…"
              : closedTodayCount > 0
                ? `The day summary reports ${closedTodayCount} trade(s) closed today, but none could be listed. That is a load failure, not an empty log — try reloading.`
                : "No closed paper trades yet."}
        </p>
      ) : (
        <div className="box-history-days">
          {days.map((day) => (
            <details
              className="box-history-day"
              key={day.key}
              open={isDayOpen(day.key)}
              onToggle={(e) => setDayOpen(day.key, e.currentTarget.open)}
            >
              <summary className="box-history-day-summary">
                <span>
                  {day.key === todayKey && <strong>Today · </strong>}
                  {day.label}
                </span>
                <span className="box-history-day-meta">
                  <span className="pill-count">
                    {day.trades.length} {day.trades.length === 1 ? "trade" : "trades"}
                  </span>
                  <span className="box-dim">Gross {rupees(day.gross)}</span>
                  <span className="box-dim">Fees {rupees(day.fees)}</span>
                  <span className={pnlClass(day.net)}>Net {rupees(day.net)}</span>
                </span>
              </summary>
              <div className="box-table-wrap">
                <table className="box-table">
                  <thead>
                    <tr>
                      <th>Underlying</th>
                      <th>Direction</th>
                      <th>Expiry</th>
                      <th className="num">Strike</th>
                      <th>Opened</th>
                      <th>Closed</th>
                      <th className="num">Held</th>
                      <th>Broker</th>
                      <th className="num" title="Lock per unit × quantity at entry: the gross if held to expiry">
                        Locked at entry
                      </th>
                      <th className="num">Entry fees</th>
                      <th className="num">Exit fees</th>
                      <th className="num">Total fees</th>
                      <th className="num">Gross P&amp;L</th>
                      <th className="num">Net P&amp;L</th>
                      <th>Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {day.trades.map((t) => (
                      <tr key={t.id}>
                        <td>
                          <span className="box-sym">{t.underlying}</span>
                          {t.is_index && <span className="badge-index">INDEX</span>}
                        </td>
                        <td>
                          <SynthDirectionBadge direction={t.direction} />
                        </td>
                        <td className="box-dim">{formatExpiry(t.expiry)}</td>
                        <td className="num">
                          {t.strike} <span className="sf-muted">{offsetLabel(t.atm_offset)}</span>
                        </td>
                        <td className="box-dim">{fmtDateTime(t.opened_at)}</td>
                        <td className="box-dim">{t.closed_at ? fmtDateTime(t.closed_at) : "-"}</td>
                        <td className="num box-dim">{duration(t.opened_at, t.closed_at)}</td>
                        <td>
                          <BrokerBadge broker={t.broker} />
                        </td>
                        <td className="num">{rupees(t.entry_edge)}</td>
                        <td className="num box-dim">{rupees(t.entry_charges)}</td>
                        <td className="num box-dim">{rupees(t.exit_charges)}</td>
                        <td className="num box-dim">{rupees(t.total_charges)}</td>
                        <td className={`num ${pnlClass(t.gross_pnl)}`}>{rupees(t.gross_pnl)}</td>
                        <td className={`num box-net ${pnlClass(t.net_pnl)}`}>{rupees(t.net_pnl)}</td>
                        <td>
                          <span className="box-reason" title={t.exit_note ?? undefined}>
                            {t.exit_reason ? EXIT_REASON_LABEL[t.exit_reason] : "-"}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          ))}
        </div>
      )}
    </section>
  );
}
