import { useEffect, useState } from "react";
import {
  fetchOiHistory,
  fetchIntradayHistory,
  fetchMinuteHistory,
  fetchFiveMinHistory,
  fetchSpreadStats,
  type BoardItem,
  type OiHistory,
  type IntradayHistory,
  type SpreadStats,
  type Tick,
  type Trade,
} from "./api.ts";
import { fmtCompact, formatExpiry } from "./format.ts";
import StockCard from "./StockCard.tsx";
import LineChart, { type ChartSeries, type ChartMarker } from "./LineChart.tsx";
import ThemeToggle from "./ThemeToggle.tsx";


interface Props {
  symbol: string;
  item: BoardItem | undefined;
  ticks: Record<number, Tick>;
  rf: number;
  div: number;
  showPrices: boolean;
  onBack: () => void;
  /** The full Trade object (if viewing a trade). */
  trade?: Trade | null;
  /** Trade entry/exit timestamps to mark on the charts (optional). */
  markStart?: string;
  markEnd?: string;
  /** Show the near-real-time 1m/5m chart (hidden for closed/history trades). */
  showIntraday?: boolean;
  /** Whether the user can initiate a trade. */
  canTrade?: boolean;
  /** True while the take-trade request is in flight. */
  tradeBusy?: boolean;
  /** True if the symbol already has an open trade. */
  hasOpenTrade?: boolean;
  /** Callback to initiate a trade on this symbol. */
  onTakeTrade?: (symbol: string) => void;
  /** Whether the user is authenticated as admin (full or trade-access). */
  isAdmin?: boolean;
}

