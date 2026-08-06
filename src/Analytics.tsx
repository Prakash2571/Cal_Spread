import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  fetchOptionChain,
  fetchQuotes,
  streamUrl,
  type OptionChain,
  type OptionChainStrike,
  type Tick,
} from "./api.ts";
import LineChart, { type ChartSeries } from "./LineChart.tsx";
import ThemeToggle from "./ThemeToggle.tsx";
import { fmt, fmtCompact, formatExpiry } from "./format.ts";

type TickMap = Record<number, Tick>;

/** The underlying this analytics page is built for. */
const UNDERLYING = "NIFTY";

const DISPLAY_HALF = 30; // show ATM ± 30 strikes
const TOTAL_UP = 24; // total-OI window: 24 strikes above ATM
const TOTAL_DOWN = 26; // total-OI window: 26 strikes below ATM
const BUCKET_HALF = 30; // OI-change buckets: 30 above / ATM / 30 below

const SAMPLE_MS = 5000; // how often we snapshot OI/price for history + charts
const HIST_MS = 20 * 60 * 1000; // keep 20 min of rolling samples per token
const MAX_SERIES_POINTS = 720; // cap chart series length (~1h at 5s)

/** One rolling snapshot for a single option token. */
interface Sample {
  t: number;
  oi: number;
  ltp: number;
}

type Buildup =
  | "long_buildup"
  | "short_buildup"
  | "short_covering"
  | "long_unwinding"
  | null;

/** Classic OI interpretation from the sign of ΔOI and ΔPrice over a window. */
function classifyBuildup(dOi: number, dPrice: number): Buildup {
  if (dOi === 0 || dPrice === 0) return null;
  if (dOi > 0 && dPrice > 0) return "long_buildup";
  if (dOi > 0 && dPrice < 0) return "short_buildup";
  if (dOi < 0 && dPrice > 0) return "short_covering";
  return "long_unwinding";
}

const BUILDUP_LABEL: Record<Exclude<Buildup, null>, string> = {
  long_buildup: "LB",
  short_buildup: "SB",
  short_covering: "SC",
  long_unwinding: "LU",
};
const BUILDUP_TITLE: Record<Exclude<Buildup, null>, string> = {
  long_buildup: "Long Buildup — OI ↑, Price ↑ (fresh longs)",
  short_buildup: "Short Buildup — OI ↑, Price ↓ (fresh shorts)",
  short_covering: "Short Covering — OI ↓, Price ↑",
  long_unwinding: "Long Unwinding — OI ↓, Price ↓",
};

