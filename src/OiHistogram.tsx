import { useLayoutEffect, useRef, useState } from "react";
import { fmtCompact } from "./format.ts";

export interface HistPoint {
  t: number; // epoch ms (bucket end)
  ceChange: number; // change in total Call OI over the bucket
  peChange: number; // change in total Put OI over the bucket
}

interface Props {
  points: HistPoint[];
  /** Format a bucket timestamp for the x-axis + tooltip title. */
  formatX: (t: number) => string;
  height?: number;
}

const PAD = { l: 56, r: 14, t: 16, b: 30 };
const GROUP_W = 26; // px per time bucket (two bars + gap)
const BAR_W = 9;

/**
 * Diverging OI-change histogram: for each time bucket a Call bar (red) and a
 * Put bar (green), pointing UP when the OI change is positive and DOWN when
 * negative. Horizontally scrollable to reveal past buckets; opens scrolled to
 * the most recent bar. Hover shows the actual OI-change values.
 */
export default function OiHistogram({ points, formatX, height = 210 }: Props) {
  const H = height;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  // Open scrolled fully to the right (latest bars) and follow new data.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [points.length]);

  if (points.length === 0) {
    return (
      <div className="chart-empty">
        No OI-change history yet for this timeframe — it fills as the day
        progresses (or backfills from history).
      </div>
    );
  }

  const plotH = H - PAD.t - PAD.b;
  const half = plotH / 2;
  const y0 = PAD.t + half; // zero baseline (center)

  let maxAbs = 1;
  for (const p of points) {
    maxAbs = Math.max(maxAbs, Math.abs(p.ceChange), Math.abs(p.peChange));
  }

  const svgW = PAD.l + points.length * GROUP_W + PAD.r;
  const yFor = (v: number) => y0 - (v / maxAbs) * half;

  // Value axis ticks (symmetric around zero).
  const ticks = [-maxAbs, -maxAbs / 2, 0, maxAbs / 2, maxAbs];

  // x labels: roughly every ~6 groups so they don't overlap.
  const labelEvery = Math.max(1, Math.round(points.length / 12));

  function bar(x: number, v: number, color: string, key: string) {
    const yv = yFor(v);
    const y = v >= 0 ? yv : y0;
    const h = Math.max(1, Math.abs(yv - y0));
    return <rect key={key} x={x} y={y} width={BAR_W} height={h} fill={color} rx={1} />;
  }

  const hoverPt = hover !== null ? points[hover] : null;
  const hoverX = hover !== null ? PAD.l + hover * GROUP_W + GROUP_W / 2 : 0;

  return (
    <div className="an-hist">
      <div className="chart-legend an-hist-legend">
        <span className="chart-legend-item">
          <span className="chart-dot" style={{ background: "var(--neg)" }} />
          Call OI change
        </span>
        <span className="chart-legend-item">
          <span className="chart-dot" style={{ background: "var(--pos)" }} />
          Put OI change
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
                  {v > 0 ? "+" : ""}
                  {fmtCompact(Math.abs(v)) === "—" ? "0" : (v < 0 ? "-" : "") + fmtCompact(Math.abs(v))}
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

            {points.map((p, i) => {
              const gx = PAD.l + i * GROUP_W;
              return (
                <g key={p.t}>
                  {bar(gx + 2, p.ceChange, "var(--neg)", `ce-${i}`)}
                  {bar(gx + 2 + BAR_W + 2, p.peChange, "var(--pos)", `pe-${i}`)}
                  {i % labelEvery === 0 && (
                    <text x={gx + GROUP_W / 2} y={H - 10} className="chart-xlabel">
                      {formatX(p.t)}
                    </text>
                  )}
                </g>
              );
            })}

            {hover !== null && (
              <line
                x1={hoverX}
                y1={PAD.t}
                x2={hoverX}
                y2={PAD.t + plotH}
                className="chart-guide"
              />
            )}
          </svg>

          {hoverPt && (
            <div
              className="chart-tip an-hist-tip"
              style={{ left: Math.max(0, hoverX - 70) }}
            >
              <div className="chart-tip-date">{formatX(hoverPt.t)}</div>
              <div className="chart-tip-row">
                <span className="chart-dot" style={{ background: "var(--neg)" }} />
                <span className="chart-tip-label">Call ΔOI</span>
                <span className="chart-tip-val">
                  {hoverPt.ceChange > 0 ? "+" : hoverPt.ceChange < 0 ? "-" : ""}
                  {fmtCompact(Math.abs(hoverPt.ceChange))}
                </span>
              </div>
              <div className="chart-tip-row">
                <span className="chart-dot" style={{ background: "var(--pos)" }} />
                <span className="chart-tip-label">Put ΔOI</span>
                <span className="chart-tip-val">
                  {hoverPt.peChange > 0 ? "+" : hoverPt.peChange < 0 ? "-" : ""}
                  {fmtCompact(Math.abs(hoverPt.peChange))}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}


