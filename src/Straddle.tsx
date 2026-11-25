import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MagnifyingGlassIcon } from "@phosphor-icons/react";
import SpikeStraddleChart from "./SpikeStraddleChart.tsx";
import {
  fetchStraddleUniverse, straddleStreamUrl, subscribeStraddle,
  type StraddleCoverage, type StraddlePoint, type StraddleSnapshot, type StraddleStreamError, type StraddleUnderlying,
} from "./straddleApi.ts";

type CachedChart = StraddleSnapshot & { snapshotAt: number };

const noPoints: StraddlePoint[] = [];
const recordingTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", second: "2-digit",
});

const statusText = {
  live: "Recording",
  capacity: "Waiting for Dhan subscription capacity",
  closed: "Market closed",
  connecting: "Connecting to Dhan",
  waiting: "Waiting for an active Dhan session",
  pricing: "Waiting for current ATM quotes",
  unavailable: "No paired options for the nearest expiry",
};

export const StraddleCard = memo(function StraddleCard({ item, chart, renderChart, connected, now, expanded, toggle }: {
  item: StraddleUnderlying;
  chart?: CachedChart;
  renderChart: boolean;
  connected: boolean;
  now?: number;
  expanded: boolean;
  toggle: (symbol: string) => void;
}) {
  const card = useRef<HTMLDivElement>(null);
  const [collapsedHeight, setCollapsedHeight] = useState<number>();
  const { symbol, name, expiry } = item;
  const points = chart?.points ?? noPoints;
  const current = chart?.current ?? null;
  const status = connected && chart ? statusText[chart.status] : chart ? "Waiting for a fresh snapshot" : "Connecting…";

  return <div className="straddle-item" data-straddle-symbol={symbol} ref={card}
    style={expanded ? { minHeight: collapsedHeight } : undefined}>
    {renderChart ? <SpikeStraddleChart
      symbol={symbol}
      name={name}
      series={points}
      current={current}
      expiry={chart?.expiry ?? expiry}
      expanded={expanded}
      onToggleExpanded={() => {
        if (!expanded) setCollapsedHeight(card.current?.offsetHeight);
        toggle(symbol);
      }}
      minuteBars
      spotATM
      snapshotAt={chart?.snapshotAt}
      now={now}
      liveStale={!connected}
      emptyMessage={points.length > 0 || (connected && chart?.status === "live") ? undefined : status}
      footer={<footer className="straddle-card-footer">
        {chart?.recording_since ? <span>Recording since {recordingTime.format(chart.recording_since)} IST</span> : null}
        <span>{status}</span>
      </footer>}
    /> : <section className="straddle-placeholder" aria-label={`${symbol} ATM straddle chart`}>
      <div className="spike-straddle-head"><div><h2>{symbol} · ATM straddle</h2><p>{name}</p></div></div>
    </section>}
  </div>;
});

export default function Straddle({ canTrade, onBack }: { canTrade: boolean; onBack: () => void }) {
  return <main className="straddle-page">
    <div className="spike-page">
      <header className="spike-header">
        <button className="btn" type="button" onClick={onBack}>← Board</button>
        <div className="spike-header-title">
          <h1>Straddle</h1>
          <p>F&amp;O stocks · ATM CE + PE premium and chart VWAP</p>
        </div>
      </header>
      {canTrade ? <StraddleCharts /> : <section className="spike-notice">
        <h2>Trade access required</h2>
        <p>Sign in to view the Straddle charts.</p>
        <a className="btn" href="/admin/access">Sign in</a>
      </section>}
    </div>
  </main>;
}

