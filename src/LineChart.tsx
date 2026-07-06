import { useRef, useState } from "react";

export interface ChartSeries {
  label: string; // already-formatted legend label (e.g. "28 Jul")
  color: string;
  dashed?: boolean;
  points: { date: string; value: number }[];
}

export interface ChartMarker {
  at: number; // JS timestamp (ms)
  color: string;
  label: string;
}

interface Props {
  series: ChartSeries[];
  /** Formats a value for the y-axis and tooltip (e.g. price or compact OI). */
  format: (v: number) => string;
  /** Formats an x-axis key (a date or timestamp) for labels + tooltip title. */
  formatX?: (key: string) => string;
  /** Vertical markers (e.g. trade entry/exit) — only drawn if within range. */
  markers?: ChartMarker[];
}

const W = 760;
const H = 280;
const PAD = { l: 58, r: 18, t: 16, b: 28 };
const plotW = W - PAD.l - PAD.r;
const plotH = H - PAD.t - PAD.b;

function shortDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
}

export default function LineChart({
  series,
  format,
  formatX = shortDate,
  markers = [],
}: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const allDates = Array.from(
    new Set(series.flatMap((s) => s.points.map((p) => p.date))),
  ).sort();
  const n = allDates.length;

  const allVals = series
    .flatMap((s) => s.points.map((p) => p.value))
    .filter((v) => v > 0);

  if (n === 0 || allVals.length === 0) {
    return <div className="chart-empty">No history available.</div>;
  }

  const vMin = Math.min(...allVals);
  const vMax = Math.max(...allVals);
  const vRange = vMax - vMin || 1;

  const xAt = (i: number) =>
    PAD.l + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const yAt = (v: number) => PAD.t + plotH - ((v - vMin) / vRange) * plotH;

  const yTicks = Array.from({ length: 5 }, (_, i) => vMin + (vRange * i) / 4);
  const xLabelIdx = Array.from(
    new Set(n <= 1 ? [0] : [0, Math.floor((n - 1) / 2), n - 1]),
  );

  function handleMove(e: React.MouseEvent<SVGSVGElement>) {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const xInView = ((e.clientX - rect.left) / rect.width) * W;
    const idx = Math.round(((xInView - PAD.l) / plotW) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, idx)));
  }

  const hoverDate = hover !== null ? allDates[hover] : null;
  // Put the tooltip on the opposite side of the cursor so it never covers the
  // point being viewed (hover on the right half -> tooltip on the left).
  const tipOnLeft = hover !== null && hover > (n - 1) / 2;

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
        {yTicks.map((v, i) => (
          <g key={i}>
            <line x1={PAD.l} y1={yAt(v)} x2={W - PAD.r} y2={yAt(v)} className="chart-grid" />
            <text x={PAD.l - 8} y={yAt(v) + 3} className="chart-ylabel">
              {format(v)}
            </text>
          </g>
        ))}

        {xLabelIdx.map((i) => (
          <text key={i} x={xAt(i)} y={H - 9} className="chart-xlabel">
            {formatX(allDates[i]!)}
          </text>
        ))}

        {series.map((s) => {
          const pts = s.points
            .filter((p) => p.value > 0)
            .map((p) => `${xAt(allDates.indexOf(p.date))},${yAt(p.value)}`)
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
              strokeDasharray={s.dashed ? "5 4" : undefined}
            />
          );
        })}

        {/* Trade entry/exit markers (only if within this chart's time span) */}
        {markers.map((m, mi) => {
          const first = new Date(
            allDates[0]!.length <= 10 ? `${allDates[0]}T00:00:00` : allDates[0]!,
          ).getTime();
          const last = new Date(
            allDates[n - 1]!.length <= 10
              ? `${allDates[n - 1]}T00:00:00`
              : allDates[n - 1]!,
          ).getTime();
          if (m.at < first || m.at > last) return null;
          let idx = 0;
          let best = Infinity;
          for (let i = 0; i < n; i++) {
            const key = allDates[i]!;
            const ms = new Date(key.length <= 10 ? `${key}T00:00:00` : key).getTime();
            const d = Math.abs(ms - m.at);
            if (d < best) {
              best = d;
              idx = i;
            }
          }
          const x = xAt(idx);
          return (
            <g key={`m-${mi}`}>
              <line
                x1={x}
                y1={PAD.t}
                x2={x}
                y2={PAD.t + plotH}
                stroke={m.color}
                strokeWidth={1.5}
                strokeDasharray="4 3"
              />
              <circle cx={x} cy={PAD.t + 5} r={4} fill={m.color} />
              <text
                x={x}
                y={PAD.t - 3}
                fill={m.color}
                fontSize="10"
                fontWeight="700"
                textAnchor="middle"
              >
                {m.label}
              </text>
            </g>
          );
        })}

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
              if (!p || p.value <= 0) return null;
              return (
                <circle key={s.label} cx={xAt(hover)} cy={yAt(p.value)} r={3.5} fill={s.color} />
              );
            })}
          </>
        )}
      </svg>

      {hover !== null && hoverDate && (
        <div
          className="chart-tip"
          style={
            tipOnLeft
              ? { left: 8, right: "auto" }
              : { right: 8, left: "auto" }
          }
        >
          <div className="chart-tip-date">{formatX(hoverDate)}</div>
          {series.map((s) => {
            const p = s.points.find((pt) => pt.date === hoverDate);
            return (
              <div key={s.label} className="chart-tip-row">
                <span className="chart-dot" style={{ background: s.color }} />
                <span className="chart-tip-label">{s.label}</span>
                <span className="chart-tip-val">{p ? format(p.value) : "—"}</span>
              </div>
            );
          })}
        </div>
      )}

      <div className="chart-legend">
        {series.map((s) => (
          <span key={s.label} className="chart-legend-item">
            <span
              className="chart-dot"
              style={{ background: s.color, opacity: s.dashed ? 0.6 : 1 }}
            />
            {s.label}
          </span>
        ))}
      </div>
    </div>
  );
}
