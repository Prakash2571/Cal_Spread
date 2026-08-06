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
import OiHistogram, { type HistPoint, type HistSeries } from "./OiHistogram.tsx";
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

/** Both futures charts share one blue identity (OI level + OI change). */
const FUT_COLOR = "var(--series-1)";

/** Bucket length of a frame. The server stamps each frame point with its
 *  bucket-END boundary, so consecutive buckets are exactly this far apart —
 *  which is what lets the change histograms detect a gap. */
const frameMs = (frame: OiFrame): number =>
  frame === "1m" ? 60_000 : frame === "5m" ? 5 * 60_000 : 15 * 60_000;

/** IST calendar day, matching the backend's day key. */
const istDayKey = () =>
  new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);

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
  const [futHistFrame, setFutHistFrame] = useState<OiFrame>("5m"); // futures OI-change frame
  const [histRaw, setHistRaw] = useState<
    { t: number; totalCe: number; totalPe: number }[]
  >([]);
  const [expandedCard, setExpandedCard] = useState<
    | "chain"
    | "straddleChain"
    | "straddle"
    | "oi"
    | "hist"
    | "futoi"
    | "futhist"
    | null
  >(null);

  // NIFTY futures OI history from the server frames. Both futures charts read the
  // CURRENT-month contract only, but each keeps its own timeframe selection.
  const [futRaw, setFutRaw] = useState<FuturesOiPoint[]>([]);
  const [futContracts, setFutContracts] = useState<FuturesOiContract[]>([]);
  const [futHistRaw, setFutHistRaw] = useState<FuturesOiPoint[]>([]);
  const [futHistContracts, setFutHistContracts] = useState<FuturesOiContract[]>([]);

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

  // ---- NIFTY futures OI, for the level chart and the change histogram ----
  // Both cards read the same endpoint (inheriting the server's per-frame cache
  // and Kite backfill) but keep independent timeframes, so we fetch the DISTINCT
  // selected frames — one request when they happen to match. Gated on `chain`
  // because the cards only render once the chain-derived metrics exist.
  useEffect(() => {
    if (!authenticated || !chain) return;
    let cancelled = false;
    const load = () => {
      for (const frame of Array.from(new Set<OiFrame>([futFrame, futHistFrame]))) {
        fetchFuturesOiFrame(UNDERLYING, frame)
          .then((r) => {
            if (cancelled) return;
            // The server coerces an unknown frame to 5m; ignore a mismatched
            // response rather than labelling it with the requested timeframe.
            if (r.frame !== frame) return;
            if (frame === futFrame) {
              setFutRaw(r.points);
              setFutContracts(r.contracts);
            }
            if (frame === futHistFrame) {
              setFutHistRaw(r.points);
              setFutHistContracts(r.contracts);
            }
          })
          .catch(() => {
            /* keep whatever we have */
          });
      }
    };
    load();
    const id = window.setInterval(load, 60000); // OI moves slowly; 60s refresh
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [authenticated, chain, futFrame, futHistFrame]);

  // First-difference of the frame series → per-bucket OI change (Call & Put).
  // Buckets that aren't adjacent are skipped: capture only runs during market
  // hours, so differencing across an overnight or weekend hole would draw the
  // whole close→open move as if it happened in one 5m/15m bucket.
  const histPoints = useMemo<HistPoint[]>(() => {
    const step = frameMs(histFrame);
    const out: HistPoint[] = [];
    let prev: { t: number; ce: number; pe: number } | null = null;
    for (const p of histRaw) {
      // A zero total means "no reading" (e.g. a pre-open bucket), not "OI
      // collapsed to nothing" — differencing against it would draw a bar the
      // size of the entire open interest.
      if (p.totalCe <= 0 || p.totalPe <= 0) continue;
      if (prev && p.t - prev.t === step) {
        out.push({
          t: p.t,
          values: [p.totalCe - prev.ce, p.totalPe - prev.pe],
        });
      }
      prev = { t: p.t, ce: p.totalCe, pe: p.totalPe };
    }
    return out;
  }, [histRaw, histFrame]);

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

    return { rows, atmStrike, spot, totalCe, totalPe, pcr };
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

  // Horizontal scrolling for the two line charts (follow-to-latest, and reset on
  // a timeframe switch via the `key` prop) is owned by LineChart itself, the same
  // way StraddleSpotChart and OiHistogram own theirs.

  // Taller charts when expanded to (near) full screen. 125px covers the measured
  // card chrome: padding (24) + head (32) + readout strip incl. margin (42) +
  // the horizontal scrollbar gutter.
  const bigChartH = Math.max(
    240,
    (typeof window !== "undefined" ? window.innerHeight : 800) - 125,
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

  // Memoised: a fresh array identity here would re-trigger LineChart's
  // follow-to-latest layout effect on every 500ms tick flush.
  const oiChart = useMemo<ChartSeries[]>(
    () => [
      { label: "Call OI", color: "var(--neg)", points: ceOiSeries },
      { label: "Put OI", color: "var(--pos)", points: peOiSeries },
    ],
    [ceOiSeries, peOiSeries],
  );

  /**
   * Nearest contract that has NOT expired. The endpoint keeps a just-expired
   * month in `contracts` for as long as its points are retained, so the first
   * entry is not necessarily the current month.
   */
  const currentMonthOf = (contracts: FuturesOiContract[]) => {
    const today = istDayKey();
    return (
      contracts
        .filter((c) => c.expiry >= today)
        .sort((a, b) => a.expiry.localeCompare(b.expiry))[0] ?? null
    );
  };

  // Current-month futures OI only — the next/far months moved in lockstep and
  // added no information to the level chart.
  const currentFut = useMemo(() => currentMonthOf(futContracts), [futContracts]);
  const futOiChart = useMemo<ChartSeries[]>(() => {
    if (!currentFut) return [];
    return [
      {
        label: `${formatExpiry(currentFut.expiry)} OI`,
        color: FUT_COLOR,
        points: futRaw
          .map((p) => ({
            date: new Date(p.t).toISOString(),
            value: p.legs.find((l) => l.expiry === currentFut.expiry)?.oi ?? 0,
          }))
          .filter((p) => p.value > 0),
      },
    ];
  }, [currentFut, futRaw]);
  const hasFutOi = futOiChart.some((s) => s.points.length > 1);

  // Per-bucket change in current-month futures OI. Buckets with no reading are
  // skipped rather than differenced against 0, which would invent a huge swing.
  const currentFutHist = useMemo(
    () => currentMonthOf(futHistContracts),
    [futHistContracts],
  );
  const futHistPoints = useMemo<HistPoint[]>(() => {
    if (!currentFutHist) return [];
    const step = frameMs(futHistFrame);
    const out: HistPoint[] = [];
    let prevOi: number | null = null;
    let prevT: number | null = null;
    for (const p of futHistRaw) {
      const oi = p.legs.find((l) => l.expiry === currentFutHist.expiry)?.oi ?? 0;
      // A non-positive reading means "no data", not "OI collapsed to zero".
      if (oi <= 0) continue;
      // Only difference genuinely adjacent buckets — see histPoints above.
      if (prevOi !== null && prevT !== null && p.t - prevT === step) {
        out.push({ t: p.t, values: [oi - prevOi] });
      }
      prevOi = oi;
      prevT = p.t;
    }
    return out;
  }, [currentFutHist, futHistRaw, futHistFrame]);
  const futHistSeries = useMemo<HistSeries[]>(
    () => [{ label: "Futures ΔOI", color: FUT_COLOR }],
    [],
  );
  const oiHistSeries = useMemo<HistSeries[]>(
    () => [
      { label: "Call ΔOI", color: "var(--neg)" },
      { label: "Put ΔOI", color: "var(--pos)" },
    ],
    [],
  );

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
          </div>

          {/* ---- Row 1: the two tables + the straddle chart ---- */}
          <div className="an-charts an-charts--3">
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
          </div>

          {/* ---- Row 2: the four time-series charts ---- */}
          <div className="an-charts an-charts--4">
            <ChartCard
              title="Call vs Put OI"
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
                <LineChart
                  key={oiFrame}
                  series={oiChart}
                  format={fmtCompact}
                  formatX={isoFmtFor(oiFrame)}
                  height={expandedCard === "oi" ? bigChartH : 210}
                  canvasWidth={Math.max(
                    760,
                    Math.max(ceOiSeries.length, peOiSeries.length) * 7,
                  )}
                  expanded={expandedCard === "oi"}
                />
              ) : (
                <div className="chart-empty">
                  No OI history yet for this timeframe — it fills as the day
                  progresses (or backfills from history).
                </div>
              )}
            </ChartCard>

            <ChartCard
              title="Call/Put ΔOI"
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
                series={oiHistSeries}
                formatX={tsFmtFor(histFrame)}
                height={expandedCard === "hist" ? bigChartH : 210}
                expanded={expandedCard === "hist"}
              />
            </ChartCard>

            <ChartCard
              title="Futures OI"
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
                <LineChart
                  key={futFrame}
                  series={futOiChart}
                  format={fmtCompact}
                  formatX={isoFmtFor(futFrame)}
                  height={expandedCard === "futoi" ? bigChartH : 210}
                  canvasWidth={Math.max(760, futRaw.length * 7)}
                  expanded={expandedCard === "futoi"}
                />
              ) : (
                <div className="chart-empty">
                  No futures OI history yet for this timeframe — it fills as the
                  day progresses (or backfills from history).
                </div>
              )}
            </ChartCard>

            <ChartCard
              title="Futures ΔOI"
              expanded={expandedCard === "futhist"}
              onToggle={() =>
                setExpandedCard((c) => (c === "futhist" ? null : "futhist"))
              }
              controls={
                <div
                  className="an-toggle"
                  role="group"
                  aria-label="Futures OI-change timeframe"
                >
                  {(["1m", "5m", "15m"] as const).map((f) => (
                    <button
                      key={f}
                      className={`btn${futHistFrame === f ? " btn--primary" : ""}`}
                      onClick={() => setFutHistFrame(f)}
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
                key={futHistFrame}
                points={futHistPoints}
                series={futHistSeries}
                formatX={tsFmtFor(futHistFrame)}
                height={expandedCard === "futhist" ? bigChartH : 210}
                expanded={expandedCard === "futhist"}
              />
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
        {/* title attribute so an ellipsised heading is still readable on hover */}
        <h3 title={title}>{title}</h3>
        <div className="an-chart-controls">
          {controls}
          {/* Icon-only: four cards in a row leave no width for a text label. */}
          <button
            className="btn an-expand"
            onClick={onToggle}
            title={expanded ? "Collapse" : "Expand"}
            aria-label={expanded ? `Collapse ${title}` : `Expand ${title}`}
          >
            {expanded ? "✕" : "⤢"}
          </button>
        </div>
      </div>
      <div className={`an-chart-body${bodyClass ? ` ${bodyClass}` : ""}`}>
        {children}
      </div>
    </div>
  );
}