/** Index of the strike whose value is closest to `spot`. */
function nearestStrikeIdx(strikes: OptionChainStrike[], spot: number): number {
  if (strikes.length === 0) return 0;
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < strikes.length; i++) {
    const d = Math.abs(strikes[i]!.strike - spot);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

interface Props {
  /** Whether a Zerodha session is live on the backend (data can flow). */
  authenticated: boolean;
  onBack: () => void;
}

export default function Analytics({ authenticated, onBack }: Props) {
  const [chain, setChain] = useState<OptionChain | null>(null);
  const [desiredExpiry, setDesiredExpiry] = useState<string>(""); // "" = nearest
  const [ticks, setTicks] = useState<TickMap>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [interval, setIntervalMin] = useState<5 | 15>(5);
  const [expandedChart, setExpandedChart] = useState<
    "straddle" | "oi" | "hist" | null
  >(null);

  // Live chart series (accumulated from the stream during the session).
  const [straddleSeries, setStraddleSeries] = useState<
    { date: string; value: number }[]
  >([]);
  const [ceOiSeries, setCeOiSeries] = useState<{ date: string; value: number }[]>([]);
  const [peOiSeries, setPeOiSeries] = useState<{ date: string; value: number }[]>([]);

  const tickBuffer = useRef<TickMap>({});
  const ticksRef = useRef<TickMap>({});
  const chainRef = useRef<OptionChain | null>(null);
  const histRef = useRef<Map<number, Sample[]>>(new Map());
  const atmRowRef = useRef<HTMLTableRowElement | null>(null);
  const didCenterRef = useRef(false);

  chainRef.current = chain;

  // ---- Load the option chain (nearest expiry, or the user-picked one) ----
  useEffect(() => {
    if (!authenticated) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchOptionChain(UNDERLYING, desiredExpiry || undefined)
      .then((c) => {
        if (cancelled) return;
        // Reset per-chain accumulators when the instrument set changes.
        histRef.current = new Map();
        didCenterRef.current = false;
        setStraddleSeries([]);
        setCeOiSeries([]);
        setPeOiSeries([]);
        setTicks({});
        tickBuffer.current = {};
        ticksRef.current = {};
        setChain(c);
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setError(err instanceof Error ? err.message : "Failed to load option chain.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [authenticated, desiredExpiry]);

  // ---- Live stream: seed via REST, then stream LTP + OI over SSE ----
  useEffect(() => {
    if (!authenticated || !chain) return;

    const tokens = [
      chain.spot_token,
      ...chain.strikes.flatMap((s) => [s.ce_token, s.pe_token]),
    ];

    fetchQuotes(tokens)
      .then((seed) => {
        if (seed.length === 0) return;
        setTicks((prev) => {
          const next = { ...prev };
          for (const t of seed) next[t.token] = t;
          return next;
        });
        ticksRef.current = { ...ticksRef.current };
        for (const t of seed) ticksRef.current[t.token] = t;
      })
      .catch(() => {
        /* stream may still fill values during market hours */
      });

    const es = new EventSource(streamUrl(tokens));
    const flush = window.setInterval(() => {
      if (Object.keys(tickBuffer.current).length === 0) return;
      setTicks((prev) => {
        const next = { ...prev, ...tickBuffer.current };
        ticksRef.current = next;
        return next;
      });
      tickBuffer.current = {};
    }, 500);

    es.onmessage = (ev) => {
      try {
        const incoming = JSON.parse(ev.data) as Tick[];
        for (const t of incoming) tickBuffer.current[t.token] = t;
        setLive(true);
      } catch {
        /* ignore malformed frame */
      }
    };
    es.addEventListener("kite_error", () => {
      setLive(false);
      es.close();
    });
    es.onerror = () => setLive(false);

    return () => {
      window.clearInterval(flush);
      es.close();
    };
  }, [authenticated, chain]);

  // ---- Periodic sampling: rolling per-token history + chart points ----
  useEffect(() => {
    if (!authenticated || !chain) return;
    const id = window.setInterval(() => {
      const ch = chainRef.current;
      const tk = ticksRef.current;
      if (!ch) return;
      const now = Date.now();

      // Per-token rolling history (for timeframe OI/price change).
      for (const s of ch.strikes) {
        for (const token of [s.ce_token, s.pe_token]) {
          const cur = tk[token];
          if (!cur) continue;
          const arr = histRef.current.get(token) ?? [];
          arr.push({ t: now, oi: cur.oi ?? 0, ltp: cur.last_price ?? 0 });
          while (arr.length && now - arr[0]!.t > HIST_MS) arr.shift();
          histRef.current.set(token, arr);
        }
      }

      // Chart points: ATM straddle + total Call/Put OI (24/1/26 window).
      const spot = tk[ch.spot_token]?.last_price ?? ch.spot;
      const atmIdx = nearestStrikeIdx(ch.strikes, spot);
      const atm = ch.strikes[atmIdx];
      const iso = new Date(now).toISOString();

      if (atm) {
        const ceLtp = tk[atm.ce_token]?.last_price ?? 0;
        const peLtp = tk[atm.pe_token]?.last_price ?? 0;
        if (ceLtp > 0 && peLtp > 0) {
          setStraddleSeries((prev) =>
            [...prev, { date: iso, value: ceLtp + peLtp }].slice(-MAX_SERIES_POINTS),
          );
        }
      }

      const lo = clamp(atmIdx - TOTAL_DOWN, 0, ch.strikes.length - 1);
      const hi = clamp(atmIdx + TOTAL_UP, 0, ch.strikes.length - 1);
      let totCe = 0;
      let totPe = 0;
      for (let i = lo; i <= hi; i++) {
        totCe += tk[ch.strikes[i]!.ce_token]?.oi ?? 0;
        totPe += tk[ch.strikes[i]!.pe_token]?.oi ?? 0;
      }
      if (totCe > 0)
        setCeOiSeries((prev) =>
          [...prev, { date: iso, value: totCe }].slice(-MAX_SERIES_POINTS),
        );
      if (totPe > 0)
        setPeOiSeries((prev) =>
          [...prev, { date: iso, value: totPe }].slice(-MAX_SERIES_POINTS),
        );
    }, SAMPLE_MS);
    return () => window.clearInterval(id);
  }, [authenticated, chain]);

  // ---- Derived metrics for the chain table + summary strip ----
  const metrics = useMemo(() => {
    if (!chain || chain.strikes.length === 0) return null;
    const strikes = chain.strikes;
    const spot = ticks[chain.spot_token]?.last_price ?? chain.spot;
    const atmIdx = nearestStrikeIdx(strikes, spot);
    const atmStrike = strikes[atmIdx]?.strike ?? chain.atm_strike;
    const cutoff = Date.now() - interval * 60 * 1000;

    // Base (interval-ago) sample for a token: newest sample at/at-before cutoff,
    // else the oldest sample we have (so a value appears as soon as we can).
    const baseOf = (token: number): Sample | null => {
      const arr = histRef.current.get(token);
      if (!arr || arr.length === 0) return null;
      let base: Sample | null = null;
      for (const s of arr) {
        if (s.t <= cutoff) base = s;
        else break;
      }
      return base ?? arr[0]!;
    };

    const changeFor = (token: number) => {
      const cur = ticks[token];
      const base = baseOf(token);
      if (!cur || !base) return { oiPct: null as number | null, buildup: null as Buildup };
      const dOi = (cur.oi ?? 0) - base.oi;
      const dPrice = (cur.last_price ?? 0) - base.ltp;
      const oiPct = base.oi > 0 ? (dOi / base.oi) * 100 : null;
      return { oiPct, buildup: classifyBuildup(dOi, dPrice) };
    };

    const dispLo = clamp(atmIdx - DISPLAY_HALF, 0, strikes.length - 1);
    const dispHi = clamp(atmIdx + DISPLAY_HALF, 0, strikes.length - 1);
    const rows = [];
    for (let i = dispLo; i <= dispHi; i++) {
      const s = strikes[i]!;
      const ce = ticks[s.ce_token];
      const pe = ticks[s.pe_token];
      const ceCh = changeFor(s.ce_token);
      const peCh = changeFor(s.pe_token);
      rows.push({
        strike: s.strike,
        isAtm: i === atmIdx,
        ceLtp: ce?.last_price ?? null,
        ceOi: ce?.oi ?? null,
        ceOiPct: ceCh.oiPct,
        ceBuildup: ceCh.buildup,
        peLtp: pe?.last_price ?? null,
        peOi: pe?.oi ?? null,
        peOiPct: peCh.oiPct,
        peBuildup: peCh.buildup,
      });
    }

    // Total OI (24 above / ATM / 26 below).
    const totLo = clamp(atmIdx - TOTAL_DOWN, 0, strikes.length - 1);
    const totHi = clamp(atmIdx + TOTAL_UP, 0, strikes.length - 1);
    let totalCe = 0;
    let totalPe = 0;
    for (let i = totLo; i <= totHi; i++) {
      totalCe += ticks[strikes[i]!.ce_token]?.oi ?? 0;
      totalPe += ticks[strikes[i]!.pe_token]?.oi ?? 0;
    }
    const pcr = totalCe > 0 ? totalPe / totalCe : null;

    // OI-change % buckets: above (30), ATM, below (30) — per side.
    const bucketPct = (from: number, to: number, side: "ce" | "pe"): number | null => {
      let cur = 0;
      let base = 0;
      let have = false;
      for (let i = from; i <= to; i++) {
        const tok = side === "ce" ? strikes[i]!.ce_token : strikes[i]!.pe_token;
        const t = ticks[tok];
        const b = baseOf(tok);
        if (t && b) {
          cur += t.oi ?? 0;
          base += b.oi;
          have = true;
        }
      }
      if (!have || base <= 0) return null;
      return ((cur - base) / base) * 100;
    };

    const aboveLo = clamp(atmIdx + 1, 0, strikes.length - 1);
    const aboveHi = clamp(atmIdx + BUCKET_HALF, 0, strikes.length - 1);
    const belowLo = clamp(atmIdx - BUCKET_HALF, 0, strikes.length - 1);
    const belowHi = clamp(atmIdx - 1, 0, strikes.length - 1);

    const buckets = {
      ce: {
        above: bucketPct(aboveLo, aboveHi, "ce"),
        atm: bucketPct(atmIdx, atmIdx, "ce"),
        below: bucketPct(belowLo, belowHi, "ce"),
      },
      pe: {
        above: bucketPct(aboveLo, aboveHi, "pe"),
        atm: bucketPct(atmIdx, atmIdx, "pe"),
        below: bucketPct(belowLo, belowHi, "pe"),
      },
    };

    return { rows, atmStrike, spot, totalCe, totalPe, pcr, buckets };
  }, [chain, ticks, interval]);

  // Center the ATM row once the chain + first ticks are in.
  useEffect(() => {
    if (didCenterRef.current || !metrics || !atmRowRef.current) return;
    atmRowRef.current.scrollIntoView({ block: "center" });
    didCenterRef.current = true;
  }, [metrics]);

  const timeFmt = (iso: string) =>
    new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

  const straddleChart: ChartSeries[] = [
    { label: "ATM Straddle", color: "var(--series-1)", points: straddleSeries },
  ];
  const oiChart: ChartSeries[] = [
    { label: "Call OI", color: "var(--neg)", points: ceOiSeries },
    { label: "Put OI", color: "var(--pos)", points: peOiSeries },
  ];

  const pctCell = (v: number | null) =>
    v === null ? (
      <span className="an-muted">—</span>
    ) : (
      <span className={v > 0 ? "pos" : v < 0 ? "neg" : ""}>
        {v > 0 ? "+" : ""}
        {v.toFixed(1)}%
      </span>
    );

  const buildupBadge = (b: Buildup) =>
    b === null ? null : (
      <span className={`an-bld an-bld--${b}`} title={BUILDUP_TITLE[b]}>
        {BUILDUP_LABEL[b]}
      </span>
    );

  return (
    <div className="app an-page">
      <header className="topbar">
        <div className="brand">
          <button className="btn an-back" onClick={onBack} title="Back to board">
            ← Board
          </button>
          <div className="card-title">
            <h1>Options Analytics</h1>
            <span className="an-underline">{chain?.name ?? "NIFTY 50"}</span>
          </div>
        </div>

        <div className="toolbar">
          <ThemeToggle />
          {chain && (
            <label className="an-select">
              <span>Expiry</span>
              <select
                value={desiredExpiry || chain.expiry}
                onChange={(e) => setDesiredExpiry(e.target.value)}
              >
                {chain.expiries.map((e) => (
                  <option key={e} value={e}>
                    {formatExpiry(e)}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="an-toggle" role="group" aria-label="OI change timeframe">
            {([5, 15] as const).map((m) => (
              <button
                key={m}
                className={`btn${interval === m ? " btn--primary" : ""}`}
                onClick={() => setIntervalMin(m)}
              >
                {m}m
              </button>
            ))}
          </div>
          {metrics && (
            <span className="an-spot">
              Spot <strong>{fmt(metrics.spot)}</strong> · ATM{" "}
              <strong>{metrics.atmStrike}</strong>
            </span>
          )}
          <span className={`status status--${live ? "live" : "wait"}`}>
            <span className="status-dot" />
            {live ? "Live" : authenticated ? "Connecting…" : "Offline"}
          </span>
        </div>
      </header>

      {!authenticated && (
        <div className="banner">
          Live options data will appear here once an admin has connected Zerodha.
        </div>
      )}
      {error && <div className="banner banner--error">{error}</div>}
      {loading && !chain && <div className="banner">Loading option chain…</div>}

      {metrics && (
        <>
          {/* ---- Summary strip ---- */}
          <div className="an-summary">
            <div className="an-stat">
              <span className="an-stat-k">Total Call OI</span>
              <span className="an-stat-v neg">{fmtCompact(metrics.totalCe)}</span>
              <span className="an-stat-sub">24↑ · ATM · 26↓</span>
            </div>
            <div className="an-stat">
              <span className="an-stat-k">Total Put OI</span>
              <span className="an-stat-v pos">{fmtCompact(metrics.totalPe)}</span>
              <span className="an-stat-sub">24↑ · ATM · 26↓</span>
            </div>
            <div className="an-stat">
              <span className="an-stat-k">PCR (OI)</span>
              <span className="an-stat-v">
                {metrics.pcr === null ? "—" : metrics.pcr.toFixed(2)}
              </span>
              <span className="an-stat-sub">Put ÷ Call</span>
            </div>
            <div className="an-stat an-stat--wide">
              <span className="an-stat-k">Call OI Δ% ({interval}m)</span>
              <span className="an-stat-buckets">
                <span>Above {pctCell(metrics.buckets.ce.above)}</span>
                <span>ATM {pctCell(metrics.buckets.ce.atm)}</span>
                <span>Below {pctCell(metrics.buckets.ce.below)}</span>
              </span>
            </div>
            <div className="an-stat an-stat--wide">
              <span className="an-stat-k">Put OI Δ% ({interval}m)</span>
              <span className="an-stat-buckets">
                <span>Above {pctCell(metrics.buckets.pe.above)}</span>
                <span>ATM {pctCell(metrics.buckets.pe.atm)}</span>
                <span>Below {pctCell(metrics.buckets.pe.below)}</span>
              </span>
            </div>
          </div>

          {/* ---- Option chain (scrollable, ATM-centered) ---- */}
          <div className="an-chain-wrap">
            <table className="an-chain">
              <thead>
                <tr className="an-chain-side">
                  <th colSpan={4} className="an-calls">CALLS</th>
                  <th className="an-strike-h">STRIKE</th>
                  <th colSpan={4} className="an-puts">PUTS</th>
                </tr>
                <tr>
                  <th>OI</th>
                  <th>OI Δ%</th>
                  <th>Bld</th>
                  <th>LTP</th>
                  <th className="an-strike-h">{interval}m</th>
                  <th>LTP</th>
                  <th>Bld</th>
                  <th>OI Δ%</th>
                  <th>OI</th>
                </tr>
              </thead>
              <tbody>
                {metrics.rows.map((r) => (
                  <tr
                    key={r.strike}
                    ref={r.isAtm ? atmRowRef : undefined}
                    className={`${r.isAtm ? "an-atm" : ""} an-row`}
                  >
                    <td className="num an-ce">{fmtCompact(r.ceOi)}</td>
                    <td className="num">{pctCell(r.ceOiPct)}</td>
                    <td className="an-bld-cell">{buildupBadge(r.ceBuildup)}</td>
                    <td className="num an-ce-ltp">{fmt(r.ceLtp)}</td>
                    <td className="num an-strike">{r.strike}</td>
                    <td className="num an-pe-ltp">{fmt(r.peLtp)}</td>
                    <td className="an-bld-cell">{buildupBadge(r.peBuildup)}</td>
                    <td className="num">{pctCell(r.peOiPct)}</td>
                    <td className="num an-pe">{fmtCompact(r.peOi)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* ---- Charts ---- */}
          <div className="an-charts">
            <ChartCard
              title="ATM Straddle (live)"
              expanded={expandedChart === "straddle"}
              onToggle={() =>
                setExpandedChart((c) => (c === "straddle" ? null : "straddle"))
              }
            >
              {straddleSeries.length > 1 ? (
                <LineChart series={straddleChart} format={fmt} formatX={timeFmt} />
              ) : (
                <div className="chart-empty">Collecting live straddle data…</div>
              )}
            </ChartCard>

            <ChartCard
              title="Call OI vs Put OI (live)"
              expanded={expandedChart === "oi"}
              onToggle={() => setExpandedChart((c) => (c === "oi" ? null : "oi"))}
            >
              {ceOiSeries.length > 1 || peOiSeries.length > 1 ? (
                <LineChart series={oiChart} format={fmtCompact} formatX={timeFmt} />
              ) : (
                <div className="chart-empty">Collecting live OI data…</div>
              )}
            </ChartCard>

            <ChartCard
              title="Total Put/Call OI Change — Histogram"
              expanded={expandedChart === "hist"}
              onToggle={() => setExpandedChart((c) => (c === "hist" ? null : "hist"))}
            >
              <div className="chart-empty an-placeholder">
                Reserved — histogram of total Put/Call OI change (to be defined).
              </div>
            </ChartCard>
          </div>
        </>
      )}
    </div>
  );
}

/** A chart panel with an expand-to-full / collapse toggle. */
function ChartCard({
  title,
  expanded,
  onToggle,
  children,
}: {
  title: string;
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div className={`an-chart-card${expanded ? " an-chart-card--expanded" : ""}`}>
      <div className="an-chart-head">
        <h3>{title}</h3>
        <button className="btn an-expand" onClick={onToggle} title={expanded ? "Collapse" : "Expand"}>
          {expanded ? "✕ Close" : "⤢ Expand"}
        </button>
      </div>
      <div className="an-chart-body">{children}</div>
    </div>
  );
}
