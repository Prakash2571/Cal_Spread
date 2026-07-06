import type { Tick, Trade } from "./api.ts";
import { fmt, fmtMoney, formatExpiry } from "./format.ts";

interface Props {
  trades: Trade[];
  ticks: Record<number, Tick>;
  /** Live spot last-price per symbol (UPPERCASE) for the underlying. */
  spotBySymbol: Record<string, number>;
  loading: boolean;
  error: string | null;
  closingId: string | null;
  onClose: () => void;
  onCloseTrade: (id: string) => void;
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

/** Current prices + per-leg / net P&L (live for open, close prices for closed). */
function computePnl(t: Trade, ticks: Record<number, Tick>) {
  const buyNow =
    t.status === "closed"
      ? t.buy_close
      : (ticks[t.buy.token]?.last_price ?? null);
  const sellNow =
    t.status === "closed"
      ? t.sell_close
      : (ticks[t.sell.token]?.last_price ?? null);

  const buyValid = buyNow && buyNow > 0 ? buyNow : null;
  const sellValid = sellNow && sellNow > 0 ? sellNow : null;

  const buyPnl = buyValid !== null ? t.lot_size * (buyValid - t.buy.entry) : null;
  const sellPnl = sellValid !== null ? t.lot_size * (t.sell.entry - sellValid) : null;
  const net =
    buyPnl !== null && sellPnl !== null
      ? buyPnl + sellPnl
      : t.status === "closed"
        ? t.close_pnl
        : null;

  return { buyNow: buyValid, sellNow: sellValid, buyPnl, sellPnl, net };
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
  onCloseTrade,
}: {
  t: Trade;
  ticks: Record<number, Tick>;
  spot: number | undefined;
  closingId: string | null;
  onCloseTrade: (id: string) => void;
}) {
  const { buyNow, sellNow, buyPnl, sellPnl, net } = computePnl(t, ticks);
  const netValue = t.status === "closed" ? t.close_pnl : net;
  const roi = roiPct(netValue, t.margin);
  const closed = t.status === "closed";

  return (
    <div className={`trade-card ${closed ? "trade-card--closed" : ""}`}>
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
        </div>
        <div className="trade-net">
          <span className="trade-pnl-label">NET</span>
          <span className={`trade-pnl ${pnlClass(netValue)}`}>{fmtMoney(netValue)}</span>
          {roi !== null && (
            <span className={`trade-roi ${pnlClass(netValue)}`}>
              {roi.toFixed(2)}% on margin
            </span>
          )}
        </div>
        {!closed && (
          <button
            className="btn btn--sm"
            disabled={closingId === t.id}
            onClick={() => onCloseTrade(t.id)}
          >
            {closingId === t.id ? "Closing…" : "Close"}
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
  onClose,
  onCloseTrade,
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
                  onCloseTrade={onCloseTrade}
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
                  onCloseTrade={onCloseTrade}
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
