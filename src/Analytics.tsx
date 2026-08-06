import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  fetchFuturesOiFrame,
  fetchOptionChain,
  fetchOptionOiBaseline,
  fetchOptionOiFrame,
  fetchQuotes,
  streamUrl,
  type FuturesOiContract,
  type FuturesOiPoint,
  type OiFrame,
  type OptionChain,
  type OptionChainStrike,
  type Tick,
} from "./api.ts";
import LineChart, { type ChartSeries } from "./LineChart.tsx";
import OiHistogram, { type HistPoint } from "./OiHistogram.tsx";
import StraddleSpotChart, { type StraddleSpotPoint } from "./StraddleSpotChart.tsx";
import ThemeToggle from "./ThemeToggle.tsx";
import { fmt, fmtCompact, formatExpiry } from "./format.ts";

type TickMap = Record<number, Tick>;
type ChainInterval = 5 | 15;
type OptionBaseline = Record<number, { oi: number; ltp: number; t: number }>;

// Baselines are sampled once per minute on the backend. Accept the nearest
// sample just before the requested cutoff, but reject incomplete or stale
// windows instead of presenting them as exact 5m/15m calculations.
const BASELINE_OLDER_TOLERANCE_MS = 75 * 1000;
const BASELINE_NEWER_TOLERANCE_MS = 5 * 1000;

/** The underlying this analytics page is built for. */
const UNDERLYING = "NIFTY";

const DISPLAY_HALF = 30; // show ATM ± 30 strikes
const CHAIN_COMPACT_HALF = 7; // collapsed option chain: ATM ± 7 strikes
const STRADDLE_HALF = 10; // straddle chain: ATM ± 10 strikes
const TOTAL_UP = 24; // total-OI window: 24 strikes above ATM
const TOTAL_DOWN = 26; // total-OI window: 26 strikes below ATM
const BUCKET_HALF = 30; // OI-change buckets: 30 above / ATM / 30 below

/**
 * Futures series colours. Four slots, keyed off the expiry MONTH rather than the
 * contract's position: for up to a week after a monthly expiry the server still
 * reports the expired month alongside current/next/far (so its line survives to
 * the edge of retention), and any 4 consecutive months map to 4 distinct slots.
 * Month-keying also stops every line changing colour when a contract rolls off.
 */
const FUT_COLORS = [
  "var(--series-1)",
  "var(--series-2)",
  "var(--series-3)",
  "var(--series-4)",
];
const futColorFor = (expiry: string) => {
  const month = Number(expiry.slice(5, 7));
  // A degenerate entry gets a neutral colour rather than silently duplicating a
  // real series' colour.
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    return "var(--series-expired)";
  }
  return FUT_COLORS[month % FUT_COLORS.length]!;
};

const SAMPLE_MS = 5000; // how often we snapshot OI/price for buildup history
const HIST_MS = 20 * 60 * 1000; // keep 20 min of rolling samples per token

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

/**
 * Vertically center a table row inside its own scroll container.
 *
 * Deliberately not `scrollIntoView`: that walks EVERY scrollable ancestor, so on
 * this page it also drags the document to the card — which is very visible now
 * that the tables live in a six-card grid taller than the viewport.
 */
