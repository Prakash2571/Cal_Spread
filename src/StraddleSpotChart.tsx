import { useLayoutEffect, useRef, useState } from "react";
import ChartReadout, { type ReadoutItem } from "./ChartReadout.tsx";
import { smoothPath } from "./chartPath.ts";
import { fmt } from "./format.ts";

export interface StraddleSpotPoint {
  t: number; // epoch ms
  straddle: number;
  spot: number;
}

interface Props {
  points: StraddleSpotPoint[];
  formatX: (t: number) => string;
  height?: number;
  expanded?: boolean;
}

const PAD = { l: 60, r: 66, t: 16, b: 30 };
const STEP = 7; // px per point (drives horizontal scroll width)

const STRADDLE_COLOR = "var(--series-1)";
const SPOT_COLOR = "var(--warn)";
/** Approximate width of a "06 Aug, 14:35" x-axis label at --fs-1 mono. */
const LABEL_PX = 110;

/**
 * Dot drawn as a zero-length round-capped stroke. `M x y l 0 0` is the
 * best-supported spelling of a zero-length subpath — same as LineChart's Dot.
 */
function Dot({
  x,
  y,
  color,
  size,
}: {
  x: number;
  y: number;
  color: string;
  size: number;
}) {
  return (
    <path
      d={`M ${x} ${y} l 0 0`}
      stroke={color}
      strokeWidth={size}
      strokeLinecap="round"
      vectorEffect="non-scaling-stroke"
    />
  );
}

/**
 * Dual-axis line chart: auto-ATM straddle (left axis) overlaid on the NIFTY
 * spot price (right axis), so their independent scales are both readable.
 * Horizontally scrollable; opens scrolled to the latest data.
 */
