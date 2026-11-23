import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { SpikeSample } from "./spikeApi.ts";
import type { StraddlePoint } from "./straddleApi.ts";

type Point = { t: number; strike: number; expiry: string; premium: number | null; vwap: number | null };

interface Props {
  symbol: string;
  name?: string;
  minuteBars?: boolean;
  spotATM?: boolean;
  emptyMessage?: string;
  footer?: ReactNode;
  series: StraddlePoint[];
  current: SpikeSample | null;
  snapshotAt?: number;
  now?: number;
  liveStale?: boolean;
  expiry: string;
  expanded: boolean;
  onToggleExpanded: () => void;
}

const numberFormat = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = (value: number) => numberFormat.format(value);
const timeFormat = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" });
const sampleTime = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const staleMs = 90_000;

// Ported from Live Index Algo F: the plot owns its size, including when expanded.
function usePlotSize(enabled: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 900, height: 280 });

  useLayoutEffect(() => {
    const element = ref.current;
    if (!enabled || !element) return;
    const measure = () => {
      const width = Math.max(220, Math.round(element.clientWidth));
      const height = Math.max(180, Math.round(element.clientHeight));
      setSize((old) => old.width === width && old.height === height ? old : { width, height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [enabled]);

  return { ref, ...size };
}

function ChartExpandButton({ expanded, onClick }: { expanded: boolean; onClick: () => void }) {
  return <button type="button" className="spike-straddle-expand-button" onClick={onClick}
    aria-expanded={expanded} aria-label={expanded ? "Close straddle chart full screen" : "Show straddle chart full screen"}
    title={expanded ? "Close full screen" : "Full screen"}>
    {expanded
      ? <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3v5H3m13-5v5h5M3 16h5v5m13-5h-5v5" /></svg>
      : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5" /></svg>}
  </button>;
}

export default function SpikeStraddleChart({
  symbol, name, series, current, expiry, expanded, onToggleExpanded, minuteBars = false,
  spotATM = false, snapshotAt, now = Date.now(), liveStale = false, emptyMessage, footer,
}: Props) {
  const [hover, setHover] = useState<number | null>(null);
  const clipId = useId();
  const points = useMemo(() => {
    const byTime = new Map<number, Point>();
    for (const point of series) {
      const { t, strike, expiry, premium, vwap, gap } = point;
      if (Number.isFinite(t) && (gap || premium > 0)) {
        byTime.set(t, { t, strike, expiry, premium: gap ? null : premium, vwap: !gap && vwap > 0 ? vwap : null });
      }
    }
    return [...byTime.values()].sort((a, b) => a.t - b.t);
  }, [series]);
  const pricedPoints = useMemo(() => points.filter((point) => point.premium !== null), [points]);
  const latestPriced = pricedPoints[pricedPoints.length - 1];
  const showPlot = pricedPoints.length >= (minuteBars ? 1 : 2);
  const plot = usePlotSize(showPlot);

  useEffect(() => setHover(null), [symbol, expiry]);

  const last = points[points.length - 1];
  const selected = hover === null ? last : points[Math.min(hover, points.length - 1)];
  const selectedPremium = selected?.premium != null ? num(selected.premium) : selected ? "No data" : "–";
  const livePremium = current?.premium ?? null;
  const displayedStrike = selected?.strike || current?.strike;
  const displayedExpiry = spotATM ? selected?.expiry || current?.expiry || expiry : expiry;
  const premiumLabel = spotATM ? "ATM premium" : "min premium";
  const { width, height } = plot;
  const { pad, x, y, premiumLine, vwapLine, ticks, startsSegment, vwapOutsideScale } = useMemo(() => {
    const pad = { l: 60, r: 20, t: 18, b: 18 };
    const values = points.flatMap((p) => {
      if (p.premium === null) return [];
      return spotATM || p.vwap === null ? [p.premium] : [p.premium, p.vwap];
    });
    const low = values.length ? Math.floor(Math.min(...values) * .97) : 0;
    const high = values.length ? Math.ceil(Math.max(...values) * 1.03) : 1;
    const span = Math.max(1, high - low);
    const firstTime = points[0]?.t ?? 0;
    const duration = (points[points.length - 1]?.t ?? firstTime) - firstTime;
    const x = (i: number) => {
      const ratio = minuteBars && duration > 0 ? (points[i].t - firstTime) / duration : i / Math.max(1, points.length - 1);
      return pad.l + ratio * (width - pad.l - pad.r);
    };
    const y = (value: number) => height - pad.b - (value - low) / span * (height - pad.t - pad.b);
    const startsSegment = (i: number) => {
      if (i === 0) return true;
      const previous = points[i - 1];
      const point = points[i];
      return previous.premium === null || point.premium === null ||
        (minuteBars && point.t - previous.t > 60_000) ||
        (spotATM && (point.strike !== previous.strike || point.expiry !== previous.expiry));
    };
    const premiumLine = points.map((p, i) => p.premium === null ? "" :
      `${startsSegment(i) ? "M" : "L"}${x(i).toFixed(1)} ${y(p.premium).toFixed(1)}`).join(" ");
    let hasVWAP = false;
    const vwapLine = points.map((p, i) => {
      if (p.vwap === null) { hasVWAP = false; return ""; }
      const command = `${hasVWAP && !startsSegment(i) ? "L" : "M"}${x(i).toFixed(1)} ${y(p.vwap).toFixed(1)}`;
      hasVWAP = true;
      return command;
    }).join(" ");
    const ticks = [0, 1, 2, 3, 4].map((i) => low + span * i / 4);
    const vwapOutsideScale = spotATM && points.some((p) => p.vwap !== null && (p.vwap < low || p.vwap > low + span));
    return { pad, x, y, premiumLine, vwapLine, ticks, startsSegment, vwapOutsideScale };
  }, [points, width, height, minuteBars, spotATM]);
  const snapshotStale = snapshotAt !== undefined && now - snapshotAt > staleMs;
  const delayed = latestPriced && now - latestPriced.t > (spotATM ? staleMs : 180_000);
  const hoverIndex = hover === null ? null : Math.min(hover, points.length - 1);

  return <section className={`spike-straddle-card${expanded ? " spike-straddle-card--expanded" : ""}`} aria-label={`${symbol} ATM straddle chart`}
    role={expanded ? "dialog" : undefined} aria-modal={expanded || undefined}>
    <div className="spike-straddle-head">
      <div><h2>{symbol === "NIFTY" ? "NIFTY 50" : symbol} · ATM straddle</h2>
        {name && <p>{name}</p>}
        <p title={spotATM ? "The ATM pair changes after spot stays across the strike midpoint" : "Each bucket uses its own lowest same-strike CE + PE premium; the minimum strike can change throughout the day"}>{displayedStrike ? `${displayedStrike} CE + PE · ${displayedExpiry || "expiry unavailable"} · ${premiumLabel}` : "Waiting for paired option premiums"}</p></div>
      <ChartExpandButton expanded={expanded} onClick={onToggleExpanded} />
    </div>
    <div className="spike-straddle-toolbar">
      <div className="spike-straddle-readout"><span><i className="spike-straddle-dot premium" />Premium <b>{selectedPremium}</b>
        {spotATM && !!selected?.strike && `· strike ${selected.strike}`}</span>
        <span title={`Each minute's ${spotATM ? "ATM" : "minimum"} CE + PE premium, weighted by the selected pair's smaller leg volume. ${spotATM ? "Resets when the ATM pair changes." : "Resets each trading day."}`}><i className="spike-straddle-dot vwap" />VWAP <b>{selected?.vwap != null ? num(selected.vwap) : "–"}</b></span>
        {spotATM && last && <span>Last bar <time>{sampleTime.format(last.t)}</time></span>}
        {(minuteBars || livePremium !== null) && <span title={current ? `Live ${spotATM ? "ATM" : "minimum"} CE + PE at strike ${current.strike}` : undefined}>Live <b>{livePremium === null ? "–" : num(livePremium)}</b>
          {spotATM && current && <time>{liveStale || snapshotStale ? "stale " : ""}{sampleTime.format(current.t)}</time>}</span>}
        {snapshotStale && <small>Last snapshot · stale {sampleTime.format(snapshotAt)}</small>}
        {delayed && <small>{spotATM ? `Delayed · last priced bar ${sampleTime.format(latestPriced.t)}` : "delayed"}</small>}
        {vwapOutsideScale && <small>VWAP extends outside the premium scale</small>}</div>
    </div>
    <div className="spike-straddle-plot" ref={plot.ref}>
      {!showPlot ? <div className="spike-straddle-empty">{emptyMessage ?? "Waiting for paired CE and PE option bars."}</div> :
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="ATM premium and volume weighted average price, completed buckets"
          onMouseMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const px = (e.clientX - rect.left) / rect.width * width;
            if (!minuteBars) {
              setHover(Math.max(0, Math.min(points.length - 1, Math.round((px - pad.l) / (width - pad.l - pad.r) * (points.length - 1)))));
              return;
            }
            const closest = points.reduce((best, _, i) => Math.abs(px - x(i)) < Math.abs(px - x(best)) ? i : best, 0);
            setHover(closest);
          }}
          onMouseLeave={() => setHover(null)}>
          {[0, 1, 2, 3, 4].map((step) => <line key={`vertical-${step}`} x1={pad.l + (width - pad.l - pad.r) * step / 4} y1={pad.t} x2={pad.l + (width - pad.l - pad.r) * step / 4} y2={height - pad.b} className="spike-straddle-grid spike-straddle-grid-vertical" />)}
          {ticks.map((tick, i) => <g key={i}><line x1={pad.l} y1={y(tick)} x2={width - pad.r} y2={y(tick)} className="spike-straddle-grid" /><text x={pad.l - 8} y={y(tick) + 4} textAnchor="end" className="spike-straddle-axis">{num(tick)}</text></g>)}
          {spotATM && <defs><clipPath id={clipId}><rect x={pad.l} y={pad.t} width={width - pad.l - pad.r} height={height - pad.t - pad.b} /></clipPath></defs>}
          <path d={premiumLine} className="spike-straddle-line premium" />
          <path d={vwapLine} className="spike-straddle-line vwap" clipPath={spotATM ? `url(#${clipId})` : undefined} />
          {minuteBars && points.map((point, i) => {
            const hasNeighbor = !startsSegment(i) || (i + 1 < points.length && !startsSegment(i + 1));
            return hasNeighbor || point.premium === null ? null : <circle key={point.t} cx={x(i)} cy={y(point.premium)} r={3} className="spike-straddle-point" />;
          })}
          {hoverIndex !== null && <line x1={x(hoverIndex)} y1={pad.t} x2={x(hoverIndex)} y2={height - pad.b} className="spike-straddle-guide" />}
          {hoverIndex !== null && selected && <g className="spike-straddle-hover-time" transform={`translate(${Math.max(pad.l + 28, Math.min(width - pad.r - 28, x(hoverIndex)))}, ${pad.t + 4})`}>
            <rect x={-28} y={0} width={56} height={22} />
            <text x={0} y={15} textAnchor="middle">{timeFormat.format(selected.t)}</text>
          </g>}
        </svg>}
    </div>
    {footer}
  </section>;
}
