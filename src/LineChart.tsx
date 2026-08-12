import { useCallback, useLayoutEffect, useRef, useState } from "react";
import ChartReadout, { type ReadoutItem } from "./ChartReadout.tsx";
import { smoothPath } from "./chartPath.ts";

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
  /** Formats a value for the y-axis and readout (e.g. price or compact OI). */
  format: (v: number) => string;
  /** Formats an x-axis key (a date or timestamp) for labels + the readout. */
  formatX?: (key: string) => string;
  /** Vertical markers (e.g. trade entry/exit) — only drawn if within range. */
  markers?: ChartMarker[];
  /** Allow negative/zero values (e.g. a spread) and draw a zero baseline. */
  signed?: boolean;
  /**
   * Rendered height in px. Together with `canvasWidth` this switches the chart
   * to a 1:1 pixel canvas (see below). Omit for the original aspect-ratio
   * behaviour used by the StockDetail charts.
   */
  height?: number;
  /**
   * Intrinsic canvas width in px. Supplying it puts the chart in "fixed canvas"
   * mode: the svg is drawn at exactly this size with NO viewBox scaling, and the
   * component owns its own horizontal scroller (with the readout outside it, so
   * the readout can never scroll off-screen). This is what makes text, strokes
   * and gridlines match the other analytics charts pixel for pixel — stretching
   * a 760-unit viewBox across a 2600px canvas smeared them by >3x.
   */
  canvasWidth?: number;
  /**
   * Size the canvas to its CONTAINER rather than to the data, and drop the
   * scroller.
   *
   * `canvasWidth` mode sizes the canvas per point (e.g. 7px each), which means a
   * full session of 1-minute buckets is several times wider than the card. Since
   * the scroller opens pinned to the newest data, the chart then silently showed
   * only its last ~60 points — reading as "the chart starts at 12:22" when the
   * series actually began at 09:15. Fitting shows the WHOLE range at a glance and
   * still renders 1:1 (no viewBox), so strokes and text stay crisp; expanding the
   * card is what buys back horizontal detail.
   */
  fit?: boolean;
  /** Re-pin the scroller to the latest data when the card is expanded. */
  expanded?: boolean;
  /**
   * Append a "next − current" spread value to the readout, computed from the
   * first two series at the reported point. Lets the price chart show the
   * calendar spread under the cursor without a second plot.
   */
  showSpreadReadout?: boolean;
}

const DEFAULT_W = 760;
/** Below this a fitted plot has no usable room between the axis gutters. */
const MIN_FIT_W = 280;
const DEFAULT_H = 280;
const PAD = { l: 58, r: 18, t: 16, b: 28 };
/** Approximate width of a "06 Aug, 14:35" x-axis label at --fs-1 mono. */
const LABEL_PX = 110;

