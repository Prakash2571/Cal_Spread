import { useMemo, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls, Text, Line } from "@react-three/drei";
import * as THREE from "three";
import type { Trade, OiHistory, IntradayHistory } from "./api.ts";

type TimeMode = "1M" | "1W" | "5m" | "1m";

interface Props {
  trade: Trade;
  history: OiHistory;
  intraday?: IntradayHistory;
  fiveMin?: IntradayHistory;
  minute?: IntradayHistory;
}

interface DataPoint {
  timeIndex: number;
  oi: number;
  pnl: number;
}

/**
 * 3D PnL graph showing PnL (Y-axis, vertical) vs Time (X-axis) vs OI (Z-axis, depth).
 * Supports orbit controls for rotation, pan, and zoom.
 * Toggle between 1M (daily), 1W (hourly), 5m, and 1m timeframes.
 */
export default function PnlGraph3D({ trade, history, intraday, fiveMin, minute }: Props) {
  const [mode, setMode] = useState<TimeMode>("1W");

  // Get the latest known OI from daily history for the buy-leg future.
  // Used as constant OI for intraday modes where per-point OI is unavailable.
  const latestOi = useMemo(() => {
    const buyFuture = history.futures.find((f) => f.token === trade.buy.token);
    if (!buyFuture || buyFuture.points.length === 0) return 0;
    const sorted = [...buyFuture.points].sort((a, b) => a.date.localeCompare(b.date));
    return sorted[sorted.length - 1]!.oi;
  }, [history, trade.buy.token]);

  const { points, xRange, yRange, zRange } = useMemo(() => {
    const openTs = new Date(trade.opened_at).getTime();
    const closeDate = trade.closed_at ? trade.closed_at.slice(0, 10) : null;
    const openDate = trade.opened_at.slice(0, 10);

    if (mode === "1M") {
      // Daily mode: use history.futures with both close and oi
      const buyFuture = history.futures.find((f) => f.token === trade.buy.token);
      const sellFuture = history.futures.find((f) => f.token === trade.sell.token);

      if (!buyFuture || !sellFuture) {
        return { points: [] as DataPoint[], xRange: [0, 1], yRange: [-1, 1], zRange: [0, 1] };
      }

      const buyMap = new Map(buyFuture.points.map((p) => [p.date, p]));
      const sellMap = new Map(sellFuture.points.map((p) => [p.date, p]));

      const dates = buyFuture.points
        .map((p) => p.date)
        .filter((d) => {
          if (d < openDate) return false;
          if (closeDate && d > closeDate) return false;
          return true;
        })
        .sort();

      const pts: DataPoint[] = [];
      dates.forEach((date, idx) => {
        const buyPoint = buyMap.get(date);
        const sellPoint = sellMap.get(date);
        if (!buyPoint || !sellPoint) return;

        const isCloseDate = closeDate && date === closeDate;
        const buyClose = isCloseDate && trade.buy_close != null ? trade.buy_close : buyPoint.close;
        const sellClose = isCloseDate && trade.sell_close != null ? trade.sell_close : sellPoint.close;

        const pnl =
          trade.lot_size *
          ((buyClose - trade.buy.entry) + (trade.sell.entry - sellClose));
        const oi = buyPoint.oi;

        pts.push({ timeIndex: idx, oi, pnl });
      });

      return computeRanges(pts);
    }

    // Intraday modes (1W, 5m, 1m): use the appropriate IntradayHistory source
    const source = mode === "1W" ? intraday : mode === "5m" ? fiveMin : minute;
    if (!source) {
      return { points: [] as DataPoint[], xRange: [0, 1], yRange: [-1, 1], zRange: [0, 1] };
    }

    const buyFuture = source.futures.find((f) => f.token === trade.buy.token);
    const sellFuture = source.futures.find((f) => f.token === trade.sell.token);

    if (!buyFuture || !sellFuture) {
      return { points: [] as DataPoint[], xRange: [0, 1], yRange: [-1, 1], zRange: [0, 1] };
    }

    // Build sorted sell-leg entries with numeric timestamps for nearest-match lookup.
    // Kite API timestamps may vary in format (e.g. "+05:30" vs "+0530" vs space-separated),
    // so exact string matching fails. Use numeric comparison with 5-min tolerance instead.
    const sellEntries = sellFuture.points
      .map((p) => ({ ts: new Date(p.t).getTime(), close: p.close }))
      .sort((a, b) => a.ts - b.ts);

    const findSellClose = (buyTs: number): number | undefined => {
      // Binary search for nearest sell entry within 5-minute tolerance
      let lo = 0;
      let hi = sellEntries.length - 1;
      let best: number | undefined;
      let bestDiff = Infinity;
      while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        const diff = Math.abs(sellEntries[mid].ts - buyTs);
        if (diff < bestDiff) {
          bestDiff = diff;
          best = mid;
        }
        if (sellEntries[mid].ts < buyTs) lo = mid + 1;
        else hi = mid - 1;
      }
      if (best !== undefined && bestDiff < 300_000) return sellEntries[best].close;
      return undefined;
    };

    // Filter points on or after trade open and build data
    const pts: DataPoint[] = [];
    let idx = 0;
    for (const bp of buyFuture.points) {
      const ptTs = new Date(bp.t).getTime();
      if (ptTs < openTs) continue;
      // For closed trades, skip points after close date
      if (closeDate && bp.t.slice(0, 10) > closeDate) continue;

      const sellClose = findSellClose(ptTs);
      if (sellClose === undefined) continue;

      const pnl =
        trade.lot_size *
        ((bp.close - trade.buy.entry) + (trade.sell.entry - sellClose));

      pts.push({ timeIndex: idx, oi: latestOi, pnl });
      idx++;
    }

    return computeRanges(pts);
  }, [trade, history, intraday, fiveMin, minute, mode, latestOi]);

  const modeLabel = mode === "1M" ? "Daily" : mode === "1W" ? "Hourly" : mode === "5m" ? "5-min" : "1-min";

  return (
    <div className="detail-chart" style={{ height: 500 }}>
      <div className="chart-head">
        <h2>3D PnL Surface</h2>
        <span className="chart-sub">
          {modeLabel} · Time (X) x PnL (Y) x OI (Z) - drag to rotate, scroll to zoom
        </span>
        <div className="chart-toggle">
          <button className={mode === "1M" ? "active" : ""} onClick={() => setMode("1M")}>
            1M
          </button>
          <button className={mode === "1W" ? "active" : ""} onClick={() => setMode("1W")}>
            1W
          </button>
          <button className={mode === "5m" ? "active" : ""} onClick={() => setMode("5m")}>
            5m
          </button>
          <button className={mode === "1m" ? "active" : ""} onClick={() => setMode("1m")}>
            1m
          </button>
        </div>
      </div>

      {points.length === 0 ? (
        <div className="empty">Not enough data for this timeframe.</div>
      ) : (
        <Graph3DCanvas points={points} xRange={xRange} yRange={yRange} zRange={zRange} />
      )}
    </div>
  );
}