// Colours per contract slot (near / next / far) — deliberately distinct hues
// (blue / green / amber) so all three lines are easy to tell apart.
const LINE_COLORS = ["var(--series-1)", "var(--series-2)", "var(--series-3)"];
// Muted colour for a contract that has already expired.
const EXPIRED_COLOR = "var(--series-expired)";

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
  trade: _trade,
  markStart,
  markEnd,
  showIntraday = true,
  canTrade,
  tradeBusy,
  hasOpenTrade,
  onTakeTrade,
  isAdmin,
}: Props) {
  const [history, setHistory] = useState<OiHistory | null>(null);
  const [intraday, setIntraday] = useState<IntradayHistory | null>(null);
  const [minute, setMinute] = useState<IntradayHistory | null>(null);
  const [fiveMin, setFiveMin] = useState<IntradayHistory | null>(null);
  const [spreadStats, setSpreadStats] = useState<SpreadStats | null>(null);
  const [intradayMode, setIntradayMode] = useState<"1m" | "5m">("1m");
  const [spreadMode, setSpreadMode] = useState<"daily" | "hourly" | "5m" | "1m">(
    "daily",
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);

    const core = Promise.all([fetchOiHistory(symbol), fetchIntradayHistory(symbol)]);
    const intra = showIntraday
      ? Promise.all([fetchMinuteHistory(symbol), fetchFiveMinHistory(symbol)])
      : Promise.resolve(null);
    const statsP = fetchSpreadStats(symbol).catch(() => null);

    Promise.all([core, intra, statsP])
      .then(([[h, intrH], intraRes, ss]) => {
        if (!alive) return;
        setHistory(h);
        setIntraday(intrH);
        setSpreadStats(ss);
        if (intraRes) {
          setMinute(intraRes[0]);
          setFiveMin(intraRes[1]);
        } else {
          setMinute(null);
          setFiveMin(null);
        }
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
  }, [symbol, showIntraday]);

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

  const toIntradaySeries = (src: IntradayHistory | null): ChartSeries[] =>
    (src?.futures ?? []).map((f, i) => {
      const expired = f.expiry < todayIso;
      return {
        label: `${formatExpiry(f.expiry)}${expired ? " (exp)" : ""}`,
        color: expired ? EXPIRED_COLOR : LINE_COLORS[i % LINE_COLORS.length]!,
        dashed: expired,
        points: f.points.map((p) => ({ date: p.t, value: p.close })),
      };
    });

  // Minute (last 2 hours) + 5-minute (today) — toggled on one chart.
  const minuteSeries = toIntradaySeries(minute);
  const fiveMinSeries = toIntradaySeries(fiveMin);
  const intradaySeries = intradayMode === "1m" ? minuteSeries : fiveMinSeries;

  // Trade entry/exit markers (drawn on charts whose window contains them).
  const markers: ChartMarker[] = [];
  if (markStart) {
    markers.push({ at: new Date(markStart).getTime(), color: "var(--pos)", label: "Entry" });
  }
  if (markEnd) {
    markers.push({ at: new Date(markEnd).getTime(), color: "var(--neg)", label: "Exit" });
  }

  // --- Calendar spread (next month − current month) ---
  function spreadFrom(
    futs: { points: { key: string; close: number }[] }[] | undefined,
  ): ChartSeries[] {
    if (!futs || futs.length < 2) return [];
    const near = futs[0]!;
    const nxt = futs[1]!;
    const m0 = new Map(near.points.map((p) => [p.key, p.close]));
    const points: { date: string; value: number }[] = [];
    for (const p of nxt.points) {
      const c0 = m0.get(p.key);
      if (c0 !== undefined && c0 > 0 && p.close > 0) {
        points.push({ date: p.key, value: p.close - c0 });
      }
    }
    return [{ label: "Spread (next − current)", color: "var(--series-1)", points }];
  }

  const dailyFuts = history?.futures.map((f) => ({
    points: f.points.map((p) => ({ key: p.date, close: p.close })),
  }));
  const hourlyFuts = intraday?.futures.map((f) => ({
    points: f.points.map((p) => ({ key: p.t, close: p.close })),
  }));
  const fiveFuts = fiveMin?.futures.map((f) => ({
    points: f.points.map((p) => ({ key: p.t, close: p.close })),
  }));
  const minFuts = minute?.futures.map((f) => ({
    points: f.points.map((p) => ({ key: p.t, close: p.close })),
  }));

  const spreadConfig = {
    daily: { futs: dailyFuts, formatX: undefined as ((k: string) => string) | undefined, sub: "Daily · last 1 month" },
    hourly: { futs: hourlyFuts, formatX: fmtHour, sub: "Hourly · last 1 week" },
    "5m": { futs: fiveFuts, formatX: fmtMinute, sub: "5-min · today" },
    "1m": { futs: minFuts, formatX: fmtMinute, sub: "1-min · last 2 hours" },
  }[spreadMode];
  const spreadSeries = spreadFrom(spreadConfig.futs);

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
        <ThemeToggle />
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

          {canTrade && item && item.futures.length >= 2 && (
            <div className="card-foot">
              <button
                className="btn btn--sm btn--trade"
                disabled={tradeBusy || hasOpenTrade}
                onClick={() => onTakeTrade?.(symbol)}
              >
                {hasOpenTrade ? "Trade open" : tradeBusy ? "Taking..." : "Take Trade"}
              </button>
            </div>
          )}

          {/* Spread Analytics — admin only, in left column below the card */}
          {(() => {
            if (!isAdmin || !spreadStats || !item || item.futures.length < 2) return null;
            const curTick = ticks[item.futures[0]!.token];
            const nxtTick = ticks[item.futures[1]!.token];
            if (!curTick?.last_price || !nxtTick?.last_price) return null;

            const currentSpread = nxtTick.last_price - curTick.last_price;
            const lotSize = item.futures[0]!.lot_size;
            const stats = spreadStats;

            const varUpside = stats.max_spread - currentSpread;
            const varDownside = currentSpread - stats.min_spread;
            const meanReversionProb = stats.mean_reversion_probability;
            const expectedProfit = Math.abs(currentSpread - stats.mean_spread) * lotSize;
            const expectedMaxLoss = Math.abs(stats.percentile_95 - currentSpread) * lotSize;
            const belowMean = currentSpread < stats.mean_spread;
            const zScore = stats.std_dev_spread !== 0
              ? (currentSpread - stats.mean_spread) / stats.std_dev_spread
              : 0;

            const green = "var(--pos)";
            const red = "var(--neg)";

            const metrics: { label: string; value: string; color: string }[] = [
              {
                label: "Current Spread",
                value: fmtPrice(currentSpread),
                color: currentSpread < stats.mean_spread ? green : red,
              },
              {
                label: "Max Profit (to Mean)",
                value: `₹${fmtPrice(expectedProfit)}`,
                color: green,
              },
              {
                label: "Max Loss (to 95th %ile)",
                value: `₹${fmtPrice(expectedMaxLoss)}`,
                color: red,
              },
              {
                label: "VaR Upside (Max − Current)",
                value: `${varUpside >= 0 ? "+" : ""}${fmtPrice(varUpside)}`,
                color: varUpside >= 0 ? green : red,
              },
              {
                label: "VaR Downside (Current − Min)",
                value: `${varDownside >= 0 ? "+" : ""}${fmtPrice(varDownside)}`,
                color: currentSpread < stats.min_spread ? green : red,
              },
              {
                label: "Mean Reversion %",
                value: `${meanReversionProb.toFixed(1)}%`,
                color: meanReversionProb >= 50 ? green : red,
              },
              {
                label: "Percentile Rank",
                value: (() => {
                  // Approximate percentile from Z-score using normal CDF approximation
                  const t = 1 / (1 + 0.2316419 * Math.abs(zScore));
                  const d = 0.3989422804 * Math.exp(-zScore * zScore / 2);
                  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
                  const percentile = zScore > 0 ? (1 - p) * 100 : p * 100;
                  return `${percentile.toFixed(1)}% ${belowMean ? "(Below Mean)" : "(Above Mean)"}`;
                })(),
                color: belowMean ? green : red,
              },
              {
                label: "Z-Score",
                value: zScore.toFixed(2),
                color: zScore < 0 ? green : red,
              },
              {
                label: "Mean Spread",
                value: fmtPrice(stats.mean_spread),
                color: "var(--text-2)",
              },
              {
                label: "Max Spread",
                value: fmtPrice(stats.max_spread),
                color: green,
              },
              {
                label: "Min Spread",
                value: fmtPrice(stats.min_spread),
                color: red,
              },
            ];

            return (
              <div className="metric-panel">
                <h3 className="metric-panel-title">
                  Spread Analytics
                </h3>
                <div className="metric-list">
                  {metrics.map((m) => (
                    <div key={m.label} className="metric-row">
                      <span className="metric-label">
                        {m.label}
                      </span>
                      <span className="metric-value" style={{ color: m.color }}>
                        {m.value}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}

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
                  <h2>Spread</h2>
                  <span className="chart-sub">{spreadConfig.sub} · next − current</span>
                  <div className="chart-toggle">
                    <button
                      className={spreadMode === "daily" ? "active" : ""}
                      onClick={() => setSpreadMode("daily")}
                    >
                      1M
                    </button>
                    <button
                      className={spreadMode === "hourly" ? "active" : ""}
                      onClick={() => setSpreadMode("hourly")}
                    >
                      1W
                    </button>
                    <button
                      className={spreadMode === "5m" ? "active" : ""}
                      onClick={() => setSpreadMode("5m")}
                    >
                      5m
                    </button>
                    <button
                      className={spreadMode === "1m" ? "active" : ""}
                      onClick={() => setSpreadMode("1m")}
                    >
                      1m
                    </button>
                  </div>
                </div>
                <LineChart
                  series={spreadSeries}
                  format={fmtPrice}
                  formatX={spreadConfig.formatX}
                  markers={markers}
                  signed
                />
              </div>

              <div className="detail-chart">
                <div className="chart-head">
                  <h2>Price</h2>
                  <span className="chart-sub">Daily close · last 1 month · 3 futures</span>
                </div>
                <LineChart series={priceSeries} format={fmtPrice} markers={markers} />
              </div>

              <div className="detail-chart">
                <div className="chart-head">
                  <h2>Price · Hourly</h2>
                  <span className="chart-sub">Hourly close · last 1 week · 3 futures</span>
                </div>
                <LineChart
                  series={hourlySeries}
                  format={fmtPrice}
                  formatX={fmtHour}
                  markers={markers}
                />
              </div>

              {showIntraday && (
                <div className="detail-chart">
                  <div className="chart-head">
                    <h2>Price · Intraday</h2>
                    <span className="chart-sub">
                      {intradayMode === "1m"
                        ? "1-min close · last 2 hours"
                        : "5-min close · today"}{" "}
                      · 3 futures
                    </span>
                    <div className="chart-toggle">
                      <button
                        className={intradayMode === "1m" ? "active" : ""}
                        onClick={() => setIntradayMode("1m")}
                      >
                        1m
                      </button>
                      <button
                        className={intradayMode === "5m" ? "active" : ""}
                        onClick={() => setIntradayMode("5m")}
                      >
                        5m
                      </button>
                    </div>
                  </div>
                  <LineChart
                    series={intradaySeries}
                    format={fmtPrice}
                    formatX={fmtMinute}
                    markers={markers}
                  />
                </div>
              )}

              <div className="detail-chart">
                <div className="chart-head">
                  <h2>Open Interest</h2>
                  <span className="chart-sub">Daily closing OI · last 1 month</span>
                </div>
                <LineChart series={oiSeries} format={fmtCompact} markers={markers} />
              </div>


            </>
          )}
        </div>
      </div>
    </div>
  );
}
