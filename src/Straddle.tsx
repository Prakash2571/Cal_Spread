import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MagnifyingGlassIcon } from "@phosphor-icons/react";
import SpikeStraddleChart from "./SpikeStraddleChart.tsx";
import { fetchStraddleUniverse, straddleStreamUrl, type StraddleSnapshot, type StraddleUnderlying } from "./straddleApi.ts";
import type { SpikeSample } from "./spikeApi.ts";

const noPoints: SpikeSample[] = [];
const recordingTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", second: "2-digit",
});

const statusText = {
  live: "Recording",
  capacity: "Waiting for Dhan subscription capacity",
  closed: "Market closed",
  connecting: "Connecting to Dhan",
  waiting: "Waiting for an active Dhan session",
  unavailable: "No paired options for the nearest expiry",
};

const StraddleCard = memo(function StraddleCard({ item, chart, selected, connected, expanded, toggle }: {
  item: StraddleUnderlying;
  chart?: StraddleSnapshot;
  selected: boolean;
  connected: boolean;
  expanded: boolean;
  toggle: (symbol: string) => void;
}) {
  const card = useRef<HTMLDivElement>(null);
  const [collapsedHeight, setCollapsedHeight] = useState<number>();
  const { symbol, name, expiry } = item;
  const points = chart?.points ?? noPoints;
  const current = selected && connected ? chart?.current ?? null : null;
  const status = selected ? (connected && chart ? statusText[chart.status] : "Connecting…") : "Paused outside live view";

  return <div className="straddle-item" data-straddle-symbol={symbol} ref={card}
    style={expanded ? { minHeight: collapsedHeight } : undefined}>
    <SpikeStraddleChart
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
      emptyMessage={selected && connected && chart?.status === "live" ? undefined : status}
      footer={<footer className="straddle-card-footer">
        {chart?.recording_since ? <span>Recording since {recordingTime.format(chart.recording_since)} IST</span> : null}
        {points.length > 0 && <span>{status}</span>}
      </footer>}
    />
  </div>;
});

