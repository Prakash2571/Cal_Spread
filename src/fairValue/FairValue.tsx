import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ThemeToggle from "../ThemeToggle.tsx";
import BrandMark from "../BrandMark.tsx";
import FairValueChart from "./Chart.tsx";
import ContractDetail from "./ContractDetail.tsx";
import { Stat, GreeksView } from "./Components.tsx";
import { calculateFairValue, exportFairValue, getFairValueConfig, getFairValueHistoricalSnapshot, getFairValueHistory, getFairValueSnapshot, getFairValueStatus, getFairValueUnderlyings, independentFairValue, pauseFairValue, refreshFairValue, setFairValueConfig } from "./api.ts";
import { displayIv, displayNumber as number, fittedPoints, localInputToUtc, localTimestamp, reasonText, utcToLocalInput } from "./view.ts";
import type { CalculatorResult, ConfigResponse, HistorySummary, Independent, OptionSide, Row, Snapshot, Status } from "./types.ts";
import "./fairValue.css";

const errorMessage = (e: unknown) => e instanceof Error ? e.message : "Fair Value unavailable.";

export default function FairValue({ isFullAdmin, onBack }: { isFullAdmin: boolean; onBack: () => void }) {
  const [accessRevoked, setAccessRevoked] = useState(false);
  useEffect(() => {
    const deny = () => setAccessRevoked(true);
    window.addEventListener("calspread:fair-value-access-denied", deny);
    return () => window.removeEventListener("calspread:fair-value-access-denied", deny);
  }, []);

  // Guard before mounting the data component: non-admins make no valuation requests
  // and cannot restore a private snapshot from browser storage.
  if (!isFullAdmin || accessRevoked) return <div className="app fv-page"><header className="topbar"><h1>Fair Value</h1><button className="btn" onClick={onBack}>Back</button></header><main className="fv-card"><h2>Full admin access required</h2><p>Sign in with full administrator access to open option valuations.</p></main></div>;
  return <FairValueAdmin onBack={onBack} />;
}

