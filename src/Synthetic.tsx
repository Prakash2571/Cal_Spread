import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeftIcon } from "@phosphor-icons/react";
import {
  closeSynthTrade,
  fetchSynthHistory,
  fetchSynthOpenTrades,
  fetchSynthOpportunities,
  saveSynthSettings,
  setSynthStrikeLevel,
  startSynthScanner,
  stopSynthScanner,
  synthStreamUrl,
  type SynthDirection,
  type SynthEntryBlock,
  type SynthOpenPosition,
  type SynthOpportunity,
  type SynthRejectReason,
  type SynthSnapshot,
  type SynthStatusView,
  type SynthTrade,
} from "./api.ts";
import { fmt, formatExpiry } from "./format.ts";
import ThemeToggle from "./ThemeToggle.tsx";
import { BrokerBadge } from "./BoxBroker.tsx";
import {
  Freshness,
  SynthClosedHistory,
  SynthDayPnlStrip,
  SynthDirectionBadge,
  SynthOpenCard,
  offsetLabel,
  pnlClass,
  rupees,
  signed,
} from "./SynthPositions.tsx";

/**
 * Futures vs synthetic futures arbitrage (conversion / reversal), PAPER trading.
 *
 * The backend makes every decision; this page renders its snapshot stream. The
 * synthetic is K + CE(K) − PE(K) at ATM, ATM±1, ±2 or ±3 of the SAME expiry as
 * the future, priced at the executable touch. While RUN is on, ELIGIBLE rows are
 * opened as one-lot paper positions and closed by the backend's exit rules.
 * Nothing here can send a real order.
 */

interface Props {
  authenticated: boolean;
  canTrade: boolean;
  onBack: () => void;
}

