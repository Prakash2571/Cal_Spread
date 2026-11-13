import { useEffect, useMemo, useRef, useState } from "react";
import SpikeStraddleChart from "./SpikeStraddleChart.tsx";
import ThemeToggle from "./ThemeToggle.tsx";
import { closeSpikeTrade, deleteSpikeTrade, fetchSpikeSeries, fetchSpikeStatus, setSpikePaper, spikeStreamUrl,
  type SpikeFrame, type SpikeSample, type SpikeSnapshot, type SpikeTrade } from "./spikeApi.ts";

const INDEXES = ["NIFTY", "SENSEX"] as const;
const FRAMES: SpikeFrame[] = ["1m", "5m", "30m", "1h"];
const price = (value: number | null | undefined) =>
  typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—";
const stamp = (value: number | null | undefined) => value ? new Date(value).toLocaleTimeString("en-GB", {
  timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", second: "2-digit",
}) : "—";
const direction = (value: string) => ({
  CALL_CREDIT: "Call credit",
  PUT_CREDIT: "Put credit",
}[value] ?? value);

export default function Spike({ canTrade, onBack }: { canTrade: boolean; onBack: () => void }) {
  const [snapshot, setSnapshot] = useState<SpikeSnapshot | null>(null);
  const [frame, setFrame] = useState<SpikeFrame>("1m");
  const [series, setSeries] = useState<Record<string, SpikeSample[]>>({ NIFTY: [], SENSEX: [] });
  const [live, setLive] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [armedDelete, setArmedDelete] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chartError, setChartError] = useState<string | null>(null);
  const [expandedSymbol, setExpandedSymbol] = useState<typeof INDEXES[number] | null>(null);
  const charts = useRef<HTMLDivElement>(null);

  // Match Live Index Algo F's expanded chart keyboard, focus and scroll handling.
  useEffect(() => {
    if (!expandedSymbol) return;
    const previous = document.body.style.overflow;
    const dialog = charts.current?.querySelector<HTMLElement>(".spike-straddle-card--expanded");
    const opener = dialog?.querySelector<HTMLElement>(".spike-straddle-expand-button");
    document.body.style.overflow = "hidden";
    opener?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setExpandedSymbol(null);
      } else if (event.key === "Tab" && dialog) {
        const buttons = Array.from(dialog.querySelectorAll<HTMLElement>("button:not(:disabled)"));
        const first = buttons[0], last = buttons[buttons.length - 1];
        if (!dialog.contains(document.activeElement) || (event.shiftKey && document.activeElement === first)) {
          event.preventDefault();
          const target = event.shiftKey ? last : first;
          target?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
      if (opener && document.contains(opener)) opener.focus();
    };
  }, [expandedSymbol]);

  useEffect(() => {
    if (!canTrade) return;
    let cancelled = false;
    void fetchSpikeStatus().then((value) => { if (!cancelled) setSnapshot(value); })
      .catch((cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : "Could not load Spike."); });
    const stream = new EventSource(spikeStreamUrl());
    const onSnapshot = (event: Event) => {
      try { const value = JSON.parse((event as MessageEvent).data) as SpikeSnapshot;
        if (!cancelled) { setSnapshot(value); setLive(true); }
      } catch { if (!cancelled) setError("Spike sent an unreadable update."); }
    };
    stream.addEventListener("snapshot", onSnapshot);
    stream.onerror = () => { if (!cancelled) setLive(false); };
    return () => { cancelled = true; stream.close(); };
  }, [canTrade]);

  useEffect(() => {
    if (!canTrade) return;
    let cancelled = false;
    setSeries({ NIFTY: [], SENSEX: [] });
    const load = async () => {
      try {
        const values = await Promise.all(INDEXES.map((symbol) => fetchSpikeSeries(symbol, frame)));
        if (cancelled) return;
        setSeries(Object.fromEntries(values.filter((value) => value.frame === frame).map((value) => [value.symbol, value.points])));
        setChartError(null);
      } catch (cause: unknown) {
        if (!cancelled) setChartError(cause instanceof Error ? cause.message : "History update failed.");
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 5000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [canTrade, frame]);

  const openPNL = useMemo(() => snapshot?.open.reduce((sum, trade) => sum + (trade.pnl ?? 0), 0) ?? 0, [snapshot]);
  const closedPNL = useMemo(() => snapshot?.closed.reduce((sum, trade) => sum + (trade.pnl ?? 0), 0) ?? 0, [snapshot]);

  async function togglePaper() {
    if (!snapshot) return;
    setBusy("paper"); setError(null);
    try { setSnapshot(await setSpikePaper(!snapshot.paper_enabled)); }
    catch (cause: unknown) { setError(cause instanceof Error ? cause.message : "Paper control failed."); }
    finally { setBusy(null); }
  }
  async function close(trade: SpikeTrade) {
    setBusy(trade.id); setError(null);
    try { await closeSpikeTrade(trade.id); setSnapshot(await fetchSpikeStatus()); }
    catch (cause: unknown) { setError(cause instanceof Error ? cause.message : "Paper close failed."); }
    finally { setBusy(null); }
  }
  async function deleteTrade(trade: SpikeTrade) {
    if (busy !== null) return;
    if (armedDelete !== trade.id) { setArmedDelete(trade.id); return; }
    setArmedDelete(null);
    setBusy(`delete:${trade.id}`); setError(null);
    try { await deleteSpikeTrade(trade.id); setSnapshot(await fetchSpikeStatus()); }
    catch (cause: unknown) { setError(cause instanceof Error ? cause.message : "Paper delete failed."); }
    finally { setBusy(null); }
  }

  const deleteButton = (trade: SpikeTrade) => <button type="button" className="btn" disabled={busy !== null}
    onClick={() => void deleteTrade(trade)}>{busy === `delete:${trade.id}` ? "Deleting…" : armedDelete === trade.id ? "Delete this trade?" : "Delete"}</button>;

  return <main className="spike-page">
    <header className="spike-header">
      <button className="btn" type="button" onClick={onBack}>← Board</button>
      <div className="spike-header-title"><h1>Spike</h1><p>NIFTY & SENSEX · minimum straddle · one-lot paper spreads</p></div>
      <div className="spike-header-actions"><ThemeToggle />
        <span className={`status status--${live && snapshot?.connected ? "live" : "idle"}`}>{live && snapshot?.connected ? "Dhan WebSocket live" : "Waiting for Dhan"}</span>
        <span className="spike-paper-label">Paper only</span>
      </div>
    </header>
    {!canTrade ? <section className="spike-notice"><h2>Trade access required</h2><p>Sign in to view the Spike monitor and paper positions.</p><a className="btn" href="/admin/access">Sign in</a></section> : <>
      {(error || snapshot?.error || chartError) && <div className="spike-error" role="alert">{error || snapshot?.error || chartError}</div>}
      <section className="spike-controls">
        <div className="spike-frame-buttons" aria-label="Chart timeframe">{FRAMES.map((value) => <button type="button" key={value} className={`btn ${frame === value ? "spike-selected" : ""}`} aria-pressed={frame === value} onClick={() => setFrame(value)}>{value}</button>)}</div>
        <button type="button" className={`spike-run-btn${snapshot?.paper_enabled ? " spike-run-btn--running" : " spike-run-btn--paused"}`} disabled={busy !== null || !snapshot?.database} aria-pressed={snapshot?.paper_enabled ?? false} onClick={() => void togglePaper()}>{snapshot?.paper_enabled ? "Pause" : "Run"}</button>
        <span className={`spike-run-status${snapshot?.paper_enabled ? " spike-run-status--running" : " spike-run-status--paused"}`}>{snapshot?.paper_enabled ? "Running" : "Paused — monitoring continues"}</span>
        <div className="spike-pnl-summary"><span>Open gross P&L <strong className={openPNL >= 0 ? "spike-positive" : "spike-negative"}>₹{price(openPNL)}</strong></span><span>Closed today <strong className={closedPNL >= 0 ? "spike-positive" : "spike-negative"}>₹{price(closedPNL)}</strong></span></div>
      </section>
      {!snapshot?.database && <p className="spike-notice">Charts can monitor in memory. Durable paper entries use the existing PostgreSQL configuration.</p>}
      <div className="spike-index-grid" ref={charts}>{INDEXES.map((symbol) => {
        const index = snapshot?.indexes.find((value) => value.symbol === symbol);
        const data = series[symbol] ?? [];
        return <section className="spike-index" key={symbol}>
          <header><div><h2>{symbol}</h2><span className="spike-muted">Expiry {index?.expiry || "—"} · {index?.pairs ?? 0} paired strikes · {index?.lot_size ?? "—"} qty / lot</span></div><div className="spike-metrics"><span>Min strike <strong>{price(index?.current?.strike)}</strong></span><span>Straddle <strong>{price(index?.current?.premium)}</strong></span><span>VWAP <strong>{price(index?.current?.vwap || null)}</strong></span></div></header>
          <p className="spike-index-note">{index?.note ?? "Loading monitor…"}<span>{index?.current ? `Updated ${stamp(index.current.t)} IST` : ""}</span></p>
          <div className="spike-chart-grid"><SpikeStraddleChart symbol={symbol} series={data} current={index?.current ?? null} expiry={index?.expiry ?? ""}
            expanded={expandedSymbol === symbol} onToggleExpanded={() => setExpandedSymbol((value) => value === symbol ? null : symbol)} /></div>
          <footer className="spike-muted">Recording since {stamp(index?.recording_since)} IST. Charts show completed buckets; latest values above update from the feed.</footer>
          {index?.signal && <p className="spike-last-signal">Last qualified {direction(index.signal.direction)} · {index.signal.move_pct.toFixed(2)}% from {price(index.signal.reference)} at {stamp(index.signal.reference_at)} · crossover {stamp(index.signal.t)}</p>}
        </section>;
      })}</div>
      <section className="spike-trades"><h2>Open primary paper spreads</h2>
        {snapshot?.open.length ? <div className="spike-table-scroll"><table><thead><tr><th>Index / signal</th><th>Short leg</th><th>Fourth-OTM hedge</th><th>Size / credit</th><th>Gross P&L</th><th>Peak P&L</th><th>Manual exit</th></tr></thead><tbody>{snapshot.open.map((trade) => <tr key={trade.id} data-spike-symbol={trade.symbol}>
          <td><strong>{trade.symbol}</strong><small>{direction(trade.direction)} · {stamp(trade.opened_at)} IST<br />Expiry {trade.expiry}</small></td><td>{trade.short.symbol}<small>Sold {price(trade.short.entry)} · cover {price(trade.mark_short)}</small></td><td>{trade.hedge.symbol}<small>Bought {price(trade.hedge.entry)} · sell {price(trade.mark_hedge)}</small></td><td>1 lot · {trade.quantity} qty<small>Credit ₹{price(trade.entry_credit)}</small></td><td className={(trade.pnl ?? 0) >= 0 ? "spike-positive" : "spike-negative"}>₹{price(trade.pnl)}<small>{trade.mark_stale ? "Last mark — depth stale" : `Touch mark ${stamp(trade.mark_at)}`}</small></td><td className={(trade.peak_pnl ?? 0) >= 0 ? "spike-positive" : "spike-negative"}>₹{price(trade.peak_pnl)}{trade.peak_at != null && <small>at {stamp(trade.peak_at)} IST</small>}</td><td><button type="button" className="btn" disabled={busy !== null} onClick={() => void close(trade)}>{busy === trade.id ? "Closing…" : "Close paper spread"}</button>{" "}{deleteButton(trade)}</td>
        </tr>)}</tbody></table></div> : <p className="spike-muted">No open paper spreads. A qualifying crossover opens one primary spread per index.</p>}
      </section>
      <section className="spike-trades"><h2>Closed paper spreads today</h2>{snapshot?.closed.length ? <div className="spike-table-scroll"><table><thead><tr><th>Index</th><th>Spread</th><th>Entry → exit</th><th>Gross P&L</th><th>Peak P&L</th><th>Action</th></tr></thead><tbody>{snapshot.closed.map((trade) => <tr key={trade.id}><td>{trade.symbol}</td><td>{direction(trade.direction)} · {price(trade.short.strike)} / {price(trade.hedge.strike)}</td><td>{stamp(trade.opened_at)} → {stamp(trade.closed_at)} IST</td><td className={(trade.pnl ?? 0) >= 0 ? "spike-positive" : "spike-negative"}>₹{price(trade.pnl)}</td><td className={(trade.peak_pnl ?? 0) >= 0 ? "spike-positive" : "spike-negative"}>₹{price(trade.peak_pnl)}{trade.peak_at != null && <small>at {stamp(trade.peak_at)} IST</small>}</td><td>{deleteButton(trade)}</td></tr>)}</tbody></table></div> : <p className="spike-muted">Manual exits and their P&L appear here.</p>}</section>
      <details className="spike-rules"><summary>Strategy rules and calculations</summary><ul>
        <li>The minimum straddle is the cheapest same-strike CE + PE pair across the nearest live expiry.</li>
        <li>If underlying spot rose since arming, short one-lot ATM CE and buy the fourth higher listed CE; if it fell, short ATM PE and buy the fourth lower listed PE. Flat or unavailable spot skips entry and consumes the arm.</li>
        <li>VWAP is the sum of those two contracts’ day-volume-weighted average traded prices supplied by Dhan.</li>
        <li>A premium at least 5% above the preceding 30-minute low arms the index. Its first price-driven downward VWAP cross then evaluates a paper entry.</li>
        <li>Entry uses short bid / hedge ask; manual exit uses short ask / hedge bid. Gross paper P&L excludes fees and taxes.</li>
        <li>One primary open spread per index. Entry strikes stay fixed as the minimum moves. Positions stay open until you close them.</li>
      </ul></details>
    </>}
  </main>;
}
