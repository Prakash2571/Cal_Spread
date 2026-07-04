import { useEffect, useState } from "react";
import { fetchOiHistory, type BoardItem, type OiHistory, type Tick } from "./api.ts";
import StockCard from "./StockCard.tsx";
import OiChart, { type ChartSeries } from "./OiChart.tsx";

interface Props {
  symbol: string;
  item: BoardItem | undefined;
  ticks: Record<number, Tick>;
  rf: number;
  div: number;
  showPrices: boolean;
  onBack: () => void;
}

const LINE_COLORS = ["#6d8bff", "#22d3ee", "#9b6dff"];

export default function StockDetail({
  symbol,
  item,
  ticks,
  rf,
  div,
  showPrices,
  onBack,
}: Props) {
  const [history, setHistory] = useState<OiHistory | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    fetchOiHistory(symbol)
      .then((h) => {
        if (alive) setHistory(h);
      })
      .catch((err: unknown) => {
        if (alive)
          setError(err instanceof Error ? err.message : "Failed to load history.");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [symbol]);

  const series: ChartSeries[] =
    history?.futures.map((f, i) => ({
      label: f.expiry,
      color: LINE_COLORS[i % LINE_COLORS.length]!,
      points: f.points,
    })) ?? [];

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <button className="btn btn--sm back-btn" onClick={onBack} aria-label="Back">
            ← Back
          </button>
          <div className="card-title">
            <h1>{item?.name ?? symbol}</h1>
            <p className="subtitle">{symbol} · open interest history</p>
          </div>
        </div>
      </header>

      <div className="detail-grid">
        <div className="detail-card">
          {item ? (
            <StockCard
              item={item}
              ticks={ticks}
              rf={rf}
              div={div}
              showPrices={showPrices}
            />
          ) : (
            <div className="empty">
              <span className="spinner" />
              Loading {symbol}…
            </div>
          )}
        </div>

        <div className="detail-chart">
          <div className="chart-head">
            <h2>Open Interest</h2>
            <span className="chart-sub">Daily closing OI · last 1 month</span>
          </div>

          {loading ? (
            <div className="empty">
              <span className="spinner" />
              Loading OI history…
            </div>
          ) : error ? (
            <div className="banner banner--error">{error}</div>
          ) : (
            <OiChart series={series} />
          )}
        </div>
      </div>
    </div>
  );
}
