import { useMemo, useState } from "react";
import type { Tick, Trade, TradeCharges } from "./api.ts";
import { fmt, fmtMoney, formatExpiry } from "./format.ts";

interface Props {
  trades: Trade[];
  ticks: Record<number, Tick>;
  /** Live spot last-price per symbol (UPPERCASE) for the underlying. */
  spotBySymbol: Record<string, number>;
  loading: boolean;
  error: string | null;
  closingId: string | null;
  deletingId: string | null;
  onClose: () => void;
  onCloseTrade: (id: string) => void;
  onOpenTrade: (trade: Trade) => void;
  onDeleteTrade: (id: string) => void;
}

function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

/* ---------------------------------------------------------------- months ---
 * The list is scoped to one calendar month at a time (the current one on open),
 * because a trading log grows without bound and "what did I do this month" is
 * the question actually being asked of it. A trade belongs to the month it was
 * TAKEN in (opened_at) — that's what "trades taken" counts, and it keeps a
 * position in one bucket for its whole life instead of moving when it closes.
 */

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** Sentinel month selection: no filter at all. */
const ALL = "all";

/** "YYYY-MM" for a date — sortable and comparable as a plain string. */
function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** "YYYY-MM" for a trade's opened_at, or "" when the timestamp is unusable. */
function tradeMonth(t: Trade): string {
  const d = new Date(t.opened_at);
  return Number.isNaN(d.getTime()) ? "" : monthKey(d);
}

/** "Aug 2026" for a "YYYY-MM" key. */
function monthLabel(key: string): string {
  const [y, m] = key.split("-").map(Number);
  if (!y || !m) return key;
  return `${MONTHS[m - 1]} ${y}`;
}

/** Step a "YYYY-MM" key by whole months, rolling the year over. */
function shiftMonth(key: string, delta: number): string {
  const [y, m] = key.split("-").map(Number);
  return monthKey(new Date(y, m - 1 + delta, 1));
}

interface MonthTotals {
  count: number;
  open: number;
  closed: number;
  margin: number | null;
  /** Trades whose margin the backend never recorded — the total is a floor. */
  marginMissing: number;
  pnl: number | null;
  /** Trades still open, so their P&L is a live mark rather than realized. */
  pnlLive: number;
  charges: number | null;
  chargesEstimated: boolean;
  /** Trades with no charge figures at all — the total is a floor. */
  chargesMissing: number;
}

/**
 * Roll a set of trades up into the month's headline numbers: how many were
 * taken, the margin they tied up, the P&L (realized for closed, marked to LTP
 * for open) and the round-trip charges.
 *
 * Missing pieces are counted rather than treated as zero, so a total that is
 * only part of the picture can say so instead of quietly reading low.
 */
function monthTotals(trades: Trade[], ticks: Record<number, Tick>): MonthTotals {
  const totals: MonthTotals = {
    count: trades.length,
    open: 0,
    closed: 0,
    margin: null,
    marginMissing: 0,
    pnl: null,
    pnlLive: 0,
    charges: null,
    chargesEstimated: false,
    chargesMissing: 0,
  };

  for (const t of trades) {
    if (t.status === "open") totals.open++;
    else totals.closed++;

    const { pnl } = computePnl(t, ticks);
    const pnlCounted = pnl !== null && Number.isFinite(pnl);

    if (pnlCounted) {
      totals.pnl = (totals.pnl ?? 0) + pnl;
      if (t.status === "open") totals.pnlLive++;

      // Margin rides with the P&L: it's the capital that produced that figure,
      // so it's only summed for a trade whose P&L is in the total. A trade that
      // never fully filled (both legs bought) has no P&L to count, so its
      // margin is left out too — otherwise the total would carry capital for a
      // position that was never actually on, and "% on margin" would read the
      // return against money that was never at work.
      if (t.margin !== null && Number.isFinite(t.margin)) {
        totals.margin = (totals.margin ?? 0) + t.margin;
      } else {
        totals.marginMissing++;
      }
    }

    const { total, estimated } = chargeSides(t);
    if (total !== null && Number.isFinite(total)) {
      totals.charges = (totals.charges ?? 0) + total;
      if (estimated) totals.chargesEstimated = true;
    } else {
      totals.chargesMissing++;
    }
  }

  return totals;
}

