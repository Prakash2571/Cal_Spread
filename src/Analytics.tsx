import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  fetchFuturesOiFrame,
  fetchOptionChain,
  fetchOptionOiBaseline,
  fetchOptionOiFrame,
  fetchOptionPrevClose,
  fetchQuotes,
  streamUrl,
  type FuturesOiContract,
  type FuturesOiPoint,
  OI_FRAME_OPTIONS,
  type OiFrame,
  type OptionChain,
  type OptionChainStrike,
  type OptionPrevClose,
  type Tick,
} from "./api.ts";
import LineChart, { type ChartSeries } from "./LineChart.tsx";
import OiHistogram, { type HistPoint, type HistSeries } from "./OiHistogram.tsx";
import ThemeToggle from "./ThemeToggle.tsx";
import { fmt, fmtCompact, formatExpiry } from "./format.ts";

type TickMap = Record<number, Tick>;
/** Comparison window for the chain's OI Δ% and buildup columns. */
type ChainInterval = 1 | 5 | 15 | 60 | "day";
type MinuteInterval = 1 | 5 | 15 | 60;
type OptionBaseline = Record<number, { oi: number; ltp: number; t: number }>;

const CHAIN_INTERVALS: ChainInterval[] = [1, 5, 15, 60, "day"];
const intervalLabel = (i: ChainInterval) =>
  i === "day" ? "Day" : i === 60 ? "1h" : `${i}m`;
const isMinuteInterval = (i: ChainInterval): i is MinuteInterval => i !== "day";
/** Human phrase for a window, used in the toggle tooltips. */
const intervalPhrase = (i: MinuteInterval) =>
  i === 60 ? "hour" : i === 1 ? "minute" : `${i} minutes`;
/** One empty baseline per window. Every key must exist — the record is total. */
const emptyBaselines = (): Record<MinuteInterval, OptionBaseline> => ({
  1: {},
  5: {},
  15: {},
  60: {},
});

/** No previous-session baseline yet (or not one that applies to today). */
const EMPTY_PREV_CLOSE: OptionPrevClose = {
  forDay: "",
  closedOn: null,
  expiry: null,
  complete: false,
  tokens: {},
};

// Baselines are sampled once per minute on the backend. Accept the nearest
// sample just before the requested cutoff, but reject incomplete or stale
// windows instead of presenting them as exact 5m/15m calculations.
const BASELINE_OLDER_TOLERANCE_MS = 75 * 1000;
const BASELINE_NEWER_TOLERANCE_MS = 5 * 1000;

/** The underlying this analytics page is built for. */
const UNDERLYING = "NIFTY";

const CHAIN_COMPACT_HALF = 14; // collapsed option chain: ATM ± 14 strikes
const TOTAL_UP = 24; // total-OI window: 24 strikes above ATM
const TOTAL_DOWN = 26; // total-OI window: 26 strikes below ATM

/** Both futures charts share one blue identity (OI level + OI change). */
const FUT_COLOR = "var(--series-1)";

/** Bucket length of a frame. The server stamps each frame point with its
 *  bucket-END boundary, so consecutive buckets are exactly this far apart —
 *  which is what lets the change histograms detect a gap. */
const frameMs = (frame: OiFrame): number =>
  frame === "1m"
    ? 60_000
    : frame === "5m"
      ? 5 * 60_000
      : frame === "15m"
        ? 15 * 60_000
        : 60 * 60_000;

/**
 * Are two frame buckets consecutive, so a difference between them is one bucket's
 * worth of change?
 *
 * Not an equality test on the spacing, because buckets at a session EDGE are
 * short: the server clamps the last bucket to the 15:30 close, so the final 1h
 * bucket spans 15:00–15:30. Requiring an exact hour silently dropped the closing
 * bar of every session on the change histograms. A genuine hole always leaves a
 * gap of at least two buckets, so "positive and no wider than one bucket" accepts
 * the short edge buckets while still rejecting overnight and downtime gaps.
 */
const isAdjacentBucket = (prevT: number, t: number, step: number) =>
  t - prevT > 0 && t - prevT <= step;

/** The shape of a frame bucket this page reads (see api.ts OptionOiFramePoint). */
type FrameBucket = { t: number; totalCe: number; totalPe: number; partial?: 1 };

/**
 * Is a total a real reading?
 *
 * Three things it can be instead. Non-finite, from a truncated or older payload —
 * and `undefined <= 0` is `false`, so a plain `> 0` test lets it through, after
 * which one NaN propagates into every bar coordinate and blanks the whole chart.
 * Zero, which for these aggregates means "nothing captured" (a pre-open bucket),
 * not "open interest went to nothing". And `partial`, the server's own admission
 * that it could not cover every strike in the window.
 *
 * All three have to be skipped rather than plotted: on a level chart they draw a
 * dip that never happened, and on a change histogram they cost two bars — a false
 * collapse followed by a false recovery of the same size.
 */
