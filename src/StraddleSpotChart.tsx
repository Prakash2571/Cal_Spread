import { useLayoutEffect, useRef, useState } from "react";
import { fmt } from "./format.ts";

export interface StraddleSpotPoint {
  t: number; // epoch ms
  straddle: number;
  spot: number;
}

interface Props {
  points: StraddleSpotPoint[];
  formatX: (t: number) => string;
}

const H = 300;
const PAD = { l: 60, r: 66, t: 16, b: 30 };
const STEP = 7; // px per point (drives horizontal scroll width)

const STRADDLE_COLOR = "var(--series-1)";
const SPOT_COLOR = "var(--warn)";

/**
 * Dual-axis line chart: auto-ATM straddle (left axis) overlaid on the NIFTY
 * spot price (right axis), so their independent scales are both readable.
 * Horizontally scrollable; opens scrolled to the latest data.
 */
export default function StraddleSpotChart({ points, formatX }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [points.length]);

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
  const range = (vals: number[]) => {
    const mn = Math.min(...vals);
    const mx = Math.max(...vals);
    return { mn, span: mx - mn || 1 };
  };
  const s = range(straddleVals.length ? straddleVals : [0, 1]);
  const p = range(spotVals.length ? spotVals : [0, 1]);

  // Each series is scaled independently to (nearly) the full plot height, so
  // both lines overlap the same area and their shapes/moves are directly
  // comparable — the two different y-axes make clear the price ranges differ.
  const PADY = plotH * 0.08; // keep lines off the very top/bottom edges
  const usableH = plotH - 2 * PADY;
  const xAt = (i: number) => PAD.l + i * STEP;
  const yFrac = (frac: number) => PAD.t + PADY + (1 - frac) * usableH;
  const yStraddle = (v: number) => yFrac((v - s.mn) / s.span);
  const ySpot = (v: number) => yFrac((v - p.mn) / p.span);

  const line = (accessor: (pt: StraddleSpotPoint) => number, yFn: (v: number) => number) =>
    points
      .map((pt, i) => ({ v: accessor(pt), i }))
      .filter((o) => o.v > 0)
      .map((o) => `${xAt(o.i)},${yFn(o.v)}`)
      .join(" ");

  const ticks = [0, 0.25, 0.5, 0.75, 1];
  const labelEvery = Math.max(1, Math.round(n / 12));
  const hoverPt = hover !== null ? points[hover] : null;
  const hoverX = hover !== null ? xAt(hover) : 0;

  return (
    <div className="an-hist">
      <div className="chart-legend an-hist-legend">
        <span className="chart-legend-item">
          <span className="chart-dot" style={{ background: STRADDLE_COLOR }} />
          ATM Straddle
        </span>
        <span className="chart-legend-item">
          <span className="chart-dot" style={{ background: SPOT_COLOR }} />
          NIFTY Spot
        </span>
      </div>
      <div className="an-scrollx" ref={scrollRef}>
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
                i % labelEvery === 0 && (
                  <text key={pt.t} x={xAt(i)} y={H - 10} className="chart-xlabel">
                    {formatX(pt.t)}
                  </text>
                ),
            )}

            <polyline
              points={line((pt) => pt.spot, ySpot)}
              fill="none"
              stroke={SPOT_COLOR}
              strokeWidth={1.5}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            <polyline
              points={line((pt) => pt.straddle, yStraddle)}
              fill="none"
              stroke={STRADDLE_COLOR}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />

            {hover !== null && (
              <>
                <line
                  x1={hoverX}
                  y1={PAD.t}
                  x2={hoverX}
                  y2={PAD.t + plotH}
                  className="chart-guide"
                />
                {hoverPt && hoverPt.straddle > 0 && (
                  <circle cx={hoverX} cy={yStraddle(hoverPt.straddle)} r={3.5} fill={STRADDLE_COLOR} />
                )}
                {hoverPt && hoverPt.spot > 0 && (
                  <circle cx={hoverX} cy={ySpot(hoverPt.spot)} r={3.5} fill={SPOT_COLOR} />
                )}
              </>
            )}
          </svg>

          {hoverPt && (
            <div
              className="chart-tip an-hist-tip"
              style={{ left: Math.max(0, hoverX - 70) }}
            >
              <div className="chart-tip-date">{formatX(hoverPt.t)}</div>
              <div className="chart-tip-row">
                <span className="chart-dot" style={{ background: STRADDLE_COLOR }} />
                <span className="chart-tip-label">Straddle</span>
                <span className="chart-tip-val">{fmt(hoverPt.straddle)}</span>
              </div>
              <div className="chart-tip-row">
                <span className="chart-dot" style={{ background: SPOT_COLOR }} />
                <span className="chart-tip-label">NIFTY</span>
                <span className="chart-tip-val">{fmt(hoverPt.spot)}</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