function FairValueAdmin({ onBack }: { onBack: () => void }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [underlyings, setUnderlyings] = useState<{ symbol: string; name: string; expiries: string[] }[]>([]);
  const [symbol, setSymbol] = useState("NIFTY");
  const [expiry, setExpiry] = useState("");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [age, setAge] = useState<number | null>(null);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [viewPaused, setViewPaused] = useState(false);
  const [search, setSearch] = useState("");
  const [detail, setDetail] = useState<Row | null>(null);
  const [configOpen, setConfigOpen] = useState(false);
  const [configText, setConfigText] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [history, setHistory] = useState<HistorySummary[]>([]);
  const [historical, setHistorical] = useState(false);
  const [clock, setClock] = useState(Date.now());
  const [independent, setIndependent] = useState<Record<string, Independent>>({});
  const [independentBusy, setIndependentBusy] = useState(false);
  const [calcStrike, setCalcStrike] = useState("");
  const [calcExpiry, setCalcExpiry] = useState("");
  const [calcSide, setCalcSide] = useState<OptionSide>("CE");
  const [research, setResearch] = useState(false);
  const [calculation, setCalculation] = useState<CalculatorResult | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    const timer = window.setInterval(() => {
      void getFairValueStatus().then((s) => { if (mounted.current) setStatus(s); }).catch((e) => {
        if (mounted.current) setError(errorMessage(e));
      });
    }, 15000);
    return () => window.clearInterval(timer);
  }, []);
  const selectedSymbol = useRef(symbol);
  selectedSymbol.current = symbol;
  const slice = snapshot?.slices.find((s) => s.expiry === expiry) ?? snapshot?.slices[0] ?? null;
  const snapshotKey = useRef<string | null>(null);
  const clockBaseline = useRef({ local: Date.now(), age: 0 });
  const displayAge = (age ?? 0) + (clock - clockBaseline.current.local);
  const expiredSlice = !!slice?.expiry_timestamp && Date.parse(slice.expiry_timestamp) <= Date.parse(snapshot?.valuation_time ?? "") + displayAge;
  const surfaceStale = stale || (!!snapshot && displayAge > (status?.surface_max_age_ms ?? 60000)) || expiredSlice;
  const privateReady = status?.enabled === true && !status.paused && !historical && !surfaceStale;

  function acceptSnapshot(next: Snapshot | null, reportedAge: number | null = null) {
    const key = next?.input_snapshot_id ?? null;
    if (snapshotKey.current !== key) {
      setIndependent({}); setCalculation(null);
      snapshotKey.current = key;
    }
    setSnapshot(next);
    setDetail((previous) => previous && next ? next.slices.flatMap((s) => s.rows).find((r) => r.token === previous.token) ?? null : null);
    const surfaceAge = reportedAge ?? (next ? Math.max(0, Date.parse(next.published_at) - Date.parse(next.valuation_time)) : 0);
    setAge(next ? surfaceAge : null);
    clockBaseline.current = { local: Date.now(), age: surfaceAge };
    setClock(Date.now());
    setStale(false);
  }

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    mounted.current = true;
    void Promise.all([getFairValueStatus(), getFairValueConfig()]).then(([s, c]) => {
      if (!mounted.current) return;
      setStatus(s); setConfig(c); setConfigText(JSON.stringify(c.config, null, 2));
    }).catch((e) => setError(errorMessage(e)));
    void getFairValueUnderlyings().then((r) => {
      if (!mounted.current) return;
      setUnderlyings(r.underlyings);
      if (!r.underlyings.some((u) => u.symbol === "NIFTY") && r.underlyings[0]) setSymbol(r.underlyings[0].symbol);
    }).catch((e) => setError(errorMessage(e)));
    return () => { mounted.current = false; };
  }, []);

  const refresh = useCallback(async () => {
    const requested = selectedSymbol.current;
    setBusy(true); setError(null); setHistorical(false);
    try {
      const r = await refreshFairValue(requested);
      if (!mounted.current || requested !== selectedSymbol.current) return;
      setStatus(r.status); acceptSnapshot(r.snapshot);
    } catch (e) { if (mounted.current) setError(errorMessage(e)); }
    finally { if (mounted.current) setBusy(false); }
  }, []);

  useEffect(() => {
    acceptSnapshot(null); setIndependent({}); setDetail(null); setCalculation(null); setHistorical(false);
    if (status?.enabled && !status.paused) void refresh();
  }, [symbol, status?.enabled, status?.paused, refresh]);

  useEffect(() => {
    if (viewPaused || historical) return;
    const controller = new AbortController();
    let running = false;
    const poll = async () => {
      if (running) return;
      running = true;
      const requested = selectedSymbol.current;
      try {
        const r = await getFairValueSnapshot(requested, controller.signal);
        if (!mounted.current || controller.signal.aborted || requested !== selectedSymbol.current) return;
        setStatus(r.status); acceptSnapshot(r.snapshot, r.surface_age_ms); setStale(r.stale);
      } catch (e) { if (!controller.signal.aborted) setError(errorMessage(e)); }
      finally { running = false; }
    };
    const timer = window.setInterval(() => void poll(), 5000);
    void poll();
    return () => { window.clearInterval(timer); controller.abort(); };
  }, [viewPaused, historical, symbol]);

  useEffect(() => {
    if (!slice) return;
    setExpiry(slice.expiry);
    if (slice.expiry_timestamp) setCalcExpiry(utcToLocalInput(slice.expiry_timestamp));
    const closest = slice.rows.find((r) => r.fair_value !== null) ?? slice.rows[0];
    if (closest) setCalcStrike(String(closest.strike));
  }, [slice?.expiry]);

  const filtered = useMemo(() => slice?.rows.filter((r) => `${r.strike} ${r.side} ${r.tradingsymbol} ${r.quality} ${r.reasons.join(" ")}`.toLowerCase().includes(search.toLowerCase())) ?? [], [slice, search]);
  const fitted = slice ? fittedPoints(slice) : [];
  const observations = slice?.observations ?? [];
  const independentKey = (strike: number) => `${snapshot?.input_snapshot_id}:${slice?.expiry}:${strike}`;

  async function saveConfiguration(patch?: unknown) {
    setBusy(true); setError(null);
    try {
      const result = await setFairValueConfig(patch ?? JSON.parse(configText));
      setStatus(result.status);
      const c = await getFairValueConfig(); setConfig(c); setConfigText(JSON.stringify(c.config, null, 2));
      setNotice(result.persisted ? "Analytics configuration saved." : "Applied in memory; configuration storage is unavailable. See persistence status.");
      if (result.status.enabled && !result.status.paused) await refresh();
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  }

  async function calculate(event: React.FormEvent) {
    event.preventDefault();
    const timestamp = localInputToUtc(calcExpiry);
    const strike = Number(calcStrike);
    if (!timestamp || !Number.isFinite(strike) || strike <= 0) { setError("Enter a positive strike and exact future expiry time in IST."); return; }
    setBusy(true); setError(null);
    const inputId = snapshot?.input_snapshot_id;
    try {
      const result = await calculateFairValue({ underlying: symbol, strike, expiry_timestamp: timestamp, side: calcSide, research_mode: research,
        ...(inputId ? { input_snapshot_id: inputId } : {}) });
      if (snapshotKey.current === result.input_snapshot_id) setCalculation(result);
      else setNotice("The surface refreshed while calculating; request a value from the current snapshot.");
    }
    catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  }

  async function loadIndependent(row: Row) {
    if (!snapshot || !slice) return;
    const key = independentKey(row.strike);
    setIndependentBusy(true); setError(null);
    try {
      const result = await independentFairValue(symbol, slice.expiry, row.strike, snapshot.input_snapshot_id);
      if (snapshotKey.current !== result.input_snapshot_id) { setNotice("Surface refreshed while refitting; select the current contract again."); return; }
      setIndependent((previous) => Object.fromEntries([...Object.entries(previous), [key, result]].slice(-64)));
    } catch (e) { setError(errorMessage(e)); }
    finally { setIndependentBusy(false); }
  }

  async function download() {
    try {
      const data = await exportFairValue(symbol);
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
      const link = document.createElement("a"); link.href = url; link.download = `fair-value-${symbol}.json`; link.click(); URL.revokeObjectURL(url);
    } catch (e) { setError(errorMessage(e)); }
  }

  async function openHistory(id: string) {
    setHistorical(true); setIndependent({}); setDetail(null); setCalculation(null);
    try {
      const result = await getFairValueHistoricalSnapshot(symbol, id);
      if (mounted.current) acceptSnapshot(result.snapshot);
    } catch (e) { setError(errorMessage(e)); }
  }

  return <div className="app fv-page">
    <header className="topbar"><div className="brand"><BrandMark /><div className="card-title"><h1>Fair Value</h1><span>Market-consistent option analytics · Full admin</span></div></div><div className="toolbar"><ThemeToggle /><button className="btn" onClick={onBack}>Back to Calspread</button></div></header>
    <main className="fv-main">
      <p className="fv-purpose">Theoretical values fitted to eligible current market quotes. These are model estimates, not objectively true prices or predictions of realized volatility. Premiums: <strong>₹ per underlying unit</strong>; IV: <strong>annualized %</strong>.</p>
      {error && <div className="error" role="alert">{error}</div>}
      {notice && <div className="fv-notice" role="status">{notice}</div>}
      <section className="fv-card fv-controls" aria-label="Valuation controls">
        <label>Underlying<select aria-label="Underlying" value={symbol} onChange={(e) => setSymbol(e.target.value)}>{!underlyings.length && <option value={symbol}>{symbol}</option>}{underlyings.map((u) => <option key={u.symbol} value={u.symbol}>{u.symbol} — {u.name}</option>)}</select></label>
        <label>Listed expiry<select aria-label="Listed expiry" value={slice?.expiry ?? expiry} onChange={(e) => { setExpiry(e.target.value); setDetail(null); }}>{(snapshot?.slices ?? []).map((s) => <option key={s.expiry} value={s.expiry}>{s.expiry} · {s.expiry_timestamp ? localTimestamp(s.expiry_timestamp) : "time unverified"}</option>)}</select></label>
        <button className="btn btn--primary" disabled={busy || !status?.enabled || status.paused} onClick={() => void refresh()}>{busy ? "Calculating…" : "Refresh"}</button>
        <button className="btn" onClick={() => setViewPaused((p) => !p)} aria-pressed={viewPaused}>{viewPaused ? "Resume display" : "Pause display"}</button>
        <button className="btn" disabled={busy || !status?.enabled} onClick={() => void pauseFairValue(!status?.paused).then((r) => setStatus(r.status)).catch((e) => setError(errorMessage(e)))}>{status?.paused ? "Resume analytics" : "Pause analytics"}</button>
        <button className="btn" onClick={() => setConfigOpen((v) => !v)}>Configuration</button>
        <button className="btn" disabled={!snapshot} onClick={() => void download()}>Export snapshot</button>
      </section>
      <section className="fv-card fv-status" aria-label="Feed and surface status">
        <Stat label="Analytics" value={!status?.enabled ? "Disabled" : status.paused ? "Paused" : "Enabled"} />
        <Stat label="Feed" value={`${status?.broker ?? "—"} · ${status?.feed.connected ? "connected" : "disconnected"}`} />
        <Stat label="Surface" value={historical ? "Historical — no live valuation" : surfaceStale ? "Stale / expired — calculator unavailable" : snapshot ? `${number(displayAge / 1000, 1)}s old` : "Awaiting eligible inputs"} />
        <Stat label="Published" value={localTimestamp(snapshot?.published_at)} /><Stat label="Storage" value={status?.storage ?? "—"} />
        <Stat label="Workers" value={`${status?.workers.running ?? 0} running / ${status?.workers.queued ?? 0} queued`} />
        {status?.last_error && <p className="fv-warning">Worker: {status.last_error}</p>}{status?.persistence_error && <p className="fv-warning">Storage: {status.persistence_error}</p>}
      </section>
      {surfaceStale && snapshot && !historical && <p className="fv-notice" role="status">Surface is stale or the viewed expiry has passed. Displayed estimates are snapshot-only; current calculator and independent refits are unavailable until refreshed.</p>}
      {(!status?.enabled || !status.expiry_policy_configured || !status.curve_configured) && <section className="fv-card fv-warning"><h2>Configuration needed</h2><ul>{!status?.enabled && <li>Analytics is independently disabled. <button className="btn" disabled={busy} onClick={() => void saveConfiguration({ enabled: true })}>Enable analytics</button></li>}{!status?.expiry_policy_configured && <li>Expiry timestamps need a verified exchange-time policy or exact instrument metadata. Date-only contracts remain unavailable.</li>}{!status?.curve_configured && <li>Supply a versioned continuous-zero discount curve or explicitly configured flat-rate assumption.</li>}</ul></section>}
      {configOpen && <section className="fv-card"><h2>Analytics configuration</h2><p>Decimal rates/IV, exact UTC source timestamps, ACT/365F. The expiry policy must include a verified source, version, `Asia/Kolkata` local time and exceptional instrument overrides. Flat-rate fallback and research extrapolation are explicit opt-ins.</p><textarea aria-label="Analytics configuration JSON" className="fv-config-json" value={configText} onChange={(e) => setConfigText(e.target.value)} spellCheck={false} /><button className="btn btn--primary" disabled={busy} onClick={() => void saveConfiguration()}>Apply configuration</button><span> {config?.persisted ? "Saved" : "Memory-only or not yet saved"} · version {config?.version}</span></section>}
      {slice && <>
        <section className="fv-grid fv-grid--assumptions">
          <div className="fv-card"><h2>Forward and discount assumptions</h2><div className="fv-stats"><Stat label="F(T), ₹/unit" value={number(slice.forward.value)} /><Stat label="D(T)" value={number(slice.discount?.d, 8)} /><Stat label="Continuous zero rate" value={displayIv(slice.discount?.zero_rate)} /><Stat label="Time, ACT/365F years" value={number(slice.t, 8)} /><Stat label="Parity pairs" value={String(slice.forward.pair_count)} /><Stat label="Forward dispersion, ₹/unit" value={number(slice.forward.dispersion)} /><Stat label="Quote dispersion" value={`${slice.snapshot_dispersion_ms}ms`} /><Stat label="Method" value={slice.forward.source.replace(/_/g, " ")} /></div><p>{slice.discount?.assumption ?? slice.discount?.reason}</p><p>{slice.discount?.provenance.source} · {slice.discount?.provenance.version} · {localTimestamp(slice.discount?.provenance.as_of)}</p>{slice.forward.assumptions.map((a) => <p key={a}>{a}</p>)}<p>Expiry: {localTimestamp(slice.expiry_timestamp)} · Source: {slice.rows.find((r) => r.metadata)?.metadata?.expiry_source ?? "unverified"}</p><p>Spot: ₹{number(snapshot?.spot?.value)} · {localTimestamp(snapshot?.spot?.timestamp)}</p></div>
          <div className="fv-card"><h2>Calibration diagnostics</h2><div className="fv-stats"><Stat label="Model" value={slice.smile.method.replace(/_/g, " ")} /><Stat label="Quality" value={slice.quality} /><Stat label="Observations / strikes" value={`${slice.smile.calibration.observation_count} / ${slice.smile.calibration.distinct_strikes}`} /><Stat label="Inside bid/ask" value={`${number(slice.smile.calibration.inside_spread_percent, 1)}%`} /><Stat label="Normalized price RMSE" value={number(slice.smile.calibration.normalized_rmse, 3)} /><Stat label="Fit time" value={`${number(slice.smile.calibration.duration_ms, 1)}ms`} /><Stat label="Optimizer" value={slice.smile.calibration.optimizer_status} /><Stat label="Minimum g(k)" value={number(slice.smile.butterfly.min_g, 5)} /></div><p>{reasonText(slice.reasons)}</p>{slice.smile.parameters && <pre>{JSON.stringify(slice.smile.parameters, null, 2)}</pre>}<p>Numerical diagnostics are not a global arbitrage proof.</p><details><summary>Diagnostics and excluded inputs</summary><ul>{slice.diagnostics.map((d, i) => <li key={i} className={d.severity === "error" ? "fv-warning" : ""}>{d.code}: {d.message}</li>)}{slice.smile.calibration.rejected.map((r, i) => <li key={`r-${i}`}>Token {r.token}: {r.reason}</li>)}{slice.forward.excluded_pairs.map((p) => <li key={`p-${p.strike}`}>Forward pair {p.strike}: {reasonText(p.reasons)}</li>)}</ul></details></div>
        </section>
        <section className="fv-grid">
          <div className="fv-card"><h2>Observed and fitted IV smile</h2><FairValueChart xLabel="Forward log-moneyness k = ln(K/F)" yLabel="Annualized IV" percent series={[{ label: "Observed eligible IV", color: "var(--series-1)", dots: true, points: observations.map((o) => ({ x: o.k, y: o.iv })) }, { label: "Fitted surface IV", color: "var(--series-2)", points: fitted.map((p) => ({ x: p.x, y: p.iv })) }]} /></div>
          <div className="fv-card"><h2>Total-variance smile</h2><FairValueChart xLabel="Forward log-moneyness k" yLabel="Total variance w = IV² × T" series={[{ label: "Observed w", color: "var(--series-1)", dots: true, points: observations.map((o) => ({ x: o.k, y: o.w })) }, { label: "Fitted w", color: "var(--series-3)", points: fitted.map((p) => ({ x: p.x, y: p.w })) }]} /></div>
          <div className="fv-card"><h2>ATM-IV maturity structure</h2><FairValueChart xLabel="ACT/365F years to expiry" yLabel="ATM annualized IV" percent series={[{ label: "Validated listed expiries", color: "var(--series-1)", points: (snapshot?.slices ?? []).filter((s) => s.t !== null && s.atm_iv !== null).map((s) => ({ x: s.t!, y: s.atm_iv! })) }]} /><p>ATM means forward log-moneyness k=0. Maturity interpolation uses total variance, not annualized IV.</p></div>
          <div className="fv-card"><h2>Fitted price residuals</h2><FairValueChart xLabel="Strike, ₹" yLabel="Model minus midpoint, ₹/unit" series={[{ label: "CE", color: "var(--series-1)", dots: true, points: slice.smile.calibration.residuals.filter((r) => r.side === "CE").map((r) => ({ x: r.strike, y: r.residual })) }, { label: "PE", color: "var(--series-3)", dots: true, points: slice.smile.calibration.residuals.filter((r) => r.side === "PE").map((r) => ({ x: r.strike, y: r.residual })) }]} /></div>
        </section>
      </>}
      <section className="fv-card"><div className="fv-section-header"><h2>Option chain</h2><label>Search<input aria-label="Search option chain" type="search" placeholder="Strike, CE/PE, symbol or quality…" value={search} onChange={(e) => setSearch(e.target.value)} /></label></div><p>Premium columns: ₹/unit. Δ and Γ are forward Greeks; vega is ₹/unit per 1 IV percentage point. Open a contract for per-lot comparisons and conventions.</p>
        <div className="fv-table-scroll" tabIndex={0} role="region" aria-label="Option valuation table"><table className="fv-table"><thead><tr>{["Strike", "CE/PE", "Bid ₹", "Ask ₹", "Mid ₹", "Observed IV %", "Surface IV %", "Full-chain fair ₹", "Independent fair ₹", "Model deviation ₹ / %", "ΔF / ΓF", "Vega / 1%", "Quote age", "Quality", "Estimation method"].map((h) => <th key={h}>{h}</th>)}</tr></thead><tbody>{filtered.map((r) => {
          const estimate = independent[independentKey(r.strike)];
          const independentValue = estimate?.values.find((v) => v.side === r.side)?.fair_value;
          return <tr key={r.token}><td><button className="fv-link" onClick={() => setDetail(r)}>{number(r.strike)}</button></td><td>{r.side}</td><td>{number(r.bid)}</td><td>{number(r.ask)}</td><td>{number(r.mid)}</td><td title={r.observed_iv?.reason}>{displayIv(r.observed_iv?.iv)}{r.observed_iv && r.observed_iv.status !== "valid" && <small>{r.observed_iv.status}</small>}</td><td>{displayIv(r.surface_iv)}</td><td title={reasonText(r.reasons)}>{number(r.fair_value)}</td><td title={estimate ? reasonText(estimate.reasons) : "On demand: remove both CE/PE at this strike, re-estimate forward and refit."}>{number(independentValue)}<small>{estimate?.status ?? "on demand"}</small></td><td>{r.comparison ? <>{number(r.comparison.mid_deviation)} / {number(r.comparison.mid_deviation_percent)}%<small>{r.comparison.label}</small></> : "—"}</td><td>{number(r.greeks?.forward_delta, 4)} / {number(r.greeks?.forward_gamma, 6)}</td><td>{number(r.greeks?.vega_1pct, 4)}</td><td>{r.quote ? `${number(r.quote.age_ms / 1000, 1)}s` : "—"}<small>{r.quote?.freshness_basis ?? reasonText(r.reasons)}</small></td><td><span className={`fv-quality fv-quality--${r.quality}`} title={reasonText(r.reasons)}>{r.quality}</span></td><td>{r.estimation_method.replace(/_/g, " ")}</td></tr>;
        })}</tbody></table></div>{!filtered.length && <p className="chart-empty">No option rows available. Check analytics configuration, broker feed and selected underlying.</p>}
      </section>
      <section className="fv-grid">
        <div className="fv-card"><h2>Custom strike / expiry calculator</h2><p>Unlisted strikes or timestamps are <strong>hypothetical, non-tradeable valuations</strong>. Time entered below is IST (Asia/Kolkata).</p><form className="fv-calculator" onSubmit={(e) => void calculate(e)}><label>Underlying<input aria-label="Calculator underlying" value={symbol} readOnly /></label><label>Positive strike, ₹<input aria-label="Calculator strike" type="number" min="0.000001" step="any" required value={calcStrike} onChange={(e) => setCalcStrike(e.target.value)} /></label><label>Future expiry date/time (IST)<input aria-label="Calculator expiry IST" type="datetime-local" step="1" required value={calcExpiry} onChange={(e) => setCalcExpiry(e.target.value)} /></label><label>Call / put<select aria-label="Calculator call put" value={calcSide} onChange={(e) => setCalcSide(e.target.value as OptionSide)}><option value="CE">Call (CE)</option><option value="PE">Put (PE)</option></select></label><label className="fv-checkbox"><input type="checkbox" checked={research} onChange={(e) => setResearch(e.target.checked)} />Explicit research-mode extrapolation opt-in</label><button className="btn btn--primary" disabled={busy || !privateReady || !snapshot}>Calculate theoretical value</button></form>{calculation && <div className="fv-calculation" aria-live="polite"><h3>{calculation.contract === "hypothetical" ? "Hypothetical contract" : "Listed contract"} · {calculation.quality}</h3><p>Valuation: {localTimestamp(calculation.valuation_time)} · config {calculation.config_version}</p><div className="fv-stats"><Stat label="Theoretical ₹/unit" value={number(calculation.fair_value)} /><Stat label="₹/actual lot" value={number(calculation.fair_value_per_lot)} /><Stat label="Surface IV" value={displayIv(calculation.surface_iv)} /><Stat label="Total variance" value={number(calculation.total_variance, 8)} /><Stat label="Forward" value={number(calculation.forward)} /><Stat label="Discount" value={number(calculation.discount, 8)} /></div><p>{calculation.strike_method} · {calculation.maturity_method}</p><p>{reasonText(calculation.reasons)}</p>{calculation.assumptions.map((a) => <p key={a}>{a}</p>)}{calculation.greeks && <GreeksView greeks={calculation.greeks} />}{calculation.sensitivity && <details><summary>{calculation.sensitivity.label}: ₹{number(calculation.sensitivity.low)}–₹{number(calculation.sensitivity.high)} / unit</summary>{calculation.sensitivity.scenarios.map((s) => <p key={s.name}>{s.name}: ₹{number(s.price)} · {s.assumption}</p>)}</details>}</div>}</div>
        <div className="fv-card"><h2>Versioned history and model validity</h2><p>Historical snapshots retain model/config versions, input IDs, assumptions and diagnostics within bounded retention. They are not refreshed or usable as current calculator inputs.</p><button className="btn" onClick={() => void getFairValueHistory(symbol).then((r) => setHistory(r.snapshots)).catch((e) => setError(errorMessage(e)))}>Load bounded history</button>{historical && <button className="btn" onClick={() => { setHistorical(false); void refresh(); }}>Return to current snapshot</button>}<ul className="fv-history">{history.map((s) => <li key={s.id}><button className="fv-link" onClick={() => void openHistory(s.id)}>{localTimestamp(s.published_at)} · {s.model_version} · config {s.config_version}</button></li>)}</ul>{snapshot && <><p>Input ID: <code>{snapshot.input_snapshot_id}</code></p><p>Surface ID: <code>{snapshot.id}</code> · sequence {snapshot.sequence}</p><p>{snapshot.day_count}</p><p>Captured {snapshot.universe.captured_contracts}/{snapshot.universe.listed_contracts} listed contracts. Full-chain estimate uses all eligible observations within this bounded captured chain.</p>{snapshot.calendar_regions.map((r) => <p key={`${r.first_expiry}-${r.second_expiry}`}>{r.first_expiry} → {r.second_expiry}: {r.valid ? "validated common region" : "invalid maturity region"} · k [{number(r.min_k, 3)}, {number(r.max_k, 3)}]</p>)}</>}<p>Quality reasons expose freshness, liquidity, support, forward dispersion, price residuals, model validity, interpolation/extrapolation and surface age.</p></div>
      </section>
    </main>
    {detail && <ContractDetail
      row={detail}
      valuationTime={snapshot?.valuation_time ?? null}
      estimate={independent[independentKey(detail.strike)]}
      busy={independentBusy}
      unavailable={!privateReady}
      onClose={() => setDetail(null)}
      onIndependent={() => void loadIndependent(detail)}
    />}
  </div>;
}