const isRealTotal = (v: number | undefined): v is number =>
  typeof v === "number" && Number.isFinite(v) && v > 0;
const isUsableBucket = (p: FrameBucket): boolean =>
  !p.partial && isRealTotal(p.totalCe) && isRealTotal(p.totalPe);

/**
 * First-difference a Call/Put frame series into per-bucket OI changes.
 *
 * Module scope, and pure, so it can be tested without mounting the page.
 * Non-adjacent buckets are never differenced: capture only runs during market
 * hours, so subtracting across an overnight or weekend hole would draw the entire
 * close-to-open move as one bucket's worth of change. A skipped bucket also
 * refuses to become the next one's baseline, which is what makes the gap two
 * buckets wide and drops that delta too.
 */
function oiDeltaPoints(raw: FrameBucket[], step: number): HistPoint[] {
  const out: HistPoint[] = [];
  let prev: { t: number; ce: number; pe: number } | null = null;
  for (const p of raw) {
    if (!isUsableBucket(p)) continue;
    if (prev && isAdjacentBucket(prev.t, p.t, step)) {
      out.push({ t: p.t, values: [p.totalCe - prev.ce, p.totalPe - prev.pe] });
    }
    prev = { t: p.t, ce: p.totalCe, pe: p.totalPe };
  }
  return out;
}

/** The same first-difference for one futures contract's OI leg. */
function futDeltaPoints(
  raw: FuturesOiPoint[],
  expiry: string,
  step: number,
): HistPoint[] {
  const out: HistPoint[] = [];
  let prev: { t: number; oi: number } | null = null;
  for (const p of raw) {
    const oi = p.legs.find((l) => l.expiry === expiry)?.oi;
    if (!isRealTotal(oi)) continue;
    if (prev && isAdjacentBucket(prev.t, p.t, step)) {
      out.push({ t: p.t, values: [oi - prev.oi] });
    }
    prev = { t: p.t, oi };
  }
  return out;
}

/**
 * Is a server baseline really the reading from `minutes` ago?
 *
 * Graded against the cutoff AS OF WHEN THE RESPONSE ARRIVED, not a moving
 * `Date.now()`. The server answers a fixed question — "the newest snapshot at or
 * before T minus the window" — so `baseT` is a fixed answer, and it can sit up to
 * one snapshot cadence (a minute) older than that cutoff. Re-grading it against
 * "now" meant the same correct baseline aged out of tolerance partway through
 * every 30s poll cycle and the entire OI Δ% column blanked until the next poll.
 * Anchoring to the fetch time leaves the tolerance covering only the cadence,
 * which is what it was sized for — and it still rejects a genuinely wrong
 * baseline, such as the hourly snapshot the server falls back to when a session's
 * minute snapshots were lost.
 */
const isServerBaselineFresh = (
  baseT: number,
  fetchedAt: number,
  minutes: MinuteInterval,
) => {
  const cutoff = fetchedAt - minutes * 60 * 1000;
  return (
    baseT >= cutoff - BASELINE_OLDER_TOLERANCE_MS &&
    baseT <= cutoff + BASELINE_NEWER_TOLERANCE_MS
  );
};

