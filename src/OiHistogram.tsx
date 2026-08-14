import { useLayoutEffect, useRef, useState } from "react";
import ChartReadout, { type ReadoutItem } from "./ChartReadout.tsx";
import { fmtCompact } from "./format.ts";

/** One bar series in the histogram (index-aligned with each point's `values`). */
export interface HistSeries {
  label: string;
  color: string;
}

export interface HistPoint {
  t: number; // epoch ms (bucket end)
  values: number[]; // one signed change per series, in `series` order
}

interface Props {
  points: HistPoint[];
  series: HistSeries[];
  /** Format a bucket timestamp for the x-axis + the readout. */
  formatX: (t: number) => string;
  height?: number;
  expanded?: boolean;
}

const PAD = { l: 56, r: 14, t: 16, b: 30 };
const BAR_W = 12;
const BAR_GAP = 4; // between bars of the same time bucket
const GROUP_GAP = 30; // blank space between adjacent time buckets
/** Approximate width of a "06 Aug, 14:35" x-axis label at --fs-1 mono. */
const LABEL_PX = 110;

/** Signed compact OI change, e.g. "+4.00L" / "-7.45L" / "0". */
function fmtDelta(v: number): string {
  const mag = fmtCompact(Math.abs(v));
  if (mag === "—" || v === 0) return "0";
  return `${v > 0 ? "+" : "-"}${mag}`;
}

/**
 * Diverging change histogram: for each time bucket one bar per series, pointing
 * UP when the change is positive and DOWN when negative. Horizontally scrollable
 * to reveal past buckets; opens scrolled to the most recent bar, whose values are
 * always shown in the readout above.
 *
 * Bar width and the gap between buckets are fixed, so a one-series histogram
 * reads at exactly the same density as a two-series one — only the bucket width
 * changes to absorb the missing bar.
 */
