import { useState } from "react";
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
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
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
          <span className="trade-pnl-label">NET</span>
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
  const open = trades.filter((t) => t.status === "open");
  const closed = trades.filter((t) => t.status === "closed");

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
          </h3>
          {open.length === 0 ? (
            <p className="trade-empty">No open trades. Use “Take Trade” on any stock.</p>
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
            <p className="trade-empty">No closed trades yet.</p>
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
