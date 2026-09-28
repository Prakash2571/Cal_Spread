import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeftIcon } from "@phosphor-icons/react";
import {
  fetchSynthOpportunities,
  saveSynthSettings,
  setSynthStrikeLevel,
  startSynthScanner,
  stopSynthScanner,
  synthStreamUrl,
  type SynthDirection,
  type SynthOpportunity,
  type SynthRejectReason,
  type SynthSnapshot,
  type SynthStatusView,
} from "./api.ts";
import { fmt, formatExpiry } from "./format.ts";
import ThemeToggle from "./ThemeToggle.tsx";
import { BrokerBadge } from "./BoxBroker.tsx";

/**
 * Futures vs synthetic futures arbitrage (conversion / reversal) — DETECTION ONLY.
 *
 * The backend makes every decision; this page renders its snapshot stream. The
 * synthetic is K + CE(K) − PE(K) at ATM, ATM±1, ±2 or ±3 of the SAME expiry as
 * the future, priced at the executable touch. Nothing here places an order.
 */

interface Props {
  authenticated: boolean;
  canTrade: boolean;
  onBack: () => void;
}

function rupees(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "-";
  const sign = v < 0 ? "-" : "";
  return `${sign}₹${Math.abs(Math.round(v)).toLocaleString("en-IN")}`;
}

