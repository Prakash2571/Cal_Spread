import {
  Component,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls, Text, Line, Billboard } from "@react-three/drei";
import * as THREE from "three";
import { fmtCompact, fmtMoney } from "./format.ts";
import type { Trade, OiHistory, IntradayHistory } from "./api.ts";

/* ---------- Error Boundary for Three.js Canvas ---------- */
interface EBProps { children: ReactNode; fallback: ReactNode }
interface EBState { hasError: boolean; error: string }

class ChartErrorBoundary extends Component<EBProps, EBState> {
  state: EBState = { hasError: false, error: "" };
  static getDerivedStateFromError(err: unknown) {
    return { hasError: true, error: err instanceof Error ? err.message : String(err) };
  }
  componentDidCatch(err: unknown) {
    console.error("[PnlGraph3D] Canvas error caught by boundary:", err);
  }
  render() {
    return this.state.hasError ? this.props.fallback : this.props.children;
  }
}

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
  /** Human-readable label for this point's time, e.g. "08 Jul" or "08 Jul 14:15". */
  timeLabel: string;
}

/* ---------- Local formatters ---------- */

/** Daily date label: "2024-07-08" -> "08 Jul". Falls back to the raw string. */
function fmtDayLabel(date: string): string {
  const d = new Date(`${date}T00:00:00`);
  if (Number.isNaN(d.getTime())) return date;
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
}

/** Intraday label: ISO timestamp -> "08 Jul 14:15" (24h). Falls back to raw. */
function fmtDateTimeLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** Compact Indian number (unsigned magnitude), e.g. 29700000 -> "2.97Cr". */
function compactNum(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e7) return `${(value / 1e7).toFixed(2)}Cr`;
  if (abs >= 1e5) return `${(value / 1e5).toFixed(2)}L`;
  return Math.round(value).toLocaleString("en-IN");
}

