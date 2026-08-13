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

/**
 * The two charge sides that make up a trade's round trip.
 *
 * An OPEN trade pairs its real entry charges with the projected exit, because
 * both halves are paid before the position is flat — netting only the entry
 * would overstate every live P&L. A CLOSED trade uses the real exit contract
 * note (which itself falls back to the projection if Zerodha couldn't price the
 * close, flagged via `source`).
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

/** Charge heads summed across both sides, for the breakdown tooltip. */
function chargesTooltip(t: Trade): string {
  const { sides, estimated } = chargeSides(t);
  const head = (pick: (s: TradeCharges) => number) =>
    sides.reduce((acc, s) => acc + (s ? pick(s) : 0), 0);
  const parts = [
    `Brokerage ${fmtMoney(head((s) => s.brokerage))}`,
    `STT ${fmtMoney(head((s) => s.stt))}`,
    `Exchange txn ${fmtMoney(head((s) => s.exchange_txn))}`,
    `SEBI ${fmtMoney(head((s) => s.sebi))}`,
    `Stamp duty ${fmtMoney(head((s) => s.stamp_duty))}`,
    `GST ${fmtMoney(head((s) => s.gst))}`,
  ].join("\n");
  const note = estimated
    ? "\n\nThe exit side is priced at the entry fills until the trade is closed."
    : "";
  return `Zerodha charges, entry + exit\n\n${parts}${note}`;
}

/** Current prices + per-leg / net P&L (live for open, close prices for closed).
 * For open trades we mark to the EXIT side (sell the long at bid, buy back the
 * short at ask) so the shown P&L matches what closing will actually realize. */
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

  // GROSS = price move only. A closed trade's gross is whatever was locked in.
  const gross =
    t.status === "closed"
      ? t.close_pnl
      : buyPnl !== null && sellPnl !== null
        ? buyPnl + sellPnl
        : null;

  // NET = gross less Zerodha's brokerage + taxes for the round trip. The fills
  // above already walked the order book, so this is the last real cost missing
  // from the number: what's shown is what the account actually keeps.
  const { total: charges, estimated: chargesEstimated } = chargeSides(t);
  const net =
    t.status === "closed" && t.net_pnl !== null
      ? t.net_pnl // authoritative: computed server-side at close
      : gross !== null && charges !== null
        ? gross - charges
        : gross;

  return {
    buyNow: buyValid,
    sellNow: sellValid,
    buyPnl,
    sellPnl,
    gross,
    charges,
    chargesEstimated,
    net,
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
  const { buyNow, sellNow, buyPnl, sellPnl, gross, charges, chargesEstimated, net } =
    computePnl(t, ticks);
  // ROI is measured on the NET result: margin is real capital, so the return on
  // it has to be after costs.
  const roi = roiPct(net, t.margin);
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
              gross {fmtMoney(gross)} · charges {fmtMoney(-charges)}
              {chargesEstimated ? " (est)" : ""}
            </span>
          ) : (
            <span
              className="trade-charges trade-charges--none"
              title="Zerodha's charges API didn't price this trade, so the P&L shown is gross of brokerage and taxes."
            >
              charges unavailable
            </span>
          )}
        </div>
        <div className="trade-net">
          <span className="trade-pnl-label">NET</span>
          <span className={`trade-pnl ${pnlClass(net)}`}>{fmtMoney(net)}</span>
          {roi !== null && (
            <span className={`trade-roi ${pnlClass(net)}`}>
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
            <span>Delete?</span>
            <button
              className="btn btn--sm btn--danger"
              disabled={deletingId === t.id}
              onClick={() => onDeleteTrade(t.id)}
            >
              {deletingId === t.id ? "…" : "Yes"}
            </button>
            <button className="btn btn--sm" onClick={() => setConfirmingDelete(false)}>
              No
            </button>
          </div>
        ) : (
          <button
            className="btn btn--sm btn--danger-ghost"
            onClick={(e) => {
              e.stopPropagation();
              setConfirmingDelete(true);
            }}
          >
            Delete
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
