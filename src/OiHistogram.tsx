import { useLayoutEffect, useRef, useState } from "react";
import ChartReadout, { type ReadoutItem } from "./ChartReadout.tsx";
import { fmtCompact } from "./format.ts";

export interface HistPoint {
  t: number; // epoch ms (bucket end)
  ceChange: number; // change in total Call OI over the bucket
  peChange: number; // change in total Put OI over the bucket
}

interface Props {
  points: HistPoint[];
  /** Format a bucket timestamp for the x-axis + the readout. */
  formatX: (t: number) => string;
  height?: number;
  expanded?: boolean;
}

const PAD = { l: 56, r: 14, t: 16, b: 30 };
const GROUP_W = 58; // 28px Call/Put pair plus a 30px inter-time gap
const BAR_W = 12;
const BAR_GAP = 4;
const PAIR_W = BAR_W * 2 + BAR_GAP;
const GROUP_PAD = (GROUP_W - PAIR_W) / 2;

const CE_COLOR = "var(--neg)";
const PE_COLOR = "var(--pos)";
/** Approximate width of a "06 Aug, 14:35" x-axis label at --fs-1 mono. */
const LABEL_PX = 110;

/** Signed compact OI change, e.g. "+4.00L" / "-7.45L" / "0". */
function fmtDelta(v: number): string {
  const mag = fmtCompact(Math.abs(v));
  if (mag === "—" || v === 0) return "0";
  return `${v > 0 ? "+" : "-"}${mag}`;
}

/**
 * Diverging OI-change histogram: for each time bucket a Call bar (red) and a
 * Put bar (green), pointing UP when the OI change is positive and DOWN when
 * negative. Horizontally scrollable to reveal past buckets; opens scrolled to
 * the most recent bar, whose values are always shown in the readout above.
 */
export default function OiHistogram({
  points,
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

  const lastI = points.length - 1;
  const svgW = PAD.l + points.length * GROUP_W + PAD.r;
  const yFor = (v: number) => y0 - (v / maxAbs) * half;
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

  /** Band covering one bucket's Call/Put pair (hover highlight + latest marker). */
  const band = (i: number, className: string) => (
    <rect
      x={groupX(i) + GROUP_PAD - 5}
      y={PAD.t}
      width={PAIR_W + 10}
      height={plotH}
      rx={3}
      className={className}
      pointerEvents="none"
    />
  );

  // The readout reports the hovered bucket, or the latest one when idle. Clamped
  // because the rolling window can shrink while a hover index is still held.
  const activeIdx = Math.min(hover ?? lastI, lastI);
  const active = points[activeIdx]!;
  const readoutItems: ReadoutItem[] = [
    { label: "Call ΔOI", color: CE_COLOR, value: fmtDelta(active.ceChange) },
    { label: "Put ΔOI", color: PE_COLOR, value: fmtDelta(active.peChange) },
  ];
  const first = points[0]!;
  const start =
    points.length > 1
      ? {
          time: formatX(first.t),
          items: [
            { label: "Call ΔOI", color: CE_COLOR, value: fmtDelta(first.ceChange) },
            { label: "Put ΔOI", color: PE_COLOR, value: fmtDelta(first.peChange) },
          ],
        }
      : null;

  return (
    <div className="an-hist">
      <ChartReadout
        time={formatX(active.t)}
        items={readoutItems}
        hovering={hover !== null}
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

            {/* The newest bucket stays marked at all times — matching the
                always-visible end dots on the line charts — with the hover band
                drawn over it while tracking. */}
            {band(lastI, "an-hist-latest-band")}
            {hover !== null && band(activeIdx, "an-hist-hover-band")}

            {points.map((p, i) => {
              const gx = groupX(i);
              return (
                <g key={p.t}>
                  {bar(gx + GROUP_PAD, p.ceChange, CE_COLOR, `ce-${i}`)}
                  {bar(
                    gx + GROUP_PAD + BAR_W + BAR_GAP,
                    p.peChange,
                    PE_COLOR,
                    `pe-${i}`,
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