/** Signed compact ₹ value for axis ticks, e.g. "+₹1.20L" / "−₹9,800". */
function fmtPnlTick(value: number): string {
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}₹${compactNum(Math.abs(value))}`;
}

/**
 * 3D PnL graph showing PnL (Y-axis, vertical) vs Time (X-axis) vs OI (Z-axis, depth).
 * Supports orbit controls for rotation, pan, and zoom (touch-enabled on mobile).
 * Hover (desktop) or tap (mobile) a point to read Time / PnL / OI all at once.
 * Toggle between 1M (daily), 1W (hourly), 5m, and 1m timeframes.
 */
export default function PnlGraph3D({ trade, history, intraday, fiveMin, minute }: Props) {
  const [mode, setMode] = useState<TimeMode>("1M");
  const [active, setActive] = useState<number | null>(null);
  const [isMobile, setIsMobile] = useState(false);

  // Responsive height: shorter on small screens so the chart isn't overwhelming.
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 640px)");
    const onChange = () => setIsMobile(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // Reset the active point whenever the timeframe changes (indices no longer align).
  useEffect(() => {
    setActive(null);
  }, [mode]);

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

        pts.push({ timeIndex: idx, oi, pnl, timeLabel: fmtDayLabel(date) });
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

      pts.push({ timeIndex: idx, oi: latestOi, pnl, timeLabel: fmtDateTimeLabel(bp.t) });
      idx++;
    }

    return computeRanges(pts);
  }, [trade, history, intraday, fiveMin, minute, mode, latestOi]);

  const modeLabel = mode === "1M" ? "Daily" : mode === "1W" ? "Hourly" : mode === "5m" ? "5-min" : "1-min";

  // Resolve the active point safely (index may be stale across renders).
  const activePoint = active != null && active < points.length ? points[active] : null;

  return (
    <div
      className="detail-chart"
      style={{
        position: "relative",
        height: isMobile ? 360 : 520,
        borderRadius: 10,
        background: "#0f1218",
      }}
    >
      <div className="chart-head">
        <h2>3D PnL Surface</h2>
        <span className="chart-sub">
          {modeLabel} · Time (X) x PnL (Y) x OI (Z) —{" "}
          {isMobile ? "one finger to rotate, pinch to zoom, tap a point" : "drag to rotate, scroll to zoom, hover a point"}
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

      {/* All-axis readout overlay: shows Time, PnL and OI of the active point at
          once. Rendered as an HTML panel inside (and clipped to) the container so
          it stays readable on both desktop and mobile. */}
      {activePoint && (
        <div
          style={{
            position: "absolute",
            top: 56,
            left: 12,
            zIndex: 5,
            pointerEvents: "none",
            background: "rgba(15, 18, 24, 0.92)",
            border: "1px solid #334155",
            borderRadius: 8,
            padding: "8px 10px",
            fontSize: 12,
            lineHeight: 1.5,
            color: "#e5e7eb",
            boxShadow: "0 4px 14px rgba(0,0,0,0.4)",
            maxWidth: "70%",
          }}
        >
          <div style={{ color: "#9ca3af", fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.5 }}>
            Point details
          </div>
          <div>
            <span style={{ color: "#9ca3af" }}>Time: </span>
            <strong>{activePoint.timeLabel}</strong>
          </div>
          <div>
            <span style={{ color: "#9ca3af" }}>PnL: </span>
            <strong style={{ color: activePoint.pnl >= 0 ? "#22c55e" : "#ff5a6a" }}>
              {fmtMoney(activePoint.pnl)}
            </strong>
          </div>
          <div>
            <span style={{ color: "#9ca3af" }}>OI: </span>
            <strong>{fmtCompact(activePoint.oi)}</strong>
          </div>
        </div>
      )}

      {points.length === 0 ? (
        <div className="empty" style={{ padding: "2rem", color: "#f59e0b", fontWeight: 500 }}>
          Not enough data for {modeLabel} timeframe.
          <br />
          <span style={{ fontSize: "0.85em", color: "#9ca3af" }}>
            Mode: {mode} | Source available: {mode === "1M" ? "history" : mode === "1W" ? (intraday ? "yes" : "no") : mode === "5m" ? (fiveMin ? "yes" : "no") : (minute ? "yes" : "no")}
          </span>
        </div>
      ) : (
        <ChartErrorBoundary
          fallback={
            <div className="empty" style={{ padding: "2rem", color: "#ef4444", fontWeight: 500 }}>
              3D rendering failed - WebGL may not be available in this browser.
              <br />
              <span style={{ fontSize: "0.85em", color: "#9ca3af" }}>
                Check the browser console for details.
              </span>
            </div>
          }
        >
          <Graph3DCanvas
            points={points}
            xRange={xRange}
            yRange={yRange}
            zRange={zRange}
            active={active}
            setActive={setActive}
          />
        </ChartErrorBoundary>
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

/** Evenly spaced values from min to max inclusive (n values). */
function linspace(min: number, max: number, n: number): number[] {
  if (n < 2) return [min];
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(min + ((max - min) * i) / (n - 1));
  return out;
}

/** A camera-facing tick/label so text never renders mirrored or upside-down. */
function TickLabel({
  position,
  children,
  fontSize = 0.32,
  color = "#cbd5e1",
}: {
  position: [number, number, number];
  children: string;
  fontSize?: number;
  color?: string;
}) {
  return (
    <Billboard position={position}>
      <Text fontSize={fontSize} color={color} anchorX="center" anchorY="middle">
        {children}
      </Text>
    </Billboard>
  );
}

/** The actual Three.js canvas with 3D rendering. */
function Graph3DCanvas({
  points,
  xRange,
  yRange,
  zRange,
  active,
  setActive,
}: {
  points: DataPoint[];
  xRange: number[];
  yRange: number[];
  zRange: number[];
  active: number | null;
  setActive: (i: number | null) => void;
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

  // PnL (Y) axis ticks — 5 even values plus a guaranteed 0, sorted ascending.
  const yTickValues = Array.from(
    new Set([...linspace(yRange[0], yRange[1], 5), 0]),
  ).sort((a, b) => a - b);

  // OI (Z) axis ticks — min / mid / max.
  const zMid = (zRange[0] + zRange[1]) / 2;
  const zTickValues = [zRange[0], zMid, zRange[1]];

  // Time (X) axis ticks — first / middle / last points.
  const timeTickIdx = points.length >= 3
    ? [0, Math.floor((points.length - 1) / 2), points.length - 1]
    : points.map((_, i) => i);

  // Active point's normalized position (for guide lines).
  const activePos = active != null && active < linePoints.length ? linePoints[active] : null;

  return (
    <Canvas
      camera={{ position: [8, 6, 8], fov: 50 }}
      style={{ background: "#1a1d23", borderRadius: 8 }}
    >
      <ambientLight intensity={0.6} />
      <pointLight position={[10, 10, 10]} intensity={0.8} />
      <OrbitControls makeDefault enableDamping dampingFactor={0.1} />

      {/* Data line - only render if we have 2+ points */}
      {linePoints.length >= 2 && (
        <Line points={linePoints} vertexColors={lineColors} lineWidth={3} />
      )}

      {/* Data point spheres — hover (desktop) / tap (mobile) to inspect. */}
      {points.map((p, i) => {
        const isActive = active === i;
        const color = p.pnl >= 0 ? "#22c55e" : "#ff5a6a";
        return (
          <mesh
            key={i}
            position={linePoints[i]}
            onPointerOver={(e) => {
              e.stopPropagation();
              setActive(i);
            }}
            onPointerOut={(e) => {
              e.stopPropagation();
              setActive(null);
            }}
            onClick={(e) => {
              e.stopPropagation();
              setActive(i);
            }}
          >
            <sphereGeometry args={[isActive ? 0.16 : 0.08, 16, 16]} />
            <meshStandardMaterial
              color={color}
              emissive={color}
              emissiveIntensity={isActive ? 0.9 : 0.25}
            />
          </mesh>
        );
      })}

      {/* Guide lines from the active point to each axis, so you can see where
          it projects onto Time (X), PnL (Y) and OI (Z). */}
      {activePos && (
        <group>
          {/* Vertical drop to the base plane at the point's (x, z). */}
          <Line
            points={[activePos, [activePos[0], -scaleSize, activePos[2]]]}
            color="#fbbf24"
            lineWidth={1.5}
            dashed
            dashSize={0.3}
            gapSize={0.15}
          />
          {/* Along the base to the Time (X) axis. */}
          <Line
            points={[[activePos[0], -scaleSize, activePos[2]], [activePos[0], -scaleSize, -scaleSize]]}
            color="#fbbf24"
            lineWidth={1.5}
            dashed
            dashSize={0.3}
            gapSize={0.15}
          />
          {/* Along the base to the OI (Z) axis. */}
          <Line
            points={[[activePos[0], -scaleSize, activePos[2]], [-scaleSize, -scaleSize, activePos[2]]]}
            color="#fbbf24"
            lineWidth={1.5}
            dashed
            dashSize={0.3}
            gapSize={0.15}
          />
          {/* To the PnL (Y) axis at the point's height. */}
          <Line
            points={[activePos, [-scaleSize, activePos[1], -scaleSize]]}
            color="#38bdf8"
            lineWidth={1.5}
            dashed
            dashSize={0.3}
            gapSize={0.15}
          />
        </group>
      )}

      {/* Axes */}
      <AxisLine from={[-scaleSize, -scaleSize, -scaleSize]} to={[scaleSize, -scaleSize, -scaleSize]} color="#6b7280" />
      <AxisLine from={[-scaleSize, -scaleSize, -scaleSize]} to={[-scaleSize, scaleSize, -scaleSize]} color="#6b7280" />
      <AxisLine from={[-scaleSize, -scaleSize, -scaleSize]} to={[-scaleSize, -scaleSize, scaleSize]} color="#6b7280" />

      {/* Axis name labels — Billboard-wrapped so they always face the camera. */}
      <TickLabel position={[0, -scaleSize - 0.9, -scaleSize]} fontSize={0.5} color="#9ca3af">
        Time
      </TickLabel>
      <TickLabel position={[-scaleSize - 1.1, 0, -scaleSize]} fontSize={0.5} color="#9ca3af">
        PnL
      </TickLabel>
      <TickLabel position={[-scaleSize, -scaleSize - 0.9, 0]} fontSize={0.5} color="#9ca3af">
        OI (2nd Month)
      </TickLabel>

      {/* PnL (Y) axis tick values with signed ₹ labels. */}
      {yTickValues.map((v, i) => (
        <TickLabel key={`y${i}`} position={[-scaleSize - 0.5, normalize(v, yRange[0], yRange[1]), -scaleSize]}>
          {fmtPnlTick(v)}
        </TickLabel>
      ))}

      {/* Time (X) axis tick values from point labels (first / middle / last). */}
      {timeTickIdx.map((idx) => (
        <TickLabel
          key={`x${idx}`}
          position={[normalize(points[idx]!.timeIndex, xRange[0], xRange[1]), -scaleSize - 0.45, -scaleSize]}
        >
          {points[idx]!.timeLabel}
        </TickLabel>
      ))}

      {/* OI (Z) axis tick values (min / mid / max). */}
      {zTickValues.map((v, i) => (
        <TickLabel key={`z${i}`} position={[-scaleSize, -scaleSize - 0.45, normalize(v, zRange[0], zRange[1])]}>
          {fmtCompact(v)}
        </TickLabel>
      ))}

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
