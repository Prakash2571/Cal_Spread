import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeftIcon } from "@phosphor-icons/react";
import {
  boxStreamUrl,
  closeBoxTrade,
  fetchBoxChain,
  fetchBoxExecutionAttempts,
  fetchBoxHistory,
  fetchBoxOpportunities,
  fetchBoxStatus,
  setBoxStrikeLevel,
  startBoxScanner,
  stopBoxScanner,
  type BoxChain,
  type BoxExecutionAttempt,
  type BoxHistorySource,
  type BoxOpenPosition,
  type BoxOpportunity,
  type BoxSnapshot,
  type BoxStatus,
  type BoxTrade,
} from "./api.ts";
import { fmt, formatExpiry } from "./format.ts";
import ThemeToggle from "./ThemeToggle.tsx";
import { DirectionBadge } from "./BoxDirection.tsx";
import { BoxExecutionHealth } from "./BoxExecutionHealth.tsx";
import { BoxExecutionAttempts } from "./BoxExecutionAttempts.tsx";
import { BoxDayPnlStrip } from "./BoxDayPnl.tsx";
import { BoxGates } from "./BoxGates.tsx";
import { BoxHelp } from "./BoxHelp.tsx";

interface Props {
  /** Whether a Zerodha session is live on the backend (data can flow). */
  authenticated: boolean;
  /** True for either admin role — the box endpoints require one. */
  canTrade: boolean;
  onBack: () => void;
}

/** Money with no decimals — box figures are rupees, not paise. */
function rupees(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "-";
  const sign = v < 0 ? "-" : "";
  return `${sign}₹${Math.abs(Math.round(v)).toLocaleString("en-IN")}`;
}

function pnlClass(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "muted";
  if (v > 0) return "pnl-pos";
  if (v < 0) return "pnl-neg";
  return "";
}

/**
 * How long ago this leg's order book was last pushed.
 *
 * A depth feed only sends a message when the book CHANGES, so a few seconds of
 * silence on a quiet strike is normal and the book is still the current one —
 * hence the generous limit. Beyond it the book is no longer trusted for a fill.
 */
function Freshness({ ageMs, limit }: { ageMs: number | null; limit: number }) {
  if (ageMs === null) {
    return (
      <span className="box-fresh box-fresh--bad" title="No order book received for this leg yet">
        no book
      </span>
    );
  }
  const kind = ageMs <= limit ? "ok" : "bad";
  const text = ageMs < 1000 ? `${ageMs}ms` : `${(ageMs / 1000).toFixed(1)}s`;
  return (
    <span
      className={`box-fresh box-fresh--${kind}`}
      title={
        ageMs <= limit
          ? `Book last changed ${text} ago — within the ${(limit / 1000).toFixed(0)}s trust window. An unchanged book is still the current book.`
          : `Book has not changed for ${text}, beyond the ${(limit / 1000).toFixed(0)}s trust window, so it is not trusted for a fill.`
      }
    >
      {text}
    </span>
  );
}

const STATUS_LABEL: Record<BoxOpportunity["status"], string> = {
  WATCHING: "WATCHING",
  INDICATIVE: "AT LAST CLOSE",
  UNPRICED: "UNPRICED",
  ELIGIBLE: "AUTO PAPER TRADE",
  PAPER_OPENED: "PAPER OPENED",
  OPEN: "OPEN",
  REJECTED: "BLOCKED",
};

const REJECT_LABEL: Record<string, string> = {
  no_quote: "no live book",
  stale_quote: "stale book",
  missing_bid: "no bid",
  missing_ask: "no ask",
  insufficient_qty: "under one lot at the touch",
  below_gross_prefilter: "spread too small",
  below_net_edge: "net edge below the requirement",
  unpriced_charges: "charges unavailable",
  duplicate_open: "already open",
  stale_underlying: "stale underlying",
  market_closed: "market closed",
  implausible_close: "no comparable close",
};

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function istDayKey(iso: string): string {
  const at = new Date(iso).getTime();
  return Number.isFinite(at)
    ? new Date(at + IST_OFFSET_MS).toISOString().slice(0, 10)
    : "unknown";
}

function istTodayKey(): string {
  return new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function istDayLabel(key: string): string {
  if (key === "unknown") return "Unknown date";
  const date = new Date(`${key}T00:00:00+05:30`);
  return date.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "long",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  });
}

function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
    timeZone: "Asia/Kolkata",
  });
}