/** What each chart timeframe covers, mirroring the server's Redis retention. */
const FRAME_TITLE: Record<OiFrame, string> = {
  "1m": "1-minute buckets · last 1 day",
  "5m": "5-minute buckets · last 3 days",
  "15m": "15-minute buckets · last 1 week",
  "1h": "1-hour buckets · last 4 days",
};
/** Same frames on the change histograms, where a bucket is a delta not a level. */
const FRAME_TITLE_DELTA: Record<OiFrame, string> = {
  "1m": "change per minute · last 1 day",
  "5m": "change per 5 minutes · last 3 days",
  "15m": "change per 15 minutes · last 1 week",
  "1h": "change per hour · last 4 days",
};

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
  // `partial` is carried through deliberately: structural typing would otherwise
  // drop it here and the histogram would difference an understated bucket.
  const [histRaw, setHistRaw] = useState<FrameBucket[]>([]);
  const [expandedCard, setExpandedCard] = useState<
    | "chain"
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
  const [straddleRaw, setStraddleRaw] = useState<{ t: number; straddle: number }[]>(
    [],
  );
  const [ceOiSeries, setCeOiSeries] = useState<{ date: string; value: number }[]>([]);
  const [peOiSeries, setPeOiSeries] = useState<{ date: string; value: number }[]>([]);

  // Server-provided OI + LTP baselines keyed by timeframe. Keeping one cache per
  // window lets OI Δ% and buildup hold independent selections.
  const [baselines, setBaselines] =
    useState<Record<MinuteInterval, OptionBaseline>>(emptyBaselines);
  // When each window's baseline was fetched. The server resolves a baseline
  // against its OWN clock at request time, so this is the instant its answer is
  // relative to — see isServerBaselineFresh. 0 means "nothing fetched yet".
  const [baselineAt, setBaselineAt] = useState<Record<MinuteInterval, number>>({
    1: 0,
    5: 0,
    15: 0,
    60: 0,
  });
  // Oldest snapshot the server's chain cache holds. A window is only offered once
  // the cache reaches that far back, so "1h" is disabled with a reason in the
  // morning rather than being selectable and rendering a column of dashes.
  const [baselineOldest, setBaselineOldest] = useState<number | null>(null);
  // Previous session's close per token — the "Day" comparison baseline. Unlike the
  // minute baselines this needs no freshness window: it is a fixed reference point
  // the server only publishes while it is valid for today. Polled regardless of the
  // toggles so the Day option can be disabled up front rather than selected and
  // then found empty.
  const [prevClose, setPrevClose] = useState<OptionPrevClose>(EMPTY_PREV_CLOSE);

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
        setStraddleRaw([]);
        setCeOiSeries([]);
        setPeOiSeries([]);
        setBaselines(emptyBaselines());
        setBaselineOldest(null);
        // Token-keyed, so a different expiry invalidates it.
        setPrevClose(EMPTY_PREV_CLOSE);
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

    // Guarded like every other effect: switching expiry tears this down and clears
    // `ticks`, and without the check an in-flight seed for the OLD instrument set
    // resolved afterwards and wrote itself over the fresh state — including a spot
    // price, which is shared across expiries and so looked plausible.
    let cancelled = false;
    fetchQuotes(tokens)
      .then((seed) => {
        if (cancelled || seed.length === 0) return;
        setTicks((prev) => {
          const next = { ...prev };
          for (const t of seed) next[t.token] = t;
          return next;
        });
        // Mirror into the ref from the same seed, so ticksRef and ticks agree.
        const nextRef = { ...ticksRef.current };
        for (const t of seed) nextRef[t.token] = t;
        ticksRef.current = nextRef;
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
      cancelled = true;
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
    const minuteFrames = selected.filter(isMinuteInterval);
    // Always request at least one window, even when both toggles are on "day":
    // every response reports how far back the snapshot cache reaches, and that is
    // what lets the 1m/1h buttons be disabled up front instead of being selectable
    // and then empty. Frame 1 is the cheapest probe.
    const framesToLoad: MinuteInterval[] =
      minuteFrames.length > 0 ? minuteFrames : [1];
    // Never expose a retained baseline under a newly selected timeframe while
    // its fresh request is still pending. The previous-session baseline is NOT
    // cleared here: it is a fixed reference for the day, so switching a toggle
    // between windows must not blank a Day column that is already correct.
    setBaselines((prev) => {
      const next = { ...prev };
      for (const frame of framesToLoad) next[frame] = {};
      return next;
    });

    const load = () => {
      for (const frame of framesToLoad) {
        // Captured BEFORE the request: the server's cutoff is its own receive
        // time, so anchoring to the moment we asked can only ever make the
        // baseline look slightly older than it is — never fresher, which is the
        // direction that would let a stale reading through.
        const askedAt = Date.now();
        fetchOptionOiBaseline(UNDERLYING, frame)
          .then((r) => {
            if (cancelled) return;
            // `oldest` is window-independent, so any response updates it.
            setBaselineOldest(typeof r.oldest === "number" ? r.oldest : null);
            setBaselines((prev) => ({
              ...prev,
              [frame]: r.minutes === frame ? r.tokens ?? {} : {},
            }));
            setBaselineAt((prev) => ({ ...prev, [frame]: askedAt }));
          })
          .catch(() => {
            if (!cancelled) {
              setBaselines((prev) => ({ ...prev, [frame]: {} }));
              setBaselineAt((prev) => ({ ...prev, [frame]: 0 }));
            }
          });
      }
      // Always polled, even when neither toggle is on "day": knowing whether a
      // baseline exists is what lets the Day buttons be disabled instead of
      // selectable-then-empty. The server only returns tokens while the baseline
      // is valid for today, so an empty map means "not available yet".
      fetchOptionPrevClose(UNDERLYING)
        .then((r) => {
          if (!cancelled) setPrevClose({ ...r, tokens: r.tokens ?? {} });
        })
        .catch(() => {
          // Deliberately keeps the last good baseline: it's a fixed reference for
          // the whole day, so a dropped poll says nothing about its validity, and
          // discarding it would blank a correct column.
        });
    };
    load();
    const id = window.setInterval(load, 30000); // slide both windows every 30s
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [authenticated, chain, oiInterval, bldInterval]);

  // ---- Auto-ATM straddle premium history for the selected timeframe ----
  useEffect(() => {
    if (!authenticated || !chain) return;
    let cancelled = false;
    const load = () =>
      fetchOptionOiFrame(UNDERLYING, straddleFrame)
        .then((r) => {
          if (cancelled || r.frame !== straddleFrame) return;
          // No `partial` filter here: that flag is about STRIKE coverage of the OI
          // window, and the straddle is just the two ATM legs. When an ATM leg is
          // the one missing, the server already publishes straddle 0, which the
          // chart's own `> 0` filter drops.
          setStraddleRaw(r.points.map((p) => ({ t: p.t, straddle: p.straddle })));
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
          if (cancelled || r.frame !== oiFrame) return;
          // Each side is filtered on its OWN total plus the shared `partial` flag,
          // so a bucket the server couldn't fully cover leaves a gap instead of a
          // dip that never happened.
          setCeOiSeries(
            r.points
              .filter((p) => !p.partial && isRealTotal(p.totalCe))
              .map((p) => ({ date: iso(p.t), value: p.totalCe })),
          );
          setPeOiSeries(
            r.points
              .filter((p) => !p.partial && isRealTotal(p.totalPe))
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
    // Drop the previous frame's buckets immediately. Unlike the level charts, this
    // card's arithmetic depends on the frame: histPoints differences any two points
    // spaced within frameMs(histFrame), so holding 1m points while the label says
    // "per hour" drew ~375 per-MINUTE deltas as if each were an hour's change.
    // Briefly empty is the honest state until the new frame's data lands.
    setHistRaw([]);
    const load = () =>
      fetchOptionOiFrame(UNDERLYING, histFrame)
        .then((r) => {
          if (!cancelled && r.frame === histFrame) setHistRaw(r.points);
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

  // Per-bucket OI change (Call & Put) — see oiDeltaPoints for the gap handling.
  const histPoints = useMemo<HistPoint[]>(
    () => oiDeltaPoints(histRaw, frameMs(histFrame)),
    [histRaw, histFrame],
  );

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
    // The backend reports spot 0 when its own quote call failed, and no tick has
    // arrived on the very first render. Anchoring ATM on 0 would pick the LOWEST
    // strike, which then moves the isAtm row, the auto-scroll target and the whole
    // 26↓/ATM/24↑ totals window to the bottom of the ladder. The chain API's own
    // atm_strike is the right fallback: it has a median-strike default, so it is
    // always a plausible centre.
    const tickSpot = ticks[chain.spot_token]?.last_price;
    const spot = isRealTotal(tickSpot)
      ? tickSpot
      : chain.spot > 0
        ? chain.spot
        : 0;
    const atmIdx = nearestStrikeIdx(strikes, spot > 0 ? spot : chain.atm_strike);
    const atmStrike = strikes[atmIdx]?.strike ?? chain.atm_strike;
    // Only the client's own rolling samples are graded against "now" — they are
    // taken continuously, so now IS their cutoff. Server baselines are graded
    // against when they were fetched; see isServerBaselineFresh.
    const cutoffFor = (frame: MinuteInterval) => Date.now() - frame * 60 * 1000;

    const isValidBaselineTime = (sampleTime: number, cutoff: number) =>
      sampleTime >= cutoff - BASELINE_OLDER_TOLERANCE_MS &&
      sampleTime <= cutoff + BASELINE_NEWER_TOLERANCE_MS;

    /**
     * Baseline for one token under one comparison window.
     *
     * "Day" is the previous session's close — a fixed reference the server only
     * serves while it is valid for today, so it needs no freshness check and has
     * no client-side fallback. The minute windows prefer the server baseline and
     * fall back to the client's rolling history, but only when a sample actually
     * lands at the requested cutoff.
     */
    const baseOf = (token: number, frame: ChainInterval): Sample | null => {
      if (frame === "day") {
        const pc = prevClose.tokens[token];
        return pc && pc.oi > 0 ? { t: 0, oi: pc.oi, ltp: pc.ltp } : null;
      }
      const cutoff = cutoffFor(frame);
      const b = baselines[frame][token];
      const fetchedAt = baselineAt[frame];
      if (b && fetchedAt > 0 && isServerBaselineFresh(b.t, fetchedAt, frame)) return b;
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
      const none = { oiPct: null as number | null, buildup: null as Buildup };
      const cur = ticks[token];
      if (!cur) return none;
      // `oi` is optional on a tick, and a missing one is NOT zero open interest.
      // Coercing it with `?? 0` printed a confident red -100% for any contract
      // whose tick hadn't carried OI yet, and fed classifyBuildup a full-size
      // negative ΔOI — labelling it short covering or long unwinding.
      const curOi = cur.oi;
      if (curOi == null || !Number.isFinite(curOi)) return none;

      const oiBase = baseOf(token, oiInterval);
      const bldBase = baseOf(token, bldInterval);
      const oiPct =
        oiBase && oiBase.oi > 0 ? ((curOi - oiBase.oi) / oiBase.oi) * 100 : null;
      const buildup = bldBase
        ? classifyBuildup(curOi - bldBase.oi, (cur.last_price ?? 0) - bldBase.ltp)
        : null;
      return { oiPct, buildup };
    };

    // Every strike the chain API returned — the straddle column makes the whole
    // ladder useful, not just the band around ATM.
    const rows = strikes.map((s, i) => {
      const ce = ticks[s.ce_token];
      const pe = ticks[s.pe_token];
      const ceCh = changeFor(s.ce_token);
      const peCh = changeFor(s.pe_token);
      const ceLtp = ce?.last_price ?? null;
      const peLtp = pe?.last_price ?? null;
      return {
        strike: s.strike,
        isAtm: i === atmIdx,
        ceLtp,
        ceOi: ce?.oi ?? null,
        ceOiPct: ceCh.oiPct,
        ceBuildup: ceCh.buildup,
        peLtp,
        peOi: pe?.oi ?? null,
        peOiPct: peCh.oiPct,
        peBuildup: peCh.buildup,
        // Straddle premium for this strike (call + put), the old Straddle Chain.
        straddle: ceLtp !== null && peLtp !== null ? ceLtp + peLtp : null,
      };
    });

    // Total OI (24 above / ATM / 26 below).
    const totLo = clamp(atmIdx - TOTAL_DOWN, 0, strikes.length - 1);
    const totHi = clamp(atmIdx + TOTAL_UP, 0, strikes.length - 1);
    let totalCe = 0;
    let totalPe = 0;
    // Legs still waiting for their first OI-bearing tick. Ticks arrive over
    // several seconds for a ~100-token chain, so right after load the sums are
    // genuinely incomplete. They are shown anyway (they converge visibly), but PCR
    // is a RATIO of two of them: publishing it while legs are missing prints a
    // precise-looking number that is simply wrong, and it would disagree with the
    // Call-vs-Put chart, which is served from the server's own aggregate.
    let missingLegs = 0;
    // Note this accepts 0: a deep strike genuinely carrying no open interest is a
    // real reading, unlike an absent one. Only the ABSENCE is counted as missing.
    const readOi = (token: number): number | null => {
      const oi = ticks[token]?.oi;
      return typeof oi === "number" && Number.isFinite(oi) ? oi : null;
    };
    for (let i = totLo; i <= totHi; i++) {
      const ceOi = readOi(strikes[i]!.ce_token);
      const peOi = readOi(strikes[i]!.pe_token);
      if (ceOi === null) missingLegs++;
      else totalCe += ceOi;
      if (peOi === null) missingLegs++;
      else totalPe += peOi;
    }
    const pcr = missingLegs === 0 && totalCe > 0 ? totalPe / totalCe : null;

    return { rows, atmStrike, spot, totalCe, totalPe, pcr, missingLegs };
  }, [chain, ticks, oiInterval, bldInterval, baselines, baselineAt, prevClose]);

  // Center the ATM row once the chain + first ticks are in.
  useEffect(() => {
    if (didCenterRef.current || !metrics || !atmRowRef.current) return;
    centerRowInScroller(atmRowRef.current);
    didCenterRef.current = true;
  }, [metrics]);

  // Expanding/collapsing the chain swaps the visible band (the whole ladder vs
  // ATM ± CHAIN_COMPACT_HALF). The scroll container is reused, so re-center ATM in
  // BOTH directions — otherwise the retained scrollTop is clamped and hides the
  // ATM row.
  const chainExpanded = expandedCard === "chain";
  useEffect(() => {
    centerRowInScroller(atmRowRef.current);
  }, [chainExpanded]);

  // Horizontal scrolling for the line charts (follow-to-latest, and reset on a
  // timeframe switch via the `key` prop) is owned by LineChart itself, the same
  // way OiHistogram owns its own.

  // Taller charts when expanded to (near) full screen. 125px covers the measured
  // card chrome: padding (24) + head (32) + readout strip incl. margin (42) +
  // the horizontal scrollbar gutter.
  const bigChartH = Math.max(
    240,
    (typeof window !== "undefined" ? window.innerHeight : 800) - 125,
  );

  // Timestamp formatting per frame: 1m shows time only; 5m/15m span multiple
  // days so they show date + time.
  // Always IST, never the browser's zone. Every bucket boundary these charts show
  // is an NSE session time the server aligned to the IST calendar, so rendering it
  // in local time put the open at "03:45" for a UTC viewer and shifted the
  // multi-day frames onto the wrong calendar day — while istDayKey right above was
  // already IST, so the page disagreed with itself.
  const fmtTs = (frame: OiFrame, ms: number) =>
    frame === "1m"
      ? new Date(ms).toLocaleTimeString("en-GB", {
          timeZone: "Asia/Kolkata",
          hour: "2-digit",
          minute: "2-digit",
        })
      : new Date(ms).toLocaleString("en-GB", {
          timeZone: "Asia/Kolkata",
          day: "2-digit",
          month: "short",
          hour: "2-digit",
          minute: "2-digit",
        });
  const isoFmtFor = (frame: OiFrame) => (iso: string) => fmtTs(frame, new Date(iso).getTime());
  const tsFmtFor = (frame: OiFrame) => (t: number) => fmtTs(frame, t);

  /**
   * The timeframe strip every chart card carries.
   *
   * One helper rather than five copies: the frame list and its tooltips were
   * duplicated per card, so adding the 1h frame would have meant the same edit in
   * five places (and the labels had already drifted).
   */
  const frameToggle = (
    label: string,
    value: OiFrame,
    onPick: (f: OiFrame) => void,
    kind: "level" | "delta" = "level",
  ) => (
    <div className="an-toggle" role="group" aria-label={label}>
      {OI_FRAME_OPTIONS.map((f) => (
        <button
          key={f}
          className={`btn${value === f ? " btn--primary" : ""}`}
          onClick={() => onPick(f)}
          title={(kind === "delta" ? FRAME_TITLE_DELTA : FRAME_TITLE)[f]}
        >
          {f}
        </button>
      ))}
    </div>
  );

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
  const futHistPoints = useMemo<HistPoint[]>(
    () =>
      currentFutHist
        ? futDeltaPoints(futHistRaw, currentFutHist.expiry, frameMs(futHistFrame))
        : [],
    [currentFutHist, futHistRaw, futHistFrame],
  );
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

  // How much of the LOADED chain the previous-session baseline actually covers.
  // Measured by token overlap rather than by comparing expiry strings, so it also
  // catches the case the cache only ever holds the nearest expiry while the user
  // is looking at a later one — there the baseline is real but useless here, and
  // "Day" would silently render a full column of dashes.
  const dayBaselineTokens = useMemo(() => {
    if (!chain) return 0;
    let n = 0;
    for (const s of chain.strikes) {
      if (prevClose.tokens[s.ce_token]) n++;
      if (prevClose.tokens[s.pe_token]) n++;
    }
    return n;
  }, [chain, prevClose]);
  const chainTokenCount = (chain?.strikes.length ?? 0) * 2;
  const dayAvailable = dayBaselineTokens > 0;

  /**
   * Can the server serve a window this long yet?
   *
   * Early in a session the snapshot cache doesn't reach back an hour, and the
   * server deliberately returns nothing rather than a newer reading. Checking here
   * lets the button say why instead of rendering a column of dashes. Recomputed on
   * every render, which is often — live ticks drive this component.
   */
  const minuteAvailable = (m: MinuteInterval) =>
    baselineOldest !== null &&
    Date.now() - baselineOldest >= m * 60 * 1000 - BASELINE_OLDER_TOLERANCE_MS;
  const intervalAvailable = (i: ChainInterval) =>
    i === "day" ? dayAvailable : minuteAvailable(i);

  /** Tooltip for one window button — what it compares, or why it can't yet. */
  const intervalTitle = (i: ChainInterval, what: "Change" | "Buildup") => {
    if (i === "day") return dayTitle(what);
    if (!minuteAvailable(i)) {
      return `Not enough history cached yet for a ${intervalPhrase(i)} comparison`;
    }
    return `${what} over the last ${intervalPhrase(i)}`;
  };

  // The chain now holds every strike the API returned, so the collapsed card
  // shows a band around ATM and expanding reveals the whole ladder.
  const chainRows = useMemo(() => {
    const rows = metrics?.rows ?? [];
    if (expandedCard === "chain" || rows.length === 0) return rows;
    const atm = rows.findIndex((r) => r.isAtm);
    if (atm < 0) return rows.slice(0, CHAIN_COMPACT_HALF * 2 + 1);
    const lo = Math.max(0, atm - CHAIN_COMPACT_HALF);
    const hi = Math.min(rows.length - 1, atm + CHAIN_COMPACT_HALF);
    return rows.slice(lo, hi + 1);
  }, [metrics, expandedCard]);

  // ATM straddle premium over time — the NIFTY spot overlay was dropped, so this
  // is a single-series chart and uses the shared LineChart like the others.
  const straddleChart = useMemo<ChartSeries[]>(
    () => [
      {
        label: "ATM Straddle",
        color: "var(--series-1)",
        points: straddleRaw
          .filter((p) => p.straddle > 0)
          .map((p) => ({ date: new Date(p.t).toISOString(), value: p.straddle })),
      },
    ],
    [straddleRaw],
  );
  const hasStraddle = straddleChart.some((s) => s.points.length > 1);

  /** Tooltip for the Day buttons — names the session, or why it's unavailable. */
  const dayTitle = (what: "Change" | "Buildup") => {
    if (!dayAvailable) {
      return "No previous-session close cached for this expiry yet — the server is still rebuilding it";
    }
    const gap =
      dayBaselineTokens < chainTokenCount
        ? ` (${dayBaselineTokens} of ${chainTokenCount} contracts covered${
            prevClose.complete === false ? " so far" : ""
          })`
        : "";
    return `${what} vs the ${prevClose.closedOn ?? "previous"} close${gap}`;
  };

  const pctCell = (v: number | null) =>
    v === null ? (
      <span className="an-muted">—</span>
    ) : (
      <span className={v > 0 ? "pos" : v < 0 ? "neg" : ""}>
        {v > 0 ? "+" : ""}
        {/* A decimal place is signal at 12.3% and noise at 1234.5% — and the
            extra two characters were enough to ellipsise the column. */}
        {Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1)}%
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
          {/* ---- Chain (2 rows tall) + the five time-series charts ---- */}
          <div className="an-charts an-charts--dash">
            <ChartCard
              className="an-card--chain"
              title="Option Chain"
              expanded={expandedCard === "chain"}
              onToggle={() => setExpandedCard((c) => (c === "chain" ? null : "chain"))}
              bodyClass="an-table-card"
            >
              {/* Totals live here now instead of a full-width strip above. */}
              <div className="an-chain-stats">
                <span className="an-chain-stat">
                  <span className="an-chain-stat-k">Call OI</span>
                  <span className="an-chain-stat-v neg">
                    {fmtCompact(metrics.totalCe)}
                  </span>
                </span>
                <span className="an-chain-stat">
                  <span className="an-chain-stat-k">Put OI</span>
                  <span className="an-chain-stat-v pos">
                    {fmtCompact(metrics.totalPe)}
                  </span>
                </span>
                <span className="an-chain-stat">
                  <span className="an-chain-stat-k">PCR</span>
                  <span
                    className="an-chain-stat-v"
                    title={
                      metrics.pcr !== null
                        ? "Put OI / Call OI over the 26↓ · ATM · 24↑ window"
                        : metrics.missingLegs > 0
                          ? `Waiting on open interest for ${metrics.missingLegs} contract(s) in the window — a ratio of incomplete sums would be wrong`
                          : "No open interest in the window yet"
                    }
                  >
                    {metrics.pcr === null ? "—" : metrics.pcr.toFixed(2)}
                  </span>
                </span>
                <span className="an-chain-stat-sub">24↑ · ATM · 26↓</span>
              </div>
              <div className="an-chain-bar">
                <div className="an-chain-control">
                  <span>OI Δ%</span>
                  <div className="an-toggle" role="group" aria-label="OI change window">
                    {CHAIN_INTERVALS.map((m) => (
                      <button
                        key={String(m)}
                        className={`btn${oiInterval === m ? " btn--primary" : ""}`}
                        onClick={() => setOiInterval(m)}
                        // Never disable the live selection: a baseline can go
                        // missing after it was picked (expiry switch), and a
                        // disabled-but-active button would trap the user there.
                        disabled={!intervalAvailable(m) && oiInterval !== m}
                        title={intervalTitle(m, "Change")}
                      >
                        {intervalLabel(m)}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="an-chain-control">
                  <span>Bld</span>
                  <div className="an-toggle" role="group" aria-label="Buildup window">
                    {CHAIN_INTERVALS.map((m) => (
                      <button
                        key={String(m)}
                        className={`btn${bldInterval === m ? " btn--primary" : ""}`}
                        onClick={() => setBldInterval(m)}
                        disabled={!intervalAvailable(m) && bldInterval !== m}
                        title={intervalTitle(m, "Buildup")}
                      >
                        {intervalLabel(m)}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <div className="an-chain-wrap">
                <table className="an-chain">
                  {/* Explicit widths + `table-layout: fixed` (see styles.css).
                      Without them the auto algorithm distributes the card's spare
                      width in proportion to each column's CONTENT, so the columns
                      moved every time the card was expanded and the values no
                      longer sat under their headers. Percentages are mirrored
                      around the strike so calls and puts line up exactly. */}
                  <colgroup>
                    <col className="an-col-oi" />
                    <col className="an-col-pct" />
                    <col className="an-col-bld" />
                    <col className="an-col-ltp" />
                    <col className="an-col-level" />
                    <col className="an-col-straddle" />
                    <col className="an-col-ltp" />
                    <col className="an-col-bld" />
                    <col className="an-col-pct" />
                    <col className="an-col-oi" />
                  </colgroup>
                  <thead>
                    <tr className="an-chain-side">
                      <th colSpan={4} className="an-calls">CALLS</th>
                      <th colSpan={2} className="an-strike-h">STRIKE</th>
                      <th colSpan={4} className="an-puts">PUTS</th>
                    </tr>
                    <tr>
                      {/* Each header's alignment matches its cells: numbers right,
                          badges and the strike centred. They used to disagree on
                          Bld (right header over a centred badge) and Straddle
                          (centred header over a right-aligned number). */}
                      <th>OI</th>
                      <th>OI Δ%</th>
                      <th className="an-bld-h">Bld</th>
                      <th>LTP</th>
                      <th className="an-strike-h">Level</th>
                      <th>Straddle</th>
                      <th>LTP</th>
                      <th className="an-bld-h">Bld</th>
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
                        <td className="num an-straddle-v">{fmt(r.straddle)}</td>
                        <td className="num an-pe-ltp">{fmt(r.peLtp)}</td>
                        <td className="an-bld-cell">{buildupBadge(r.peBuildup)}</td>
                        <td className="num">{pctCell(r.peOiPct)}</td>
                        <td className="num an-pe">{fmtCompact(r.peOi)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="an-card-note">
                {expandedCard === "chain"
                  ? `${chainRows.length} strikes · straddle = call LTP + put LTP`
                  : `${chainRows.length} of ${metrics.rows.length} strikes — expand for the full ladder`}
              </div>
            </ChartCard>

            <ChartCard
              title="ATM Straddle"
              expanded={expandedCard === "straddle"}
              onToggle={() =>
                setExpandedCard((c) => (c === "straddle" ? null : "straddle"))
              }
              controls={frameToggle("Straddle timeframe", straddleFrame, setStraddleFrame)}
            >
              {hasStraddle ? (
                <LineChart
                  key={straddleFrame}
                  series={straddleChart}
                  format={fmt}
                  formatX={isoFmtFor(straddleFrame)}
                  height={expandedCard === "straddle" ? bigChartH : 210}
                  fit
                  expanded={expandedCard === "straddle"}
                />
              ) : (
                <div className="chart-empty">
                  No straddle history yet for this timeframe — it fills as the day
                  progresses (or backfills from history).
                </div>
              )}
            </ChartCard>

            <ChartCard
              title="Call vs Put OI"
              expanded={expandedCard === "oi"}
              onToggle={() => setExpandedCard((c) => (c === "oi" ? null : "oi"))}
              controls={frameToggle("OI chart timeframe", oiFrame, setOiFrame)}
            >
              {ceOiSeries.length > 1 || peOiSeries.length > 1 ? (
                <LineChart
                  key={oiFrame}
                  series={oiChart}
                  format={fmtCompact}
                  formatX={isoFmtFor(oiFrame)}
                  height={expandedCard === "oi" ? bigChartH : 210}
                  fit
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
              controls={frameToggle(
                "OI-change histogram timeframe",
                histFrame,
                setHistFrame,
                "delta",
              )}
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
              controls={frameToggle("Futures OI timeframe", futFrame, setFutFrame)}
            >
              {hasFutOi ? (
                <LineChart
                  key={futFrame}
                  series={futOiChart}
                  format={fmtCompact}
                  formatX={isoFmtFor(futFrame)}
                  height={expandedCard === "futoi" ? bigChartH : 210}
                  fit
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
              controls={frameToggle(
                "Futures OI-change timeframe",
                futHistFrame,
                setFutHistFrame,
                "delta",
              )}
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
  className,
  children,
}: {
  title: string;
  expanded: boolean;
  onToggle: () => void;
  controls?: ReactNode;
  /** Extra class on the body (e.g. to lay a table card out as a column). */
  bodyClass?: string;
  /** Extra class on the card itself (e.g. to place it in the grid). */
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={`an-chart-card${expanded ? " an-chart-card--expanded" : ""}${
        className ? ` ${className}` : ""
      }`}
    >
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