/**
 * Dot drawn as a zero-length round-capped stroke.
 *
 * `M x y l 0 0` is the best-supported spelling of a zero-length subpath, and a
 * non-scaling stroke keeps the dot circular even in the aspect-ratio mode where
 * the canvas is stretched.
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
  signed = false,
  height,
  canvasWidth,
  fit = false,
  expanded = false,
  showSpreadReadout = false,
}: Props) {
  // `Number.isFinite` in BOTH modes. `v > 0` alone rejects NaN but happily accepts
  // Infinity, which then becomes vMax, makes vRange Infinity and turns every other
  // y coordinate into NaN — so one bad value silently erased the whole plot rather
  // than just its own point.
  const valid = (v: number) => Number.isFinite(v) && (signed || v > 0);
  const svgRef = useRef<SVGSVGElement>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const roRef = useRef<ResizeObserver | null>(null);
  const atEndRef = useRef(true);
  const [hover, setHover] = useState<number | null>(null);
  const [fitW, setFitW] = useState(0);

  // Measure the SCROLLER in `fit` mode — not the wrapper. Its clientWidth already
  // excludes the scrollbar gutter, so a canvas of exactly that width never
  // overflows, while the gutter itself stays reserved. That keeps a fitted line
  // card the same height as a histogram card, which matters because they share
  // grid rows: a 15px difference makes the shorter one stretch and leaves dead
  // space under its plot.
  //
  // A CALLBACK REF rather than an effect, because the scroller isn't always
  // mounted: this component returns an empty state before any data arrives, and an
  // effect keyed on props would not re-run when the real node finally appears —
  // leaving the canvas at its 760px fallback inside a ~570px card, i.e. exactly the
  // pinned-scroller bug `fit` exists to remove. A ref callback fires on mount.
  const attachScroller = useCallback(
    (el: HTMLDivElement | null) => {
      scrollRef.current = el;
      roRef.current?.disconnect();
      roRef.current = null;
      if (!el || !fit) return;
      // A zero width means "not measurable yet" (a hidden container), not "zero
      // wide" — storing it would pin the canvas to its fallback width. The observer
      // fires with a real width as soon as the element is laid out.
      const measure = () => {
        if (el.clientWidth > 0) setFitW(el.clientWidth);
      };
      measure();
      if (typeof ResizeObserver === "undefined") return;
      const ro = new ResizeObserver(measure);
      ro.observe(el);
      roRef.current = ro;
    },
    [fit],
  );

  const H = height ?? DEFAULT_H;
  const W = fit
    ? Math.max(MIN_FIT_W, fitW || DEFAULT_W)
    : (canvasWidth ?? DEFAULT_W);
  // 1:1 pixel rendering (no viewBox) for both explicit widths and fitted ones.
  const fixedCanvas = fit || canvasWidth !== undefined;
  const plotH = H - PAD.t - PAD.b;
  const plotW = W - PAD.l - PAD.r;

  // A per-point canvas scrolls horizontally; follow new data to the right only
  // when the user is already pinned there (matching the other charts). A fitted
  // canvas never overflows, so there is nothing to follow.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && atEndRef.current) el.scrollLeft = el.scrollWidth;
  }, [series, expanded]);

  const allDates = Array.from(
    new Set(series.flatMap((s) => s.points.map((p) => p.date))),
  ).sort();
  const n = allDates.length;
  // date → x-index, so building the paths below stays linear. With several
  // hundred points across 3 series, a per-point indexOf scan was re-running on
  // every mousemove (each hover triggers a re-render).
  const dateIdx = new Map(allDates.map((d, i) => [d, i]));

  const allVals = series
    .flatMap((s) => s.points.map((p) => p.value))
    .filter(valid);

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

  // Label on a ~110px pixel budget, always including the first point and — when
  // it clears the first by a label's width — the last. Same rule as the
  // histogram and straddle charts, so a card scrolled into the middle of a wide
  // canvas still shows timestamps instead of going blank.
  const stepPx = n <= 1 ? plotW : plotW / (n - 1);
  const labelEvery = Math.max(1, Math.ceil(LABEL_PX / Math.max(stepPx, 1)));
  const xLabelIdx = new Set<number>([0]);
  if (n > 1 && (n - 1) * stepPx >= LABEL_PX) xLabelIdx.add(n - 1);
  for (let i = labelEvery; i < n - 1; i += labelEvery) {
    if (n - 1 - i >= labelEvery) xLabelIdx.add(i);
  }

  // Per-series date → value, the plotted points (sorted by x, which smoothPath
  // requires), and each series' own first/last valid sample.
  const plotted = series.map((s) => {
    const byDate = new Map<string, number>();
    const pts: { x: number; y: number; v: number }[] = [];
    for (const p of s.points) {
      byDate.set(p.date, p.value);
      if (valid(p.value)) {
        pts.push({ x: xAt(dateIdx.get(p.date) ?? 0), y: yAt(p.value), v: p.value });
      }
    }
    // smoothPath requires ascending x; the first/last readout values are read
    // off the SORTED array so they always name the same samples as the markers.
    pts.sort((a, b) => a.x - b.x);
    const firstPt = pts[0] ?? null;
    const endPt = pts[pts.length - 1] ?? null;
    return {
      s,
      byDate,
      pts,
      firstVal: firstPt ? firstPt.v : null,
      lastVal: endPt ? endPt.v : null,
      end: endPt,
    };
  });

  function handleMove(e: React.MouseEvent<SVGSVGElement>) {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const xInView = ((e.clientX - rect.left) / rect.width) * W;
    // Ignore the axis gutters so the empty margins don't fake a hover on the
    // first/last point (the other charts null out there too).
    if (xInView < PAD.l - 4 || xInView > W - PAD.r + 4) {
      setHover(null);
      return;
    }
    const idx = Math.round(((xInView - PAD.l) / plotW) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, idx)));
  }

  // The readout reports the hovered point, or each series' own latest value when
  // idle — so it always agrees with the end-of-line markers, even for a series
  // that has no sample at the newest shared timestamp.
  // Clamped: the rolling window can shrink while a hover index is still held.
  const hoverIdx = hover === null ? null : Math.min(hover, n - 1);
  const hoverDate = hoverIdx === null ? null : allDates[hoverIdx]!;
  const readoutItems: ReadoutItem[] = plotted.map(({ s, byDate, lastVal }) => {
    let v: number | null | undefined;
    if (hoverDate !== null) {
      const hv = byDate.get(hoverDate);
      v = hv !== undefined && valid(hv) ? hv : null;
    } else {
      v = lastVal;
    }
    return {
      label: s.label,
      color: s.color,
      dashed: s.dashed,
      value: v === null || v === undefined ? "—" : format(v),
    };
  });

  // Calendar-spread readout: next month − current month at the reported point.
  // Hovering targets that x; idle falls back to the newest date both legs share,
  // so the strip always names a real spread instead of "—" at the very edge.
  if (showSpreadReadout && plotted.length >= 2) {
    const cur = plotted[0]!;
    const nxt = plotted[1]!;
    let dateKey = hoverDate;
    if (dateKey === null) {
      for (let i = n - 1; i >= 0; i--) {
        const d = allDates[i]!;
        const cv = cur.byDate.get(d);
        const nv = nxt.byDate.get(d);
        if (cv !== undefined && nv !== undefined && valid(cv) && valid(nv)) {
          dateKey = d;
          break;
        }
      }
    }
    const cv = dateKey === null ? undefined : cur.byDate.get(dateKey);
    const nv = dateKey === null ? undefined : nxt.byDate.get(dateKey);
    const spreadVal =
      cv !== undefined && nv !== undefined && valid(cv) && valid(nv) ? nv - cv : null;
    readoutItems.push({
      label: "Spread (next − current)",
      color: "var(--series-1)",
      value:
        spreadVal === null
          ? "—"
          : `${spreadVal >= 0 ? "+" : ""}${format(spreadVal)}`,
    });
  }

  const start =
    n > 1
      ? {
          time: formatX(allDates[0]!),
          items: plotted.map(({ s, firstVal }) => ({
            label: s.label,
            color: s.color,
            dashed: s.dashed,
            value: firstVal === null ? "—" : format(firstVal),
          })),
        }
      : null;

  const svg = (
    <svg
      ref={svgRef}
      className="oi-chart"
      {...(fixedCanvas
        ? {
            width: W,
            height: H,
            // Inline, not just attributes: `.oi-chart` sets `width: 100%;
            // height: auto` for the responsive mode, and author CSS beats svg
            // geometry attributes — which without a viewBox would CLIP the
            // canvas to the column width instead of scaling it.
            style: { width: `${W}px`, height: `${H}px` },
          }
        : {
            viewBox: `0 0 ${W} ${H}`,
            preserveAspectRatio: "none" as const,
            style: height ? { height: `${height}px` } : undefined,
          })}
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

        {signed && vMin < 0 && vMax > 0 && (
          <line
            x1={PAD.l}
            y1={yAt(0)}
            x2={W - PAD.r}
            y2={yAt(0)}
            stroke="var(--chart-zero)"
            strokeWidth={1}
          />
        )}

        {Array.from(xLabelIdx).map((i) => (
          <text key={i} x={xAt(i)} y={H - 10} className="chart-xlabel">
            {formatX(allDates[i]!)}
          </text>
        ))}

        {plotted.map(({ s, pts }) => (
          <path
            key={s.label}
            d={smoothPath(pts)}
            fill="none"
            stroke={s.color}
            className="chart-line"
            vectorEffect="non-scaling-stroke"
            strokeLinejoin="round"
            strokeLinecap="round"
            strokeDasharray={s.dashed ? "5 4" : undefined}
          />
        ))}

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
              <Dot x={x} y={PAD.t + 5} color={m.color} size={8} />
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

        {/* Latest value of each series, always marked so the end of the line is
            obvious without hovering. */}
        {plotted.map(({ s, end }) =>
          end ? (
            <g key={`end-${s.label}`}>
              <Dot x={end.x} y={end.y} color={s.color} size={6} />
            </g>
          ) : null,
        )}

        {hoverIdx !== null && hoverDate !== null && (
          <>
            <line
              x1={xAt(hoverIdx)}
              y1={PAD.t}
              x2={xAt(hoverIdx)}
              y2={PAD.t + plotH}
              className="chart-guide"
            />
            {plotted.map(({ s, byDate }) => {
              const v = byDate.get(hoverDate);
              if (v === undefined || !valid(v)) return null;
              return (
                <g key={s.label}>
                  <Dot x={xAt(hoverIdx)} y={yAt(v)} color={s.color} size={7} />
                </g>
              );
            })}
          </>
        )}
    </svg>
  );

  return (
    <div className="chart-wrap">
      {/* Readout sits OUTSIDE the scroller: inside it, the strip would sit at the
          left end of a canvas that opens scrolled to the newest data, i.e. far
          off-screen. */}
      <ChartReadout
        time={formatX(hoverDate ?? allDates[n - 1]!)}
        items={readoutItems}
        hovering={hoverIdx !== null}
        start={start}
      />
      {fixedCanvas ? (
        <div
          className="an-scrollx"
          ref={attachScroller}
          onScroll={(e) => {
            const el = e.currentTarget;
            atEndRef.current = el.scrollWidth - el.clientWidth - el.scrollLeft < 24;
          }}
        >
          {svg}
        </div>
      ) : (
        svg
      )}
    </div>
  );
}
