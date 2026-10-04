import { useState } from "react";
import { displayNumber } from "./view.ts";

export interface Series { label: string; color: string; points: { x: number; y: number }[]; dots?: boolean }
/** Numeric axes preserve nonuniform strike/maturity spacing. Straight paths do not add fictitious smoothing. */
export default function FairValueChart({ series, xLabel, yLabel, percent = false }: { series: Series[]; xLabel: string; yLabel: string; percent?: boolean }) {
  const [hover, setHover] = useState<{ x: number; y: number; label: string } | null>(null);
  const points = series.flatMap((s) => s.points).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (!points.length) return <div className="chart-empty">No eligible, validated observations for this chart.</div>;
  const width = 660, height = 285;
  const minX = Math.min(...points.map((p) => p.x)), maxX = Math.max(...points.map((p) => p.x));
  const minY = Math.min(...points.map((p) => p.y)), maxY = Math.max(...points.map((p) => p.y));
  const rangeX = maxX - minX || 1, rangeY = maxY - minY || Math.max(.001, maxY * .1);
  const x = (value: number) => 68 + (value - minX) / rangeX * 570;
  const y = (value: number) => 242 - (value - minY) / rangeY * 212;
  const fmt = (v: number) => percent ? `${displayNumber(v * 100, 2)}%` : displayNumber(v, 5);
  return <>
    <div className="fv-chart-legend">{series.map((s) => <span key={s.label}><i style={{ background: s.color }} />{s.label}</span>)}</div>
    <svg className="fv-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${yLabel} by ${xLabel}`} onMouseLeave={() => setHover(null)}>
      {Array.from({ length: 5 }, (_, i) => {
        const value = minY + rangeY * i / 4;
        return <g key={i}><line x1={68} x2={638} y1={y(value)} y2={y(value)} stroke="var(--chart-grid)" /><text x={60} y={y(value) + 4} textAnchor="end">{fmt(value)}</text></g>;
      })}
      {Array.from({ length: 5 }, (_, i) => {
        const value = minX + rangeX * i / 4;
        return <text key={i} x={x(value)} y={261} textAnchor="middle">{displayNumber(value, 3)}</text>;
      })}
      {series.map((s) => {
        const sorted = s.points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y)).slice().sort((a, b) => a.x - b.x);
        return <g key={s.label}>
          {!s.dots && <path d={sorted.map((p, i) => `${i ? "L" : "M"} ${x(p.x)} ${y(p.y)}`).join(" ")} fill="none" stroke={s.color} strokeWidth={2} />}
          {sorted.map((p, i) => <circle key={i} cx={x(p.x)} cy={y(p.y)} r={s.dots ? 3 : 2} fill={s.color} onMouseEnter={() => setHover({ ...p, label: s.label })}><title>{s.label}: {displayNumber(p.x, 5)}, {fmt(p.y)}</title></circle>)}
        </g>;
      })}
      <text x={350} y={281} textAnchor="middle">{xLabel}</text>
    </svg>
    <div className="fv-chart-readout" aria-live="polite">{hover ? `${hover.label} · ${xLabel} ${displayNumber(hover.x, 5)} · ${yLabel} ${fmt(hover.y)}` : `${yLabel} · hover over a point for values`}</div>
  </>;
}