function duration(fromIso: string, toIso: string | null): string {
  const a = new Date(fromIso).getTime();
  const b = toIso ? new Date(toIso).getTime() : Date.now();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return "-";
  const secs = Math.max(0, Math.round((b - a) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

export default function Box({ authenticated, canTrade, onBack }: Props) {
  const [status, setStatus] = useState<BoxStatus | null>(null);
  const [opportunities, setOpportunities] = useState<BoxOpportunity[]>([]);
  const [open, setOpen] = useState<BoxOpenPosition[]>([]);
  const [history, setHistory] = useState<BoxTrade[]>([]);
  const [chain, setChain] = useState<BoxChain | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  /** The exact strike pair whose four legs should be highlighted in the chain. */
  const [selectedPair, setSelectedPair] = useState<{ k1: number; k2: number } | null>(null);
  /** Which of the three jobs the page is showing. */
  const [view, setView] = useState<"opportunities" | "open" | "history">("opportunities");
  /** Aborted paper_legging execution attempts (loaded lazily on the History tab). */
  const [attempts, setAttempts] = useState<BoxExecutionAttempt[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [closingId, setClosingId] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  /** Closed-trade loading state, kept apart from the control surface's own error. */
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  /** Which tier served today's trades: memory / redis / mongo. */
  const [historySource, setHistorySource] = useState<BoxHistorySource | null>(null);
  const [historyDbEnabled, setHistoryDbEnabled] = useState(true);

  // The stream pushes a full snapshot a couple of times a second. It is buffered
  // and flushed on an interval so a busy scanner cannot re-render this page on
  // every frame — the backend has already made the trading decision by then.
  const pending = useRef<BoxSnapshot | null>(null);
  /**
   * Ids of closed trades held with their full execution audit, so a later
   * audit-stripped copy of the same trade cannot replace it. See mergeHistory.
   */
  const fullRows = useRef<Set<string>>(new Set());

  const running = status?.running === true;

  /* --------------------------------- load -------------------------------- */

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await fetchBoxStatus());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load box status.");
    }
  }, []);

  /**
   * Merge closed trades into the list, newest-closed first.
   *
   * Never a plain replace. Three sources feed this list — the fast "today" fetch,
   * the slower full-book fetch and live SSE `exit` events — and they can land in
   * any order, so it is keyed on id and no source can drop another's trades.
   *
   * `lite` says whether the incoming rows have had their execution-audit blobs
   * stripped (the fast path does that; the full book does not). A lite row must not
   * overwrite a full one already in state — an SSE `exit` delivers the complete
   * trade, and a later "today" refresh would otherwise quietly hollow it out.
   *
   * Which rows are full is tracked here rather than sniffed off the row, because
   * `BoxTrade` deliberately does not model the audit blobs at all: nothing on this
   * page renders them, so the wire carries fields the type has no reason to declare.
   */
  const mergeHistory = useCallback((incoming: BoxTrade[], lite = false) => {
    setHistory((current) => {
      const byId = new Map<string, BoxTrade>();
      for (const trade of current) byId.set(trade.id, trade);
      for (const trade of incoming) {
        // Keep the richer row: only skip when a lite row would replace a full one.
        if (lite && fullRows.current.has(trade.id)) continue;
        if (!lite) fullRows.current.add(trade.id);
        byId.set(trade.id, trade);
      }
      return [...byId.values()].sort((a, b) =>
        (b.closed_at ?? b.opened_at).localeCompare(a.closed_at ?? a.opened_at),
      );
    });
  }, []);

  /**
   * TODAY's closed trades — the fast path.
   *
   * The backend answers this from memory (or Redis after a restart), so the
   * session the operator is actually watching appears immediately instead of
   * waiting on a sort over the whole closed book.
   */
  const loadToday = useCallback(async () => {
    try {
      const res = await fetchBoxHistory(0, "today");
      // Audit-stripped rows: never let them overwrite a fuller row already held.
      mergeHistory(res.trades, res.lite ?? true);
      setHistorySource(res.source ?? null);
      setHistoryError(null);
      return true;
    } catch (err) {
      setHistoryError(
        err instanceof Error ? err.message : "Failed to load today's closed trades.",
      );
      return false;
    }
  }, [mergeHistory]);

  /**
   * The FULL closed book, including earlier days. Slower by nature, so it runs
   * after (and independently of) the fast path.
   *
   * The error is surfaced rather than swallowed: this list is the trade log, and an
   * empty one that silently meant "the request failed" was indistinguishable from
   * "nothing has been closed" — which is exactly how a broken history query hid
   * itself while the day-P&L strip cheerfully reported closed trades.
   */
  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      // Ask for the backend's full cap (up to 1000) rather than the first 100,
      // so the Closed tab is the whole book, not a recent slice.
      const res = await fetchBoxHistory(1000, "all");
      mergeHistory(res.trades, res.lite ?? false);
      setHistoryDbEnabled(res.dbEnabled);
      setHistoryError(null);
    } catch (err) {
      // Today's rows may already be on screen from the fast path; say so rather
      // than implying the whole log is gone.
      setHistoryError(
        `${err instanceof Error ? err.message : "Failed to load the closed-trade history."}` +
          " Earlier days may be missing.",
      );
    } finally {
      setHistoryLoading(false);
    }
  }, [mergeHistory]);

  useEffect(() => {
    if (!canTrade) return;
    void loadStatus();
    // Two phases: today's closed trades first (memory/Redis, immediate), then the
    // full book in the background. The old single full-book fetch meant the tab
    // showed nothing until the slowest query on the page finished — or forever, if
    // it failed.
    void loadToday().then(() => loadHistory());
    // A first opportunity/open snapshot, so the page is populated before the
    // stream's first frame arrives.
    fetchBoxOpportunities()
      .then((r) => {
        setOpportunities(r.opportunities);
        setStatus(r.status);
      })
      .catch(() => {});
  }, [canTrade, loadStatus, loadToday, loadHistory]);

  /* --------------------------------- stream ------------------------------- */

  useEffect(() => {
    if (!canTrade) return;
    const es = new EventSource(boxStreamUrl());

    const flush = window.setInterval(() => {
      const snap = pending.current;
      if (!snap) return;
      pending.current = null;
      setStatus(snap.status);
      setOpportunities(snap.opportunities);
      setOpen(snap.open_trades);
    }, 400);

    es.addEventListener("snapshot", (ev) => {
      try {
        pending.current = JSON.parse((ev as MessageEvent).data) as BoxSnapshot;
        setLive(true);
      } catch {
        /* ignore a malformed frame */
      }
    });
    // Entries and exits are discrete events: refresh the history immediately so a
    // closed box appears without waiting for a poll.
    es.addEventListener("entry", () => setLive(true));
    es.addEventListener("exit", (ev) => {
      try {
        const payload = JSON.parse((ev as MessageEvent).data) as { trade?: BoxTrade };
        if (!payload.trade) {
          // An exit happened but the frame carried no trade: re-read TODAY only.
          // That is the day the exit belongs to, and it is the cheap query.
          void loadToday();
          return;
        }
        // The exit stream already carries the complete serialized trade. Put it
        // at the top immediately and de-duplicate it by id; the archive fetch on
        // mount/tab-open still reconciles anything missed while disconnected.
        // Recorded as a full row so a later "today" refresh cannot strip it.
        fullRows.current.add(payload.trade.id);
        setHistory((current) => [
          payload.trade!,
          ...current.filter((trade) => trade.id !== payload.trade!.id),
        ]);
      } catch {
        void loadToday();
      }
    });
    es.onerror = () => setLive(false);

    return () => {
      window.clearInterval(flush);
      es.close();
    };
  }, [canTrade, loadToday]);

  /* --------------------------------- chain -------------------------------- */

  // The expanded underlying's chain is polled on its own slow cadence; it is a
  // visualization, not part of any decision.
  useEffect(() => {
    if (!expanded) {
      setChain(null);
      return;
    }
    let cancelled = false;
    const load = () => {
      fetchBoxChain(expanded)
        .then((c) => {
          if (!cancelled) setChain(c);
        })
        .catch((err) => {
          if (!cancelled) {
            setChain(null);
            setError(err instanceof Error ? err.message : "Failed to load the chain.");
          }
        });
    };
    load();
    const t = window.setInterval(load, 1000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [expanded]);

  /* -------------------------------- actions ------------------------------- */

  async function toggleScanner() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const next = running ? await stopBoxScanner() : await startBoxScanner();
      setStatus(next);
      setNotice(
        running
          ? "Scanner stopped. No new boxes will be opened — open positions are still monitored and can still auto-exit."
          : "Scanner running. Qualifying boxes will be paper-opened automatically.",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to change the scanner state.");
    } finally {
      setBusy(false);
    }
  }

  async function handleStrikeLevel(level: 1 | 2 | 3) {
    if (status?.strike_level === level) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const next = await setBoxStrikeLevel(level);
      setStatus(next);
      setNotice(
        `Now monitoring ATM ±${level}. New boxes are limited to this window — positions already open are unaffected and keep being monitored.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to set the strike level.");
    } finally {
      setBusy(false);
    }
  }

  async function handleClose(id: string) {
    setClosingId(id);
    setError(null);
    setNotice(null);
    try {
      setOpen(await closeBoxTrade(id));
      setNotice("Box closed at the executable touch.");
      // A manual close lands in today, so the cheap fast path is enough.
      void loadToday();
    } catch (err) {
      // A refusal (no one-lot market) is the expected, meaningful case here.
      setError(err instanceof Error ? err.message : "Failed to close the box.");
    } finally {
      setClosingId(null);
    }
  }

  const cfg = status?.config;
  const freshLimit = cfg?.quote_max_age_ms ?? 1500;
  /**
   * The ACTIVE strikes-each-side level the backend is monitoring on.
   *
   * `status.strike_level` (the live control) is authoritative; `config.strike_level`
   * is the same number and is the fallback. NOT `config.strikes_each_side`, which
   * is the immutable ATM ±3 CAP — reading that is what made the status strip claim
   * ±3 no matter which level was selected.
   */
  const strikeLevel = status?.strike_level ?? cfg?.strike_level ?? 3;
  /** Strike PAIRS in the active window: C(n,2) for n = 2·level+1 strikes. */
  const strikePairs =
    cfg?.max_candidates_per_underlying ??
    ((strikeLevel * 2 + 1) * (strikeLevel * 2)) / 2;
  /**
   * Whether the backend will build a last-close view with the scanner stopped.
   *
   * Needs the feature switched on AND a Zerodha session, since the closes are
   * fetched over REST. Without both, promising "building the last-close view…" would
   * be a spinner for work that is never going to happen — so the plain
   * "press RUN" message is the honest one.
   */
  const closedViewExpected = (cfg?.indicative_discovery ?? false) && authenticated;
  // The backend is the authority on market hours; default to "open" only once we
  // actually have a status, so the page never claims tradability it can't back.
  const marketOpen = status ? status.market_open : true;

  const eligibleCount = useMemo(
    () => opportunities.filter((o) => o.status === "ELIGIBLE").length,
    [opportunities],
  );
  // Surfaced on the Open tab so a position that needs attention is visible even
  // while you are looking at the scanner.
  const exitEligibleCount = useMemo(() => open.filter((p) => p.exit_eligible).length, [open]);
  const blockedCount = useMemo(
    () => open.filter((p) => p.exit_blocked_reason !== null).length,
    [open],
  );
  const closedNet = useMemo(
    () => history.reduce((acc, t) => acc + (t.net_pnl ?? 0), 0),
    [history],
  );
  const closedFees = useMemo(
    () => history.reduce((acc, t) => acc + (t.total_charges ?? 0), 0),
    [history],
  );
  const closedGross = useMemo(
    () => history.reduce((acc, t) => acc + (t.gross_pnl ?? 0), 0),
    [history],
  );
  /** Total basket margin every listed closed box blocked (a sum, not a peak). */
  const closedMargin = useMemo(
    () => history.reduce((acc, t) => acc + (t.margin ?? 0), 0),
    [history],
  );
  /**
   * What the backend's day summary says was closed today.
   *
   * Used to catch the exact disagreement that hid the broken history query: the
   * strip reporting "Closed today (164)" while the list rendered "No closed paper
   * boxes yet". If these two ever disagree again, the empty state says so out loud
   * instead of implying nothing was traded.
   */
  const dayPnlClosedCount = status?.day_pnl?.closed_count ?? 0;
  const todayKey = istTodayKey();
  // `<details>` has no React "defaultOpen", and an uncontrolled `open` would be
  // reset by the frequent snapshot re-renders on this page. So the open state is
  // tracked here: today is expanded until the user explicitly toggles a day.
  const [dayOverrides, setDayOverrides] = useState<Record<string, boolean>>({});
  const isDayOpen = useCallback(
    (key: string) => dayOverrides[key] ?? key === todayKey,
    [dayOverrides, todayKey],
  );
  const setDayOpen = useCallback((key: string, next: boolean) => {
    setDayOverrides((prev) => (prev[key] === next ? prev : { ...prev, [key]: next }));
  }, []);
  const historyDays = useMemo(() => {
    const groups = new Map<string, BoxTrade[]>();
    for (const trade of history) {
      const key = istDayKey(trade.closed_at ?? trade.opened_at);
      const group = groups.get(key);
      if (group) group.push(trade);
      else groups.set(key, [trade]);
    }
    return [...groups]
      .sort(([a], [b]) => {
        if (a === "unknown") return 1;
        if (b === "unknown") return -1;
        return b.localeCompare(a);
      })
      .map(([key, trades]) => ({
      key,
      label: istDayLabel(key),
      trades,
      gross: trades.reduce((sum, trade) => sum + (trade.gross_pnl ?? 0), 0),
      fees: trades.reduce((sum, trade) => sum + (trade.total_charges ?? 0), 0),
      net: trades.reduce((sum, trade) => sum + (trade.net_pnl ?? 0), 0),
      /**
       * Total basket margin these boxes blocked, and how many are missing a
       * figure. Summed over the day, so it is an upper bound on what was blocked
       * at any single instant rather than a peak: boxes that opened and closed at
       * different times never held their margin simultaneously.
       */
      margin: trades.reduce((sum, trade) => sum + (trade.margin ?? 0), 0),
      marginUnknown: trades.filter((trade) => trade.margin === null || trade.margin === undefined)
        .length,
    }));
  }, [history]);

  /* --------------------------------- render ------------------------------- */

  if (!canTrade) {
    return (
      <div className="app an-page">
        <header className="topbar">
          <div className="brand">
            <a
              className="btn an-back"
              href="/"
              onClick={(e) => {
                e.preventDefault();
                onBack();
              }}
              title="Back to board"
            >
              <ArrowLeftIcon size={16} weight="regular" aria-hidden="true" />
              Board
            </a>
            <div className="card-title">
              <h1>Box Arbitrage</h1>
            </div>
          </div>
          <div className="toolbar">
            <ThemeToggle />
          </div>
        </header>
        <div className="banner banner--info">
          The box scanner is an admin tool. Enter the access code at <code>/admin/access</code>{" "}
          (or the admin secret at <code>/admin/verify</code>) to use it.
        </div>
      </div>
    );
  }

  return (
    <div className="app an-page">
      <header className="topbar">
        <div className="brand">
          <a
            className="btn an-back"
            href="/"
            onClick={(e) => {
              e.preventDefault();
              onBack();
            }}
            title="Back to board"
            aria-label="← Board"
          >
            <ArrowLeftIcon size={16} weight="regular" aria-hidden="true" />
            Board
          </a>
          <div className="card-title">
            <h1>Box Arbitrage</h1>
            <span className="an-underline">Paper trading, one lot</span>
          </div>
        </div>

        <div className="toolbar">
          <BoxHelp />
          <ThemeToggle />
          <span
            className="box-mode"
            title="The execution model the backend is actually running. Fills are always simulated from observed executable books — never real orders."
          >
            {(status?.execution_mode ?? "paper").replace(/_/g, " ").toUpperCase()}
          </span>
          <span
            className={`status status--${
              running ? (!marketOpen ? "wait" : live ? "live" : "wait") : "idle"
            }`}
          >
            <span className="status-dot" />
            {running
              ? !marketOpen
                ? "Market closed"
                : live
                  ? "Scanning"
                  : "Starting…"
              : "Stopped"}
          </span>
          <div
            className="box-strike-level"
            role="group"
            aria-label="Strikes each side of ATM"
            title="How many strikes up/down from ATM are monitored and traded. Narrowing this only limits NEW boxes — positions already open are unaffected."
          >
            <span className="box-strike-level-label">ATM ±</span>
            {([1, 2, 3] as const).map((lvl) => (
              <button
                key={lvl}
                type="button"
                className={`btn btn--sm${status?.strike_level === lvl ? " btn--primary" : ""}`}
                aria-pressed={status?.strike_level === lvl}
                disabled={busy || !canTrade}
                onClick={() => void handleStrikeLevel(lvl)}
              >
                {lvl}
              </button>
            ))}
          </div>
          <button
            className={`btn ${running ? "btn--danger" : "btn--primary"}`}
            onClick={() => void toggleScanner()}
            disabled={busy}
            title={
              running
                ? "Stop opening new boxes (open positions stay monitored)"
                : "Start discovering and auto-opening paper boxes"
            }
          >
            {running ? "STOP" : "RUN"}
          </button>
        </div>
      </header>

      {!authenticated && (
        <div className="banner">
          Live box data needs a Zerodha session — an admin has to connect Zerodha first.
        </div>
      )}
      {error && <div className="banner banner--error">{error}</div>}
      {notice && !error && <div className="banner banner--info">{notice}</div>}
      {status && !status.db_enabled && (
        <div className="banner banner--warn">
          Box persistence is not configured on the server (MONGODB_URI), so no paper box can be
          recorded.
        </div>
      )}
      {status && status.last_error && (
        <div className="banner banner--warn">{status.last_error}</div>
      )}
      {/* The single most important thing to say when the exchange is shut: these
          are yesterday's numbers and nothing can be entered from them. */}
      {/* A dead feed is the case freshness actually guards against: every cached
          book still looks normal while being of unknown age. */}
      {status && marketOpen && running && !status.feed_healthy && (
        <div className="banner banner--error">
          <strong>Tick feed is down.</strong> No tick has arrived across the whole universe for{" "}
          {status.feed_age_ms === null
            ? "some time"
            : `${(status.feed_age_ms / 1000).toFixed(1)}s`}
          , so every cached order book is of unknown age. Entries and automatic exits are paused
          until it recovers — open positions stay open and are not closed on unverifiable prices.
        </div>
      )}
      {status && !marketOpen && (
        <div className="banner banner--warn">
          <strong>Market closed.</strong> The prices below are the{" "}
          <strong>last traded</strong> prices from the{" "}
          {status.indicative_session_day ?? "latest"} session, shown so you can see which boxes were
          mispriced at the close. They are not executable, so nothing will be entered and no open
          position will be auto-exited until the market reopens. Only strikes that actually traded in
          that session are used, and a box whose four closes do not form a coherent spread is left
          out rather than shown with an impossible edge
          {status.indicative_stale_legs > 0
            ? ` (${status.indicative_stale_legs} leg(s) skipped as stale)`
            : ""}
          .
          {status.indicative_at
            ? ` Refreshed ${fmtDateTime(new Date(status.indicative_at).toISOString())}.`
            : ""}
        </div>
      )}

      {/* ------------------------------ status strip ----------------------- */}
      <section className="box-strip">
        <div className="box-stat">
          <span className="box-stat-k">Status</span>
          <span className="box-stat-v">{status?.state ?? "…"}</span>
        </div>
        <div className="box-stat">
          <span className="box-stat-k">Entry gate</span>
          <span
            className="box-stat-v"
            title="A box is entered only when its EXPECTED NET profit — gross minus entry fees, estimated exit fees, simulated execution/slippage cost and the safety buffer — clears this, measured on the executed snapshot"
          >
            {rupees(cfg?.min_expected_net_profit ?? null)} expected net
          </span>
        </div>
        <div className="box-stat">
          <span className="box-stat-k">Execution</span>
          <span
            className="box-stat-v"
            title={
              cfg?.execution_mode === "paper_latency"
                ? `paper_latency: fills from the first WebSocket book at/after a simulated ${cfg?.simulated_latency_ms ?? 0}ms latency`
                : "paper_touch: fills at the detected touch"
            }
          >
            {cfg?.execution_mode ?? "…"}
          </span>
        </div>
        {cfg && (cfg.directions?.length ?? 0) > 1 && (
          <div className="box-stat">
            <span className="box-stat-k">Directions</span>
            <span className="box-stat-v">long + short</span>
          </div>
        )}
        <div className="box-stat">
          <span className="box-stat-k">Safety buffer</span>
          {/* It IS part of the gate: the backend deducts it inside the expected-net
              figure the gate tests against, so raising it makes entry strictly
              harder. The old tooltip said the opposite. */}
          <span
            className="box-stat-v"
            title="Deducted inside the expected-net figure the entry gate tests, so it is part of the entry decision — not just a reported number"
          >
            {rupees(cfg?.safety_buffer ?? null)}
          </span>
        </div>
        <div className="box-stat">
          <span className="box-stat-k">Universe</span>
          <span className="box-stat-v">F&amp;O stocks + indices</span>
        </div>
        <div className="box-stat">
          <span className="box-stat-k">Prices</span>
          <span className="box-stat-v">{marketOpen ? "Executable touch" : "Last close"}</span>
        </div>
        <div className="box-stat">
          <span className="box-stat-k">Strikes</span>
          {/* The ACTIVE level, not the cap. This used to render
              `strikes_each_side` — the immutable ATM ±3 ceiling — so it read ±3
              however narrow a window the admin had actually selected. */}
          <span
            className="box-stat-v"
            title={`Monitoring ${strikeLevel * 2 + 1} strikes (ATM ±${strikeLevel}), up to ${strikePairs} strike pairs per underlying. Maximum ±${cfg?.strikes_each_side ?? 3}.`}
          >
            ATM ±{strikeLevel}
            {cfg && strikeLevel < cfg.strikes_each_side && (
              <span className="box-dim"> of ±{cfg.strikes_each_side}</span>
            )}
          </span>
        </div>
        <div className="box-stat">
          <span className="box-stat-k">Mode</span>
          <span className="box-stat-v">
            {(status?.execution_mode ?? "—").replace(/_/g, " ").toUpperCase()}
          </span>
        </div>
        <div className="box-stat">
          <span className="box-stat-k">Lot</span>
          <span className="box-stat-v">1</span>
        </div>
        <div className="box-stat">
          <span className="box-stat-k">Book trusted for</span>
          <span
            className="box-stat-v"
            title="How long an UNCHANGED order book is still accepted. A depth feed only sends a message when the book changes, so silence on a quiet strike is not staleness."
          >
            {(freshLimit / 1000).toFixed(0)}s
          </span>
        </div>
        <div className="box-stat">
          <span className="box-stat-k">Feed</span>
          <span
            className={`box-stat-v ${status && !status.feed_healthy && marketOpen ? "pnl-neg" : ""}`}
            title="Heartbeat: how long since ANY instrument last ticked. Not a delay from NSE — if it goes quiet the connection is down and trading pauses."
          >
            {!status
              ? "-"
              : !marketOpen
                ? "idle"
                : status.feed_healthy
                  ? `live ${status.feed_age_ms === null ? "" : `(${status.feed_age_ms}ms)`}`
                  : "DOWN"}
          </span>
        </div>
        <div className="box-stat">
          <span className="box-stat-k">Exchange lag ≈</span>
          <span
            className="box-stat-v"
            title="Approximate staleness of the data versus NSE, from Kite's exchange_timestamp (1-second resolution, and sensitive to server-clock skew — so this is a rough figure, not a precise latency)."
          >
            {/* Only meaningful on a live feed: with the market shut the last
                sample is hours old, so the figure is stale, not a real lag. */}
            {!marketOpen || !status?.exchange_lag_ms
              ? "—"
              : `${(status.exchange_lag_ms.median_ms / 1000).toFixed(1)}s (p95 ${(status.exchange_lag_ms.p95_ms / 1000).toFixed(1)}s)`}
          </span>
        </div>
        <div className="box-stat">
          <span className="box-stat-k">Watching</span>
          <span className="box-stat-v">
            {status?.underlyings ?? 0} underlyings, {status?.candidates ?? 0} boxes
          </span>
        </div>
        <div className="box-stat">
          <span className="box-stat-k">Monitoring</span>
          <span className="box-stat-v">
            {status?.open_positions ?? 0} open
            {status?.monitor.running ? "" : " (monitor idle)"}
          </span>
        </div>
      </section>

      {/* The two thresholds above that an admin can actually change at runtime. */}
      <BoxGates
        cfg={cfg}
        canTrade={canTrade}
        onSaved={(next) => {
          setStatus(next.status);
          setNotice(null);
        }}
      />

      {status && status.skipped_for_budget > 0 && (
        <div className="banner banner--warn">
          {status.skipped_for_budget} underlying(s) are outside the live-feed token budget
          ({cfg?.max_subscribed_tokens} instruments) and are not being scanned
          {status.skipped_symbols.length > 0 ? `: ${status.skipped_symbols.join(", ")}…` : "."}
        </div>
      )}

      {/* One view at a time. The scanner, open book and history are three
          different jobs, and stacking them made the page a scroll-fest — but the
          counts stay on the tabs so nothing important is hidden behind a click. */}
      <BoxDayPnlStrip dayPnl={status?.day_pnl} />

      <BoxExecutionHealth
        metrics={status?.metrics}
        mode={status?.execution_mode ?? "paper_latency"}
      />

      <nav className="box-views" role="tablist" aria-label="Box view">
        <button
          type="button"
          role="tab"
          aria-selected={view === "opportunities"}
          className={`btn${view === "opportunities" ? " btn--primary" : ""}`}
          onClick={() => setView("opportunities")}
        >
          Opportunities <span className="pill-count">{opportunities.length}</span>
          {eligibleCount > 0 && (
            <span className="box-badge box-badge--eligible">{eligibleCount}</span>
          )}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === "open"}
          className={`btn${view === "open" ? " btn--primary" : ""}`}
          onClick={() => setView("open")}
        >
          Open trades <span className="pill-count">{open.length}</span>
          {/* Attention markers, so a position needing a look is visible from any tab. */}
          {exitEligibleCount > 0 && (
            <span className="box-badge box-badge--exit">{exitEligibleCount}</span>
          )}
          {blockedCount > 0 && <span className="box-badge box-badge--warn">{blockedCount}</span>}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === "history"}
          className={`btn${view === "history" ? " btn--primary" : ""}`}
          onClick={() => {
            setView("history");
            // Today first (instant), then reconcile the full book behind it.
            void loadToday().then(() => loadHistory());
            void fetchBoxExecutionAttempts(100).then(setAttempts).catch(() => {});
          }}
        >
          Closed trades <span className="pill-count">{history.length}</span>
        </button>
        {view === "history" && history.length > 0 && (
          <span className="box-views-total">
            <span
              className="box-dim"
              title="Total basket margin every listed box blocked, summed. Not a peak: boxes closed at different times did not hold their margin at the same moment."
            >
              Margin {rupees(closedMargin)}
            </span>
            {"  ·  "}
            <span className="box-dim">Gross {rupees(closedGross)}</span>
            {"  −  "}
            <span className="box-dim">Fees {rupees(closedFees)}</span>
            {"  =  "}
            <span className={pnlClass(closedNet)}>Net {rupees(closedNet)}</span>
          </span>
        )}
      </nav>

      {/* ------------------------------ opportunities ---------------------- */}
      {view === "opportunities" && (
      <section className="box-section">
        {!running && opportunities.length === 0 && !marketOpen && closedViewExpected ? (
          /* Market shut AND stopped, and the backend does build the last-close view
             without RUN. Only claim a pass is coming when that is actually true —
             gated on `indicative_discovery`, on Zerodha being connected, and on
             whether a pass has already completed, so this never spins forever
             asserting work that will not happen. */
          <p className="box-empty">
            {status?.indicative_at ? null : <span className="spinner" />}
            {status?.indicative_at
              ? `The last session's closes were checked ${fmtDateTime(new Date(status.indicative_at).toISOString())} and no box in the ATM ±${strikeLevel} window had a coherent, mispriced close. Nothing is executable while the market is shut.`
              : `Building the last-close view of the ATM ±${strikeLevel} window… This is a read-only look at how boxes were priced at the close; nothing can be entered while the market is shut.`}
          </p>
        ) : !running && opportunities.length === 0 ? (
          <p className="box-empty">
            The scanner is stopped. Press <strong>RUN</strong> to start scanning F&amp;O stock and
            index options — only the ATM ±{strikeLevel} window of each underlying is monitored, so at
            most {strikePairs} strike pairs per symbol.
          </p>
        ) : opportunities.length === 0 ? (
          <p className="box-empty">
            <span className="spinner" />
            {marketOpen
              ? `Scanning for a box with at least ${rupees(cfg?.min_gross_edge ?? 1200)} of spread…`
              : "Loading last-close prices…"}
          </p>
        ) : (
          <div className="box-table-wrap">
            <table className="box-table">
              <thead>
                <tr>
                  <th>Underlying</th>
                  <th>Direction</th>
                  <th>Expiry</th>
                  <th className="num">K1</th>
                  <th className="num">K2</th>
                  <th className="num">Width</th>
                  <th className="num">{marketOpen ? "Box value" : "Close cost"}</th>
                  <th className="num">Gross edge</th>
                  <th className="num">Entry fees</th>
                  <th className="num">Est. exit fees</th>
                  <th className="num">Exec. cost</th>
                  <th className="num">Safety</th>
                  <th className="num">Expected net</th>
                  <th>Liquidity</th>
                  <th>Fresh</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {opportunities.map((o) => {
                  const isOpen = o.status === "OPEN" || o.status === "PAPER_OPENED";
                  return (
                    <tr
                      key={o.key}
                      className={
                        o.status === "ELIGIBLE"
                          ? "box-row--eligible"
                          : isOpen
                            ? "box-row--open"
                            : undefined
                      }
                    >
                      <td>
                        <span className="box-sym">{o.underlying}</span>
                        {o.is_index && <span className="badge-index">INDEX</span>}
                      </td>
                      <td><DirectionBadge direction={o.direction} /></td>
                      <td className="box-dim">{formatExpiry(o.expiry)}</td>
                      <td className="num">{o.lower_strike}</td>
                      <td className="num">{o.upper_strike}</td>
                      <td className="num">{o.box_width}</td>
                      <td className="num">{rupees(o.entry_box_cost)}</td>
                      <td className={`num ${pnlClass(o.gross_edge)}`}>{rupees(o.gross_edge)}</td>
                      <td className="num box-dim">{rupees(o.entry_charges)}</td>
                      <td className="num box-dim">{rupees(o.estimated_exit_charges)}</td>
                      <td className="num box-dim">{rupees(o.execution_cost)}</td>
                      <td className="num box-dim">{rupees(o.safety_buffer)}</td>
                      <td
                        className={`num box-net ${pnlClass(o.expected_net_profit)}`}
                        title={`The entry gate is expected net ≥ ${rupees(o.min_expected_net_profit)} after every cost`}
                      >
                        {o.expected_net_profit === null ? "unpriced" : rupees(o.expected_net_profit)}
                      </td>
                      <td>
                        {/* Depth ONLY. Staleness has its own column, so a
                            perfectly deep but quiet book no longer reads as
                            illiquid. */}
                        {o.price_source === "last_close" ? (
                          <span
                            className="box-liq box-liq--closed"
                            title="Closing prices carry no bid/ask, so executable size is unknown"
                          >
                            n/a at close
                          </span>
                        ) : o.depth_ok ? (
                          <span
                            className="box-liq box-liq--ok"
                            title={`One whole lot (${o.lot_size}) rests at the best price on all four legs`}
                          >
                            {o.lot_size} @ touch
                          </span>
                        ) : (
                          <span
                            className="box-liq box-liq--bad"
                            title="At least one leg does not show a full lot at its best price"
                          >
                            under 1 lot
                          </span>
                        )}
                      </td>
                      <td>
                        {o.price_source === "last_close" ? (
                          <span className="box-fresh box-fresh--closed">close</span>
                        ) : (
                          <Freshness ageMs={o.worst_age_ms} limit={freshLimit} />
                        )}
                      </td>
                      <td>
                        <span
                          className={`box-status box-status--${o.status.toLowerCase()}`}
                          title={
                            o.status === "UNPRICED"
                              ? "Zerodha could not price the eight box orders, so this box is shown but never auto-traded"
                              : o.status === "INDICATIVE"
                                ? "Derived from last traded prices while the market is shut — not executable, so it cannot be entered"
                                : o.reject
                                  ? `Not tradable: ${REJECT_LABEL[o.reject] ?? o.reject}`
                                  : undefined
                          }
                        >
                          {STATUS_LABEL[o.status]}
                        </span>
                      </td>
                      <td>
                        <button
                          className="btn btn--sm"
                          onClick={() => {
                            const same =
                              expanded === o.underlying &&
                              selectedPair?.k1 === o.lower_strike &&
                              selectedPair?.k2 === o.upper_strike;
                            if (same) {
                              setExpanded(null);
                              setSelectedPair(null);
                            } else {
                              setExpanded(o.underlying);
                              // Pin THIS row's pair so the chain marks exactly its
                              // four legs, not just aggregate box marks.
                              setSelectedPair({ k1: o.lower_strike, k2: o.upper_strike });
                            }
                          }}
                          title="Show this box's four legs in the ATM ±3 chain"
                        >
                          {expanded === o.underlying &&
                          selectedPair?.k1 === o.lower_strike &&
                          selectedPair?.k2 === o.upper_strike
                            ? "Hide legs"
                            : "Show legs"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      )}

      {/* --------------------------------- chain --------------------------- */}
      {view === "opportunities" && expanded && (
        <section className="box-section">
          <h2 className="box-section-title">
            {expanded} chain
            {chain && (
              <span className="box-chain-meta">
                {formatExpiry(chain.expiry)} · spot {fmt(chain.spot)} · ATM {chain.atm_strike} · lot{" "}
                {chain.lot_size}
              </span>
            )}
          </h2>
          {!chain ? (
            <p className="box-empty">
              <span className="spinner" />
              Loading the ATM ±3 window…
            </p>
          ) : (
            <>
            {selectedPair && (
              <BoxLegSummary chain={chain} pair={selectedPair} />
            )}
            <div className="box-table-wrap">
              <table className="box-chain">
                <thead>
                  <tr>
                    <th colSpan={4} className="box-chain-ce">
                      CALLS
                    </th>
                    <th className="box-chain-strike-h">STRIKE</th>
                    <th colSpan={4} className="box-chain-pe">
                      PUTS
                    </th>
                  </tr>
                  <tr>
                    <th className="num">BidQty</th>
                    <th className="num">Bid</th>
                    <th className="num">Ask</th>
                    <th className="num">AskQty</th>
                    <th className="box-chain-strike-h" />
                    <th className="num">BidQty</th>
                    <th className="num">Bid</th>
                    <th className="num">Ask</th>
                    <th className="num">AskQty</th>
                  </tr>
                </thead>
                <tbody>
                  {chain.strikes.map((row) => {
                    // When a specific box row is selected, mark EXACTLY its four
                    // legs; otherwise fall back to the aggregate detected-box marks.
                    const ceSide = selectedPair
                      ? boxLegSide(selectedPair, row.strike, "CE")
                      : hasMark(row.ce?.marks, "BUY_CE")
                        ? "BUY"
                        : hasMark(row.ce?.marks, "SELL_CE")
                          ? "SELL"
                          : null;
                    const peSide = selectedPair
                      ? boxLegSide(selectedPair, row.strike, "PE")
                      : hasMark(row.pe?.marks, "BUY_PE")
                        ? "BUY"
                        : hasMark(row.pe?.marks, "SELL_PE")
                          ? "SELL"
                          : null;
                    const inPair =
                      !!selectedPair &&
                      (row.strike === selectedPair.k1 || row.strike === selectedPair.k2);
                    return (
                    <tr
                      key={row.strike}
                      className={`${row.is_atm ? "box-chain-atm" : ""}${inPair ? " box-chain-leg-row" : ""}`}
                    >
                      <td className="num">{row.ce?.bid_qty || "-"}</td>
                      <td className={`num ${ceSide === "SELL" ? "box-marked" : ""}`}>
                        {row.ce?.bid ? fmt(row.ce.bid) : "-"}
                        {ceSide === "SELL" && <span className="box-leg box-leg--sell">SELL</span>}
                      </td>
                      <td className={`num ${ceSide === "BUY" ? "box-marked" : ""}`}>
                        {row.ce?.ask ? fmt(row.ce.ask) : "-"}
                        {ceSide === "BUY" && <span className="box-leg box-leg--buy">BUY</span>}
                      </td>
                      <td className="num">{row.ce?.ask_qty || "-"}</td>
                      <td className="box-chain-strike" title={row.ce?.tradingsymbol ?? ""}>
                        {row.strike}
                        {row.is_atm && <span className="box-atm-tag">ATM</span>}
                      </td>
                      <td className="num">{row.pe?.bid_qty || "-"}</td>
                      <td className={`num ${peSide === "SELL" ? "box-marked" : ""}`}>
                        {row.pe?.bid ? fmt(row.pe.bid) : "-"}
                        {peSide === "SELL" && <span className="box-leg box-leg--sell">SELL</span>}
                      </td>
                      <td className={`num ${peSide === "BUY" ? "box-marked" : ""}`}>
                        {row.pe?.ask ? fmt(row.pe.ask) : "-"}
                        {peSide === "BUY" && <span className="box-leg box-leg--buy">BUY</span>}
                      </td>
                      <td className="num">{row.pe?.ask_qty || "-"}</td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            </>
          )}
        </section>
      )}

      {/* ------------------------------- open boxes ------------------------ */}
      {view === "open" && (
      <section className="box-section">
        <h2 className="box-section-title">
          Open box trades <span className="pill-count">{open.length}</span>
          <span className="box-chain-meta">
            Monitored by the backend — this continues with the scanner stopped and the browser
            closed.
          </span>
        </h2>
        {open.length === 0 ? (
          <p className="box-empty">
            No open paper boxes. Qualifying boxes are opened automatically while the scanner is
            running.
          </p>
        ) : (
          <div className="box-cards">
            {open.map((p) => (
              <OpenBoxCard
                key={p.id}
                p={p}
                freshLimit={freshLimit}
                closing={closingId === p.id}
                onClose={() => void handleClose(p.id)}
              />
            ))}
          </div>
        )}
      </section>
      )}

      {/* ------------------------------ closed boxes ----------------------- */}
      {view === "history" && (
      <section className="box-section">
        <h2 className="box-section-title">
          Closed box trades <span className="pill-count">{history.length}</span>
          {historyLoading && (
            <span className="box-chain-meta">
              <span className="spinner" /> loading earlier days…
            </span>
          )}
          {!historyLoading && historySource && historySource !== "none" && (
            <span className="box-chain-meta" title="Where today's closed trades were served from. memory/redis are the fast paths; mongo means the cache was cold.">
              today from {historySource}
            </span>
          )}
        </h2>
        {/* Never let a failed fetch look like "nothing has been closed". */}
        {historyError && <div className="banner banner--warn">{historyError}</div>}
        {!historyDbEnabled && (
          <div className="banner banner--warn">
            The box database is not connected on the server, so the closed-trade log cannot be
            read. Trades closed in this session may still be listed from memory.
          </div>
        )}
        {history.length === 0 ? (
          <p className="box-empty">
            {historyError
              ? "The closed-trade log could not be loaded — see the message above."
              : historyLoading
                ? "Loading closed paper boxes…"
                : dayPnlClosedCount > 0
                  ? `The day summary reports ${dayPnlClosedCount} box(es) closed today, but none could be listed. This is a load failure, not an empty log — try reloading.`
                  : "No closed paper boxes yet."}
          </p>
        ) : (
          <div className="box-history-days">
            {historyDays.map((day) => (
              <details
                className="box-history-day"
                key={day.key}
                open={isDayOpen(day.key)}
                onToggle={(e) => setDayOpen(day.key, e.currentTarget.open)}
              >
                <summary className="box-history-day-summary">
                  <span>
                    {day.key === todayKey && <strong>Today · </strong>}
                    {day.label}
                  </span>
                  <span className="box-history-day-meta">
                    <span className="pill-count">
                      {day.trades.length} {day.trades.length === 1 ? "trade" : "trades"}
                    </span>
                    <span
                      className="box-dim"
                      title={
                        `Total basket margin these ${day.trades.length} box(es) blocked, summed over the day — ` +
                        `an upper bound on what was blocked at any one instant, since boxes closed at ` +
                        `different times did not hold their margin simultaneously.` +
                        (day.marginUnknown > 0
                          ? ` ${day.marginUnknown} box(es) have no margin figure and are excluded.`
                          : "")
                      }
                    >
                      Margin {rupees(day.margin)}
                      {day.marginUnknown > 0 ? ` (${day.marginUnknown} n/a)` : ""}
                    </span>
                    <span className="box-dim">Gross {rupees(day.gross)}</span>
                    <span className="box-dim">Fees {rupees(day.fees)}</span>
                    <span className={pnlClass(day.net)}>Net {rupees(day.net)}</span>
                  </span>
                </summary>
                <div className="box-table-wrap">
                  <table className="box-table">
                    <thead>
                      <tr>
                        <th>Underlying</th>
                        <th>Direction</th>
                        <th>Expiry</th>
                        <th className="num">K1 → K2</th>
                        <th>Opened</th>
                        <th>Closed</th>
                        <th className="num">Held</th>
                        <th className="num">Margin</th>
                        <th className="num">Entry cost</th>
                        <th className="num">Exit value</th>
                        <th className="num">Entry fees</th>
                        <th className="num">Exit fees</th>
                        <th className="num">Total fees</th>
                        <th className="num">Gross P&amp;L</th>
                        <th className="num">Net P&amp;L</th>
                        <th>Reason</th>
                      </tr>
                    </thead>
                    <tbody>
                      {day.trades.map((t) => (
                        <tr key={t.id}>
                          <td>
                            <span className="box-sym">{t.underlying}</span>
                            {t.is_index && <span className="badge-index">INDEX</span>}
                          </td>
                          <td><DirectionBadge direction={t.direction} /></td>
                          <td className="box-dim">{formatExpiry(t.expiry)}</td>
                          <td className="num">
                            {t.lower_strike} → {t.upper_strike}
                          </td>
                          <td className="box-dim">{fmtDateTime(t.opened_at)}</td>
                          <td className="box-dim">{t.closed_at ? fmtDateTime(t.closed_at) : "-"}</td>
                          <td className="num box-dim">{duration(t.opened_at, t.closed_at)}</td>
                          <td className="num box-dim">{rupees(t.margin)}</td>
                          <td className="num">{rupees(t.entry_box_cost)}</td>
                          <td className="num">{rupees(t.exit_box_value)}</td>
                          <td className="num box-dim">{rupees(t.entry_charges?.total ?? null)}</td>
                          <td className="num box-dim">{rupees(t.exit_charges?.total ?? null)}</td>
                          <td className="num box-dim">{rupees(t.total_charges)}</td>
                          <td className={`num ${pnlClass(t.gross_pnl)}`}>{rupees(t.gross_pnl)}</td>
                          <td className={`num box-net ${pnlClass(t.net_pnl)}`}>{rupees(t.net_pnl)}</td>
                          <td>
                            <span className="box-reason">{t.exit_reason ?? "-"}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            ))}
          </div>
        )}

        <h2 className="box-section-title box-section-title--sub">
          Aborted legging executions <span className="pill-count">{attempts.length}</span>
          <span className="box-chain-meta">
            Partial fills that had to be emergency-unwound at a loss — not trades, but they cost
            money, so they count against strategy P&amp;L.
          </span>
        </h2>
        <BoxExecutionAttempts attempts={attempts} />
      </section>
      )}

      <p className="box-disclaimer">
        <strong>Paper execution.</strong> Every box above is simulated. A paper fill assumes all
        four one-lot legs were simultaneously executable at the touch recorded in that snapshot.
        Real trading can differ because of inter-leg latency, queue position, depth disappearing,
        partial fills, order rejection and legging risk. These are not exchange fills.
      </p>
    </div>
  );
}

function hasMark(marks: string[] | undefined, mark: string): boolean {
  return !!marks && marks.includes(mark);
}

/**
 * The side a given (strike, CE/PE) cell trades for a specific long box K1<K2:
 *   BUY  K1 CE   SELL K2 CE   BUY  K2 PE   SELL K1 PE
 * Returns null for any cell that is not one of that box's four legs.
 */
function boxLegSide(
  pair: { k1: number; k2: number } | null,
  strike: number,
  type: "CE" | "PE",
): "BUY" | "SELL" | null {
  if (!pair) return null;
  if (type === "CE" && strike === pair.k1) return "BUY";
  if (type === "CE" && strike === pair.k2) return "SELL";
  if (type === "PE" && strike === pair.k2) return "BUY";
  if (type === "PE" && strike === pair.k1) return "SELL";
  return null;
}

/** One live open box, with its entry fills and current exit arithmetic. */
function OpenBoxCard({
  p,
  freshLimit,
  closing,
  onClose,
}: {
  p: BoxOpenPosition;
  freshLimit: number;
  closing: boolean;
  onClose: () => void;
}) {
  const exitByRole = new Map(p.exit_legs.map((l) => [l.role, l]));
  return (
    <div className={`box-card${p.exit_eligible ? " box-card--exiting" : ""}`}>
      <div className="box-card-head">
        <div>
          <span className="box-sym">{p.underlying}</span>
          {p.is_index && <span className="badge-index">INDEX</span>}
          <DirectionBadge direction={p.direction} />
          <span className="box-card-strikes">
            {p.lower_strike} → {p.upper_strike}
          </span>
          <span className="box-chain-meta">
            {formatExpiry(p.expiry)} · {p.quantity} qty (1 lot) · held{" "}
            {duration(p.opened_at, null)}
          </span>
        </div>
        <div className="box-card-actions">
          {p.exit_eligible && <span className="box-badge box-badge--exit">AUTO EXIT ELIGIBLE</span>}
          {p.expiry_safety && <span className="box-badge box-badge--warn">EXPIRY SAFETY</span>}
          <button
            className="btn btn--sm"
            onClick={onClose}
            disabled={closing}
            title="Close now at the current executable touch"
          >
            {closing ? "Closing…" : "Close now"}
          </button>
        </div>
      </div>

      <div className="box-legs">
        {p.entry_legs.map((leg) => {
          const ex = exitByRole.get(leg.role);
          return (
            <div className="box-leg-row" key={leg.role}>
              <span className={`leg-tag ${leg.side === "BUY" ? "tag-buy" : "tag-sell"}`}>
                {leg.side}
              </span>
              <span className="box-leg-name">
                {leg.strike} {leg.instrument_type}
              </span>
              <span className="box-leg-cell">
                @ {fmt(leg.entry_price)}
                <span className="box-leg-side">
                  {leg.side === "BUY" ? "ask" : "bid"}
                </span>
              </span>
              <span className={`leg-tag ${ex?.side === "BUY" ? "tag-buy" : "tag-sell"}`}>
                {ex?.side ?? "-"}
              </span>
              <span className="box-leg-cell">
                {ex?.price ? fmt(ex.price) : "-"}
                <span className="box-leg-side">{ex?.side === "BUY" ? "ask" : "bid"}</span>
              </span>
              <span className="box-leg-cell box-dim">
                {ex ? `${ex.side === "BUY" ? ex.ask_qty : ex.bid_qty} @ touch` : "-"}
              </span>
              <Freshness ageMs={ex?.age_ms ?? null} limit={freshLimit} />
              {ex && !ex.executable && <span className="box-liq box-liq--bad">thin</span>}
            </div>
          );
        })}
      </div>

      <div className="box-card-grid">
        <Metric label="Entry edge" value={rupees(p.entry_edge)} />
        <Metric label="Expected net (entry)" value={rupees(p.expected_net_profit)} />
        <Metric
          label="Margin (all 4 legs)"
          value={p.margin === null ? "unpriced" : rupees(p.margin)}
        />
        <Metric label="Entry cost" value={rupees(p.entry_box_cost)} />
        <Metric label="Exit value now" value={rupees(p.exit_box_value)} />
        <Metric label="Gross P&L" value={rupees(p.gross_pnl)} cls={pnlClass(p.gross_pnl)} />
        <Metric label="Entry fees" value={rupees(p.entry_charges)} />
        <Metric label="Est. exit fees" value={rupees(p.current_exit_charges)} />
        <Metric label="Total charges" value={rupees(p.total_charges)} />
        <Metric
          label="CURRENT NET P&L"
          value={rupees(p.net_pnl)}
          cls={`box-metric--strong ${pnlClass(p.net_pnl)}`}
        />
        <Metric
          label="Realisable net"
          value={rupees(p.realisable_net_pnl)}
          cls={pnlClass(p.realisable_net_pnl)}
        />
        {/* Convergence progress — the point of the strategy. */}
        <Metric label="Remaining edge" value={rupees(p.remaining_edge)} />
        <Metric label="Captured edge" value={rupees(p.captured_edge)} />
        <Metric
          label="Captured %"
          value={p.captured_pct === null ? "—" : `${Math.round(p.captured_pct * 100)}%`}
        />
        <Metric label="Exit threshold" value={rupees(p.convergence_threshold)} />
        <Metric label="Min exit profit" value={rupees(p.min_exit_net_pnl)} />
        <Metric label="Profit capture at" value={rupees(p.profit_capture_target)} />
      </div>

      {/* Say plainly why an open box is NOT closing, so the rules are legible
          rather than looking like the engine is asleep. */}
      {!p.exit_eligible && <p className="box-held">{whyHeld(p)}</p>}
      {p.exit_blocked_reason && (
        <p className="box-blocked">
          Exit held back: {p.exit_blocked_reason}. The position stays open and keeps being
          monitored — no fill is invented.
        </p>
      )}
    </div>
  );
}

/**
 * The four exact contracts a selected box is monitoring, so the strikes and
 * trading symbols can be checked against Zerodha directly.
 */
function BoxLegSummary({
  chain,
  pair,
}: {
  chain: BoxChain;
  pair: { k1: number; k2: number };
}) {
  const k1 = chain.strikes.find((s) => s.strike === pair.k1);
  const k2 = chain.strikes.find((s) => s.strike === pair.k2);
  const legs = [
    { role: "K1 CE", side: "BUY" as const, side_price: "ask", side_of: k1?.ce },
    { role: "K2 CE", side: "SELL" as const, side_price: "bid", side_of: k2?.ce },
    { role: "K2 PE", side: "BUY" as const, side_price: "ask", side_of: k2?.pe },
    { role: "K1 PE", side: "SELL" as const, side_price: "bid", side_of: k1?.pe },
  ];
  return (
    <div className="box-legsum">
      <div className="box-legsum-head">
        Monitoring these four legs for {chain.underlying} {pair.k1} → {pair.k2}
        <span className="box-chain-meta">
          fills at the touch: BUY = ask, SELL = bid · verify the symbols against Zerodha
        </span>
      </div>
      <div className="box-legsum-grid">
        {legs.map((l) => {
          const q = l.side_of;
          const fill = q ? (l.side === "BUY" ? q.ask : q.bid) : 0;
          const qty = q ? (l.side === "BUY" ? q.ask_qty : q.bid_qty) : 0;
          return (
            <div className="box-legsum-leg" key={l.role}>
              <span className={`leg-tag ${l.side === "BUY" ? "tag-buy" : "tag-sell"}`}>
                {l.side}
              </span>
              <span className="box-legsum-role">{l.role}</span>
              <span className="box-legsum-sym" title={q?.tradingsymbol ?? "not in the window"}>
                {q?.tradingsymbol ?? "—"}
              </span>
              <span className="box-legsum-px">
                {fill ? fmt(fill) : "-"}
                <span className="box-leg-side"> {l.side_price}</span>
              </span>
              <span className="box-legsum-qty">{qty ? `${qty} qty` : "no size"}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Why an open box has not auto-closed yet, in one sentence.
 *
 * The exit rules are: close when the net P&L is positive AND either the edge has
 * converged (remaining <= threshold) with net >= the minimum profit, or the
 * captured profit has reached the target — and only while all four reversed legs
 * have fresh one-lot liquidity. This turns "not eligible" into the specific
 * reason so the page never looks like it is doing nothing.
 */
function whyHeld(p: BoxOpenPosition): string {
  if (p.net_pnl === null) {
    return "Held: charges for this box could not be priced, so its net P&L can't be confirmed — it will not auto-close on an unknown cost.";
  }
  if (p.net_pnl <= 0) {
    return `Held: closing now would realise ${rupees(p.net_pnl)} — the box will not be closed below break-even. It waits for the spread to converge back in profit.`;
  }
  if (!p.liquidity_ok) {
    return "Held: the four-leg one-lot market is not currently executable (see the leg rows above). It will close once liquidity returns.";
  }
  const remaining = p.remaining_edge;
  const converged = remaining !== null && remaining <= p.convergence_threshold;
  if (!converged && p.net_pnl < p.profit_capture_target) {
    return `Held: in profit at ${rupees(p.net_pnl)}, but the edge has not converged (remaining ${rupees(remaining)} > ${rupees(p.convergence_threshold)} target) and profit is below the ${rupees(p.profit_capture_target)} capture level. Waiting for one of those.`;
  }
  if (converged && p.net_pnl < p.min_exit_net_pnl) {
    return `Held: the edge has converged, but net profit ${rupees(p.net_pnl)} is below the ${rupees(p.min_exit_net_pnl)} minimum for a convergence exit.`;
  }
  return "Held: monitoring — exit conditions not yet met.";
}

function Metric({ label, value, cls }: { label: string; value: string; cls?: string }) {
  return (
    <div className={`box-metric ${cls ?? ""}`}>
      <span className="box-metric-k">{label}</span>
      <span className="box-metric-v">{value}</span>
    </div>
  );
}
