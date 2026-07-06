import { useEffect, useState } from "react";
import {
  fetchOiHistory,
  fetchIntradayHistory,
  fetchMinuteHistory,
  type BoardItem,
  type OiHistory,
  type IntradayHistory,
  type Tick,
} from "./api.ts";
import { fmtCompact, formatExpiry } from "./format.ts";
import StockCard from "./StockCard.tsx";
import LineChart, { type ChartSeries } from "./LineChart.tsx";

interface Props {
  symbol: string;
  item: BoardItem | undefined;
  ticks: Record<number, Tick>;
  rf: number;
  div: number;
  showPrices: boolean;
  onBack: () => void;
}

// Colours per contract slot (near / next / far) — deliberately distinct hues
// (blue / green / amber) so all three lines are easy to tell apart.
const LINE_COLORS = ["#4d8bff", "#22c55e", "#f59e0b"];
// Muted colour for a contract that has already expired.
const EXPIRED_COLOR = "#8d97ac";

const fmtPrice = (v: number) =>
  v.toLocaleString("en-IN", { maximumFractionDigits: 2 });

// x-axis label for hourly timestamps, e.g. "02 Jul 10:00".
const fmtHour = (iso: string) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
};

// x-axis label for minute timestamps, e.g. "10:15".
const fmtMinute = (iso: string) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
};

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
  const [intraday, setIntraday] = useState<IntradayHistory | null>(null);
  const [minute, setMinute] = useState<IntradayHistory | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    Promise.all([
      fetchOiHistory(symbol),
      fetchIntradayHistory(symbol),
      fetchMinuteHistory(symbol),
    ])
      .then(([h, intr, min]) => {
        if (!alive) return;
        setHistory(h);
        setIntraday(intr);
        setMinute(min);
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

  const todayIso = new Date().toISOString().slice(0, 10);

  // Build price + OI series. An expired contract is drawn dashed in a muted
  // colour and labelled, so a rolled-over far month stays traceable.
  const priceSeries: ChartSeries[] = [];
  const oiSeries: ChartSeries[] = [];
  (history?.futures ?? []).forEach((f, i) => {
    const expired = f.expiry < todayIso;
    const color = expired ? EXPIRED_COLOR : LINE_COLORS[i % LINE_COLORS.length]!;
    const label = `${formatExpiry(f.expiry)}${expired ? " (exp)" : ""}`;
    priceSeries.push({
      label,
      color,
      dashed: expired,
      points: f.points.map((p) => ({ date: p.date, value: p.close })),
    });
    oiSeries.push({
      label,
      color,
      dashed: expired,
      points: f.points.map((p) => ({ date: p.date, value: p.oi })),
    });
  });

  // Hourly closing price (last ~1 week).
  const hourlySeries: ChartSeries[] = (intraday?.futures ?? []).map((f, i) => {
    const expired = f.expiry < todayIso;
    return {
      label: `${formatExpiry(f.expiry)}${expired ? " (exp)" : ""}`,
      color: expired ? EXPIRED_COLOR : LINE_COLORS[i % LINE_COLORS.length]!,
      dashed: expired,
      points: f.points.map((p) => ({ date: p.t, value: p.close })),
    };
  });

  // Minute-by-minute closing price (last 2 hours).
  const minuteSeries: ChartSeries[] = (minute?.futures ?? []).map((f, i) => {
    const expired = f.expiry < todayIso;
    return {
      label: `${formatExpiry(f.expiry)}${expired ? " (exp)" : ""}`,
      color: expired ? EXPIRED_COLOR : LINE_COLORS[i % LINE_COLORS.length]!,
      dashed: expired,
      points: f.points.map((p) => ({ date: p.t, value: p.close })),
    };
  });

  // Current OI per future (live from ticks) for the left-column panel.
  const oiRows = (item?.futures ?? []).map((f, i) => ({
    expiry: f.expiry,
    color: LINE_COLORS[i % LINE_COLORS.length]!,
    oi: ticks[f.token]?.oi ?? 0,
  }));

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <button className="btn btn--sm back-btn" onClick={onBack} aria-label="Back">
            ← Back
          </button>
          <div className="card-title">
            <h1>{item?.name ?? symbol}</h1>
            <p className="subtitle">{symbol} · price &amp; open interest history</p>
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

          {item && showPrices && oiRows.length > 0 && (
            <div className="oi-panel">
              <div className="oi-panel-title">Open Interest</div>
              {oiRows.map((r) => (
                <div className="oi-panel-row" key={r.expiry}>
                  <span className="oi-dot" style={{ background: r.color }} />
                  <span className="oi-panel-exp">{formatExpiry(r.expiry)}</span>
                  <span className="oi-panel-val">{fmtCompact(r.oi)}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="detail-charts">
          {loading ? (
            <div className="detail-chart">
              <div className="empty">
                <span className="spinner" />
                Loading history…
              </div>
            </div>
          ) : error ? (
            <div className="detail-chart">
              <div className="banner banner--error">{error}</div>
            </div>
          ) : (
            <>
              <div className="detail-chart">
                <div className="chart-head">
                  <h2>Price</h2>
                  <span className="chart-sub">Daily close · last 1 month · 3 futures</span>
                </div>
                <LineChart series={priceSeries} format={fmtPrice} />
              </div>

              <div className="detail-chart">
                <div className="chart-head">
                  <h2>Price · Hourly</h2>
                  <span className="chart-sub">Hourly close · last 1 week · 3 futures</span>
                </div>
                <LineChart series={hourlySeries} format={fmtPrice} formatX={fmtHour} />
              </div>

              <div className="detail-chart">
                <div className="chart-head">
                  <h2>Price · Minute</h2>
                  <span className="chart-sub">Minute close · last 2 hours · 3 futures</span>
                </div>
                <LineChart series={minuteSeries} format={fmtPrice} formatX={fmtMinute} />
              </div>

              <div className="detail-chart">
                <div className="chart-head">
                  <h2>Open Interest</h2>
                  <span className="chart-sub">Daily closing OI · last 1 month</span>
                </div>
                <LineChart series={oiSeries} format={fmtCompact} />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