export default function StraddleSpotChart({
  points,
  formatX,
  height = 210,
  expanded = false,
}: Props) {
  const H = height;
  const scrollRef = useRef<HTMLDivElement>(null);
  const atEndRef = useRef(true);
  const [hover, setHover] = useState<number | null>(null);

  // Follow to the latest only when already pinned to the right edge.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && atEndRef.current) el.scrollLeft = el.scrollWidth;
  }, [points, expanded]);

  if (points.length < 2) {
    return (
      <div className="chart-empty">
        No straddle/spot history yet for this timeframe — it fills as the day
        progresses (or backfills from history).
      </div>
    );
  }

  const n = points.length;
  const plotH = H - PAD.t - PAD.b;
  const svgW = PAD.l + (n - 1) * STEP + PAD.r;

  const straddleVals = points.map((p) => p.straddle).filter((v) => v > 0);
  const spotVals = points.map((p) => p.spot).filter((v) => v > 0);
  // Headroom is added to the VALUE range rather than inset in pixels, so the
  // gridlines still span the full plot box and line up with the other cards.
  const range = (vals: number[]) => {
    const mn = Math.min(...vals);
    const mx = Math.max(...vals);
    const span = mx - mn || 1;
    const pad = span * 0.08; // keep lines off the very top/bottom edges
    return { mn: mn - pad, span: span + 2 * pad };
  };
  const s = range(straddleVals.length ? straddleVals : [0, 1]);
  const p = range(spotVals.length ? spotVals : [0, 1]);

  // Each series is scaled independently to the full plot height, so both lines
  // overlap the same area and their shapes/moves are directly comparable — the
  // two different y-axes make clear the price ranges differ.
  const xAt = (i: number) => PAD.l + i * STEP;
  const yFrac = (frac: number) => PAD.t + (1 - frac) * plotH;
  const yStraddle = (v: number) => yFrac((v - s.mn) / s.span);
  const ySpot = (v: number) => yFrac((v - p.mn) / p.span);

  /** Plotted points for one series (zero/missing samples are skipped). */
  const linePts = (
    accessor: (pt: StraddleSpotPoint) => number,
    yFn: (v: number) => number,
  ) =>
    points
      .map((pt, i) => ({ v: accessor(pt), i }))
      .filter((o) => o.v > 0)
      .map((o) => ({ x: xAt(o.i), y: yFn(o.v) }));

  const straddlePts = linePts((pt) => pt.straddle, yStraddle);
  const spotPts = linePts((pt) => pt.spot, ySpot);
  const straddleEnd = straddlePts[straddlePts.length - 1] ?? null;
  const spotEnd = spotPts[spotPts.length - 1] ?? null;

  const ticks = [0, 0.25, 0.5, 0.75, 1];
  // Clamped: the rolling window can shrink while a hover index is still held.
  const hoverIdx = hover === null ? null : Math.min(hover, n - 1);
  const hoverPt = hoverIdx === null ? null : points[hoverIdx]!;
  const hoverX = hoverIdx === null ? 0 : xAt(hoverIdx);

  // Label roughly every 110px, always including the first sample and — when it
  // clears the first by a label's width — the last, so short series never
  // overlap their two labels.
  const lastI = n - 1;
  const labelEvery = Math.max(1, Math.ceil(LABEL_PX / STEP));
  const labelIdx = new Set<number>([0]);
  if (lastI * STEP >= LABEL_PX) labelIdx.add(lastI);
  for (let i = labelEvery; i < lastI; i += labelEvery) {
    if (lastI - i >= labelEvery) labelIdx.add(i);
  }

  /** Last positive value of a series, so the readout agrees with the end dot. */
  const lastPositive = (accessor: (pt: StraddleSpotPoint) => number) => {
    for (let i = lastI; i >= 0; i--) {
      const v = accessor(points[i]!);
      if (v > 0) return v;
    }
    return null;
  };
  const firstPositive = (accessor: (pt: StraddleSpotPoint) => number) => {
    for (let i = 0; i <= lastI; i++) {
      const v = accessor(points[i]!);
      if (v > 0) return v;
    }
    return null;
  };

  // The readout reports the hovered sample, or each series' own latest value when
  // idle — which is what the end dots mark.
  const readValue = (accessor: (pt: StraddleSpotPoint) => number) => {
    if (hoverPt) {
      const v = accessor(hoverPt);
      return v > 0 ? fmt(v) : "—";
    }
    const v = lastPositive(accessor);
    return v === null ? "—" : fmt(v);
  };
  const readoutItems: ReadoutItem[] = [
    {
      label: "ATM Straddle",
      color: STRADDLE_COLOR,
      value: readValue((pt) => pt.straddle),
    },
    { label: "NIFTY Spot", color: SPOT_COLOR, value: readValue((pt) => pt.spot) },
  ];
  const startVal = (accessor: (pt: StraddleSpotPoint) => number) => {
    const v = firstPositive(accessor);
    return v === null ? "—" : fmt(v);
  };
  const start =
    n > 1
      ? {
          time: formatX(points[0]!.t),
          items: [
            {
              label: "ATM Straddle",
              color: STRADDLE_COLOR,
              value: startVal((pt) => pt.straddle),
            },
            {
              label: "NIFTY Spot",
              color: SPOT_COLOR,
              value: startVal((pt) => pt.spot),
            },
          ],
        }
      : null;

  return (
    <div className="an-hist">
      <ChartReadout
        time={formatX((hoverPt ?? points[lastI]!).t)}
        items={readoutItems}
        hovering={hoverIdx !== null}
        start={start}
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
              const idx = Math.round((e.clientX - rect.left - PAD.l) / STEP);
              setHover(idx >= 0 && idx < n ? idx : null);
            }}
            onMouseLeave={() => setHover(null)}
          >
            {ticks.map((tk, i) => {
              const y = yFrac(tk);
              return (
                <g key={i}>
                  <line x1={PAD.l} y1={y} x2={svgW - PAD.r} y2={y} className="chart-grid" />
                  <text x={PAD.l - 8} y={y + 3} className="chart-ylabel" style={{ fill: STRADDLE_COLOR }}>
                    {fmt(s.mn + tk * s.span)}
                  </text>
                  <text
                    x={svgW - PAD.r + 8}
                    y={y + 3}
                    className="chart-ylabel"
                    style={{ textAnchor: "start", fill: SPOT_COLOR }}
                  >
                    {Math.round(p.mn + tk * p.span)}
                  </text>
                </g>
              );
            })}

            {points.map(
              (pt, i) =>
                labelIdx.has(i) && (
                  <text key={pt.t} x={xAt(i)} y={H - 10} className="chart-xlabel">
                    {formatX(pt.t)}
                  </text>
                ),
            )}

            <path
              d={smoothPath(spotPts)}
              fill="none"
              stroke={SPOT_COLOR}
              className="chart-line"
              vectorEffect="non-scaling-stroke"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            <path
              d={smoothPath(straddlePts)}
              fill="none"
              stroke={STRADDLE_COLOR}
              className="chart-line"
              vectorEffect="non-scaling-stroke"
              strokeLinejoin="round"
              strokeLinecap="round"
            />

            {/* Latest value of each series, always marked so the end of the line
                is obvious without hovering. */}
            {spotEnd && (
              <Dot x={spotEnd.x} y={spotEnd.y} color={SPOT_COLOR} size={6} />
            )}
            {straddleEnd && (
              <Dot
                x={straddleEnd.x}
                y={straddleEnd.y}
                color={STRADDLE_COLOR}
                size={6}
              />
            )}

            {hoverIdx !== null && (
              <>
                <line
                  x1={hoverX}
                  y1={PAD.t}
                  x2={hoverX}
                  y2={PAD.t + plotH}
                  className="chart-guide"
                />
                {hoverPt && hoverPt.straddle > 0 && (
                  <Dot
                    x={hoverX}
                    y={yStraddle(hoverPt.straddle)}
                    color={STRADDLE_COLOR}
                    size={7}
                  />
                )}
                {hoverPt && hoverPt.spot > 0 && (
                  <Dot x={hoverX} y={ySpot(hoverPt.spot)} color={SPOT_COLOR} size={7} />
                )}
              </>
            )}
          </svg>
        </div>
      </div>
    </div>
  );
}
