import { useMemo } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls, Text, Line } from "@react-three/drei";
import * as THREE from "three";
import type { Trade, OiHistory } from "./api.ts";

interface Props {
  trade: Trade;
  history: OiHistory;
}

interface DataPoint {
  timeIndex: number;
  oi: number;
  pnl: number;
}

/**
 * 3D PnL graph showing PnL (Z-axis) vs Time (X-axis) vs OI (Y-axis).
 * Supports orbit controls for rotation, pan, and zoom.
 */
export default function PnlGraph3D({ trade, history }: Props) {
  const { points, xRange, yRange, zRange } = useMemo(() => {
    const openDate = trade.opened_at.slice(0, 10);

    // Find buy-leg and sell-leg futures in the OI history
    const buyFuture = history.futures.find((f) => f.token === trade.buy.token);
    const sellFuture = history.futures.find((f) => f.token === trade.sell.token);

    if (!buyFuture || !sellFuture) {
      return { points: [] as DataPoint[], xRange: [0, 1], yRange: [0, 1], zRange: [-1, 1] };
    }

    // Build date-indexed maps for quick lookup
    const buyMap = new Map(buyFuture.points.map((p) => [p.date, p]));
    const sellMap = new Map(sellFuture.points.map((p) => [p.date, p]));

    // Get all dates from the buy future that are on or after the trade open date
    const dates = buyFuture.points
      .map((p) => p.date)
      .filter((d) => d >= openDate)
      .sort();

    const pts: DataPoint[] = [];
    dates.forEach((date, idx) => {
      const buyPoint = buyMap.get(date);
      const sellPoint = sellMap.get(date);
      if (!buyPoint || !sellPoint) return;

      const pnl =
        trade.lot_size *
        ((buyPoint.close - trade.buy.entry) + (trade.sell.entry - sellPoint.close));
      const oi = buyPoint.oi + sellPoint.oi;

      pts.push({ timeIndex: idx, oi, pnl });
    });

    if (pts.length === 0) {
      return { points: [] as DataPoint[], xRange: [0, 1], yRange: [0, 1], zRange: [-1, 1] };
    }

    const xMin = 0;
    const xMax = Math.max(pts[pts.length - 1]!.timeIndex, 1);
    const oiValues = pts.map((p) => p.oi);
    const yMin = Math.min(...oiValues);
    const yMax = Math.max(...oiValues);
    const pnlValues = pts.map((p) => p.pnl);
    const zMin = Math.min(...pnlValues, 0);
    const zMax = Math.max(...pnlValues, 0);

    return {
      points: pts,
      xRange: [xMin, xMax],
      yRange: [yMin, yMax === yMin ? yMin + 1 : yMax],
      zRange: [zMin, zMax === zMin ? zMin + 1 : zMax],
    };
  }, [trade, history]);

  if (points.length < 2) {
    return (
      <div className="detail-chart" style={{ height: 500 }}>
        <div className="chart-head">
          <h2>3D PnL Surface</h2>
          <span className="chart-sub">Time x OI x PnL</span>
        </div>
        <div className="empty">Not enough data points for 3D graph.</div>
      </div>
    );
  }

  // Normalize to [-5, 5] range for scene coordinates
  const scaleSize = 5;
  const normalize = (val: number, min: number, max: number) => {
    const range = max - min;
    if (range === 0) return 0;
    return ((val - min) / range) * scaleSize * 2 - scaleSize;
  };

  // Create line segments colored by PnL sign
  const linePoints: [number, number, number][] = points.map((p) => [
    normalize(p.timeIndex, xRange[0], xRange[1]),
    normalize(p.oi, yRange[0], yRange[1]),
    normalize(p.pnl, zRange[0], zRange[1]),
  ]);

  const lineColors: [number, number, number][] = points.map((p) => {
    if (p.pnl >= 0) return [0.13, 0.77, 0.37]; // green
    return [1.0, 0.35, 0.42]; // red
  });

  return (
    <div className="detail-chart" style={{ height: 500 }}>
      <div className="chart-head">
        <h2>3D PnL Surface</h2>
        <span className="chart-sub">Time (X) x OI (Y) x PnL (Z) - drag to rotate, scroll to zoom</span>
      </div>
      <Canvas
        camera={{ position: [8, 6, 8], fov: 50 }}
        style={{ background: "#1a1d23", borderRadius: 8 }}
      >
        <ambientLight intensity={0.6} />
        <pointLight position={[10, 10, 10]} intensity={0.8} />
        <OrbitControls enableDamping dampingFactor={0.1} />

        {/* Data line */}
        <Line
          points={linePoints}
          vertexColors={lineColors}
          lineWidth={3}
        />

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
          OI
        </Text>
        <Text position={[-scaleSize, -scaleSize - 0.8, 0]} fontSize={0.5} color="#9ca3af">
          PnL
        </Text>

        {/* Zero PnL plane (faint grid) */}
        <mesh
          position={[0, 0, normalize(0, zRange[0], zRange[1])]}
          rotation={[Math.PI / 2, 0, 0]}
        >
          <planeGeometry args={[scaleSize * 2, scaleSize * 2]} />
          <meshBasicMaterial
            color="#4b5563"
            transparent
            opacity={0.15}
            side={THREE.DoubleSide}
          />
        </mesh>

        {/* Grid lines on bottom */}
        <gridHelper
          args={[scaleSize * 2, 10, "#374151", "#374151"]}
          position={[0, -scaleSize, 0]}
          rotation={[0, 0, 0]}
        />
      </Canvas>
    </div>
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