export default function Straddle({ onBack }: { onBack: () => void }) {
  const [universe, setUniverse] = useState<Awaited<ReturnType<typeof fetchStraddleUniverse>> | null>(null);
  const [query, setQuery] = useState("");
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [tabVisible, setTabVisible] = useState(() => !document.hidden);
  const [visible, setVisible] = useState<string[]>([]);
  const [charts, setCharts] = useState<Record<string, StraddleSnapshot>>({});
  const [connectedWindow, setConnectedWindow] = useState("");
  const [streamError, setStreamError] = useState(false);
  const [streamAttempt, setStreamAttempt] = useState(0);
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
    function onVisibilityChange() { setTabVisible(!document.hidden); }
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  const filtered = useMemo(() => {
    const term = query.trim().toUpperCase();
    return universe?.underlyings.filter(({ symbol, name }) =>
      symbol.toUpperCase().includes(term) || name.toUpperCase().includes(term)) ?? [];
  }, [universe, query]);

  useEffect(() => {
    const cards = grid.current?.querySelectorAll<HTMLElement>("[data-straddle-symbol]");
    if (!cards) return;
    const ratios = new Map<HTMLElement, number>();
    let observing = true;
    const observer = new IntersectionObserver((entries) => {
      if (!observing) return;
      for (const entry of entries) ratios.set(entry.target as HTMLElement, entry.intersectionRatio);
      // Prefer the most visible charts and keep their request order stable within the grid.
      const ranked = Array.from(cards).filter((card) => (ratios.get(card) ?? 0) >= 0.15);
      ranked.sort((a, b) => (ratios.get(b) ?? 0) - (ratios.get(a) ?? 0));
      const chosen = new Set(ranked.slice(0, universe?.max_live ?? 0));
      const symbols = Array.from(cards).filter((card) => chosen.has(card)).map((card) => card.dataset.straddleSymbol!);
      setVisible((previous) => previous.join() === symbols.join() ? previous : symbols);
    }, { threshold: [0, 0.15, 0.5, 0.85] });
    for (const card of cards) observer.observe(card);
    return () => { observing = false; observer.disconnect(); };
  }, [filtered, universe?.max_live]);

  const symbols = useMemo(() => {
    if (!tabVisible) return [];
    if (expanded) return [expanded];
    const matches = new Set(filtered.map(({ symbol }) => symbol));
    return visible.filter((symbol) => matches.has(symbol));
  }, [tabVisible, expanded, filtered, visible]);
  const liveWindow = symbols.join(",");
  const liveSet = useMemo(() => new Set(symbols), [symbols]);

  useEffect(() => {
    setConnectedWindow("");
    setStreamError(false);
    if (!liveWindow) return;
    const stream = new EventSource(straddleStreamUrl(liveWindow));
    let retry: number | undefined;
    const update = (event: Event) => {
      try {
        const snapshots = JSON.parse((event as MessageEvent<string>).data) as StraddleSnapshot[];
        if (snapshots.length === 0) return;
        setCharts((previous) => {
          const next = Object.fromEntries(Object.entries(previous).filter(([, chart]) => chart.day === snapshots[0].day));
          for (const chart of snapshots) {
            next[chart.symbol] = { ...chart, points: chart.points ?? next[chart.symbol]?.points };
          }
          return next;
        });
        setConnectedWindow(liveWindow);
        setStreamError(false);
      } catch {
        setConnectedWindow("");
        setStreamError(true);
      }
    };
    stream.addEventListener("snapshot", update);
    stream.onerror = () => {
      setConnectedWindow("");
      setStreamError(true);
      if (stream.readyState === EventSource.CLOSED) {
        retry = window.setTimeout(() => setStreamAttempt((value) => value + 1), 5000);
      }
    };
    return () => {
      window.clearTimeout(retry);
      stream.removeEventListener("snapshot", update);
      stream.onerror = null;
      stream.close();
    };
  }, [liveWindow, streamAttempt]);

  useEffect(() => {
    if (!expanded) return;
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
  }, [expanded]);

  const toggle = useCallback((symbol: string) => {
    setExpanded((previous) => previous === symbol ? null : symbol);
  }, []);

  return <main className="straddle-page">
    <div className="spike-page">
      <header className="spike-header">
        <button className="btn" type="button" onClick={onBack}>← Board</button>
        <div className="spike-header-title">
          <h1>Straddle</h1>
          <p>F&amp;O stocks · minimum CE + PE premium and chart VWAP</p>
        </div>
      </header>
      <div className="straddle-controls">
        <label className="search-wrap">
          <MagnifyingGlassIcon aria-hidden="true" />
          <input className="search" type="search" value={query} onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by symbol or company" aria-label="Search F&O stocks" />
        </label>
        {universe && <span className="spike-muted">{filtered.length} of {universe.underlyings.length} stocks</span>}
      </div>
      <p className="straddle-session-note spike-muted">
        Market recording opens at 09:15:00 IST. Each chart starts when first viewed during market hours.
        It shows completed one-minute bars for periods when the stock was live.
        {universe && ` Up to ${universe.max_live} visible stocks can stream at once, subject to shared Dhan capacity.`}
      </p>
      {catalogError && <div className="spike-error" role="alert">{catalogError}{" "}
        <button className="btn" type="button" onClick={() => { setCatalogError(null); setAttempt((value) => value + 1); }}>Retry</button>
      </div>}
      {!universe && !catalogError && <p className="spike-notice" role="status">Loading F&amp;O stocks…</p>}
      {universe && filtered.length === 0 && <p className="spike-notice" role="status">No matching F&amp;O stocks.</p>}
      {liveWindow && streamError && <p className="spike-error" role="status">Live chart connection interrupted. Reconnecting…</p>}
      <div className="straddle-grid" ref={grid}>
        {filtered.map((item) => <StraddleCard key={item.symbol} item={item} chart={charts[item.symbol]}
          selected={liveSet.has(item.symbol)} connected={liveWindow === connectedWindow} expanded={expanded === item.symbol} toggle={toggle} />)}
      </div>
    </div>
  </main>;
}