export default function OiHistogram({
  points,
  series,
  formatX,
  height = 210,
  expanded = false,
}: Props) {
  const H = height;
  const scrollRef = useRef<HTMLDivElement>(null);
  const atEndRef = useRef(true); // whether the user is pinned to the latest bar
  const [hover, setHover] = useState<number | null>(null);

  // Follow new data to the right ONLY when already at the latest bar; if the
  // user has scrolled into the past, leave their position untouched.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && atEndRef.current) el.scrollLeft = el.scrollWidth;
  }, [points, expanded]);

  if (points.length === 0 || series.length === 0) {
    return (
      <div className="chart-empty">
        No history yet for this timeframe — it fills as the day progresses (or
        backfills from history).
      </div>
    );
  }

  // Bucket geometry: the bars sit centred in the bucket with half the inter-time
  // gap on either side, so the visible gap between buckets is always GROUP_GAP.
  const barsW = series.length * BAR_W + (series.length - 1) * BAR_GAP;
  const GROUP_W = barsW + GROUP_GAP;
  const GROUP_PAD = GROUP_GAP / 2;

  const plotH = H - PAD.t - PAD.b;
  const half = plotH / 2;
  const y0 = PAD.t + half; // zero baseline (center)

  // Skip non-finite values rather than folding them in: Math.max(1, NaN) is NaN,
  // so a single bad bar used to poison maxAbs and with it every bar height, every
  // gridline and every tick label — blanking the entire chart.
  let maxAbs = 1;
  for (const p of points) {
    for (const v of p.values) {
      if (Number.isFinite(v)) maxAbs = Math.max(maxAbs, Math.abs(v));
    }
  }

  const lastI = points.length - 1;
  const svgW = PAD.l + points.length * GROUP_W + PAD.r;
  // Sub-linear (power) height scale: lifts the many small changes into
  // visibility while the largest bar still reaches the axis extreme. Both the
  // bars and the gridlines below run through this same transform, so every
  // labelled tick still sits on its own line — only the spacing is non-linear
  // (compressed toward the extremes), like a gentle log axis. Exact values are
  // always available in the readout, so the emphasis doesn't mislead.
  const BAR_SCALE_EXP = 0.6;
  const yFor = (v: number) => {
    if (!Number.isFinite(v)) return y0; // maxAbs starts at 1, so it's never 0
    const scaled = Math.pow(Math.abs(v) / maxAbs, BAR_SCALE_EXP);
    return y0 - Math.sign(v) * scaled * half;
  };
  const groupX = (i: number) => PAD.l + i * GROUP_W;
  const centreX = (i: number) => groupX(i) + GROUP_W / 2;

  // Value axis ticks (symmetric around zero).
  const ticks = [-maxAbs, -maxAbs / 2, 0, maxAbs / 2, maxAbs];

  // Label roughly every 110px, always including the first bucket and — when it
  // clears the first by a label's width — the last, so the covered span is
  // readable without hovering and short series never overlap their two labels.
  const labelEvery = Math.max(1, Math.ceil(LABEL_PX / GROUP_W));
  const labelIdx = new Set<number>([0]);
  if (lastI * GROUP_W >= LABEL_PX) labelIdx.add(lastI);
  for (let i = labelEvery; i < lastI; i += labelEvery) {
    if (lastI - i >= labelEvery) labelIdx.add(i);
  }

  function bar(x: number, v: number, color: string, key: string) {
    const yv = yFor(v);
    const y = v >= 0 ? yv : y0;
    const h = Math.max(1, Math.abs(yv - y0));
    return <rect key={key} x={x} y={y} width={BAR_W} height={h} fill={color} rx={2} />;
  }

  /** Band covering one bucket's bars — used for the hover highlight only. */
  const band = (i: number, className: string) => (
    <rect
      x={groupX(i) + GROUP_PAD - 5}
      y={PAD.t}
      width={barsW + 10}
      height={plotH}
      rx={3}
      className={className}
      pointerEvents="none"
    />
  );

  const itemsFor = (p: HistPoint): ReadoutItem[] =>
    series.map((s, si) => ({
      label: s.label,
      color: s.color,
      value: fmtDelta(p.values[si] ?? 0),
    }));

  // The readout reports the hovered bucket, or the latest one when idle. Clamped
  // because the rolling window can shrink while a hover index is still held.
  const activeIdx = Math.min(hover ?? lastI, lastI);
  const active = points[activeIdx]!;

  return (
    <div className="an-hist">
      {/* No "From <first bucket>" row here: the bars already show the whole
          window at a glance, so the strip stays a single line reporting the
          CURRENT bucket when idle (and the hovered one while tracking). */}
      <ChartReadout
        time={formatX(active.t)}
        items={itemsFor(active)}
        hovering={hover !== null}
      />
      <div
        className="an-scrollx"
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          atEndRef.current = el.scrollWidth - el.clientWidth - el.scrollLeft < 24;
        }}
      >
        <div className="an-hist-inner" style={{ width: `${svgW}px` }}>
          <svg
            className="oi-hist-svg"
            width={svgW}
            height={H}
            onMouseMove={(e) => {
              const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
              const x = e.clientX - rect.left;
              const idx = Math.floor((x - PAD.l) / GROUP_W);
              setHover(idx >= 0 && idx < points.length ? idx : null);
            }}
            onMouseLeave={() => setHover(null)}
          >
            {ticks.map((v, i) => (
              <g key={i}>
                <line
                  x1={PAD.l}
                  y1={yFor(v)}
                  x2={svgW - PAD.r}
                  y2={yFor(v)}
                  className="chart-grid"
                />
                <text x={PAD.l - 8} y={yFor(v) + 3} className="chart-ylabel">
                  {fmtDelta(v)}
                </text>
              </g>
            ))}
            {/* zero baseline */}
            <line
              x1={PAD.l}
              y1={y0}
              x2={svgW - PAD.r}
              y2={y0}
              stroke="var(--chart-zero)"
              strokeWidth={1}
            />

            {/* Only the HOVERED bucket gets a band. The newest bucket used to
                carry a permanent translucent tint to mark it as "current", but a
                see-through slab sitting over the bars just muddied them — and the
                readout above already names the current bucket and its values
                whenever the cursor is away. */}
            {hover !== null && band(activeIdx, "an-hist-hover-band")}

            {points.map((p, i) => {
              const gx = groupX(i) + GROUP_PAD;
              return (
                <g key={p.t}>
                  {series.map((s, si) =>
                    bar(
                      gx + si * (BAR_W + BAR_GAP),
                      p.values[si] ?? 0,
                      s.color,
                      `${si}-${i}`,
                    ),
                  )}
                  {labelIdx.has(i) && (
                    <text x={centreX(i)} y={H - 10} className="chart-xlabel">
                      {formatX(p.t)}
                    </text>
                  )}
                </g>
              );
            })}

            {hover !== null && (
              <line
                x1={centreX(activeIdx)}
                y1={PAD.t}
                x2={centreX(activeIdx)}
                y2={PAD.t + plotH}
                className="chart-guide"
              />
            )}
          </svg>
        </div>
      </div>
    </div>
  );
}
