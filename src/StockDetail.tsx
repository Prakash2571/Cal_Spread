import { useEffect, useState } from "react";
import {
  fetchOiHistory,
  fetchIntradayHistory,
  fetchMinuteHistory,
  fetchFiveMinHistory,
  fetchSpreadHistory,
  fetchSpreadStats,
  type BoardItem,
  type OiHistory,
  type IntradayHistory,
  type SpreadHistory,
  type SpreadStats,
  type Tick,
  type Trade,
} from "./api.ts";
import { fmtCompact, formatExpiry } from "./format.ts";
import StockCard from "./StockCard.tsx";
import LineChart, { type ChartSeries, type ChartMarker } from "./LineChart.tsx";


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
  const [spreadHistory, setSpreadHistory] = useState<SpreadHistory | null>(null);
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
    const spreadHist = fetchSpreadHistory(symbol).catch(() => null);
    const statsP = fetchSpreadStats(symbol).catch(() => null);

    Promise.all([core, intra, spreadHist, statsP])
      .then(([[h, intrH], intraRes, sh, ss]) => {
        if (!alive) return;
        setHistory(h);
        setIntraday(intrH);
        setSpreadHistory(sh);
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
    markers.push({ at: new Date(markStart).getTime(), color: "#22c55e", label: "Entry" });
  }
  if (markEnd) {
    markers.push({ at: new Date(markEnd).getTime(), color: "#ff5a6a", label: "Exit" });
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
    return [{ label: "Spread (next − current)", color: "#6d8bff", points }];
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

            const green = "#22c55e";
            const red = "#ef4444";

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
                color: varDownside >= 0 ? green : red,
              },
              {
                label: "Mean Reversion %",
                value: `${meanReversionProb.toFixed(1)}%`,
                color: meanReversionProb >= 50 ? green : red,
              },
              {
                label: "Percentile Rank",
                value: belowMean ? "Below Mean" : "Above Mean",
                color: belowMean ? green : red,
              },
              {
                label: "Z-Score",
                value: zScore.toFixed(2),
                color: zScore < 0 ? green : red,
              },
            ];

            return (
              <div style={{ marginTop: "1rem", borderTop: "1px solid rgba(255,255,255,0.08)", paddingTop: "0.75rem" }}>
                <h3 style={{ margin: "0 0 0.6rem", fontSize: "0.9rem", fontWeight: 700, letterSpacing: "-0.2px" }}>
                  Spread Analytics
                </h3>
                <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                  {metrics.map((m) => (
                    <div
                      key={m.label}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        background: "rgba(255,255,255,0.03)",
                        borderRadius: "6px",
                        padding: "0.5rem 0.7rem",
                      }}
                    >
                      <span style={{ fontSize: "0.75rem", opacity: 0.7 }}>
                        {m.label}
                      </span>
                      <span style={{ fontSize: "0.9rem", fontWeight: 600, color: m.color }}>
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
              {spreadHistory && spreadHistory.points.length > 0 && (() => {
                const pts = spreadHistory.points;
                const stats = spreadHistory.stats;
                const firstDate = pts[0]!.date;
                const lastDate = pts[pts.length - 1]!.date;
                const spreadHistSeries: ChartSeries[] = [
                  {
                    label: "Spread",
                    color: "#6d8bff",
                    points: pts.map((p) => ({ date: p.date, value: p.spread })),
                  },
                  {
                    label: "Mean",
                    color: "#94a3b8",
                    dashed: true,
                    points: [
                      { date: firstDate, value: stats.mean },
                      { date: lastDate, value: stats.mean },
                    ],
                  },
                  {
                    label: "Max",
                    color: "#22c55e",
                    dashed: true,
                    points: [
                      { date: firstDate, value: stats.max },
                      { date: lastDate, value: stats.max },
                    ],
                  },
                  {
                    label: "Min",
                    color: "#ef4444",
                    dashed: true,
                    points: [
                      { date: firstDate, value: stats.min },
                      { date: lastDate, value: stats.min },
                    ],
                  },
                ];
                return (
                  <div className="detail-chart">
                    <div className="chart-head">
                      <h2>Spread History</h2>
                      <span className="chart-sub">
                        Daily spread (all available data) · next − current month
                      </span>
                    </div>
                    <LineChart
                      series={spreadHistSeries}
                      format={fmtPrice}
                      signed
                    />
                    <div style={{ display: 'flex', gap: '1.5rem', padding: '0.5rem 0', fontSize: '0.85rem' }}>
                      <span>Mean: <strong>{fmtPrice(stats.mean)}</strong></span>
                      <span style={{ color: '#22c55e' }}>Max: <strong>{fmtPrice(stats.max)}</strong></span>
                      <span style={{ color: '#ef4444' }}>Min: <strong>{fmtPrice(stats.min)}</strong></span>
                      <span>Count: <strong>{stats.count}</strong></span>
                    </div>
                  </div>
                );
              })()}

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
