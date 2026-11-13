import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { SpikeSample } from "./spikeApi.ts";

type Point = { at: string; strike: number; premium: number; vwap: number | null };

interface Props {
  symbol: "NIFTY" | "SENSEX";
  series: SpikeSample[];
  current: SpikeSample | null;
  expiry: string;
  expanded: boolean;
  onToggleExpanded: () => void;
}

const numberFormat = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = (value: number) => numberFormat.format(value);
const timeFormat = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" });
const chartTime = (iso: string) => timeFormat.format(new Date(iso));

// Ported from Live Index Algo F: the plot owns its size, including when expanded.
function usePlotSize() {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 900, height: 280 });

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      const width = Math.max(220, Math.round(element.clientWidth));
      const height = Math.max(180, Math.round(element.clientHeight));
      setSize((old) => old.width === width && old.height === height ? old : { width, height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

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

export default function SpikeStraddleChart({ symbol, series, current, expiry, expanded, onToggleExpanded }: Props) {
  const [hover, setHover] = useState<number | null>(null);
  const plot = usePlotSize();
  const points = useMemo<Point[]>(() => series.filter((point) => point.premium > 0).map((point) => ({
    at: new Date(point.t).toISOString(), strike: point.strike, premium: point.premium,
    vwap: point.vwap > 0 ? point.vwap : null,
  })), [series]);

  useEffect(() => setHover(null), [symbol, expiry]);

  const last = points[points.length - 1];
  const selected = hover === null ? last : points[Math.min(hover, points.length - 1)];
  const livePremium = current?.premium ?? null;
  const displayedStrike = selected?.strike ?? current?.strike;
  const { width, height } = plot;
  const { pad, x, y, premiumLine, vwapLine, ticks } = useMemo(() => {
    const pad = { l: 60, r: 20, t: 18, b: 18 };
    const values = points.flatMap((p) => p.vwap === null ? [p.premium] : [p.premium, p.vwap]);
    const low = values.length ? Math.floor(Math.min(...values) * .97) : 0;
    const high = values.length ? Math.ceil(Math.max(...values) * 1.03) : 1;
    const span = Math.max(1, high - low);
    const x = (i: number) => pad.l + (points.length < 2 ? 0 : i / (points.length - 1)) * (width - pad.l - pad.r);
    const y = (value: number) => height - pad.b - (value - low) / span * (height - pad.t - pad.b);
    const premiumLine = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(p.premium).toFixed(1)}`).join(" ");
    let hasVWAP = false;
    const vwapLine = points.map((p, i) => {
      if (p.vwap === null) { hasVWAP = false; return ""; }
      const command = `${hasVWAP ? "L" : "M"}${x(i).toFixed(1)} ${y(p.vwap).toFixed(1)}`;
      hasVWAP = true;
      return command;
    }).join(" ");
    const ticks = [0, 1, 2, 3, 4].map((i) => low + span * i / 4);
    return { pad, x, y, premiumLine, vwapLine, ticks };
  }, [points, width, height]);
  const latestAt = last ? Date.parse(last.at) : 0;
  const delayed = latestAt > 0 && Date.now() - latestAt > 180_000;

  return <section className={`spike-straddle-card${expanded ? " spike-straddle-card--expanded" : ""}`} aria-label={`${symbol} ATM straddle chart`}
    role={expanded ? "dialog" : undefined} aria-modal={expanded || undefined}>
    <div className="spike-straddle-head">
      <div><h2>{symbol === "NIFTY" ? "NIFTY 50" : "SENSEX"} · ATM straddle</h2>
        <p title="Each bucket uses its own lowest same-strike CE + PE premium; the minimum strike can change throughout the day">{displayedStrike ? `${displayedStrike} CE + PE · ${expiry || "expiry unavailable"} · min premium` : "Waiting for paired option premiums"}</p></div>
      <ChartExpandButton expanded={expanded} onClick={onToggleExpanded} />
    </div>
    <div className="spike-straddle-toolbar">
      <div className="spike-straddle-readout"><span><i className="spike-straddle-dot premium" />Premium <b>{selected ? num(selected.premium) : "–"}</b></span>
        <span title="Each minute's minimum CE + PE premium, weighted by the selected pair's smaller leg volume; resets each trading day"><i className="spike-straddle-dot vwap" />VWAP <b>{selected?.vwap != null ? num(selected.vwap) : "–"}</b></span>
        {livePremium !== null && <span title={`Live minimum CE + PE at strike ${current?.strike}`}>Live <b>{num(livePremium)}</b></span>}
        {delayed && <small>delayed</small>}</div>
    </div>
    <div className="spike-straddle-plot" ref={plot.ref}>
      {points.length < 2 ? <div className="spike-straddle-empty">Waiting for paired CE and PE option bars.</div> :
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="ATM premium and volume weighted average price, completed buckets"
          onMouseMove={(e) => { const rect = e.currentTarget.getBoundingClientRect(); const px = (e.clientX - rect.left) / rect.width * width; setHover(Math.max(0, Math.min(points.length - 1, Math.round((px - pad.l) / (width - pad.l - pad.r) * (points.length - 1))))); }}
          onMouseLeave={() => setHover(null)}>
          {[0, 1, 2, 3, 4].map((step) => <line key={`vertical-${step}`} x1={pad.l + (width - pad.l - pad.r) * step / 4} y1={pad.t} x2={pad.l + (width - pad.l - pad.r) * step / 4} y2={height - pad.b} className="spike-straddle-grid spike-straddle-grid-vertical" />)}
          {ticks.map((tick, i) => <g key={i}><line x1={pad.l} y1={y(tick)} x2={width - pad.r} y2={y(tick)} className="spike-straddle-grid" /><text x={pad.l - 8} y={y(tick) + 4} textAnchor="end" className="spike-straddle-axis">{num(tick)}</text></g>)}
          <path d={premiumLine} className="spike-straddle-line premium" /><path d={vwapLine} className="spike-straddle-line vwap" />
          {hover !== null && <line x1={x(Math.min(hover, points.length - 1))} y1={pad.t} x2={x(Math.min(hover, points.length - 1))} y2={height - pad.b} className="spike-straddle-guide" />}
          {hover !== null && selected && <g className="spike-straddle-hover-time" transform={`translate(${Math.max(pad.l + 28, Math.min(width - pad.r - 28, x(Math.min(hover, points.length - 1))))}, ${pad.t + 4})`}>
            <rect x={-28} y={0} width={56} height={22} />
            <text x={0} y={15} textAnchor="middle">{chartTime(selected.at)}</text>
          </g>}
        </svg>}
    </div>
  </section>;
}
