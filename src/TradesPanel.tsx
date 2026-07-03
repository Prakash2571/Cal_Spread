import { useMemo } from "react";
import type { Tick, Trade } from "./api.ts";
import { fmt, formatExpiry } from "./format.ts";

interface Props {
  trades: Trade[];
  ticks: Record<number, Tick>;
  loading: boolean;
  error: string | null;
  closingId: string | null;
  onClose: () => void;
  onCloseTrade: (id: string) => void;
}

/** Live P&L for an open trade using the latest ticks (₹ for 1 lot). */
function livePnl(trade: Trade, ticks: Record<number, Tick>): number | null {
  const buy = ticks[trade.buy.token]?.last_price;
  const sell = ticks[trade.sell.token]?.last_price;
  if (!buy || !sell) return null;
  return trade.lot_size * (buy - trade.buy.entry + (trade.sell.entry - sell));
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

function fmtMoney(pnl: number | null): string {
  if (pnl === null) return "—";
  const sign = pnl > 0 ? "+" : pnl < 0 ? "−" : "";
  return `${sign}₹${Math.abs(pnl).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

export default function TradesPanel({
  trades,
  ticks,
  loading,
  error,
  closingId,
  onClose,
  onCloseTrade,
}: Props) {
  const open = useMemo(() => trades.filter((t) => t.status === "open"), [trades]);
  const closed = useMemo(() => trades.filter((t) => t.status === "closed"), [trades]);

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

        {error && <div className="banner banner--error">{error}</div>}
        {loading && trades.length === 0 && (
          <div className="empty">
            <span className="spinner" />
            Loading trades…
          </div>
        )}

        {/* Open trades */}
        <section className="trade-section">
          <h3 className="trade-section-title">
            Open <span className="pill-count">{open.length}</span>
          </h3>
          {open.length === 0 ? (
            <p className="trade-empty">No open trades. Use “Take Trade” on any stock.</p>
          ) : (
            <div className="trade-list">
              {open.map((t) => {
                const pnl = livePnl(t, ticks);
                return (
                  <div className="trade-row" key={t.id}>
                    <div className="trade-main">
                      <div className="trade-symbol">
                        {t.symbol}
                        {t.is_index && <span className="badge-index">INDEX</span>}
                      </div>
                      <div className="trade-legs">
                        <span className="leg leg-buy">
                          BUY {formatExpiry(t.buy.expiry)} @ {fmt(t.buy.entry)}
                        </span>
                        <span className="leg leg-sell">
                          SELL {formatExpiry(t.sell.expiry)} @ {fmt(t.sell.entry)}
                        </span>
                      </div>
                      <div className="trade-meta">
                        {t.lot_size} qty · {fmtDateTime(t.opened_at)}
                      </div>
                    </div>
                    <div className="trade-right">
                      <span className={`trade-pnl ${pnlClass(pnl)}`}>{fmtMoney(pnl)}</span>
                      <button
                        className="btn btn--sm"
                        disabled={closingId === t.id}
                        onClick={() => onCloseTrade(t.id)}
                      >
                        {closingId === t.id ? "Closing…" : "Close"}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Closed / history */}
        <section className="trade-section">
          <h3 className="trade-section-title">
            History <span className="pill-count">{closed.length}</span>
          </h3>
          {closed.length === 0 ? (
            <p className="trade-empty">No closed trades yet.</p>
          ) : (
            <div className="trade-list">
              {closed.map((t) => (
                <div className="trade-row trade-row--closed" key={t.id}>
                  <div className="trade-main">
                    <div className="trade-symbol">
                      {t.symbol}
                      {t.is_index && <span className="badge-index">INDEX</span>}
                    </div>
                    <div className="trade-legs">
                      <span className="leg leg-buy">
                        BUY {formatExpiry(t.buy.expiry)} @ {fmt(t.buy.entry)} → {fmt(t.buy_close)}
                      </span>
                      <span className="leg leg-sell">
                        SELL {formatExpiry(t.sell.expiry)} @ {fmt(t.sell.entry)} → {fmt(t.sell_close)}
                      </span>
                    </div>
                    <div className="trade-meta">
                      {t.lot_size} qty · opened {fmtDateTime(t.opened_at)}
                      {t.closed_at ? ` · closed ${fmtDateTime(t.closed_at)}` : ""}
                    </div>
                  </div>
                  <div className="trade-right">
                    <span className={`trade-pnl ${pnlClass(t.close_pnl)}`}>
                      {fmtMoney(t.close_pnl)}
                    </span>
                    <span className="trade-closed-tag">closed</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
