import { useEffect, useState } from "react";
import { XIcon } from "@phosphor-icons/react";
import { fetchSpreadStats, type BoardItem, type Tick, type SpreadStats } from "./api.ts";

interface Props {
  symbol: string;
  item: BoardItem;
  ticks: Record<number, Tick>;
  onConfirm: () => void;
  onCancel: () => void;
  busy: boolean;
}

const fmtPrice = (v: number) =>
  v.toLocaleString("en-IN", { maximumFractionDigits: 2 });

export default function TradeConfirmModal({
  symbol,
  item,
  ticks,
  onConfirm,
  onCancel,
  busy,
}: Props) {
  const [stats, setStats] = useState<SpreadStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetchSpreadStats(symbol)
      .then(setStats)
      .catch(() => setStats(null))
      .finally(() => setLoading(false));
  }, [symbol]);

  const curTick = ticks[item.futures[0]?.token ?? 0];
  const nxtTick = ticks[item.futures[1]?.token ?? 0];
  const currentSpread =
    curTick?.last_price && nxtTick?.last_price
      ? nxtTick.last_price - curTick.last_price
      : null;
  const lotSize = item.futures[0]?.lot_size ?? 1;

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal modal--sm" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <div>
            <h2>Confirm Trade</h2>
            <p className="modal-sub">{symbol}: Calendar Spread</p>
          </div>
          <button type="button" className="modal-x" onClick={onCancel} aria-label="Close">
            <XIcon size={18} weight="regular" aria-hidden="true" />
          </button>
        </header>

        <div className="modal-body confirm-modal-body">
          {currentSpread !== null && (
            <div className="confirm-hero">
              <div className="confirm-hero-label">Current Spread</div>
              <div className={`confirm-hero-value ${currentSpread < 0 ? "neg" : "pos"}`}>
                {fmtPrice(currentSpread)}
              </div>
              <div className="metric-label">
                Lot: {lotSize} qty
              </div>
            </div>
          )}

          {loading ? (
            <div className="empty empty--compact">
              <span className="spinner" /> Loading spread stats…
            </div>
          ) : stats ? (
            <div className="metric-list">
              {(() => {
                const cs = currentSpread ?? 0;
                const expectedProfit = Math.abs(cs - stats.mean_spread) * lotSize;
                const expectedMaxLoss = Math.abs(stats.percentile_95 - cs) * lotSize;
                const varUpside = stats.max_spread - cs;
                const varDownside = cs - stats.min_spread;
                const zScore = stats.std_dev_spread !== 0
                  ? (cs - stats.mean_spread) / stats.std_dev_spread
                  : 0;

                const rows: { label: string; value: string; tone: "pos" | "neg" | "muted" }[] = [
                  { label: "Max Profit (spread → mean)", value: `₹${fmtPrice(expectedProfit)}`, tone: "pos" },
                  { label: "Max Loss (spread → 95th %ile)", value: `₹${fmtPrice(expectedMaxLoss)}`, tone: "neg" },
                  { label: "VaR Upside (Max − Current)", value: `${varUpside >= 0 ? "+" : ""}${fmtPrice(varUpside)}`, tone: varUpside >= 0 ? "pos" : "neg" },
                  { label: "VaR Downside (Current − Min)", value: `${varDownside >= 0 ? "+" : ""}${fmtPrice(varDownside)}`, tone: cs < stats.min_spread ? "pos" : "neg" },
                  { label: "Mean Reversion %", value: `${stats.mean_reversion_probability.toFixed(1)}%`, tone: stats.mean_reversion_probability >= 50 ? "pos" : "neg" },
                  { label: "Z-Score", value: zScore.toFixed(2), tone: zScore < 0 ? "pos" : "neg" },
                  { label: "Mean Spread", value: fmtPrice(stats.mean_spread), tone: "muted" },
                  { label: "Observations", value: String(stats.observations), tone: "muted" },
                ];

                return rows.map((r) => (
                  <div key={r.label} className="metric-row">
                    <span className="metric-label">{r.label}</span>
                    <span className={`metric-value ${r.tone}`}>{r.value}</span>
                  </div>
                ));
              })()}
            </div>
          ) : (
            <div className="confirm-unavailable">
              Spread stats unavailable for this symbol.
            </div>
          )}

          <div className="modal-actions">
            <button
              className="btn btn--primary modal-action"
              disabled={busy}
              onClick={onConfirm}
            >
              {busy ? "Executing…" : "Confirm Trade"}
            </button>
            <button
              className="btn modal-action"
              onClick={onCancel}
              disabled={busy}
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