function StraddleCharts() {
  const [universe, setUniverse] = useState<Awaited<ReturnType<typeof fetchStraddleUniverse>> | null>(null);
  const [query, setQuery] = useState("");
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [tabVisible, setTabVisible] = useState(() => !document.hidden);
  const [visible, setVisible] = useState<string[]>([]);
  const [charts, setCharts] = useState<Record<string, CachedChart>>({});
  const [now, setNow] = useState(Date.now);
  const [connectedWindow, setConnectedWindow] = useState<{ url: string }>();
  const [streamError, setStreamError] = useState<StraddleStreamError | null>(null);
  const [coverageError, setCoverageError] = useState(false);
  const [coverage, setCoverage] = useState<StraddleCoverage>();
  const grid = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetchStraddleUniverse(controller.signal).then((data) => {
      setUniverse(data);
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setCatalogError(error instanceof Error ? error.message : "Could not load F&O stocks.");
    });
    return () => controller.abort();
  }, [attempt]);

  useEffect(() => {
    function onVisibilityChange() {
      setTabVisible(!document.hidden);
      setNow(Date.now());
    }
    const clock = window.setInterval(() => setNow(Date.now()), 5000);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearInterval(clock);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  const filtered = useMemo(() => {
    const term = query.trim().toUpperCase();
    return universe?.underlyings.filter(({ symbol, name }) =>
      symbol.toUpperCase().includes(term) || name.toUpperCase().includes(term)) ?? [];
  }, [universe, query]);
  const matchingSymbols = useMemo(() => new Set(filtered.map(({ symbol }) => symbol)), [filtered]);
  const expandedSymbol = expanded && matchingSymbols.has(expanded) ? expanded : null;

  useEffect(() => {
    if (expanded && !expandedSymbol) setExpanded(null);
  }, [expanded, expandedSymbol]);

  useEffect(() => {
    const cards = grid.current?.querySelectorAll<HTMLElement>("[data-straddle-symbol]");
    if (!cards) return;
    const inView = new Set<HTMLElement>();
    let observing = true;
    const observer = new IntersectionObserver((entries) => {
      if (!observing) return;
      for (const entry of entries) {
        const card = entry.target as HTMLElement;
        if (entry.isIntersecting) inView.add(card);
        else inView.delete(card);
      }
      const symbols = Array.from(cards).filter((card) => inView.has(card)).map((card) => card.dataset.straddleSymbol!);
      setVisible((previous) => previous.join("\n") === symbols.join("\n") ? previous : symbols);
    });
    for (const card of cards) observer.observe(card);
    return () => { observing = false; observer.disconnect(); };
  }, [filtered]);

  const renderSet = useMemo(() => new Set(expandedSymbol ? [...visible, expandedSymbol] : visible), [expandedSymbol, visible]);
  const viewUrl = useMemo(() => {
    if (!tabVisible) return;
    const symbols = expandedSymbol ? [expandedSymbol] : visible.filter((symbol) => matchingSymbols.has(symbol));
    if (symbols.length) return straddleStreamUrl(symbols);
  }, [tabVisible, expandedSymbol, matchingSymbols, visible]);
  const viewRequest = useMemo(() => viewUrl ? { url: viewUrl } : undefined, [viewUrl]);

  useEffect(() => subscribeStraddle<StraddleCoverage>(straddleStreamUrl(), "coverage", (coverage) => {
    setCoverage(coverage);
    setCoverageError(false);
  }, () => setCoverageError(true)), []);

  useEffect(() => {
    if (!viewRequest) return;
    // Scroll and search can change the viewport repeatedly within a few frames.
    let unsubscribe: (() => void) | undefined;
    const timer = window.setTimeout(() => {
      unsubscribe = subscribeStraddle<StraddleSnapshot[]>(viewRequest.url, "snapshot", (snapshots) => {
        if (snapshots.length === 0) return;
        const snapshotAt = Date.now();
        setNow(snapshotAt);
        setCharts((previous) => {
          const next = Object.fromEntries(Object.entries(previous).filter(([, chart]) => chart.day === snapshots[0].day));
          for (const chart of snapshots) {
            next[chart.symbol] = { ...chart, points: chart.points ?? next[chart.symbol]?.points, snapshotAt };
          }
          return next;
        });
        setConnectedWindow(viewRequest);
        setStreamError(null);
      }, (error) => {
        setConnectedWindow(undefined);
        setStreamError(error);
      });
    }, 120);
    return () => {
      window.clearTimeout(timer);
      unsubscribe?.();
    };
  }, [viewRequest]);

  useEffect(() => {
    if (!expandedSymbol) return;
    const button = grid.current?.querySelector<HTMLButtonElement>(".spike-straddle-card--expanded .spike-straddle-expand-button");
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    button?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setExpanded(null);
      } else if (event.key === "Tab" && button) {
        event.preventDefault();
        button.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      if (button?.isConnected) button.focus();
    };
  }, [expandedSymbol]);

  const toggle = useCallback((symbol: string) => {
    setExpanded((previous) => previous === symbol ? null : symbol);
  }, []);

  return (
    <>
      <div className="straddle-controls">
        <label className="search-wrap">
          <MagnifyingGlassIcon aria-hidden="true" />
          <input className="search" type="search" value={query} onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by symbol or company" aria-label="Search F&O stocks" />
        </label>
        {universe && <span className="spike-muted">{filtered.length} of {universe.underlyings.length} stocks</span>}
      </div>
      <p className="straddle-session-note spike-muted">
        Recording runs automatically on trading days from 09:15 to 15:30 IST.
        Charts show completed one-minute bars and leave gaps where quotes were unavailable.
      </p>
      {catalogError && <div className="spike-error" role="alert">{catalogError}{" "}
        <button className="btn" type="button" onClick={() => { setCatalogError(null); setAttempt((value) => value + 1); }}>Retry</button>
      </div>}
      {!universe && !catalogError && <p className="spike-notice" role="status">Loading F&amp;O stocks…</p>}
      {universe && filtered.length === 0 && <p className="spike-notice" role="status">No matching F&amp;O stocks.</p>}
      {!coverageError && coverage?.dhan_over_limit && <p className="spike-error" role="status">
        The Dhan feed has exceeded its 5,000-instrument limit. Straddle charts may be unavailable.
      </p>}
      {!coverageError && coverage && !coverage.dhan_over_limit && coverage.capacity_limited > 0 && <p className="spike-notice" role="status">
        Dhan capacity is limited. {coverage.capacity_limited} {coverage.capacity_limited === 1 ? "stock is" : "stocks are"} waiting to record.
      </p>}
      {viewUrl && streamError === "capacity" && <p className="spike-error" role="status">All Straddle chart streams are in use. Retrying…</p>}
      {(coverageError || (viewUrl && streamError === "connection")) && <p className="spike-error" role="status">Live chart connection interrupted. Reconnecting…</p>}
      <div className="straddle-grid" ref={grid}>
        {filtered.map((item) => <StraddleCard key={item.symbol} item={item} chart={charts[item.symbol]}
          renderChart={renderSet.has(item.symbol)} now={renderSet.has(item.symbol) ? now : undefined}
          connected={(!expandedSymbol || item.symbol === expandedSymbol) && renderSet.has(item.symbol) && !!viewRequest && viewRequest === connectedWindow}
          expanded={expandedSymbol === item.symbol} toggle={toggle} />)}
      </div>
    </>
  );
}