function centerRowInScroller(row: HTMLTableRowElement | null): void {
  const scroller = row?.closest<HTMLElement>(".an-chain-wrap");
  if (!row || !scroller) return;
  const rowRect = row.getBoundingClientRect();
  const scRect = scroller.getBoundingClientRect();
  // `scrollTop` is measured from the padding box, so discount the top border
  // (`clientTop`) that getBoundingClientRect includes.
  const delta =
    rowRect.top -
    (scRect.top + scroller.clientTop) -
    (scroller.clientHeight - rowRect.height) / 2;
  scroller.scrollTop += delta;
}

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
  const [oiInterval, setOiInterval] = useState<ChainInterval>(5);
  const [bldInterval, setBldInterval] = useState<ChainInterval>(5);
  const [straddleFrame, setStraddleFrame] = useState<OiFrame>("5m"); // ATM straddle chart timeframe
  const [oiFrame, setOiFrame] = useState<OiFrame>("5m"); // Call/Put OI chart timeframe
  const [histFrame, setHistFrame] = useState<OiFrame>("5m"); // OI-change histogram frame
  const [futFrame, setFutFrame] = useState<OiFrame>("5m"); // futures-OI chart timeframe
  const [histRaw, setHistRaw] = useState<
    { t: number; totalCe: number; totalPe: number }[]
  >([]);
  const [expandedCard, setExpandedCard] = useState<
    "chain" | "straddleChain" | "straddle" | "oi" | "hist" | "futoi" | null
  >(null);

  // NIFTY futures OI history (current/next/far month) from the server frames.
  const [futRaw, setFutRaw] = useState<FuturesOiPoint[]>([]);
  const [futContracts, setFutContracts] = useState<FuturesOiContract[]>([]);

  // Chart series sourced from the server frame caches.
  const [straddleRaw, setStraddleRaw] = useState<StraddleSpotPoint[]>([]);
  const [ceOiSeries, setCeOiSeries] = useState<{ date: string; value: number }[]>([]);
  const [peOiSeries, setPeOiSeries] = useState<{ date: string; value: number }[]>([]);

  // Server-provided OI + LTP baselines keyed by timeframe. Keeping both
  // caches lets OI Δ% and buildup use independent 5m/15m selections.
  const [baselines, setBaselines] = useState<Record<ChainInterval, OptionBaseline>>({
    5: {},
    15: {},
  });

  const tickBuffer = useRef<TickMap>({});
  const ticksRef = useRef<TickMap>({});
  const chainRef = useRef<OptionChain | null>(null);
  const histRef = useRef<Map<number, Sample[]>>(new Map());
  const atmRowRef = useRef<HTMLTableRowElement | null>(null);
  const straddleAtmRowRef = useRef<HTMLTableRowElement | null>(null);
  const didCenterStraddleRef = useRef(false);
  const didCenterRef = useRef(false);
  const oiScrollRef = useRef<HTMLDivElement | null>(null);
  const oiAtEndRef = useRef(true);
  const futScrollRef = useRef<HTMLDivElement | null>(null);
  const futAtEndRef = useRef(true);

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
        didCenterStraddleRef.current = false;
        setStraddleRaw([]);
        setCeOiSeries([]);
        setPeOiSeries([]);
        setBaselines({ 5: {}, 15: {} });
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

  // ---- Server baselines for independent OI Δ% and buildup timeframes ----
  useEffect(() => {
    if (!authenticated || !chain) return;
    let cancelled = false;
    const selected = Array.from(
      new Set<ChainInterval>([oiInterval, bldInterval]),
    );
    const clearSelected = () => {
      setBaselines((prev) => {
        const next = { ...prev };
        for (const frame of selected) next[frame] = {};
        return next;
      });
    };
    // Never expose a retained baseline under a newly selected timeframe while
    // its fresh request is still pending.
    clearSelected();
    const load = () => {
      for (const frame of selected) {
        fetchOptionOiBaseline(UNDERLYING, frame)
          .then((r) => {
            if (!cancelled) {
              setBaselines((prev) => ({
                ...prev,
                [frame]: r.minutes === frame ? r.tokens ?? {} : {},
              }));
            }
          })
          .catch(() => {
            if (!cancelled) {
              setBaselines((prev) => ({ ...prev, [frame]: {} }));
            }
          });
      }
    };
    load();
    const id = window.setInterval(load, 30000); // slide both windows every 30s
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [authenticated, chain, oiInterval, bldInterval]);

  // ---- Auto-ATM straddle + NIFTY spot history for the selected timeframe ----
  useEffect(() => {
    if (!authenticated || !chain) return;
    let cancelled = false;
    const load = () =>
      fetchOptionOiFrame(UNDERLYING, straddleFrame)
        .then((r) => {
          if (cancelled) return;
          setStraddleRaw(
            r.points.map((p) => ({ t: p.t, straddle: p.straddle, spot: p.spot })),
          );
        })
        .catch(() => {
          /* keep whatever we have */
        });
    load();
    const id = window.setInterval(load, 30000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [authenticated, chain, straddleFrame]);

  // ---- Call/Put OI history for the selected timeframe (server frame cache) ----
  useEffect(() => {
    if (!authenticated || !chain) return;
    let cancelled = false;
    const iso = (t: number) => new Date(t).toISOString();
    const load = () =>
      fetchOptionOiFrame(UNDERLYING, oiFrame)
        .then((r) => {
          if (cancelled) return;
          setCeOiSeries(
            r.points
              .filter((p) => p.totalCe > 0)
              .map((p) => ({ date: iso(p.t), value: p.totalCe })),
          );
          setPeOiSeries(
            r.points
              .filter((p) => p.totalPe > 0)
              .map((p) => ({ date: iso(p.t), value: p.totalPe })),
          );
        })
        .catch(() => {
          /* keep whatever we have */
        });
    load();
    const id = window.setInterval(load, 60000); // OI moves slowly; 60s refresh
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [authenticated, chain, oiFrame]);

  // ---- OI-change histogram data for the selected timeframe ----
  useEffect(() => {
    if (!authenticated || !chain) return;
    let cancelled = false;
    const load = () =>
      fetchOptionOiFrame(UNDERLYING, histFrame)
        .then((r) => {
          if (!cancelled) setHistRaw(r.points);
        })
        .catch(() => {
          /* keep whatever we have */
        });
    load();
    const id = window.setInterval(load, 60000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [authenticated, chain, histFrame]);

  // ---- NIFTY futures OI (current/next/far) for the selected timeframe ----
  // Served by its own frame cache, but gated on `chain` because the card only
  // renders once the chain-derived metrics exist — no point polling before that.
  useEffect(() => {
    if (!authenticated || !chain) return;
    let cancelled = false;
    const load = () =>
      fetchFuturesOiFrame(UNDERLYING, futFrame)
        .then((r) => {
          if (cancelled) return;
          // The server coerces an unknown frame to 5m; ignore a mismatched
          // response rather than labelling it with the requested timeframe.
          if (r.frame !== futFrame) return;
          setFutRaw(r.points);
          setFutContracts(r.contracts);
        })
        .catch(() => {
          /* keep whatever we have */
        });
    load();
    const id = window.setInterval(load, 60000); // OI moves slowly; 60s refresh
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [authenticated, chain, futFrame]);

  // First-difference of the frame series → per-bucket OI change (Call & Put).
  const histPoints = useMemo<HistPoint[]>(() => {
    const out: HistPoint[] = [];
    for (let i = 1; i < histRaw.length; i++) {
      out.push({
        t: histRaw[i]!.t,
        ceChange: histRaw[i]!.totalCe - histRaw[i - 1]!.totalCe,
        peChange: histRaw[i]!.totalPe - histRaw[i - 1]!.totalPe,
      });
    }
    return out;
  }, [histRaw]);

  // ---- Periodic sampling: rolling per-token OI/price history ----
  // Powers the 5m/15m OI-change % + buildup fallback when the server baseline
  // has no entry yet. The straddle & OI charts are driven by the frame caches.
  useEffect(() => {
    if (!authenticated || !chain) return;
    const id = window.setInterval(() => {
      const ch = chainRef.current;
      const tk = ticksRef.current;
      if (!ch) return;
      const now = Date.now();
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
    const oiCutoff = Date.now() - oiInterval * 60 * 1000;
    const bldCutoff = Date.now() - bldInterval * 60 * 1000;

    const isValidBaselineTime = (sampleTime: number, cutoff: number) =>
      sampleTime >= cutoff - BASELINE_OLDER_TOLERANCE_MS &&
      sampleTime <= cutoff + BASELINE_NEWER_TOLERANCE_MS;

    // Resolve the selected server baseline, falling back to the client rolling
    // history only when a complete sample exists at the matching cutoff.
    const baseOf = (token: number, frame: ChainInterval): Sample | null => {
      const cutoff = frame === oiInterval ? oiCutoff : bldCutoff;
      const b = baselines[frame][token];
      if (b && isValidBaselineTime(b.t, cutoff)) return b;
      const arr = histRef.current.get(token);
      if (!arr || arr.length === 0) return null;
      let base: Sample | null = null;
      for (const s of arr) {
        if (s.t <= cutoff) base = s;
        else break;
      }
      return base && isValidBaselineTime(base.t, cutoff) ? base : null;
    };

    const changeFor = (token: number) => {
      const cur = ticks[token];
      if (!cur) return { oiPct: null as number | null, buildup: null as Buildup };

      const oiBase = baseOf(token, oiInterval);
      const bldBase = baseOf(token, bldInterval);
      const oiPct =
        oiBase && oiBase.oi > 0
          ? (((cur.oi ?? 0) - oiBase.oi) / oiBase.oi) * 100
          : null;
      const buildup = bldBase
        ? classifyBuildup(
            (cur.oi ?? 0) - bldBase.oi,
            (cur.last_price ?? 0) - bldBase.ltp,
          )
        : null;
      return { oiPct, buildup };
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
        const b = baseOf(tok, oiInterval);
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
  }, [chain, ticks, oiInterval, bldInterval, baselines]);

  // Center the ATM row once the chain + first ticks are in.
  useEffect(() => {
    if (didCenterRef.current || !metrics || !atmRowRef.current) return;
    centerRowInScroller(atmRowRef.current);
    didCenterRef.current = true;
  }, [metrics]);

  // Expanding/collapsing the chain swaps the visible band (ATM ± 30 vs ± 7).
  // The scroll container is reused, so re-center ATM in BOTH directions —
  // otherwise the retained scrollTop is clamped and hides the ATM row.
  const chainExpanded = expandedCard === "chain";
  useEffect(() => {
    centerRowInScroller(atmRowRef.current);
  }, [chainExpanded]);

  // On a 60s data refresh, only follow to the latest if already pinned to the
  // right edge — otherwise leave the user where they scrolled into the past.
  useEffect(() => {
    const el = oiScrollRef.current;
    if (el && oiAtEndRef.current) el.scrollLeft = el.scrollWidth;
  }, [ceOiSeries, peOiSeries]);

  // A timeframe switch starts at the latest point. Expanding or collapsing
  // preserves historical position unless the chart was already pinned right.
  useEffect(() => {
    const el = oiScrollRef.current;
    if (el) {
      el.scrollLeft = el.scrollWidth;
      oiAtEndRef.current = true;
    }
  }, [oiFrame]);

  const oiExpanded = expandedCard === "oi";
  useEffect(() => {
    const el = oiScrollRef.current;
    if (el && oiAtEndRef.current) el.scrollLeft = el.scrollWidth;
  }, [oiExpanded]);

  // Same pinned-to-latest behaviour for the futures-OI chart.
  useEffect(() => {
    const el = futScrollRef.current;
    if (el && futAtEndRef.current) el.scrollLeft = el.scrollWidth;
  }, [futRaw]);

  useEffect(() => {
    const el = futScrollRef.current;
    if (el) {
      el.scrollLeft = el.scrollWidth;
      futAtEndRef.current = true;
    }
  }, [futFrame]);

  const futExpanded = expandedCard === "futoi";
  useEffect(() => {
    const el = futScrollRef.current;
    if (el && futAtEndRef.current) el.scrollLeft = el.scrollWidth;
  }, [futExpanded]);

  // Taller charts when expanded to (near) full screen.
  const bigChartH = Math.max(
    320,
    (typeof window !== "undefined" ? window.innerHeight : 800) - 140,
  );

  // Timestamp formatting per frame: 1m shows time only; 5m/15m span multiple
  // days so they show date + time.
  const fmtTs = (frame: OiFrame, ms: number) =>
    frame === "1m"
      ? new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
      : new Date(ms).toLocaleString("en-GB", {
          day: "2-digit",
          month: "short",
          hour: "2-digit",
          minute: "2-digit",
        });
  const isoFmtFor = (frame: OiFrame) => (iso: string) => fmtTs(frame, new Date(iso).getTime());
  const tsFmtFor = (frame: OiFrame) => (t: number) => fmtTs(frame, t);

  const oiChart: ChartSeries[] = [
    { label: "Call OI", color: "var(--neg)", points: ceOiSeries },
    { label: "Put OI", color: "var(--pos)", points: peOiSeries },
  ];

  // One series per tracked futures contract, labelled by expiry month.
  const futOiChart = useMemo<ChartSeries[]>(
    () =>
      futContracts.map((c) => ({
        label: formatExpiry(c.expiry),
        color: futColorFor(c.expiry),
        points: futRaw
          .map((p) => ({
            date: new Date(p.t).toISOString(),
            value: p.legs.find((l) => l.expiry === c.expiry)?.oi ?? 0,
          }))
          .filter((p) => p.value > 0),
      })),
    [futContracts, futRaw],
  );
  const hasFutOi = futOiChart.some((s) => s.points.length > 1);

  // The option chain stays deliberately small until expanded: ATM ± 7 strikes
  // collapsed, the full ATM ± 30 band when expanded.
  const chainRows = useMemo(() => {
    const rows = metrics?.rows ?? [];
    if (expandedCard === "chain" || rows.length === 0) return rows;
    const atm = rows.findIndex((r) => r.isAtm);
    if (atm < 0) return rows.slice(0, CHAIN_COMPACT_HALF * 2 + 1);
    const lo = Math.max(0, atm - CHAIN_COMPACT_HALF);
    const hi = Math.min(rows.length - 1, atm + CHAIN_COMPACT_HALF);
    return rows.slice(lo, hi + 1);
  }, [metrics, expandedCard]);

  // Straddle chain: ATM ± 10 strikes with the straddle premium (CE LTP + PE LTP).
  const straddleChain = useMemo(() => {
    const rows = metrics?.rows ?? [];
    if (rows.length === 0) return [];
    const atm = rows.findIndex((r) => r.isAtm);
    const centre = atm < 0 ? Math.floor(rows.length / 2) : atm;
    const lo = Math.max(0, centre - STRADDLE_HALF);
    const hi = Math.min(rows.length - 1, centre + STRADDLE_HALF);
    return rows.slice(lo, hi + 1).map((r) => ({
      strike: r.strike,
      isAtm: r.isAtm,
      ceLtp: r.ceLtp,
      peLtp: r.peLtp,
      straddle: r.ceLtp !== null && r.peLtp !== null ? r.ceLtp + r.peLtp : null,
    }));
  }, [metrics]);

  // The straddle chain is 21 rows in a ~210px scroller, so ATM starts below the
  // fold unless we center it. Center ONCE when the rows first arrive, then only
  // on expand/collapse: `straddleChain` gets a new identity on every 500ms tick
  // flush, and re-centering that often would fight the user's own scrolling.
  // NOTE: must stay below the `straddleChain` memo — a dependency array is
  // evaluated during render, so referencing it earlier is a TDZ error.
  const straddleChainExpanded = expandedCard === "straddleChain";
  useEffect(() => {
    if (didCenterStraddleRef.current || straddleChain.length === 0) return;
    // No ATM row rendered yet — leave the flag unset so the next `straddleChain`
    // identity change (every metrics recompute) re-attempts the centering.
    if (!straddleAtmRowRef.current) return;
    centerRowInScroller(straddleAtmRowRef.current);
    didCenterStraddleRef.current = true;
  }, [straddleChain]);

  useEffect(() => {
    centerRowInScroller(straddleAtmRowRef.current);
  }, [straddleChainExpanded]);

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
              <span className="an-stat-k">Call OI Δ% ({oiInterval}m)</span>
              <span className="an-stat-buckets">
                <span>Above {pctCell(metrics.buckets.ce.above)}</span>
                <span>ATM {pctCell(metrics.buckets.ce.atm)}</span>
                <span>Below {pctCell(metrics.buckets.ce.below)}</span>
              </span>
            </div>
            <div className="an-stat an-stat--wide">
              <span className="an-stat-k">Put OI Δ% ({oiInterval}m)</span>
              <span className="an-stat-buckets">
                <span>Above {pctCell(metrics.buckets.pe.above)}</span>
                <span>ATM {pctCell(metrics.buckets.pe.atm)}</span>
                <span>Below {pctCell(metrics.buckets.pe.below)}</span>
              </span>
            </div>
          </div>

          {/* ---- Cards: row 1 = chain | straddle chain | ATM straddle,
                 row 2 = Call/Put OI | OI change | NIFTY futures OI ---- */}
          <div className="an-charts">
            <ChartCard
              title="Option Chain"
              expanded={expandedCard === "chain"}
              onToggle={() => setExpandedCard((c) => (c === "chain" ? null : "chain"))}
              bodyClass="an-table-card"
            >
              <div className="an-chain-bar">
                <div className="an-chain-control">
                  <span>OI Δ%</span>
                  <div className="an-toggle" role="group" aria-label="OI change timeframe">
                    {([5, 15] as const).map((m) => (
                      <button
                        key={m}
                        className={`btn${oiInterval === m ? " btn--primary" : ""}`}
                        onClick={() => setOiInterval(m)}
                      >
                        {m}m
                      </button>
                    ))}
                  </div>
                </div>
                <div className="an-chain-control">
                  <span>Bld</span>
                  <div className="an-toggle" role="group" aria-label="Buildup timeframe">
                    {([5, 15] as const).map((m) => (
                      <button
                        key={m}
                        className={`btn${bldInterval === m ? " btn--primary" : ""}`}
                        onClick={() => setBldInterval(m)}
                      >
                        {m}m
                      </button>
                    ))}
                  </div>
                </div>
              </div>
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
                      <th className="an-strike-h">Level</th>
                      <th>LTP</th>
                      <th>Bld</th>
                      <th>OI Δ%</th>
                      <th>OI</th>
                    </tr>
                  </thead>
                  <tbody>
                    {chainRows.map((r) => (
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
              {expandedCard !== "chain" && (
                <div className="an-card-note">
                  {chainRows.length} strikes around ATM — expand for the full band
                </div>
              )}
            </ChartCard>

            <ChartCard
              title="Straddle Chain"
              expanded={expandedCard === "straddleChain"}
              onToggle={() =>
                setExpandedCard((c) => (c === "straddleChain" ? null : "straddleChain"))
              }
              bodyClass="an-table-card"
            >
              <div className="an-chain-wrap">
                <table className="an-chain an-straddle-chain">
                  <thead>
                    <tr>
                      <th className="an-strike-h">STRIKE</th>
                      <th>CALL</th>
                      <th>PUT</th>
                      <th>STRADDLE</th>
                    </tr>
                  </thead>
                  <tbody>
                    {straddleChain.map((r) => (
                      <tr
                        key={r.strike}
                        ref={r.isAtm ? straddleAtmRowRef : undefined}
                        className={`${r.isAtm ? "an-atm" : ""} an-row`}
                      >
                        <td className="num an-strike">{r.strike}</td>
                        <td className="num an-ce-ltp">{fmt(r.ceLtp)}</td>
                        <td className="num an-pe-ltp">{fmt(r.peLtp)}</td>
                        <td className="num an-straddle-v">{fmt(r.straddle)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="an-card-note">
                {straddleChain.length} strikes around ATM · straddle = call LTP +
                put LTP
              </div>
            </ChartCard>

            <ChartCard
              title="ATM Straddle"
              expanded={expandedCard === "straddle"}
              onToggle={() =>
                setExpandedCard((c) => (c === "straddle" ? null : "straddle"))
              }
              controls={
                <div className="an-toggle" role="group" aria-label="Straddle timeframe">
                  {(["1m", "5m", "15m"] as const).map((f) => (
                    <button
                      key={f}
                      className={`btn${straddleFrame === f ? " btn--primary" : ""}`}
                      onClick={() => setStraddleFrame(f)}
                      title={
                        f === "1m"
                          ? "1-minute · last 1 day"
                          : f === "5m"
                            ? "5-minute · last 3 days"
                            : "15-minute · last 1 week"
                      }
                    >
                      {f}
                    </button>
                  ))}
                </div>
              }
            >
              <StraddleSpotChart
                key={straddleFrame}
                points={straddleRaw}
                formatX={tsFmtFor(straddleFrame)}
                height={expandedCard === "straddle" ? bigChartH : 210}
                expanded={expandedCard === "straddle"}
              />
            </ChartCard>

            <ChartCard
              title="Call OI vs Put OI"
              expanded={expandedCard === "oi"}
              onToggle={() => setExpandedCard((c) => (c === "oi" ? null : "oi"))}
              controls={
                <div className="an-toggle" role="group" aria-label="OI chart timeframe">
                  {(["1m", "5m", "15m"] as const).map((f) => (
                    <button
                      key={f}
                      className={`btn${oiFrame === f ? " btn--primary" : ""}`}
                      onClick={() => setOiFrame(f)}
                      title={
                        f === "1m"
                          ? "1-minute · last 1 day"
                          : f === "5m"
                            ? "5-minute · last 3 days"
                            : "15-minute · last 1 week"
                      }
                    >
                      {f}
                    </button>
                  ))}
                </div>
              }
            >
              {ceOiSeries.length > 1 || peOiSeries.length > 1 ? (
                <div
                  className="an-scrollx an-oi-scroll"
                  ref={oiScrollRef}
                  onScroll={(e) => {
                    const el = e.currentTarget;
                    oiAtEndRef.current =
                      el.scrollWidth - el.clientWidth - el.scrollLeft < 24;
                  }}
                >
                  <div
                    className="an-scrollx-inner"
                    style={{
                      minWidth: `${Math.max(
                        760,
                        Math.max(ceOiSeries.length, peOiSeries.length) * 7,
                      )}px`,
                    }}
                  >
                    <LineChart
                      series={oiChart}
                      format={fmtCompact}
                      formatX={isoFmtFor(oiFrame)}
                    />
                  </div>
                </div>
              ) : (
                <div className="chart-empty">
                  No OI history yet for this timeframe — it fills as the day
                  progresses (or backfills from history).
                </div>
              )}
            </ChartCard>

            <ChartCard
              title="Total Call/Put OI Change"
              expanded={expandedCard === "hist"}
              onToggle={() => setExpandedCard((c) => (c === "hist" ? null : "hist"))}
              controls={
                <div className="an-toggle" role="group" aria-label="OI-change histogram timeframe">
                  {(["1m", "5m", "15m"] as const).map((f) => (
                    <button
                      key={f}
                      className={`btn${histFrame === f ? " btn--primary" : ""}`}
                      onClick={() => setHistFrame(f)}
                      title={
                        f === "1m"
                          ? "per-minute change · last 1 day"
                          : f === "5m"
                            ? "per-5-min change · last 3 days"
                            : "per-15-min change · last 1 week"
                      }
                    >
                      {f}
                    </button>
                  ))}
                </div>
              }
            >
              <OiHistogram
                key={histFrame}
                points={histPoints}
                formatX={tsFmtFor(histFrame)}
                height={expandedCard === "hist" ? bigChartH : 210}
                expanded={expandedCard === "hist"}
              />
            </ChartCard>

            <ChartCard
              title="NIFTY Futures OI"
              expanded={expandedCard === "futoi"}
              onToggle={() => setExpandedCard((c) => (c === "futoi" ? null : "futoi"))}
              controls={
                <div className="an-toggle" role="group" aria-label="Futures OI timeframe">
                  {(["1m", "5m", "15m"] as const).map((f) => (
                    <button
                      key={f}
                      className={`btn${futFrame === f ? " btn--primary" : ""}`}
                      onClick={() => setFutFrame(f)}
                      title={
                        f === "1m"
                          ? "1-minute · last 1 day"
                          : f === "5m"
                            ? "5-minute · last 3 days"
                            : "15-minute · last 1 week"
                      }
                    >
                      {f}
                    </button>
                  ))}
                </div>
              }
            >
              {hasFutOi ? (
                <div
                  className="an-scrollx an-oi-scroll"
                  ref={futScrollRef}
                  onScroll={(e) => {
                    const el = e.currentTarget;
                    futAtEndRef.current =
                      el.scrollWidth - el.clientWidth - el.scrollLeft < 24;
                  }}
                >
                  <div
                    className="an-scrollx-inner"
                    style={{ minWidth: `${Math.max(760, futRaw.length * 7)}px` }}
                  >
                    <LineChart
                      series={futOiChart}
                      format={fmtCompact}
                      formatX={isoFmtFor(futFrame)}
                    />
                  </div>
                </div>
              ) : (
                <div className="chart-empty">
                  No futures OI history yet for this timeframe — it fills as the
                  day progresses (or backfills from history).
                </div>
              )}
            </ChartCard>
          </div>
        </>
      )}
    </div>
  );
}

/** A chart panel with optional header controls and an expand/collapse toggle. */
function ChartCard({
  title,
  expanded,
  onToggle,
  controls,
  bodyClass,
  children,
}: {
  title: string;
  expanded: boolean;
  onToggle: () => void;
  controls?: ReactNode;
  /** Extra class on the body (e.g. to lay a table card out as a column). */
  bodyClass?: string;
  children: ReactNode;
}) {
  return (
    <div className={`an-chart-card${expanded ? " an-chart-card--expanded" : ""}`}>
      <div className="an-chart-head">
        <h3>{title}</h3>
        <div className="an-chart-controls">
          {controls}
          <button
            className="btn an-expand"
            onClick={onToggle}
            title={expanded ? "Collapse" : "Expand"}
          >
            {expanded ? "✕ Close" : "⤢ Expand"}
          </button>
        </div>
      </div>
      <div className={`an-chart-body${bodyClass ? ` ${bodyClass}` : ""}`}>
        {children}
      </div>
    </div>
  );
}