const STATUS_LABEL: Record<SynthOpportunity["status"], string> = {
  ELIGIBLE: "ELIGIBLE",
  OPEN: "OPEN",
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

/** Why an ELIGIBLE row is not being paper-entered right now. */
const ENTRY_BLOCK_LABEL: Record<SynthEntryBlock, string> = {
  paper_off: "paper trading off",
  no_db: "no trade storage",
  feed_stale: "feed stale",
  position_open: "already held",
  entering: "entering…",
  cooldown: "re-entry cooldown",
  expiry_cutoff: "expiry-day cutoff",
  max_open: "max open reached",
  confirming: "confirming",
};

type DirFilter = "all" | SynthDirection;
type View = "opportunities" | "open" | "history";

export default function Synthetic({ authenticated, canTrade, onBack }: Props) {
  const [status, setStatus] = useState<SynthStatusView | null>(null);
  const [opportunities, setOpportunities] = useState<SynthOpportunity[]>([]);
  const [open, setOpen] = useState<SynthOpenPosition[]>([]);
  const [history, setHistory] = useState<SynthTrade[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyDbEnabled, setHistoryDbEnabled] = useState(true);
  const [view, setView] = useState<View>("opportunities");
  const [live, setLive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [closingId, setClosingId] = useState<string | null>(null);
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

  /**
   * Merge closed trades by id, newest-closed first. Three sources feed this list
   * (today, the full book and live `exit` events) and they can land in any order.
   */
  const mergeHistory = useCallback((incoming: SynthTrade[]) => {
    if (incoming.length === 0) return;
    setHistory((prev) => {
      const byId = new Map(prev.map((t) => [t.id, t]));
      for (const t of incoming) byId.set(t.id, t);
      return [...byId.values()].sort((a, b) =>
        (b.closed_at ?? "").localeCompare(a.closed_at ?? ""),
      );
    });
  }, []);

  const loadHistory = useCallback(
    async (scope: "today" | "all") => {
      setHistoryLoading(true);
      setHistoryError(null);
      try {
        const r = await fetchSynthHistory(scope, 1000);
        setHistoryDbEnabled(r.db_enabled);
        mergeHistory(r.trades);
      } catch (err) {
        setHistoryError(err instanceof Error ? err.message : "Failed to load closed trades.");
      } finally {
        setHistoryLoading(false);
      }
    },
    [mergeHistory],
  );

  /* ------------------------------ load + stream ----------------------------- */

  useEffect(() => {
    if (!canTrade) return;
    fetchSynthOpportunities()
      .then((snap) => {
        adopt(snap.status);
        setOpportunities(snap.opportunities);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load the scanner."));
    fetchSynthOpenTrades()
      .then(setOpen)
      .catch(() => {
        /* the stream carries them too */
      });
    void loadHistory("today");
  }, [canTrade, adopt, loadHistory]);

  useEffect(() => {
    if (!canTrade) return;
    const es = new EventSource(synthStreamUrl());
    // Buffered and flushed on an interval, so a busy scanner cannot re-render the
    // page on every frame; the backend has made every decision by then.
    const flush = window.setInterval(() => {
      const snap = pending.current;
      if (!snap) return;
      pending.current = null;
      adopt(snap.status);
      setOpportunities(snap.opportunities);
      setOpen(snap.open_trades ?? []);
    }, 500);
    es.addEventListener("snapshot", (ev) => {
      try {
        pending.current = JSON.parse((ev as MessageEvent).data) as SynthSnapshot;
        setLive(true);
      } catch {
        /* ignore a malformed frame */
      }
    });
    es.addEventListener("entry", () => setLive(true));
    // An exit carries the complete closed trade: show it immediately.
    es.addEventListener("exit", (ev) => {
      try {
        const payload = JSON.parse((ev as MessageEvent).data) as { trade?: SynthTrade };
        if (payload.trade) mergeHistory([payload.trade]);
        else void loadHistory("today");
      } catch {
        void loadHistory("today");
      }
    });
    es.onerror = () => setLive(false);
    return () => {
      window.clearInterval(flush);
      es.close();
    };
  }, [canTrade, adopt, mergeHistory, loadHistory]);

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
        ? "Scanner stopped. No new paper positions are opened; open positions stay monitored and can still auto-exit."
        : "Scanner running. ELIGIBLE opportunities are paper-traded automatically.",
      (s) => {
        adopt(s);
        if (!s.running) setOpportunities([]);
      },
    );

  const handleStrikeLevel = (level: 1 | 2 | 3) => {
    if (status?.strike_level === level) return;
    void run(
      () => setSynthStrikeLevel(level),
      `Synthetic now built from ATM ±${level} strikes only. Open positions are unaffected.`,
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

  async function handleClose(id: string) {
    setClosingId(id);
    setError(null);
    setNotice(null);
    try {
      const r = await closeSynthTrade(id);
      setOpen(r.open);
      adopt(r.status);
      mergeHistory([r.trade]);
      setNotice(
        `Closed at the executable touch: gross ${rupees(r.trade.gross_pnl)}, charges ${rupees(
          r.trade.total_charges,
        )}, net ${rupees(r.trade.net_pnl)} after charges.`,
      );
    } catch (err) {
      // A refusal (a leg has no one-lot touch) is the meaningful case: show it as-is.
      setError(err instanceof Error ? err.message : "Failed to close the position.");
    } finally {
      setClosingId(null);
    }
  }

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

  const exitEligibleCount = useMemo(() => open.filter((p) => p.exit_eligible).length, [open]);
  const closedGross = useMemo(() => history.reduce((s, t) => s + (t.gross_pnl ?? 0), 0), [history]);
  const closedFees = useMemo(() => history.reduce((s, t) => s + (t.total_charges ?? 0), 0), [history]);
  const closedNet = useMemo(() => history.reduce((s, t) => s + (t.net_pnl ?? 0), 0), [history]);

  const freshLimit = cfg?.quote_max_age_ms ?? 15_000;
  const strikeLevel = status?.strike_level ?? cfg?.strike_level ?? 3;
  const eligibleCount = status?.eligible_count ?? 0;

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
              Conversion / reversal · K + CE − PE · paper trading, one lot
            </span>
          </div>
        </div>

        <div className="toolbar">
          <ThemeToggle />
          <span className="box-mode" title="Fills are simulated at the observed touch. Never real orders.">
            PAPER
          </span>
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
            title="The synthetic future is only built from strikes within ATM ± this many listed strikes. Open positions are unaffected."
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
            title={
              running
                ? "Stop opening new paper positions (open ones stay monitored)"
                : "Start scanning and auto-opening paper positions"
            }
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
      {status?.paper_blocked_reason === "no_db" ? (
        <div className="banner banner--warn">
          <strong>Paper trading paused.</strong> Trade storage (MongoDB) is not connected on the
          server, so ELIGIBLE opportunities are shown but not traded.
        </div>
      ) : status?.paper_blocked_reason === "disabled" ? (
        <div className="banner banner--info">
          <strong>Detection only.</strong> Paper trading is switched off on the server
          (SYNTH_PAPER_TRADING=false).
        </div>
      ) : (
        <div className="banner banner--info">
          <strong>Paper trading.</strong> While RUN is on, ELIGIBLE opportunities are opened as
          one-lot paper positions at the touch (BUY at ask, SELL at bid) and closed by the exit
          rules. The option expiry always equals the future's. Charges are shown beside P&amp;L,
          not hidden in it. Never real orders.
        </div>
      )}
      {status && status.unlinked_positions > 0 && (
        <div className="banner banner--warn">
          {status.unlinked_positions} open position(s) are not yet resolved on the active broker, so
          they cannot be priced or closed. They re-link on the next universe refresh.
        </div>
      )}
      {status && marketOpen && (running || status.open_count > 0) && !status.feed_healthy && (
        <div className="banner banner--error">
          <strong>Feed stale.</strong> No tick for{" "}
          {status.feed_age_ms === null ? "some time" : `${(status.feed_age_ms / 1000).toFixed(1)}s`}
          . Entries and automatic exits are paused until it recovers; open positions stay open.
        </div>
      )}
      {status && !marketOpen && (running || status.open_count > 0) && (
        <div className="banner banner--warn">
          <strong>Market closed.</strong> Figures use last traded prices from the{" "}
          {status.close_session_day ?? "latest"} session. Nothing is entered or exited until the
          market reopens.
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
            status
              ? `Watched / paired (future + same-expiry options). ${status.skipped_for_budget} left out by the token budget` +
                (status.unbuilt_windows > 0 ? `, ${status.unbuilt_windows} waiting for a future price.` : ".")
              : undefined
          }
        />
        <Stat
          k="Tokens"
          v={status ? `${status.subscribed_tokens} / ${status.token_budget}` : "-"}
          title={
            status
              ? `Subscribed / budget. Books received: ${status.ready_books}. Budget = ${status.base_token_budget} base` +
                (status.borrowed_from_box > 0
                  ? ` + ${status.borrowed_from_box} borrowed from the stopped Box scanner (handed back the moment Box starts).`
                  : ".")
              : undefined
          }
        />
        <Stat
          k="Box lane"
          v={
            !status || status.box_scanner_running === null
              ? "-"
              : status.box_scanner_running
                ? "Box running"
                : status.borrowed_from_box > 0
                  ? `+${status.borrowed_from_box} borrowed`
                  : "Box idle"
          }
          title="While the Box scanner is stopped, this scanner uses the part of Box's token budget Box is not holding. Box always gets it back first."
        />
        <Stat
          k="Open"
          v={status ? `${status.open_count} / ${status.max_open_positions}` : "-"}
          title="Open paper positions / maximum (never two on one underlying)"
        />
        <Stat k="Eligible" v={status ? String(eligibleCount) : "-"} />
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

      <SynthDayPnlStrip dayPnl={status?.day_pnl} />

      <nav className="box-views" role="tablist" aria-label="Synthetic view">
        <button
          type="button"
          role="tab"
          aria-selected={view === "opportunities"}
          className={`btn${view === "opportunities" ? " btn--primary" : ""}`}
          onClick={() => setView("opportunities")}
        >
          Opportunities{" "}
          <span className="pill-count">{status?.opportunity_count ?? opportunities.length}</span>
          {eligibleCount > 0 && <span className="box-badge box-badge--eligible">{eligibleCount}</span>}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === "open"}
          className={`btn${view === "open" ? " btn--primary" : ""}`}
          onClick={() => setView("open")}
        >
          Open trades <span className="pill-count">{open.length}</span>
          {exitEligibleCount > 0 && (
            <span className="box-badge box-badge--exit">{exitEligibleCount}</span>
          )}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === "history"}
          className={`btn${view === "history" ? " btn--primary" : ""}`}
          onClick={() => {
            setView("history");
            // Today first (instant), then reconcile the full book behind it.
            void loadHistory("today").then(() => loadHistory("all"));
          }}
        >
          Closed trades <span className="pill-count">{history.length}</span>
        </button>
        {view === "history" && history.length > 0 && (
          <span className="box-views-total">
            <span className="box-dim">Gross {rupees(closedGross)}</span>
            {"  −  "}
            <span className="box-dim">Fees {rupees(closedFees)}</span>
            {"  =  "}
            <span className={pnlClass(closedNet)}>Net {rupees(closedNet)}</span>
          </span>
        )}
      </nav>

      {view === "opportunities" && canTrade && cfg && (
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
              {d === "all" ? "Both" : d}
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

      {view === "opportunities" && (
        <section className="box-section">
          {!running && opportunities.length === 0 ? (
            <p className="box-empty">
              The scanner is stopped. Press <strong>RUN</strong> to compare each underlying's
              nearest future with its synthetic (K + CE − PE) at ATM ±{strikeLevel} and paper-trade
              the ones that clear the gate.
            </p>
          ) : rows.length === 0 ? (
            <p className="box-empty">
              <span className="spinner" />
              {opportunities.length === 0
                ? "Building the universe and waiting for books…"
                : "No rows match the filters."}
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
                    <th className="num" title="Locked per unit at the touch, before carry">
                      Mispricing/u
                    </th>
                    <th className="num" title="Financing of the net option premium to expiry, per unit">
                      Carry/u
                    </th>
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
                          className={`sf-row${
                            o.status === "ELIGIBLE"
                              ? " box-row--eligible"
                              : o.status === "OPEN"
                                ? " box-row--open"
                                : ""
                          }`}
                          onClick={() => setExpanded(isOpen ? null : o.key)}
                          title="Click for the three legs"
                        >
                          <td>
                            <span className="box-sym">{o.underlying}</span>
                            {o.is_index && <span className="badge-index">INDEX</span>}
                          </td>
                          <td>
                            <SynthDirectionBadge direction={o.direction} />
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
                            <Freshness
                              ageMs={o.worst_age_ms}
                              limit={freshLimit}
                              closed={o.price_source === "last_close"}
                            />
                          </td>
                          <td>
                            <span
                              className={`box-status box-status--${o.status.toLowerCase()}`}
                              title={
                                o.status === "OPEN"
                                  ? "Held as an open paper position (see Open trades)"
                                  : o.reject
                                    ? REJECT_LABEL[o.reject]
                                    : o.entry_blocked
                                      ? `Clears the gate, not entered: ${ENTRY_BLOCK_LABEL[o.entry_blocked]}`
                                      : "Clears the net-profit gate: being paper-entered"
                              }
                            >
                              {STATUS_LABEL[o.status]}
                            </span>
                            {o.status === "ELIGIBLE" && o.entry_blocked && (
                              <span className="sf-block">{ENTRY_BLOCK_LABEL[o.entry_blocked]}</span>
                            )}
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
      )}

      {view === "open" && (
        <section className="box-section">
          <h2 className="box-section-title">
            Open synthetic trades <span className="pill-count">{open.length}</span>
            <span className="box-chain-meta">
              Monitored by the backend — this continues with the scanner stopped and the browser
              closed.
            </span>
          </h2>
          {open.length === 0 ? (
            <p className="box-empty">
              No open paper positions. Qualifying opportunities are opened automatically while the
              scanner is running.
            </p>
          ) : (
            <div className="box-cards">
              {open.map((p) => (
                <SynthOpenCard
                  key={p.id}
                  p={p}
                  freshLimit={freshLimit}
                  closing={closingId === p.id}
                  onClose={() => void handleClose(p.id)}
                />
              ))}
            </div>
          )}
        </section>
      )}

      {view === "history" && (
        <SynthClosedHistory
          trades={history}
          loading={historyLoading}
          error={historyError}
          dbEnabled={historyDbEnabled}
          closedTodayCount={status?.day_pnl?.closed_count ?? 0}
        />
      )}

      <p className="box-disclaimer">
        <strong>Paper execution.</strong> Every position above is simulated. A paper fill assumes
        all three one-lot legs were executable at once at the touch recorded in that snapshot. Real
        trading can differ because of inter-leg latency, queue position, depth disappearing,
        partial fills, rejections and legging risk. These are not exchange fills.
      </p>
    </div>
  );
}

function Stat({ k, v, title }: { k: string; v: string; title?: string | undefined }) {
  return (
    <div className="box-stat" title={title}>
      <span className="box-stat-k">{k}</span>
      <span className="box-stat-v">{v}</span>
    </div>
  );
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