function pnlClass(pnl: number | null): string {
  if (pnl === null) return "muted";
  return pnl > 0 ? "pnl-pos" : pnl < 0 ? "pnl-neg" : "muted";
}

function roiPct(pnl: number | null, margin: number | null): number | null {
  if (pnl === null || !margin) return null;
  return (pnl / margin) * 100;
}

/** A cost, formatted unsigned (₹648.36) — charges are reported, not netted. */
function fmtCost(v: number | null | undefined): string {
  // isFinite, not !isNaN: a malformed payload could otherwise render "₹∞".
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return `₹${Math.abs(v).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

/**
 * The two charge sides that make up a trade's round trip: the real entry
 * charges plus the exit. An OPEN trade uses the projected exit (priced at the
 * entry fills); a CLOSED trade uses the real exit contract note, which itself
 * falls back to the projection if Zerodha couldn't price the close (flagged
 * via `source`).
 */
function chargeSides(t: Trade): {
  sides: (TradeCharges | null)[];
  total: number | null;
  estimated: boolean;
} {
  const exit = t.status === "closed" ? t.exit_charges : t.est_exit_charges;
  const sides = [t.entry_charges, exit];
  const known = sides.filter((s): s is TradeCharges => s !== null);
  return {
    sides,
    total: known.length > 0 ? known.reduce((acc, s) => acc + s.total, 0) : null,
    // Estimated whenever a projected side is in the sum, or a side is missing
    // entirely (so the figure is a floor rather than the full round trip).
    estimated:
      known.length < sides.length ||
      known.some((s) => s.source === "kite_estimate"),
  };
}

/** Every charge head, summed across the entry and exit sides. */
function chargeHeads(t: Trade) {
  const { sides } = chargeSides(t);
  const head = (pick: (s: TradeCharges) => number) =>
    sides.reduce((acc, s) => acc + (s ? pick(s) : 0), 0);
  return {
    brokerage: head((s) => s.brokerage),
    stt: head((s) => s.stt),
    exchange_txn: head((s) => s.exchange_txn),
    sebi: head((s) => s.sebi),
    stamp_duty: head((s) => s.stamp_duty),
    gst: head((s) => s.gst),
  };
}

/** Hover detail for the charges line. */
function chargesTooltip(t: Trade): string {
  const h = chargeHeads(t);
  const { estimated } = chargeSides(t);
  const parts = [
    `Brokerage ${fmtCost(h.brokerage)}`,
    `STT ${fmtCost(h.stt)}`,
    `Exchange txn ${fmtCost(h.exchange_txn)}`,
    `SEBI ${fmtCost(h.sebi)}`,
    `Stamp duty ${fmtCost(h.stamp_duty)}`,
    `GST ${fmtCost(h.gst)}`,
  ].join("\n");
  const note = estimated
    ? "\n\nThe exit side is priced at the entry fills until the trade is closed."
    : "";
  return (
    `Zerodha charges for the round trip (entry + exit).\n` +
    `Reported for reference — NOT deducted from the P&L, which already\n` +
    `carries the bid/ask spread from the actual fills.\n\n${parts}${note}`
  );
}

/**
 * Current prices + per-leg / total P&L (live for open, close prices for closed),
 * plus the round-trip charges to report alongside it.
 *
 * An open trade is marked to LTP (the tick feed carries no depth), so the live
 * figure still owes the exit half of the spread; the ENTRY spread is already in
 * it, because the entry price is a book-walking fill. Closing re-prices both
 * legs against the book, so the realized number carries the full round trip.
 */
function computePnl(t: Trade, ticks: Record<number, Tick>) {
  const buyTick = ticks[t.buy.token];
  const sellTick = ticks[t.sell.token];
  // "Now" = the actual latest traded price (LTP), and the live P&L is computed
  // against it. (The real close still executes at bid/ask, so the realized
  // close P&L includes the spread.)
  const buyNow =
    t.status === "closed" ? t.buy_close : (buyTick?.last_price || null);
  const sellNow =
    t.status === "closed" ? t.sell_close : (sellTick?.last_price || null);

  const buyValid = buyNow && buyNow > 0 ? buyNow : null;
  const sellValid = sellNow && sellNow > 0 ? sellNow : null;

  const buyPnl = buyValid !== null ? t.lot_size * (buyValid - t.buy.entry) : null;
  const sellPnl = sellValid !== null ? t.lot_size * (t.sell.entry - sellValid) : null;

  // The P&L is the PRICE MOVE. Both legs are filled by walking the live order
  // book (buy into the asks, sell into the bids), so the bid/ask spread —
  // slippage — is already inside this number.
  //
  // Brokerage and taxes are deliberately NOT subtracted: they're reported beside
  // the figure so the cost is visible at entry and exit, while the P&L stays a
  // clean read of the trade itself.
  const pnl =
    t.status === "closed"
      ? t.close_pnl
      : buyPnl !== null && sellPnl !== null
        ? buyPnl + sellPnl
        : null;

  const { total: charges, estimated: chargesEstimated } = chargeSides(t);

  return {
    buyNow: buyValid,
    sellNow: sellValid,
    buyPnl,
    sellPnl,
    pnl,
    charges,
    chargesEstimated,
  };
}

interface LegRowProps {
  side: "BUY" | "SELL";
  expiry: string;
  entry: number;
  now: number | null;
  pnl: number | null;
}

function LegRow({ side, expiry, entry, now, pnl }: LegRowProps) {
  return (
    <div className="leg-line">
      <span className={`leg-tag ${side === "BUY" ? "tag-buy" : "tag-sell"}`}>{side}</span>
      <span className="leg-exp">{formatExpiry(expiry)}</span>
      <span className="leg-cell">@ {fmt(entry)}</span>
      <span className="leg-cell leg-now">{fmt(now)}</span>
      <span className={`leg-cell leg-pnl ${pnlClass(pnl)}`}>{fmtMoney(pnl)}</span>
    </div>
  );
}

function TradeCard({
  t,
  ticks,
  spot,
  closingId,
  deletingId,
  onCloseTrade,
  onOpenTrade,
  onDeleteTrade,
}: {
  t: Trade;
  ticks: Record<number, Tick>;
  spot: number | undefined;
  closingId: string | null;
  deletingId: string | null;
  onCloseTrade: (id: string) => void;
  onOpenTrade: (trade: Trade) => void;
  onDeleteTrade: (id: string) => void;
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const { buyNow, sellNow, buyPnl, sellPnl, pnl, charges, chargesEstimated } =
    computePnl(t, ticks);
  const heads = chargeHeads(t);
  const roi = roiPct(pnl, t.margin);
  const closed = t.status === "closed";

  return (
    <div
      className={`trade-card trade-card--clickable ${closed ? "trade-card--closed" : ""}`}
      onClick={() => onOpenTrade(t)}
      title="Open charts with this trade's entry/exit marked"
    >
      <div className="trade-head">
        <span className="trade-symbol">
          {t.symbol}
          {t.is_index && <span className="badge-index">INDEX</span>}
        </span>
        {!closed && spot ? (
          <span className="trade-spot">
            Spot <strong>{fmt(spot)}</strong>
          </span>
        ) : (
          <span className="trade-closed-tag">closed</span>
        )}
      </div>

      <div className="leg-grid">
        <LegRow side="BUY" expiry={t.buy.expiry} entry={t.buy.entry} now={buyNow} pnl={buyPnl} />
        <LegRow side="SELL" expiry={t.sell.expiry} entry={t.sell.entry} now={sellNow} pnl={sellPnl} />
      </div>

      <div className="trade-foot">
        <div className="trade-meta">
          {t.lot_size} qty · margin {fmtMoney(t.margin)} · {fmtDateTime(t.opened_at)}
          {closed && t.closed_at ? ` → ${fmtDateTime(t.closed_at)}` : ""}
          {charges !== null ? (
            <span className="trade-charges" title={chargesTooltip(t)}>
              charges {fmtCost(charges)}
              {chargesEstimated ? " (est)" : ""}
              <span className="trade-charge-heads">
                brokerage {fmtCost(heads.brokerage)} · STT {fmtCost(heads.stt)} ·
                stamp {fmtCost(heads.stamp_duty)} · exch{" "}
                {fmtCost(heads.exchange_txn)} · SEBI {fmtCost(heads.sebi)} · GST{" "}
                {fmtCost(heads.gst)}
              </span>
            </span>
          ) : (
            <span
              className="trade-charges trade-charges--none"
              title="Zerodha's charges API didn't price this trade, so no brokerage/tax figures are available for it."
            >
              charges unavailable
            </span>
          )}
        </div>
        <div className="trade-net">
          {/* "P&L", not "NET": this figure is the price move (slippage included,
              since the fills are real bid/ask), and charges are reported beside
              it rather than deducted — calling it NET contradicted the charges
              note directly above. */}
          <span className="trade-pnl-label">P&amp;L</span>
          <span className={`trade-pnl ${pnlClass(pnl)}`}>{fmtMoney(pnl)}</span>
          {roi !== null && (
            <span className={`trade-roi ${pnlClass(pnl)}`}>
              {roi.toFixed(2)}% on margin
            </span>
          )}
        </div>
        {!closed ? (
          <button
            className="btn btn--sm"
            disabled={closingId === t.id}
            onClick={(e) => {
              e.stopPropagation();
              onCloseTrade(t.id);
            }}
          >
            {closingId === t.id ? "Closing…" : "Close"}
          </button>
        ) : confirmingDelete ? (
          <div className="trade-del-confirm" onClick={(e) => e.stopPropagation()}>
            <button
              className="btn btn--sm btn--danger"
              disabled={deletingId === t.id}
              onClick={() => onDeleteTrade(t.id)}
            >
              {deletingId === t.id ? "Deleting…" : "Delete"}
            </button>
            <button className="btn btn--sm" onClick={() => setConfirmingDelete(false)}>
              Cancel
            </button>
          </div>
        ) : (
          /* Icon-only and quiet until hovered: deleting a closed trade is a rare,
             destructive action, so it shouldn't compete with the P&L figure for
             attention the way a red-outlined "Delete" button did. */
          <button
            className="trade-del"
            aria-label="Delete trade from history"
            title="Delete trade from history"
            onClick={(e) => {
              e.stopPropagation();
              setConfirmingDelete(true);
            }}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 7h16" />
              <path d="M10 4h4a1 1 0 0 1 1 1v2H9V5a1 1 0 0 1 1-1Z" />
              <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" />
              <path d="M10 11v6M14 11v6" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Month selector: arrows for the neighbouring months, and a click on the label
 * opens a year of months at once, each showing how many trades it holds — so
 * finding the months that actually have activity doesn't mean clicking back
 * through the empty ones.
 */
function MonthBar({
  value,
  onChange,
  counts,
  maxMonth,
  total,
}: {
  value: string;
  onChange: (key: string) => void;
  counts: Record<string, number>;
  /** The current month — nothing after it can hold a trade. */
  maxMonth: string;
  total: number;
}) {
  const anchor = value === ALL ? maxMonth : value;
  const [openPicker, setOpenPicker] = useState(false);
  const [year, setYear] = useState(() => Number(anchor.slice(0, 4)));

  const maxYear = Number(maxMonth.slice(0, 4));
  const canNext = value !== ALL && value < maxMonth;

  const pick = (key: string) => {
    onChange(key);
    setOpenPicker(false);
  };

  return (
    <div className="month-head">
      <div className="month-bar">
        <button
          className="month-nav"
          aria-label="Previous month"
          onClick={() => pick(shiftMonth(anchor, -1))}
        >
          ‹
        </button>

        <button
          className={`month-pick ${openPicker ? "month-pick--open" : ""}`}
          aria-expanded={openPicker}
          onClick={() => {
            setYear(Number(anchor.slice(0, 4)));
            setOpenPicker((v) => !v);
          }}
          title="Pick a month"
        >
          <svg className="month-ico" viewBox="0 0 24 24" aria-hidden="true">
            <rect x="3" y="5" width="18" height="16" rx="2" />
            <path d="M3 10h18M8 3v4M16 3v4" />
          </svg>
          {value === ALL ? "All months" : monthLabel(value)}
          <span className="month-caret" aria-hidden="true">
            ▾
          </span>
        </button>

        <button
          className="month-nav"
          aria-label="Next month"
          disabled={!canNext}
          onClick={() => canNext && pick(shiftMonth(anchor, 1))}
        >
          ›
        </button>

        <button
          className={`month-all ${value === ALL ? "month-all--on" : ""}`}
          onClick={() => pick(value === ALL ? maxMonth : ALL)}
          title="Show every trade, ignoring the month"
        >
          All <span className="pill-count">{total}</span>
        </button>
      </div>

      {openPicker && (
        <div className="month-panel">
          <div className="month-year">
            <button
              className="month-nav"
              aria-label="Previous year"
              onClick={() => setYear((y) => y - 1)}
            >
              ‹
            </button>
            <span className="month-year-v">{year}</span>
            <button
              className="month-nav"
              aria-label="Next year"
              disabled={year >= maxYear}
              onClick={() => setYear((y) => Math.min(maxYear, y + 1))}
            >
              ›
            </button>
          </div>

          <div className="month-grid">
            {MONTHS.map((label, i) => {
              const key = `${year}-${String(i + 1).padStart(2, "0")}`;
              const n = counts[key] ?? 0;
              const future = key > maxMonth;
              return (
                <button
                  key={key}
                  className={[
                    "month-cell",
                    key === value ? "month-cell--sel" : "",
                    n > 0 ? "month-cell--has" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  disabled={future}
                  onClick={() => pick(key)}
                  title={future ? "" : `${n} trade${n === 1 ? "" : "s"} in ${monthLabel(key)}`}
                >
                  <span className="month-cell-m">{label}</span>
                  <span className="month-cell-n">{future ? "—" : n || "·"}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/** The month's headline: trades taken, margin tied up, P&L, charges. */
function MonthStats({ label, totals }: { label: string; totals: MonthTotals }) {
  const roi = roiPct(totals.pnl, totals.margin);
  const net =
    totals.pnl !== null && totals.charges !== null ? totals.pnl - totals.charges : null;

  return (
    <div className="month-stats" aria-label={`${label} summary`}>
      <div className="month-stat">
        <span className="month-stat-k">Trades taken</span>
        <span className="month-stat-v">{totals.count}</span>
        <span className="month-stat-sub">
          {totals.open} open · {totals.closed} closed
        </span>
      </div>

      <div className="month-stat">
        <span className="month-stat-k">Margin</span>
        <span className="month-stat-v mono">{fmtCost(totals.margin)}</span>
        <span className="month-stat-sub">
          {totals.marginMissing > 0
            ? `${totals.marginMissing} without margin`
            : "required, at entry"}
        </span>
      </div>

      <div className="month-stat">
        <span className="month-stat-k">P&amp;L</span>
        <span className={`month-stat-v mono ${pnlClass(totals.pnl)}`}>
          {fmtMoney(totals.pnl)}
        </span>
        <span className="month-stat-sub">
          {roi !== null ? `${roi.toFixed(2)}% on margin` : "—"}
          {totals.pnlLive > 0 ? ` · ${totals.pnlLive} live` : ""}
        </span>
      </div>

      <div
        className="month-stat"
        title={
          "Zerodha charges for the round trip (entry + exit) on this month's trades.\n" +
          "Reported for reference — the P&L beside it is the price move and does\n" +
          "not have them deducted."
        }
      >
        <span className="month-stat-k">Charges</span>
        <span className="month-stat-v mono">
          {fmtCost(totals.charges)}
          {totals.chargesEstimated ? <span className="month-stat-est"> (est)</span> : null}
        </span>
        <span className="month-stat-sub">
          {totals.chargesMissing > 0 ? (
            `${totals.chargesMissing} unpriced`
          ) : net !== null ? (
            <>
              after charges{" "}
              <span className={pnlClass(net)}>{fmtMoney(net)}</span>
            </>
          ) : (
            "entry + exit"
          )}
        </span>
      </div>
    </div>
  );
}

export default function TradesPanel({
  trades,
  ticks,
  spotBySymbol,
  loading,
  error,
  closingId,
  deletingId,
  onClose,
  onCloseTrade,
  onOpenTrade,
  onDeleteTrade,
}: Props) {
  // Opens on the current month: the log is a working view of "this month", not
  // an archive to scroll through.
  const thisMonth = monthKey(new Date());
  const [month, setMonth] = useState(thisMonth);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const t of trades) {
      const k = tradeMonth(t);
      if (k) c[k] = (c[k] ?? 0) + 1;
    }
    return c;
  }, [trades]);

  const visible = month === ALL ? trades : trades.filter((t) => tradeMonth(t) === month);
  const open = visible.filter((t) => t.status === "open");
  const closed = visible.filter((t) => t.status === "closed");
  const label = month === ALL ? "All months" : monthLabel(month);

  // Recomputed every tick on purpose: the open legs are marked to LTP, so the
  // month's P&L is live while a position is running.
  const totals = monthTotals(visible, ticks);

  // A position opened in an earlier month is still money at risk, so it can't
  // just vanish behind the filter without a word.
  const openElsewhere =
    month === ALL ? [] : trades.filter((t) => t.status === "open" && tradeMonth(t) !== month);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <div>
            <h2>Trades</h2>
            <p className="modal-sub">
              Buy the discount leg, sell the premium leg · 1 lot · current &amp; next month
            </p>
          </div>
          <button className="modal-x" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <MonthBar
          value={month}
          onChange={setMonth}
          counts={counts}
          maxMonth={thisMonth}
          total={trades.length}
        />
        <MonthStats label={label} totals={totals} />

        <div className="modal-body">
        {error && <div className="banner banner--error">{error}</div>}
        {loading && trades.length === 0 && (
          <div className="empty">
            <span className="spinner" />
            Loading trades…
          </div>
        )}

        <section className="trade-section">
          <h3 className="trade-section-title">
            Open <span className="pill-count">{open.length}</span>
            {openElsewhere.length > 0 && (
              <button
                className="month-jump"
                onClick={() => setMonth(ALL)}
                title="These positions are still running, but were taken in another month"
              >
                +{openElsewhere.length} open in other months
              </button>
            )}
          </h3>
          {open.length === 0 ? (
            <p className="trade-empty">
              {month === ALL || month === thisMonth
                ? "No open trades. Use “Take Trade” on any stock."
                : `No trades were open from ${label}.`}
            </p>
          ) : (
            <div className="trade-list">
              {open.map((t) => (
                <TradeCard
                  key={t.id}
                  t={t}
                  ticks={ticks}
                  spot={spotBySymbol[t.symbol.toUpperCase()]}
                  closingId={closingId}
                  deletingId={deletingId}
                  onCloseTrade={onCloseTrade}
                  onOpenTrade={onOpenTrade}
                  onDeleteTrade={onDeleteTrade}
                />
              ))}
            </div>
          )}
        </section>

        <section className="trade-section">
          <h3 className="trade-section-title">
            History <span className="pill-count">{closed.length}</span>
          </h3>
          {closed.length === 0 ? (
            <p className="trade-empty">
              {month === ALL
                ? "No closed trades yet."
                : `No closed trades from ${label}.`}
            </p>
          ) : (
            <div className="trade-list">
              {closed.map((t) => (
                <TradeCard
                  key={t.id}
                  t={t}
                  ticks={ticks}
                  spot={spotBySymbol[t.symbol.toUpperCase()]}
                  closingId={closingId}
                  deletingId={deletingId}
                  onCloseTrade={onCloseTrade}
                  onOpenTrade={onOpenTrade}
                  onDeleteTrade={onDeleteTrade}
                />
              ))}
            </div>
          )}
        </section>
        </div>
      </div>
    </div>
  );
}
