import { useEffect, useState } from "react";
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

  const green = "#22c55e";
  const red = "#ef4444";
  const muted = "#9ca3af";

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 440 }}>
        <header className="modal-head">
          <div>
            <h2>Confirm Trade</h2>
            <p className="modal-sub">{symbol} · Calendar Spread</p>
          </div>
          <button className="modal-x" onClick={onCancel} aria-label="Close">
            ✕
          </button>
        </header>

        <div className="modal-body" style={{ padding: "1rem 1.25rem" }}>
          {currentSpread !== null && (
            <div style={{ marginBottom: "1rem", padding: "0.75rem", background: "rgba(255,255,255,0.04)", borderRadius: 8, textAlign: "center" }}>
              <div style={{ fontSize: "0.75rem", color: muted, marginBottom: 4 }}>Current Spread</div>
              <div style={{ fontSize: "1.5rem", fontWeight: 700, color: currentSpread < 0 ? red : green }}>
                {fmtPrice(currentSpread)}
              </div>
              <div style={{ fontSize: "0.7rem", color: muted, marginTop: 4 }}>
                Lot: {lotSize} qty
              </div>
            </div>
          )}

          {loading ? (
            <div className="empty" style={{ padding: "1rem" }}>
              <span className="spinner" /> Loading spread stats...
            </div>
          ) : stats ? (
            <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
              {(() => {
                const cs = currentSpread ?? 0;
                const expectedProfit = Math.abs(cs - stats.mean_spread) * lotSize;
                const expectedMaxLoss = Math.abs(stats.percentile_95 - cs) * lotSize;
                const varUpside = stats.max_spread - cs;
                const varDownside = cs - stats.min_spread;
                const zScore = stats.std_dev_spread !== 0
                  ? (cs - stats.mean_spread) / stats.std_dev_spread
                  : 0;

                const rows: { label: string; value: string; color: string }[] = [
                  { label: "Max Profit (spread → mean)", value: `₹${fmtPrice(expectedProfit)}`, color: green },
                  { label: "Max Loss (spread → 95th %ile)", value: `₹${fmtPrice(expectedMaxLoss)}`, color: red },
                  { label: "VaR Upside (Max − Current)", value: `${varUpside >= 0 ? "+" : ""}${fmtPrice(varUpside)}`, color: varUpside >= 0 ? green : red },
                  { label: "VaR Downside (Current − Min)", value: `${varDownside >= 0 ? "+" : ""}${fmtPrice(varDownside)}`, color: varDownside >= 0 ? green : red },
                  { label: "Mean Reversion %", value: `${stats.mean_reversion_probability.toFixed(1)}%`, color: stats.mean_reversion_probability >= 50 ? green : red },
                  { label: "Z-Score", value: zScore.toFixed(2), color: zScore < 0 ? green : red },
                  { label: "Mean Spread", value: fmtPrice(stats.mean_spread), color: muted },
                  { label: "Observations", value: String(stats.observations), color: muted },
                ];

                return rows.map((r) => (
                  <div
                    key={r.label}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      padding: "0.4rem 0.6rem",
                      background: "rgba(255,255,255,0.03)",
                      borderRadius: 6,
                    }}
                  >
                    <span style={{ fontSize: "0.75rem", color: muted }}>{r.label}</span>
                    <span style={{ fontSize: "0.9rem", fontWeight: 600, color: r.color }}>{r.value}</span>
                  </div>
                ));
              })()}
            </div>
          ) : (
            <div style={{ padding: "0.75rem", color: muted, fontSize: "0.85rem" }}>
              Spread stats unavailable for this symbol.
            </div>
          )}

          <div style={{ display: "flex", gap: "0.75rem", marginTop: "1.25rem" }}>
            <button
              className="btn btn--primary"
              style={{ flex: 1 }}
              disabled={busy}
              onClick={onConfirm}
            >
              {busy ? "Executing..." : "Confirm Trade"}
            </button>
            <button
              className="btn"
              style={{ flex: 1 }}
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