function signed(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "-";
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}`;
}

function pnlClass(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "muted";
  if (v > 0) return "pnl-pos";
  if (v < 0) return "pnl-neg";
  return "";
}

function offsetLabel(off: number): string {
  return off === 0 ? "ATM" : `ATM${off > 0 ? "+" : "−"}${Math.abs(off)}`;
}

const DIRECTION_LABEL: Record<SynthDirection, string> = {
  CONVERSION: "CONVERSION",
  REVERSAL: "REVERSAL",
};

const DIRECTION_TITLE: Record<SynthDirection, string> = {
  CONVERSION: "Future cheap vs synthetic: BUY FUT, SELL CE, BUY PE",
  REVERSAL: "Future rich vs synthetic: SELL FUT, BUY CE, SELL PE",
};

const STATUS_LABEL: Record<SynthOpportunity["status"], string> = {
  ELIGIBLE: "ELIGIBLE",
  WATCHING: "WATCHING",
  REJECTED: "REJECTED",
  INDICATIVE: "AT LAST CLOSE",
};

const REJECT_LABEL: Record<SynthRejectReason, string> = {
  no_quote: "no order book yet",
  stale_quote: "book older than trust window",
  missing_bid: "no bid on a SELL leg",
  missing_ask: "no ask on a BUY leg",
  insufficient_qty: "less than one lot at the touch",
  below_expected_net_profit: "below the net-profit gate",
  market_closed: "market closed — not executable",
  no_close: "a leg did not trade in the last session",
};

type DirFilter = "all" | SynthDirection;

export default function Synthetic({ authenticated, canTrade, onBack }: Props) {
  const [status, setStatus] = useState<SynthStatusView | null>(null);
  const [opportunities, setOpportunities] = useState<SynthOpportunity[]>([]);
  const [live, setLive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  /** Collapse to the single best strike/direction per underlying. */
  const [bestOnly, setBestOnly] = useState(true);
  const [positiveOnly, setPositiveOnly] = useState(false);
  const [dirFilter, setDirFilter] = useState<DirFilter>("all");
  const [minNetInput, setMinNetInput] = useState("");
  const [bufferInput, setBufferInput] = useState("");
  const pending = useRef<SynthSnapshot | null>(null);

  const running = status?.running === true;
  const marketOpen = status ? status.market_open : true;
  const cfg = status?.config;

  const adopt = useCallback((s: SynthStatusView) => {
    setStatus(s);
    setMinNetInput((v) => (v === "" ? String(s.config.min_expected_net_profit) : v));
    setBufferInput((v) => (v === "" ? String(s.config.safety_buffer) : v));
  }, []);

  /* ------------------------------ load + stream ----------------------------- */

  useEffect(() => {
    if (!canTrade) return;
    fetchSynthOpportunities()
      .then((snap) => {
        adopt(snap.status);
        setOpportunities(snap.opportunities);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load the scanner."));
  }, [canTrade, adopt]);

  useEffect(() => {
    if (!canTrade) return;
    const es = new EventSource(synthStreamUrl());
    const flush = window.setInterval(() => {
      const snap = pending.current;
      if (!snap) return;
      pending.current = null;
      adopt(snap.status);
      setOpportunities(snap.opportunities);
    }, 500);
    es.addEventListener("snapshot", (ev) => {
      try {
        pending.current = JSON.parse((ev as MessageEvent).data) as SynthSnapshot;
        setLive(true);
      } catch {
        /* ignore a malformed frame */
      }
    });
    es.onerror = () => setLive(false);
    return () => {
      window.clearInterval(flush);
      es.close();
    };
  }, [canTrade, adopt]);

  /* -------------------------------- actions -------------------------------- */

  async function run<T>(fn: () => Promise<T>, ok: string, after?: (v: T) => void) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const v = await fn();
      after?.(v);
      setNotice(ok);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  }

  const toggleScanner = () =>
    void run(
      () => (running ? stopSynthScanner() : startSynthScanner()),
      running
        ? "Scanner stopped and its subscriptions released."
        : "Scanner running. Futures and ATM-window options are being subscribed.",
      (s) => {
        adopt(s);
        if (!s.running) setOpportunities([]);
      },
    );

  const handleStrikeLevel = (level: 1 | 2 | 3) => {
    if (status?.strike_level === level) return;
    void run(
      () => setSynthStrikeLevel(level),
      `Synthetic now built from ATM ±${level} strikes only.`,
      adopt,
    );
  };

  const handleSaveSettings = () => {
    const min = Number(minNetInput);
    const buf = Number(bufferInput);
    if (!Number.isFinite(min) || !Number.isFinite(buf)) {
      setError("Both thresholds must be numbers.");
      return;
    }
    void run(
      () => saveSynthSettings({ min_expected_net_profit: min, safety_buffer: buf }),
      "Thresholds updated (in memory on the server; reset on restart).",
      (s) => {
        setStatus(s);
        setMinNetInput(String(s.config.min_expected_net_profit));
        setBufferInput(String(s.config.safety_buffer));
      },
    );
  };

  /* --------------------------------- views --------------------------------- */

  const rows = useMemo(() => {
    let list = opportunities;
    if (dirFilter !== "all") list = list.filter((o) => o.direction === dirFilter);
    if (positiveOnly) list = list.filter((o) => (o.gross_edge ?? 0) > 0);
    if (bestOnly) {
      // The backend already sorts best-first, so the first row seen per symbol wins.
      const seen = new Set<string>();
      list = list.filter((o) => {
        if (seen.has(o.underlying)) return false;
        seen.add(o.underlying);
        return true;
      });
    }
    return list;
  }, [opportunities, dirFilter, positiveOnly, bestOnly]);

  const freshLimit = cfg?.quote_max_age_ms ?? 15_000;
  const strikeLevel = status?.strike_level ?? cfg?.strike_level ?? 3;

  return (
    <div className="app an-page">
      <header className="topbar">
        <div className="brand">
          <a
            className="btn an-back"
            href="/"
            onClick={(e) => {
              e.preventDefault();
              onBack();
            }}
            title="Back to board"
          >
            <ArrowLeftIcon size={16} weight="regular" aria-hidden="true" />
            Board
          </a>
          <div className="card-title">
            <h1>Futures vs Synthetic</h1>
            <span className="an-underline">
              Conversion / reversal · K + CE − PE · detection only
            </span>
          </div>
        </div>

        <div className="toolbar">
          <ThemeToggle />
          <span
            className={`status status--${
              running ? (!marketOpen ? "wait" : live ? "live" : "wait") : "idle"
            }`}
          >
            <span className="status-dot" />
            {running ? (!marketOpen ? "Market closed" : live ? "Scanning" : "Starting…") : "Stopped"}
          </span>
          <div
            className="box-strike-level"
            role="group"
            aria-label="Strikes each side of ATM for the synthetic"
            title="The synthetic future is only built from strikes within ATM ± this many listed strikes."
          >
            <span className="box-strike-level-label">ATM ±</span>
            {([1, 2, 3] as const).map((lvl) => (
              <button
                key={lvl}
                type="button"
                className={`btn btn--sm${strikeLevel === lvl ? " btn--primary" : ""}`}
                aria-pressed={strikeLevel === lvl}
                disabled={busy || !canTrade}
                onClick={() => handleStrikeLevel(lvl)}
              >
                {lvl}
              </button>
            ))}
          </div>
          <button
            className={`btn ${running ? "btn--danger" : "btn--primary"}`}
            onClick={toggleScanner}
            disabled={busy || !canTrade}
            title={running ? "Stop scanning and release subscriptions" : "Start scanning"}
          >
            {running ? "STOP" : "RUN"}
          </button>
        </div>
      </header>

      {!canTrade && (
        <div className="banner banner--warn">Admin sign-in is required to use this scanner.</div>
      )}
      {!authenticated && (
        <div className="banner">
          Live data needs a broker session — an admin has to connect the broker first.
        </div>
      )}
      {error && <div className="banner banner--error">{error}</div>}
      {notice && !error && <div className="banner banner--info">{notice}</div>}
      {status?.last_error && <div className="banner banner--warn">{status.last_error}</div>}
      <div className="banner banner--info">
        <strong>Detection only.</strong> No orders are placed. Prices are the executable touch
        (BUY at ask, SELL at bid), one lot, and the option expiry always equals the future's.
        Charges are shown beside the gross edge, not hidden in it.
      </div>
      {status && running && marketOpen && !status.feed_healthy && (
        <div className="banner banner--error">
          <strong>Feed stale.</strong> No book update for{" "}
          {status.feed_age_ms === null ? "some time" : `${(status.feed_age_ms / 1000).toFixed(1)}s`}
          . Nothing is ELIGIBLE on books of unknown age.
        </div>
      )}
      {status && running && !marketOpen && (
        <div className="banner banner--warn">
          <strong>Market closed.</strong> Figures use last traded prices from the{" "}
          {status.close_session_day ?? "latest"} session. They are not executable.
        </div>
      )}

      <section className="box-strip">
        <div className="box-stat">
          <span className="box-stat-k">Broker</span>
          <span className="box-stat-v">
            {status ? <BrokerBadge broker={status.broker} /> : "-"}
          </span>
        </div>
        <Stat k="Window" v={`ATM ±${strikeLevel}`} />
        <Stat
          k="Underlyings"
          v={status ? `${status.monitored_underlyings} / ${status.paired_underlyings}` : "-"}
          title={
            status && status.skipped_for_budget > 0
              ? `${status.skipped_for_budget} skipped by the SYNTH_MAX_TOKENS budget`
              : "Watched / paired (future + same-expiry options)"
          }
        />
        <Stat k="Tokens" v={status ? `${status.ready_books} / ${status.subscribed_tokens}` : "-"} title="Books received / subscribed" />
        <Stat k="Eligible" v={status ? String(status.eligible_count) : "-"} />
        <Stat
          k="rf (carry)"
          v={
            status
              ? cfg?.include_carry
                ? `${status.rf_pct}% ${status.rf_source === "default" ? "(default)" : ""}`
                : "off"
              : "-"
          }
        />
        <Stat k="Net gate" v={rupees(cfg?.min_expected_net_profit)} />
        <Stat k="Safety" v={rupees(cfg?.safety_buffer)} />
      </section>

      {canTrade && cfg && (
        <section className="box-section sf-controls">
          <label>
            Min expected net (₹)
            <input
              type="number"
              min={cfg.tunable.min_expected_net_profit.min}
              max={cfg.tunable.min_expected_net_profit.max}
              value={minNetInput}
              onChange={(e) => setMinNetInput(e.target.value)}
            />
          </label>
          <label>
            Safety buffer (₹)
            <input
              type="number"
              min={cfg.tunable.safety_buffer.min}
              max={cfg.tunable.safety_buffer.max}
              value={bufferInput}
              onChange={(e) => setBufferInput(e.target.value)}
            />
          </label>
          <button className="btn btn--sm" disabled={busy} onClick={handleSaveSettings}>
            Save
          </button>
          <span className="sf-spacer" />
          {(["all", "CONVERSION", "REVERSAL"] as const).map((d) => (
            <button
              key={d}
              className={`btn btn--sm${dirFilter === d ? " btn--primary" : ""}`}
              aria-pressed={dirFilter === d}
              onClick={() => setDirFilter(d)}
            >
              {d === "all" ? "Both" : DIRECTION_LABEL[d]}
            </button>
          ))}
          <button
            className={`btn btn--sm${bestOnly ? " btn--primary" : ""}`}
            aria-pressed={bestOnly}
            onClick={() => setBestOnly((v) => !v)}
            title="Show only the best strike/direction for each underlying"
          >
            Best per symbol
          </button>
          <button
            className={`btn btn--sm${positiveOnly ? " btn--primary" : ""}`}
            aria-pressed={positiveOnly}
            onClick={() => setPositiveOnly((v) => !v)}
            title="Hide rows whose gross edge is not positive"
          >
            Gross &gt; 0
          </button>
        </section>
      )}

      <section className="box-section">
        {!running && opportunities.length === 0 ? (
          <p className="box-empty">
            The scanner is stopped. Press <strong>RUN</strong> to compare each underlying's
            nearest future with its synthetic (K + CE − PE) at ATM ±{strikeLevel}.
          </p>
        ) : rows.length === 0 ? (
          <p className="box-empty">
            <span className="spinner" />
            {opportunities.length === 0 ? "Building the universe and waiting for books…" : "No rows match the filters."}
          </p>
        ) : (
          <div className="box-table-wrap">
            <table className="box-table">
              <thead>
                <tr>
                  <th>Underlying</th>
                  <th>Direction</th>
                  <th>Expiry</th>
                  <th className="num">Strike</th>
                  <th className="num">Future</th>
                  <th className="num">Synthetic</th>
                  <th className="num" title="Locked per unit at the touch, before carry">Mispricing/u</th>
                  <th className="num" title="Financing of the net option premium to expiry, per unit">Carry/u</th>
                  <th className="num">Gross edge</th>
                  <th className="num">Entry fees</th>
                  <th className="num">Est. exit fees</th>
                  <th className="num">Expected net</th>
                  <th>Liquidity</th>
                  <th>Fresh</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((o) => {
                  const isOpen = expanded === o.key;
                  return (
                    <Fragment key={o.key}>
                      <tr
                        className={`sf-row${o.status === "ELIGIBLE" ? " box-row--eligible" : ""}`}
                        onClick={() => setExpanded(isOpen ? null : o.key)}
                        title="Click for the three legs"
                      >
                        <td>
                          <span className="box-sym">{o.underlying}</span>
                          {o.is_index && <span className="badge-index">INDEX</span>}
                        </td>
                        <td>
                          <span
                            className={`box-badge sf-dir sf-dir--${o.direction.toLowerCase()}`}
                            title={DIRECTION_TITLE[o.direction]}
                          >
                            {DIRECTION_LABEL[o.direction]}
                          </span>
                        </td>
                        <td className="box-dim">
                          {formatExpiry(o.expiry)}{" "}
                          <span className="sf-muted">{o.days_to_expiry.toFixed(1)}d</span>
                        </td>
                        <td className="num">
                          {o.strike} <span className="sf-muted">{offsetLabel(o.atm_offset)}</span>
                        </td>
                        <td className="num">{fmt(o.future_price)}</td>
                        <td className="num">{fmt(o.synthetic_price)}</td>
                        <td className={`num ${pnlClass(o.mispricing_per_unit)}`}>
                          {signed(o.mispricing_per_unit)}
                        </td>
                        <td className="num box-dim">{signed(o.carry_per_unit)}</td>
                        <td className={`num ${pnlClass(o.gross_edge)}`}>{rupees(o.gross_edge)}</td>
                        <td className="num box-dim">{rupees(o.entry_charges)}</td>
                        <td className="num box-dim">{rupees(o.estimated_exit_charges)}</td>
                        <td
                          className={`num box-net ${pnlClass(o.expected_net_profit)}`}
                          title={`Gross − fees − slippage ${rupees(o.expected_slippage)} − safety ${rupees(o.safety_buffer)}. Gate ≥ ${rupees(o.min_expected_net_profit)}`}
                        >
                          {rupees(o.expected_net_profit)}
                        </td>
                        <td>
                          {o.price_source === "last_close" ? (
                            <span className="box-liq box-liq--closed">n/a at close</span>
                          ) : o.depth_ok ? (
                            <span className="box-liq box-liq--ok">{o.lot_size} @ touch</span>
                          ) : (
                            <span className="box-liq box-liq--bad">thin</span>
                          )}
                        </td>
                        <td>
                          <Freshness ageMs={o.worst_age_ms} limit={freshLimit} closed={o.price_source === "last_close"} />
                        </td>
                        <td>
                          <span
                            className={`box-status box-status--${o.status.toLowerCase()}`}
                            title={o.reject ? REJECT_LABEL[o.reject] : "Clears the net-profit gate"}
                          >
                            {STATUS_LABEL[o.status]}
                          </span>
                        </td>
                      </tr>
                      {isOpen && (
                        <tr className="sf-legs-row">
                          <td colSpan={15}>
                            <LegsDetail o={o} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function Stat({ k, v, title }: { k: string; v: string; title?: string }) {
  return (
    <div className="box-stat" title={title}>
      <span className="box-stat-k">{k}</span>
      <span className="box-stat-v">{v}</span>
    </div>
  );
}

function Freshness({ ageMs, limit, closed }: { ageMs: number | null; limit: number; closed: boolean }) {
  if (closed) return <span className="box-fresh box-fresh--warn">close</span>;
  if (ageMs === null) return <span className="box-fresh box-fresh--bad">no book</span>;
  const text = ageMs < 1000 ? `${ageMs}ms` : `${(ageMs / 1000).toFixed(1)}s`;
  return <span className={`box-fresh box-fresh--${ageMs <= limit ? "ok" : "bad"}`}>{text}</span>;
}

function LegsDetail({ o }: { o: SynthOpportunity }) {
  return (
    <div className="sf-legs">
      <p className="sf-formula">
        {o.direction === "CONVERSION"
          ? `Locked/u = K + CE.bid − PE.ask − FUT.ask = ${o.strike} + (${fmt(o.legs[1]?.price)} − ${fmt(o.legs[2]?.price)}) − ${fmt(o.future_price)}`
          : `Locked/u = FUT.bid − K − (CE.ask − PE.bid) = ${fmt(o.future_price)} − ${o.strike} − (${fmt(o.legs[1]?.price)} − ${fmt(o.legs[2]?.price)})`}{" "}
        = <strong className={pnlClass(o.mispricing_per_unit)}>{signed(o.mispricing_per_unit)}</strong>
        {" · "}mid basis F − (K + C − P) = {signed(o.mid_basis)}
        {" · "}qty {o.quantity}
      </p>
      <table className="box-chain sf-legs-table">
        <thead>
          <tr>
            <th className="sf-left">Leg</th>
            <th className="sf-left">Contract</th>
            <th>Side</th>
            <th className="num">BidQty</th>
            <th className="num">Bid</th>
            <th className="num">Ask</th>
            <th className="num">AskQty</th>
            <th className="num">Last</th>
            <th className="num">Price used</th>
            <th>OK</th>
          </tr>
        </thead>
        <tbody>
          {o.legs.map((l) => (
            <tr key={l.role}>
              <td className="sf-left">{l.instrument_type}</td>
              <td className="sf-left">{l.tradingsymbol}</td>
              <td>
                <span className={`box-leg box-leg--${l.side === "BUY" ? "buy" : "sell"}`}>{l.side}</span>
              </td>
              <td className="num">{l.bid_qty || "-"}</td>
              <td className="num">{l.bid ? fmt(l.bid) : "-"}</td>
              <td className="num">{l.ask ? fmt(l.ask) : "-"}</td>
              <td className="num">{l.ask_qty || "-"}</td>
              <td className="num">{l.last ? fmt(l.last) : "-"}</td>
              <td className="num">{fmt(l.price)}</td>
              <td>{l.executable ? "✓" : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
