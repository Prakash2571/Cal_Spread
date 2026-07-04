import { useRef, useState } from "react";
import { fmtCompact, formatExpiry } from "./format.ts";

export interface ChartSeries {
  label: string; // expiry ISO
  color: string;
  points: { date: string; oi: number }[];
}

interface Props {
  series: ChartSeries[];
}

// Internal coordinate system (scaled responsively via viewBox).
const W = 760;
const H = 300;
const PAD = { l: 56, r: 18, t: 18, b: 30 };
const plotW = W - PAD.l - PAD.r;
const plotH = H - PAD.t - PAD.b;

function shortDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
}

export default function OiChart({ series }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  // Unified, sorted list of all trading days across the series.
  const allDates = Array.from(
    new Set(series.flatMap((s) => s.points.map((p) => p.date))),
  ).sort();
  const n = allDates.length;

  const allOi = series
    .flatMap((s) => s.points.map((p) => p.oi))
    .filter((v) => v > 0);

  if (n === 0 || allOi.length === 0) {
    return <div className="chart-empty">No open-interest history available.</div>;
  }

  const yMin = Math.min(...allOi);
  const yMax = Math.max(...allOi);
  const yRange = yMax - yMin || 1;

  const xAt = (i: number) =>
    PAD.l + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const yAt = (v: number) => PAD.t + plotH - ((v - yMin) / yRange) * plotH;

  // Y-axis ticks (5 levels).
  const yTicks = Array.from({ length: 5 }, (_, i) => yMin + (yRange * i) / 4);

  // X-axis labels (first, middle, last) — deduped for short ranges.
  const xLabelIdx = Array.from(
    new Set(n <= 1 ? [0] : [0, Math.floor((n - 1) / 2), n - 1]),
  );

  function handleMove(e: React.MouseEvent<SVGSVGElement>) {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const xInView = ((e.clientX - rect.left) / rect.width) * W;
    const ratio = (xInView - PAD.l) / plotW;
    const idx = Math.round(ratio * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, idx)));
  }

  const hoverDate = hover !== null ? allDates[hover] : null;

  return (
    <div className="chart-wrap">
      <svg
        ref={svgRef}
        className="oi-chart"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        onMouseMove={handleMove}
        onMouseLeave={() => setHover(null)}
      >
        {/* Y grid + labels */}
        {yTicks.map((v, i) => (
          <g key={i}>
            <line
              x1={PAD.l}
              y1={yAt(v)}
              x2={W - PAD.r}
              y2={yAt(v)}
              className="chart-grid"
            />
            <text x={PAD.l - 8} y={yAt(v) + 3} className="chart-ylabel">
              {fmtCompact(v)}
            </text>
          </g>
        ))}

        {/* X labels */}
        {xLabelIdx.map((i) => (
          <text key={i} x={xAt(i)} y={H - 10} className="chart-xlabel">
            {shortDate(allDates[i]!)}
          </text>
        ))}

        {/* Series lines */}
        {series.map((s) => {
          const pts = s.points
            .filter((p) => p.oi > 0)
            .map((p) => `${xAt(allDates.indexOf(p.date))},${yAt(p.oi)}`)
            .join(" ");
          return (
            <polyline
              key={s.label}
              points={pts}
              fill="none"
              stroke={s.color}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          );
        })}

        {/* Hover guide + markers */}
        {hover !== null && (
          <>
            <line
              x1={xAt(hover)}
              y1={PAD.t}
              x2={xAt(hover)}
              y2={PAD.t + plotH}
              className="chart-guide"
            />
            {series.map((s) => {
              const p = s.points.find((pt) => pt.date === hoverDate);
              if (!p || p.oi <= 0) return null;
              return (
                <circle
                  key={s.label}
                  cx={xAt(hover)}
                  cy={yAt(p.oi)}
                  r={3.5}
                  fill={s.color}
                />
              );
            })}
          </>
        )}
      </svg>

      {/* Tooltip */}
      {hover !== null && hoverDate && (
        <div className="chart-tip">
          <div className="chart-tip-date">{shortDate(hoverDate)}</div>
          {series.map((s) => {
            const p = s.points.find((pt) => pt.date === hoverDate);
            return (
              <div key={s.label} className="chart-tip-row">
                <span className="chart-dot" style={{ background: s.color }} />
                <span className="chart-tip-label">{formatExpiry(s.label)}</span>
                <span className="chart-tip-val">
                  {p ? fmtCompact(p.oi) : "—"}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* Legend */}
      <div className="chart-legend">
        {series.map((s) => (
          <span key={s.label} className="chart-legend-item">
            <span className="chart-dot" style={{ background: s.color }} />
            {formatExpiry(s.label)}
          </span>
        ))}
      </div>
    </div>
  );
}