/** Compute axis ranges from a DataPoint array. */
function computeRanges(pts: DataPoint[]) {
  if (pts.length === 0) {
    return { points: [] as DataPoint[], xRange: [0, 1], yRange: [-1, 1], zRange: [0, 1] };
  }

  const xMin = 0;
  const xMax = Math.max(pts[pts.length - 1]!.timeIndex, 1);
  const pnlValues = pts.map((p) => p.pnl);
  const yMin = Math.min(...pnlValues, 0);
  const yMax = Math.max(...pnlValues, 0);
  const oiValues = pts.map((p) => p.oi);
  const zMin = Math.min(...oiValues);
  const zMax = Math.max(...oiValues);

  return {
    points: pts,
    xRange: [xMin, xMax],
    yRange: [yMin, yMax === yMin ? yMin + 1 : yMax],
    zRange: [zMin, zMax === zMin ? zMin + 1 : zMax],
  };
}

/** The actual Three.js canvas with 3D rendering. */
function Graph3DCanvas({
  points,
  xRange,
  yRange,
  zRange,
}: {
  points: DataPoint[];
  xRange: number[];
  yRange: number[];
  zRange: number[];
}) {
  const scaleSize = 5;
  const normalize = (val: number, min: number, max: number) => {
    const range = max - min;
    if (range === 0) return 0;
    return ((val - min) / range) * scaleSize * 2 - scaleSize;
  };

  // Create line segments: X = time, Y = PnL (vertical), Z = OI (depth)
  const linePoints: [number, number, number][] = points.map((p) => [
    normalize(p.timeIndex, xRange[0], xRange[1]),
    normalize(p.pnl, yRange[0], yRange[1]),
    normalize(p.oi, zRange[0], zRange[1]),
  ]);

  const lineColors: [number, number, number][] = points.map((p) => {
    if (p.pnl >= 0) return [0.13, 0.77, 0.37]; // green
    return [1.0, 0.35, 0.42]; // red
  });

  // Zero-PnL plane Y position
  const zeroPnlY = normalize(0, yRange[0], yRange[1]);

  return (
    <Canvas
      camera={{ position: [8, 6, 8], fov: 50 }}
      style={{ background: "#1a1d23", borderRadius: 8 }}
    >
      <ambientLight intensity={0.6} />
      <pointLight position={[10, 10, 10]} intensity={0.8} />
      <OrbitControls enableDamping dampingFactor={0.1} />

      {/* Data line - only render if we have 2+ points */}
      {linePoints.length >= 2 && (
        <Line points={linePoints} vertexColors={lineColors} lineWidth={3} />
      )}

      {/* Data point spheres */}
      {points.map((p, i) => (
        <mesh key={i} position={linePoints[i]}>
          <sphereGeometry args={[0.08, 8, 8]} />
          <meshStandardMaterial color={p.pnl >= 0 ? "#22c55e" : "#ff5a6a"} />
        </mesh>
      ))}

      {/* Axes */}
      <AxisLine from={[-scaleSize, -scaleSize, -scaleSize]} to={[scaleSize, -scaleSize, -scaleSize]} color="#6b7280" />
      <AxisLine from={[-scaleSize, -scaleSize, -scaleSize]} to={[-scaleSize, scaleSize, -scaleSize]} color="#6b7280" />
      <AxisLine from={[-scaleSize, -scaleSize, -scaleSize]} to={[-scaleSize, -scaleSize, scaleSize]} color="#6b7280" />

      {/* Axis labels */}
      <Text position={[0, -scaleSize - 0.8, -scaleSize]} fontSize={0.5} color="#9ca3af">
        Time
      </Text>
      <Text position={[-scaleSize - 0.8, 0, -scaleSize]} fontSize={0.5} color="#9ca3af" rotation={[0, 0, Math.PI / 2]}>
        PnL
      </Text>
      <Text position={[-scaleSize, -scaleSize - 0.8, 0]} fontSize={0.5} color="#9ca3af">
        OI (2nd Month)
      </Text>

      {/* Zero PnL plane - horizontal at the y-level where PnL = 0 */}
      <mesh position={[0, zeroPnlY, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[scaleSize * 2, scaleSize * 2]} />
        <meshBasicMaterial color="#4b5563" transparent opacity={0.15} side={THREE.DoubleSide} />
      </mesh>

      {/* Grid lines on bottom */}
      <gridHelper args={[scaleSize * 2, 10, "#374151", "#374151"]} position={[0, -scaleSize, 0]} />
    </Canvas>
  );
}

/** Simple axis line helper. */
function AxisLine({
  from,
  to,
  color,
}: {
  from: [number, number, number];
  to: [number, number, number];
  color: string;
}) {
  return <Line points={[from, to]} color={color} lineWidth={1.5} />;
}
