import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MagnifyingGlassIcon, SlidersHorizontalIcon } from "@phosphor-icons/react";
import {
  createSession,
  fetchDividends,
  fetchFnoBoard,
  fetchQuotes,
  getStatus,
  type RuntimeStatus,
  logout,
  logoutDhan,
  loginUrl,
  StaleBrokerTokensError,
  API_ORIGIN,
  browserTickStreamDeps,
  getAdminStatus,
  logoutAdmin,
  verifyAdminSecret,
  verifyAccessSecret,
  createDhanSession,
  type BrokerId,
  createTrade,
  listTrades,
  closeTrade,
  deleteTrade,
  setRfRate as syncRf,
  getRfRate,
  fetchBoxTrades,
  type BoardItem,
  type BoxOpenPosition,
  type BoxTrade,
  type Tick,
  type Trade,
  type AdminRole,
} from "./api.ts";
import {
  boardMarketDataTokens,
  describeTokenRequest,
  marketDataPhase,
  IDLE_STREAM_STATE,
  type StreamState,
} from "./marketData.ts";
import { TickStream } from "./tickStream.ts";
import { primaryAuthAction } from "./brokerAction.ts";
import StockCard from "./StockCard.tsx";
import SkeletonCard from "./SkeletonCard.tsx";
import Admin from "./Admin.tsx";
import { BrokerBadge } from "./BoxBroker.tsx";
import BrokerPanel from "./BrokerPanel.tsx";
import TradesPanel from "./TradesPanel.tsx";
import TradeConfirmModal from "./TradeConfirmModal.tsx";
import StockDetail from "./StockDetail.tsx";
import AccessTokenModal from "./AccessTokenModal.tsx";
import ThemeToggle from "./ThemeToggle.tsx";
import Analytics from "./Analytics.tsx";
import Box from "./Box.tsx";
import BrandMark from "./BrandMark.tsx";

type TickMap = Record<number, Tick>;

export default function App() {
  const [board, setBoard] = useState<BoardItem[]>([]);
  const [ticks, setTicks] = useState<TickMap>({});
  const [divYields, setDivYields] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [verifying, setVerifying] = useState(false);
  /**
   * The ACTIVE broker's market data is usable.
   *
   * Deliberately NOT "Zerodha is logged in": that conflation is what left the board
   * blank while Dhan was authenticated and streaming.
   */
  const [authenticated, setAuthenticated] = useState(false);
  /** Full runtime readiness of the active broker, for banners and diagnostics. */
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [adminRole, setAdminRole] = useState<AdminRole>(null);
  const [live, setLive] = useState(false);

  const adminAuthenticated = adminRole !== null;
  const isFullAdmin = adminRole === "full";

  // Admin-only: show only stocks with a calendar arbitrage (current & next
  // month on opposite sides - one at premium, one at discount).
  const [arbOnly, setArbOnly] = useState(false);
  const [sortMinArb, setSortMinArb] = useState(false);
  const [sortMaxArb, setSortMaxArb] = useState(false);
  const [sortOi, setSortOi] = useState(false);
  const [sortSpread, setSortSpread] = useState(false);
  const [sortDepth, setSortDepth] = useState(false);
  /**
   * Aggregated live-stream health.
   *
   * A single boolean could not distinguish "no stream yet" from "stream open, no data",
   * which is why the banner could sit on "Connecting…" indefinitely.
   */
  const [streamState, setStreamState] = useState<StreamState>(IDLE_STREAM_STATE);
  /** REST snapshot failures, previously swallowed entirely. */
  const [quoteError, setQuoteError] = useState<string | null>(null);
  /** Non-fatal stream problems (e.g. falling back to chunked streams). */
  const [streamError, setStreamError] = useState<string | null>(null);
  const [tokenModalOpen, setTokenModalOpen] = useState(false);
  const [rfRate, setRfRate] = useState<number>(() => {
    const saved = parseFloat(localStorage.getItem("cal_spread_rf") ?? "");
    return Number.isFinite(saved) ? saved : 6.5;
  });

  // --- Trades (admin only) ---
  const [trades, setTrades] = useState<Trade[]>([]);
  const [tradesOpen, setTradesOpen] = useState(false);
  const [tradesLoading, setTradesLoading] = useState(false);
  const [tradesError, setTradesError] = useState<string | null>(null);
  const [takingSymbol, setTakingSymbol] = useState<string | null>(null);
  const [confirmSymbol, setConfirmSymbol] = useState<string | null>(null);
  const [closingId, setClosingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  // Trade whose entry/exit should be marked on the detail charts.
  const [detailTrade, setDetailTrade] = useState<Trade | null>(null);

  // --- Box arbitrage trades (a separate strategy, shown in its own tab) ---
  const [boxOpen, setBoxOpen] = useState<BoxOpenPosition[]>([]);
  const [boxTrades, setBoxTrades] = useState<BoxTrade[]>([]);
  const [boxLoading, setBoxLoading] = useState(false);
  const [boxError, setBoxError] = useState<string | null>(null);

  // Client-side route (stock detail page + admin routes).
  const [route, setRoute] = useState<string>(() => window.location.pathname);
  function navigate(to: string) {
    window.history.pushState({}, "", to);
    setRoute(to);
  }
  function goHome() {
    window.history.replaceState({}, "", "/");
    setRoute("/");
  }

  const openTradeSymbols = useMemo(
    () =>
      new Set(
        trades.filter((t) => t.status === "open").map((t) => t.symbol.toUpperCase()),
      ),
    [trades],
  );

  // Live spot last-price per symbol, for the Trades panel header.
  const spotBySymbol = useMemo(() => {
    const m: Record<string, number> = {};
    for (const b of board) {
      const p = ticks[b.spot_token]?.last_price;
      if (p) m[b.symbol.toUpperCase()] = p;
    }
    return m;
  }, [board, ticks]);

  async function refreshTrades() {
    setTradesLoading(true);
    setTradesError(null);
    try {
      const res = await listTrades();
      setTrades(res.trades);
      if (!res.dbEnabled) {
        setTradesError("Trade storage isn't configured on the server (MONGODB_URI).");
      }
    } catch (err) {
      setTradesError(err instanceof Error ? err.message : "Failed to load trades.");
    } finally {
      setTradesLoading(false);
    }
  }

  /**
   * Load the box positions shown in the Trades panel's Box tab.
   *
   * Independent of refreshTrades on purpose: box documents live in their own
   * collection, so a box failure must never affect the calendar list.
   */
  async function refreshBoxTrades() {
    setBoxLoading(true);
    setBoxError(null);
    try {
      const res = await fetchBoxTrades();
      setBoxOpen(res.open);
      setBoxTrades(res.trades);
      if (!res.dbEnabled) {
        setBoxError("Box storage isn't configured on the server (MONGODB_URI).");
      }
    } catch (err) {
      setBoxError(err instanceof Error ? err.message : "Failed to load box trades.");
    } finally {
      setBoxLoading(false);
    }
  }

  async function executeTrade(symbol: string) {
    setTakingSymbol(symbol);
    setTradesError(null);
    try {
      const trade = await createTrade(symbol);
      setTrades((prev) => [trade, ...prev.filter((t) => t.id !== trade.id)]);
      setTradesOpen(true);
    } catch (err) {
      setTradesError(err instanceof Error ? err.message : "Failed to take trade.");
      setTradesOpen(true);
    } finally {
      setTakingSymbol(null);
      setConfirmSymbol(null);
    }
  }

  function handleTakeTrade(symbol: string) {
    setConfirmSymbol(symbol);
  }

  async function handleDeleteTrade(id: string) {
    setDeletingId(id);
    setTradesError(null);
    try {
      await deleteTrade(id);
      setTrades((prev) => prev.filter((t) => t.id !== id));
    } catch (err) {
      setTradesError(err instanceof Error ? err.message : "Failed to delete trade.");
    } finally {
      setDeletingId(null);
    }
  }

  function openTradeChart(t: Trade) {
    setDetailTrade(t);
    setTradesOpen(false);
    navigate(`/stock/${t.symbol}`);
  }

  async function handleCloseTrade(id: string) {
    setClosingId(id);
    setTradesError(null);
    try {
      const updated = await closeTrade(id);
      setTrades((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
    } catch (err) {
      setTradesError(err instanceof Error ? err.message : "Failed to close trade.");
    } finally {
      setClosingId(null);
    }
  }

  function updateRf(value: string) {
    const n = parseFloat(value);
    // Never store NaN. A partial entry ("-", ".", "1e") parses to NaN, which React
    // rejects as a controlled input value (blanking the box) and which fairPrice()
    // silently substitutes with rf=0 — so every card's Fair and PREM/DISC quietly
    // recomputed at zero with no indication anything was wrong.
    if (value === "") setRfRate(0);
    else if (Number.isFinite(n)) setRfRate(n);
    if (Number.isFinite(n)) {
      localStorage.setItem("cal_spread_rf", String(n));
      // Full admin only: sync to backend so it can be read via GET /api/rf.
      if (isFullAdmin) void syncRf(n).catch(() => {});
    }
  }

  const tickBuffer = useRef<TickMap>({});
  const verifyGuard = useRef(false);
  /**
   * Separate guard for the Dhan tokenId.
   *
   * Its OWN ref, not shared with the Zerodha one: the two redirects can never occur in
   * the same page load, but sharing a guard would mean whichever flow ran first
   * silently disarmed the other.
   */
  const dhanVerifyGuard = useRef(false);
  const [activeBroker, setActiveBroker] = useState<BrokerId | null>(null);
  const [brokerPanelOpen, setBrokerPanelOpen] = useState(false);

  async function loadBoard() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchFnoBoard();
      setBoard(res.board);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load F&O board.");
    } finally {
      setLoading(false);
    }
  }

  async function handleLogout() {
    // Disconnects the ACTIVE broker. This unconditionally called Zerodha's logout, so
    // with Dhan active it cleared an irrelevant Kite session and left the Dhan session
    // connected — the button said "Logout" and nothing the user cared about logged out.
    if (activeBroker === "dhan") await logoutDhan();
    else await logout();
    setAuthenticated(false);
    setLive(false);
  }

  // Full admin logout: disconnect Zerodha (token still present) then clear it.
  async function handleFullLogout() {
    await handleLogout();
    logoutAdmin();
    setAdminRole(null);
  }

  // Trade-access logout: just clear the access token (never touches Zerodha).
  function handleAccessLogout() {
    logoutAdmin();
    setAdminRole(null);
  }

  // Keep route state in sync with browser back/forward.
  useEffect(() => {
    const onPop = () => setRoute(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    let title = "Calspread";
    if (route === "/analytics") title = "Options Analytics | Calspread";
    if (route === "/box") title = "Box Arbitrage | Calspread";
    if (route.startsWith("/admin/verify")) title = "Admin Verification | Calspread";
    if (route.startsWith("/admin/access")) title = "Trade Access | Calspread";
    if (route === "/dhan/verify") title = "Connecting Dhan | Calspread";
    if (route.startsWith("/stock/")) {
      title = `${decodeURIComponent(route.slice("/stock/".length))} | Calspread`;
    }
    document.title = title;
  }, [route]);

  // Once authenticated, leave the admin login routes.
  useEffect(() => {
    // Only bounce a SIGNED-IN admin away from the plain login screens. `?switch=1`
    // deliberately still renders /admin/verify, because that is how an already-signed-in
    // operator reaches the broker picker — bouncing unconditionally is what made the
    // broker choice effectively one-shot and left the UI stuck on the first selection.
    const wantsSwitch = new URLSearchParams(window.location.search).get("switch") === "1";
    if (
      adminAuthenticated &&
      !wantsSwitch &&
      (route === "/admin/verify" || route === "/admin/access")
    ) {
      goHome();
    }
  }, [adminAuthenticated, route]);

  // Handle the Zerodha redirect at /zerodha/verify?request_token=...
  useEffect(() => {
    if (window.location.pathname !== "/zerodha/verify") return;
    // A request_token is single-use. Guard against React StrictMode running
    // this effect twice (which would re-use the token and fail the 2nd time).
    if (verifyGuard.current) return;
    verifyGuard.current = true;

    const params = new URLSearchParams(window.location.search);
    const status = params.get("status");
    const requestToken = params.get("request_token");

    if (status !== "success" || !requestToken) {
      void logout();
      setAuthenticated(false);
      setError("Zerodha login was cancelled or rejected. Please try again.");
      window.history.replaceState({}, "", "/");
      return;
    }

    setVerifying(true);
    createSession(requestToken)
      .then(() => {
        setAuthenticated(true);
        setError(null);
        window.history.replaceState({}, "", "/");
      })
      .catch((err: unknown) => {
        setAuthenticated(false);
        setError(err instanceof Error ? err.message : "Login failed.");
        window.history.replaceState({}, "", "/");
      })
      .finally(() => setVerifying(false));
  }, []);

  // Handle the Dhan redirect at /dhan/verify?tokenId=...
  useEffect(() => {
    if (window.location.pathname !== "/dhan/verify") return;
    // A tokenId is SINGLE-USE, exactly like Zerodha's request_token. Without this
    // guard React StrictMode's double effect invocation consumes it twice and the
    // second attempt fails, which looks like a broken login.
    if (dhanVerifyGuard.current) return;
    dhanVerifyGuard.current = true;

    const params = new URLSearchParams(window.location.search);
    const tokenId = params.get("tokenId");

    if (!tokenId) {
      setError("Dhan login was cancelled or rejected. Please try again.");
      window.history.replaceState({}, "", "/");
      return;
    }

    setVerifying(true);
    createDhanSession(tokenId)
      .then((session) => {
        // The Dhan SESSION is now live. Note this does not by itself switch the
        // active broker — that is a separate, guarded step, so connecting Dhan can
        // never silently move the system off Zerodha while exposure is open.
        setActiveBroker(session.broker);
        setError(null);
        window.history.replaceState({}, "", "/");
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Dhan login failed.");
        window.history.replaceState({}, "", "/");
      })
      .finally(() => setVerifying(false));
  }, []);

  // Load the board + auth status on first open.
  useEffect(() => {
    void loadBoard();
    
    // Check admin authentication + role (full vs trade-access)
    getAdminStatus()
      .then((s) => {
        setAdminRole(s.role);
        // The BACKEND is the authority on which broker is active. Adopting it here
        // means a reload shows the truth rather than whatever this tab last selected.
        if (s.broker) setActiveBroker(s.broker);
      })
      .catch(() => setAdminRole(null));
    
    getStatus()
      .then((s) => {
        setRuntime(s);
        setAuthenticated(s.authenticated);
        if (s.broker) setActiveBroker(s.broker);
      })
      .catch(() => setAuthenticated(false));
    // Dividend yields come from Yahoo (independent of Zerodha login).
    fetchDividends()
      .then(setDivYields)
      .catch(() => setDivYields({}));
    // The backend is the source of truth for the risk-free rate. Load the
    // admin-set value so every browser/visitor shows the same latest number.
    getRfRate()
      .then((rf) => {
        if (rf !== null) {
          setRfRate(rf);
          localStorage.setItem("cal_spread_rf", String(rf));
        }
      })
      .catch(() => {
        /* keep local default */
      });
  }, []);

  // Load trades once any admin (full or trade-access) is authenticated.
  useEffect(() => {
    if (!adminAuthenticated) return;
    void refreshTrades();
  }, [adminRole]);

  /** Re-read runtime status on demand (stream opened, first tick, broker change). */
  const refreshRuntime = useCallback(async () => {
    try {
      const s = await getStatus();
      setRuntime(s);
      if (s.broker) setActiveBroker(s.broker);
      // ADOPT the server's answer in BOTH directions. This used to only ever set true,
      // so a session that expired server-side left the UI insisting it was authenticated:
      // the stream was never torn down, stale prices kept rendering as if live, and the
      // "connect your broker" banner never appeared.
      setAuthenticated(s.authenticated);
    } catch {
      /* backend unreachable — the poll below keeps trying */
    }
  }, []);

  // Poll runtime status CONTINUOUSLY, not only until a session appears.
  //
  // This used to bail out with `if (authenticated) return`, so polling stopped the
  // moment a session existed. But `feed_state` keeps changing afterwards —
  // CONNECTED_NO_SUBSCRIPTIONS -> CONNECTING -> LIVE as browser streams open and ticks
  // start arriving. Freezing the poll froze the banner, which is why it kept insisting
  // "nothing is subscribed yet" long after subscriptions existed.
  useEffect(() => {
    const id = setInterval(() => {
      void refreshRuntime();
    }, 7000);
    return () => clearInterval(id);
  }, [refreshRuntime]);

  // Live market data for the whole board, for ANY visitor once the active broker has a
  // session (not just the admin who logged in).
  //
  // The token list is POSTed rather than put in a URL. Listing ~816 ten-digit tokens in
  // a query string produced a 9022-character request line, which nginx rejects with 414
  // before the backend runs — so no subscription was ever registered and every cell
  // showed "-". See marketData.ts / tickStream.ts.
  useEffect(() => {
    if (!authenticated || board.length === 0) return;

    // DEDUPLICATED once, here, and used for both the snapshot and the stream so the two
    // can never disagree about what is being watched.
    const tokens = boardMarketDataTokens(board);

    // Logged in production too, once per board load. These are exactly the numbers that
    // identify this class of failure, and having to reproduce them by hand is what made
    // the original diagnosis slow.
    const diag = describeTokenRequest(board, API_ORIGIN);
    console.log(
      `[MarketData] board=${diag.board} rawTokens=${diag.rawTokens} ` +
        `uniqueTokens=${diag.uniqueTokens}`,
    );
    console.log(
      `[MarketData] singleGetUrlLength=${diag.singleUrlLength} (the shape nginx rejected ` +
        `with 414) fallbackChunks=${diag.chunks} maxChunkUrlLength=${diag.maxChunkUrlLength} ` +
        `withinLimit=${diag.withinUrlLimit}`,
    );

    let cancelled = false;

    // 1) SNAPSHOT FIRST. Seeds prices immediately and is the ONLY source outside market
    //    hours, so a failure here must be visible rather than swallowed.
    fetchQuotes(tokens)
      .then((seed) => {
        if (cancelled || seed.length === 0) return;
        setTicks((prev) => {
          const next = { ...prev };
          for (const t of seed) next[t.token] = t;
          return next;
        });
        setQuoteError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        if (err instanceof StaleBrokerTokensError) {
          void loadBoard();
          return;
        }
        // Previously discarded. That silence is what made a 414 look like a quiet market.
        console.error("[MarketData] REST quote seed failed:", message);
        setQuoteError(`Price snapshot failed: ${message}`);
      });

    // 2) LIVE UPDATES over a single session-backed SSE connection.
    const stream = new TickStream(tokens, {
      onTicks: (incoming) => {
        for (const t of incoming) tickBuffer.current[t.token] = t;
        setLive(true);
      },
      onState: (state) => setStreamState(state),
      // The feed state changes AFTER these happen, so the banner must be re-read or it
      // stays stuck on whatever it said when the page loaded.
      onOpened: () => void refreshRuntime(),
      onFirstTick: () => void refreshRuntime(),
      onFatal: (message) => {
        setLive(false);
        setStreamState(IDLE_STREAM_STATE);
        setError(message);
        // RE-ARM, don't just report. A TickStream that has gone fatal is stopped for good,
        // and this effect only re-runs when `authenticated` or `board` changes — neither of
        // which a fatal feed altered. The result was a permanently dead feed sitting on
        // "Connecting…" until the user reloaded the page. Refetching the board changes
        // `board`'s identity, which rebuilds the stream; `refreshRuntime` then also adopts
        // a genuinely lost session and tears the effect down instead.
        void refreshRuntime();
        void loadBoard();
      },
      onError: (message) => {
        console.warn("[MarketData]", message);
        setStreamError(message);
      },
    }, browserTickStreamDeps());
    void stream.start();

    // Batch ticks and flush twice a second to keep rendering smooth.
    const flush = setInterval(() => {
      if (Object.keys(tickBuffer.current).length === 0) return;
      setTicks((prev) => ({ ...prev, ...tickBuffer.current }));
      tickBuffer.current = {};
    }, 500);

    return () => {
      cancelled = true;
      clearInterval(flush);
      // The BUFFER must be dropped too, not just the tick map. It survives this effect,
      // so on a broker change the pending Kite-namespaced ticks were flushed into the
      // freshly cleared Dhan-keyed map 500ms later — re-injecting the previous broker's
      // prices under colliding token integers, which is exactly what clearing `ticks`
      // was meant to prevent.
      tickBuffer.current = {};
      setStreamState(IDLE_STREAM_STATE);
      // Without this, `marketDataPhase` still saw hasTicks=true with zero open streams
      // and reported "Live" while nothing was connected.
      setLive(false);
      stream.close();
    };
  }, [authenticated, board]);

  const filtered = useMemo(() => {
    let list = board;

    const q = query.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (b) =>
          b.symbol.toLowerCase().includes(q) ||
          b.name.toLowerCase().includes(q),
      );
    }

    if (arbOnly) {
      // Mispricing size as a PERCENTAGE of spot (sum of both legs' deviation).
      const arbPct = (b: BoardItem): number => {
        const spot = ticks[b.spot_token]?.last_price;
        const cur = b.futures[0] ? ticks[b.futures[0].token]?.last_price : undefined;
        const nxt = b.futures[1] ? ticks[b.futures[1].token]?.last_price : undefined;
        if (!spot || !cur || !nxt) return 0;
        return ((Math.abs(cur - spot) + Math.abs(nxt - spot)) / spot) * 100;
      };

      list = list.filter((b) => {
        const spot = ticks[b.spot_token]?.last_price;
        const cur = b.futures[0] ? ticks[b.futures[0].token]?.last_price : undefined;
        const nxt = b.futures[1] ? ticks[b.futures[1].token]?.last_price : undefined;
        if (!spot || !cur || !nxt) return false;
        const premCur = cur - spot;
        const premNext = nxt - spot;
        // Arbitrage: the two legs are on opposite sides of spot.
        return (premCur > 0 && premNext < 0) || (premCur < 0 && premNext > 0);
      });

      // Sort only when an explicit sort button is active:
      // sortMinArb = ascending (smallest diff first)
      // sortMaxArb = descending (biggest diff first)
      // neither = keep original (unsorted/random) order
      if (sortMinArb || sortMaxArb || sortOi || sortSpread || sortDepth) {
        list = [...list].sort((a, b) => {
          let cmp = 0;

          // Primary: arb percentage sort (if active)
          if ((sortMinArb || sortMaxArb) && cmp === 0) {
            cmp = sortMinArb ? arbPct(a) - arbPct(b) : arbPct(b) - arbPct(a);
          }

          // Secondary: OI, Spread, Depth (tiebreakers when arb is active, primary otherwise)
          if (sortOi && cmp === 0) {
            const oiA = (a.futures[1] ? ticks[a.futures[1].token]?.oi : undefined) ?? 0;
            const oiB = (b.futures[1] ? ticks[b.futures[1].token]?.oi : undefined) ?? 0;
            cmp = oiB - oiA; // descending (high to low)
          }

          if (sortSpread && cmp === 0) {
            const tickA = a.futures[1] ? ticks[a.futures[1].token] : undefined;
            const tickB = b.futures[1] ? ticks[b.futures[1].token] : undefined;
            const spreadA = tickA && tickA.ask && tickA.ask > 0 && tickA.bid && tickA.bid > 0 ? tickA.ask - tickA.bid : Infinity;
            const spreadB = tickB && tickB.ask && tickB.ask > 0 && tickB.bid && tickB.bid > 0 ? tickB.ask - tickB.bid : Infinity;
            cmp = spreadA - spreadB; // ascending (tightest first)
          }

          if (sortDepth && cmp === 0) {
            const tickA = a.futures[1] ? ticks[a.futures[1].token] : undefined;
            const tickB = b.futures[1] ? ticks[b.futures[1].token] : undefined;
            const depthA =
              (tickA?.bids?.slice(0, 5).reduce((sum, l) => sum + l.orders, 0) ?? 0) +
              (tickA?.asks?.slice(0, 5).reduce((sum, l) => sum + l.orders, 0) ?? 0);
            const depthB =
              (tickB?.bids?.slice(0, 5).reduce((sum, l) => sum + l.orders, 0) ?? 0) +
              (tickB?.asks?.slice(0, 5).reduce((sum, l) => sum + l.orders, 0) ?? 0);
            cmp = depthB - depthA; // descending (most orders first)
          }

          return cmp;
        });
      }
    } else if (sortOi || sortSpread || sortDepth) {
      // When arbOnly is not active, OI/Spread/Depth still work as primary sorts
      list = [...list].sort((a, b) => {
        let cmp = 0;

        if (sortOi && cmp === 0) {
          const oiA = (a.futures[1] ? ticks[a.futures[1].token]?.oi : undefined) ?? 0;
          const oiB = (b.futures[1] ? ticks[b.futures[1].token]?.oi : undefined) ?? 0;
          cmp = oiB - oiA;
        }

        if (sortSpread && cmp === 0) {
          const tickA = a.futures[1] ? ticks[a.futures[1].token] : undefined;
          const tickB = b.futures[1] ? ticks[b.futures[1].token] : undefined;
          const spreadA = tickA && tickA.ask && tickA.ask > 0 && tickA.bid && tickA.bid > 0 ? tickA.ask - tickA.bid : Infinity;
          const spreadB = tickB && tickB.ask && tickB.ask > 0 && tickB.bid && tickB.bid > 0 ? tickB.ask - tickB.bid : Infinity;
          cmp = spreadA - spreadB;
        }

        if (sortDepth && cmp === 0) {
          const tickA = a.futures[1] ? ticks[a.futures[1].token] : undefined;
          const tickB = b.futures[1] ? ticks[b.futures[1].token] : undefined;
          const depthA =
            (tickA?.bids?.slice(0, 5).reduce((sum, l) => sum + l.orders, 0) ?? 0) +
            (tickA?.asks?.slice(0, 5).reduce((sum, l) => sum + l.orders, 0) ?? 0);
          const depthB =
            (tickB?.bids?.slice(0, 5).reduce((sum, l) => sum + l.orders, 0) ?? 0) +
            (tickB?.asks?.slice(0, 5).reduce((sum, l) => sum + l.orders, 0) ?? 0);
          cmp = depthB - depthA;
        }

        return cmp;
      });
    }

    return list;
  }, [board, query, arbOnly, sortMinArb, sortMaxArb, sortOi, sortSpread, sortDepth, ticks]);

  /**
   * Whether the ACTIVE broker has a session.
   *
   * `broker_authenticated` rather than `authenticated`: the latter also requires market
   * data to be ready, so a connected Dhan account whose static IP is still being
   * verified would read as "not logged in" and be offered a connect button it does not
   * need. Falls back to local state when the runtime poll has not landed yet.
   */
  const brokerConnected = runtime?.broker_authenticated ?? authenticated;

  /** Which primary auth button the header shows. See brokerAction.ts. */
  const authAction = useMemo(
    () => primaryAuthAction(activeBroker, brokerConnected),
    [activeBroker, brokerConnected],
  );

  // Derived from stream COUNTS plus tick arrival, so each distinct situation gets its
  // own label instead of everything collapsing into "Connecting…".
  const status = useMemo(() => {
    switch (marketDataPhase(streamState, live, authenticated)) {
      case "live":
        return { kind: "live", label: "Live" };
      case "degraded":
        return { kind: "wait", label: "Live (reconnecting)" };
      case "awaiting-ticks":
        return { kind: "wait", label: "Awaiting ticks" };
      case "connecting":
        return { kind: "wait", label: "Connecting…" };
      default:
        return { kind: "idle", label: "Login for live" };
    }
  }, [streamState, live, authenticated]);

  // Full-admin verification route
  // Accept /admin/verify and any trailing segment (e.g. the /admin/verify/dhan URL
  // people naturally try), rather than silently falling through to the board.
  const isAdminVerifyRoute = route === "/admin/verify" || route.startsWith("/admin/verify/");
  const isAdminAccessRoute = route === "/admin/access" || route.startsWith("/admin/access/");
  /** A signed-in admin re-opening the picker to CHANGE broker. */
  const wantsBrokerSwitch =
    new URLSearchParams(window.location.search).get("switch") === "1";
  /** A broker preselected by the URL, so /admin/verify/dhan lands on Dhan. */
  const routeBroker: BrokerId | null = route.endsWith("/dhan")
    ? "dhan"
    : route.endsWith("/zerodha")
      ? "zerodha"
      : null;

  if (isAdminVerifyRoute && (!adminAuthenticated || wantsBrokerSwitch)) {
    return (
      <Admin
        verify={verifyAdminSecret}
        chooseBroker
        {...(routeBroker ? { initialBroker: routeBroker } : {})}
        title="Admin Verification"
        subtitle="Choose a broker and enter the admin secret for full access."
        placeholder="Enter admin secret"
        onAuthenticated={(result) => {
          setAdminRole("full");
          if (result.broker) setActiveBroker(result.broker);
          // A refused switch keeps the operator on this screen's warning; only a
          // clean verification navigates away.
          if (!result.brokerSwitchRefused) goHome();
        }}
      />
    );
  }

  // Trade-access route (view & take trades only, no Zerodha controls)
  if (isAdminAccessRoute && !adminAuthenticated) {
    return (
      <Admin
        verify={verifyAccessSecret}
        title="Trade Access"
        subtitle="Enter the access code to view and take trades."
        placeholder="Enter access code"
        onAuthenticated={(result) => {
          setAdminRole("trade");
          // Trade-access INHERITS the active broker; it never chooses one.
          if (result.broker) setActiveBroker(result.broker);
          goHome();
        }}
      />
    );
  }

  // Public NIFTY options analytics page.
  if (route === "/analytics") {
    return <Analytics authenticated={authenticated} onBack={() => navigate("/")} />;
  }

  // Box arbitrage scanner (paper trading) — its own page, like Analytics.
  if (route === "/box") {
    return (
      <Box
        authenticated={authenticated}
        canTrade={adminAuthenticated}
        onBack={() => navigate("/")}
      />
    );
  }

  // Stock detail page with price/OI history charts.
  if (route.startsWith("/stock/")) {
    const sym = decodeURIComponent(route.slice("/stock/".length));
    const item = board.find((b) => b.symbol.toUpperCase() === sym.toUpperCase());
    const tradeForView =
      (detailTrade && detailTrade.symbol.toUpperCase() === sym.toUpperCase()
        ? detailTrade
        : null) ??
      trades.find(
        (t) => t.symbol.toUpperCase() === sym.toUpperCase() && t.status === "open",
      ) ??
      trades.find((t) => t.symbol.toUpperCase() === sym.toUpperCase()) ??
      null;
    return (
      <>
        <StockDetail
          symbol={item?.symbol ?? sym}
          item={item}
          ticks={ticks}
          rf={rfRate}
          div={divYields[item?.symbol ?? ""] ?? 0}
          showPrices={authenticated}
          trade={tradeForView}
          markStart={tradeForView?.opened_at}
          markEnd={tradeForView?.closed_at ?? undefined}
          showIntraday={!tradeForView || tradeForView.status === "open"}
          onBack={() => navigate("/")}
          canTrade={adminAuthenticated && authenticated}
          tradeBusy={takingSymbol === sym}
          hasOpenTrade={openTradeSymbols.has(sym.toUpperCase())}
          onTakeTrade={handleTakeTrade}
          isAdmin={adminAuthenticated}
        />
        {confirmSymbol && (() => {
          const confirmItem = board.find((b) => b.symbol === confirmSymbol);
          if (!confirmItem) return null;
          return (
            <TradeConfirmModal
              symbol={confirmSymbol}
              item={confirmItem}
              ticks={ticks}
              busy={takingSymbol === confirmSymbol}
              onConfirm={() => void executeTrade(confirmSymbol)}
              onCancel={() => setConfirmSymbol(null)}
            />
          );
        })()}
      </>
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <BrandMark />
          <div className="card-title">
            <h1>Calspread</h1>
          </div>
        </div>

        <div className="toolbar">
          <label className="search-wrap">
            <span className="sr-only">Search symbol or company</span>
            <MagnifyingGlassIcon size={16} weight="regular" aria-hidden="true" />
            <input
              className="search"
              type="search"
              placeholder="Search symbol or company…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <ThemeToggle />
          {adminAuthenticated && activeBroker && (
            <button
              type="button"
              className="broker-chip"
              onClick={() => setBrokerPanelOpen(true)}
              title="Change broker, connect or disconnect"
            >
              <BrokerBadge broker={activeBroker} />
            </button>
          )}
          {(authenticated || adminAuthenticated) && (
            <span className={`status status--${status.kind}`}>
              <span className="status-dot" />
              {status.label}
            </span>
          )}
          <span className="count">
            <strong>{filtered.length.toLocaleString()}</strong> stocks
          </span>
          <a
            className="btn"
            href="/analytics"
            onClick={(event) => {
              event.preventDefault();
              navigate("/analytics");
            }}
            title="NIFTY options analytics: live option chain, OI change & charts"
          >
            Analytics
          </a>
          {/* Admin-only: the box scanner is an internal paper-trading tool and is
              deliberately not advertised to ordinary visitors. */}
          {adminAuthenticated && (
            <a
              className="btn"
              href="/box"
              onClick={(event) => {
                event.preventDefault();
                navigate("/box");
              }}
              title="Box arbitrage scanner (paper trading): ATM ±3, one lot, executable touch prices"
            >
              Box
            </a>
          )}
          {adminAuthenticated && (
            <details className="toolbar-menu">
              <summary className="btn toolbar-menu-trigger">
                <SlidersHorizontalIcon size={16} weight="regular" aria-hidden="true" />
                Controls
                {openTradeSymbols.size > 0 && (
                  <span className="btn-badge">{openTradeSymbols.size}</span>
                )}
              </summary>
              <div className="toolbar-popover">
                {isFullAdmin && (
                  <label className="rf" title="Annual risk-free rate used for fair value">
                    <span>rf</span>
                    <input
                      type="number"
                      step="0.1"
                      min="0"
                      value={rfRate}
                      onChange={(e) => updateRf(e.target.value)}
                    />
                    <span>%</span>
                  </label>
                )}
                <div className="toolbar-popover-actions">
                  <button
                    className={`btn${arbOnly ? " btn--primary" : ""}`}
                    aria-pressed={arbOnly}
                    onClick={() => {
                      setArbOnly((v) => {
                        if (v) {
                          setSortMinArb(false);
                          setSortMaxArb(false);
                        }
                        return !v;
                      });
                    }}
                    title="Show only stocks where current & next month are on opposite sides (one premium, one discount)"
                  >
                    Arbitrage
                  </button>
                  {arbOnly && (
                    <>
                      <button
                        className={`btn${sortMinArb ? " btn--primary" : ""}`}
                        aria-pressed={sortMinArb}
                        onClick={() => {
                          setSortMinArb((v) => !v);
                          setSortMaxArb(false);
                        }}
                        title="Sort by minimum percentage difference between current and next month futures (smallest first)"
                      >
                        Min Arb
                      </button>
                      <button
                        className={`btn${sortMaxArb ? " btn--primary" : ""}`}
                        aria-pressed={sortMaxArb}
                        onClick={() => {
                          setSortMaxArb((v) => !v);
                          setSortMinArb(false);
                        }}
                        title="Sort by maximum percentage difference between current and next month futures (largest first)"
                      >
                        Max Arb
                      </button>
                    </>
                  )}
                  <button
                    className={`btn${sortOi ? " btn--primary" : ""}`}
                    aria-pressed={sortOi}
                    onClick={() => setSortOi((v) => !v)}
                    title="Sort by mid-month futures OI (high to low)"
                  >
                    OI
                  </button>
                  <button
                    className={`btn${sortSpread ? " btn--primary" : ""}`}
                    aria-pressed={sortSpread}
                    onClick={() => setSortSpread((v) => !v)}
                    title="Sort by bid-ask spread for 2nd month future (tightest first)"
                  >
                    Spread
                  </button>
                  <button
                    className={`btn${sortDepth ? " btn--primary" : ""}`}
                    aria-pressed={sortDepth}
                    onClick={() => setSortDepth((v) => !v)}
                    title="Sort by total orders in top 5 bids + top 5 asks for 2nd month future (deepest first)"
                  >
                    Depth
                  </button>
                  <button
                    className="btn"
                    onClick={() => {
                      setTradesOpen(true);
                      void refreshTrades();
                      void refreshBoxTrades();
                    }}
                  >
                    Trades
                    {openTradeSymbols.size > 0 && (
                      <span className="btn-badge">{openTradeSymbols.size}</span>
                    )}
                  </button>
                  {isFullAdmin && authenticated && (
                    <button
                      className="btn"
                      onClick={() => setTokenModalOpen(true)}
                      title="View & copy today's Zerodha access token"
                    >
                      Access Token
                    </button>
                  )}
                </div>
              </div>
            </details>
          )}
          {isFullAdmin && (
            <button
              className="btn"
              onClick={() => setBrokerPanelOpen(true)}
              title="Switch broker, connect or disconnect"
            >
              Broker
            </button>
          )}
          {isFullAdmin ? (
            // The choice itself lives in `primaryAuthAction`, which tests connectedness
            // ONCE for whichever broker is active. The Dhan branch here used to render
            // "Connect to Dhan" unconditionally, never consulting the session, so a
            // connected Dhan account streaming live prices still showed a connect
            // button. Keeping the decision in one tested function is what stops that
            // asymmetry coming back a third time.
            authAction.kind === "logout" ? (
              <button
                className="btn"
                onClick={() => void handleFullLogout()}
                title={`Disconnect ${authAction.broker === "dhan" ? "Dhan" : "Zerodha"} and sign out`}
              >
                {authAction.label}
              </button>
            ) : authAction.kind === "connect-dhan" ? (
              <button className="btn btn--primary" onClick={() => setBrokerPanelOpen(true)}>
                {authAction.label}
              </button>
            ) : (
              <a className="btn btn--primary" href={loginUrl()}>
                {authAction.label}
              </a>
            )
          ) : adminAuthenticated ? (
            <button className="btn" onClick={handleAccessLogout}>
              Logout
            </button>
          ) : null}
        </div>
      </header>

      {verifying && <div className="banner">Verifying your login…</div>}

      {isFullAdmin && !authenticated && !verifying && (
        // Names the ACTIVE broker. Telling an operator to connect Zerodha while Dhan is
        // the active broker sent them to fix the wrong thing.
        <div className="banner">
          {activeBroker === "dhan" ? (
            <>
              <button className="link link--button" onClick={() => setBrokerPanelOpen(true)}>
                Connect Dhan
              </button>{" "}
              to stream live prices &amp; premium/discount.
              {runtime?.problems && runtime.problems.length > 0 && (
                // Every reason, never collapsed into one vague line.
                <ul className="banner-reasons">
                  {runtime.problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <>
              Click{" "}
              <a className="link" href={loginUrl()}>
                Connect to Zerodha
              </a>{" "}
              to stream live prices &amp; premium/discount.
            </>
          )}
        </div>
      )}
      {/* A failed price snapshot used to be discarded silently, which is precisely how a
          414 from the proxy looked identical to a quiet market. */}
      {quoteError && <div className="banner banner--warn">{quoteError}</div>}
      {streamError && <div className="banner banner--warn">{streamError}</div>}
      {/* Connected and subscribed-to-nothing is its own failure, and used to be
          invisible: the panel said Feed=Live while every card showed "-".
          Suppressed once streams are actually open, because the status poll can still be
          a few seconds behind reality and a stale warning is worse than none. */}
      {isFullAdmin &&
        authenticated &&
        runtime?.feed_state === "CONNECTED_NO_SUBSCRIPTIONS" &&
        streamState.open === 0 && (
          <div className="banner banner--warn">
            {activeBroker === "dhan" ? "Dhan" : "Zerodha"} feed is connected but nothing is
            subscribed yet — prices will appear once the board loads.
          </div>
        )}
      {isFullAdmin && authenticated && runtime?.feed_state === "STALE" && (
        <div className="banner banner--warn">
          No {activeBroker === "dhan" ? "Dhan" : "Zerodha"} tick received recently. The
          feed may have stalled — check the Broker panel.
        </div>
      )}

      {error && <div className="banner banner--error">{error}</div>}

      {loading && board.length === 0 ? (
        <div className="cards">
          {Array.from({ length: 9 }).map((_, i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
      ) : (
        <div className="cards">
          {filtered.map((item) => (
            <StockCard
              key={item.symbol}
              item={item}
              ticks={ticks}
              rf={rfRate}
              div={divYields[item.symbol] ?? 0}
              showPrices={authenticated}
              canTrade={adminAuthenticated && authenticated}
              tradeBusy={takingSymbol === item.symbol}
              hasOpenTrade={openTradeSymbols.has(item.symbol.toUpperCase())}
              onTakeTrade={handleTakeTrade}
              onOpen={(sym) => {
                setDetailTrade(null);
                navigate(`/stock/${sym}`);
              }}
            />
          ))}
        </div>
      )}

      {!loading && filtered.length === 0 && (
        <div className="empty">
          {arbOnly
            ? "No stocks currently show a calendar arbitrage (one leg premium, one discount)."
            : `No F&O stocks match “${query}”.`}
        </div>
      )}

      {brokerPanelOpen && (
        <BrokerPanel
          isFullAdmin={isFullAdmin}
          onClose={() => setBrokerPanelOpen(false)}
          // Adopt the SERVER's answer, so the badge can never disagree with reality.
          onBrokerChanged={(broker) => {
            const changed = activeBroker !== null && activeBroker !== broker;
            setActiveBroker(broker);
            if (!changed) return;
            // A BROKER CHANGE INVALIDATES EVERY PRICE ON SCREEN. Kite and Dhan tokens
            // are different namespaces, so the tick map is keyed by ids that no longer
            // mean anything — leaving it would display the previous broker's prices
            // against the new broker's board.
            setTicks({});
            setBoard([]);
            setRuntime(null);
            setAuthenticated(false);
            setBrokerPanelOpen(false);
            // The old broker's streams are torn down by the board effect's cleanup; clear
            // the derived state so the banner cannot report the previous broker's health.
            setStreamState(IDLE_STREAM_STATE);
            setQuoteError(null);
            setStreamError(null);
            setLive(false);
            // Refetch the board in the NEW namespace; the stream effect then reopens
            // SSE with the new tokens.
            void loadBoard();
            void getStatus()
              .then((s) => {
                setRuntime(s);
                setAuthenticated(s.authenticated);
              })
              .catch(() => undefined);
          }}
        />
      )}
      {tokenModalOpen && (
        <AccessTokenModal onClose={() => setTokenModalOpen(false)} />
      )}

      {tradesOpen && (
        <TradesPanel
          trades={trades}
          ticks={ticks}
          spotBySymbol={spotBySymbol}
          loading={tradesLoading}
          error={tradesError}
          closingId={closingId}
          onClose={() => setTradesOpen(false)}
          onCloseTrade={(id) => void handleCloseTrade(id)}
          onOpenTrade={openTradeChart}
          deletingId={deletingId}
          onDeleteTrade={(id) => void handleDeleteTrade(id)}
          boxOpen={boxOpen}
          boxTrades={boxTrades}
          boxLoading={boxLoading}
          boxError={boxError}
          onOpenBoxPage={() => {
            setTradesOpen(false);
            navigate("/box");
          }}
        />
      )}

      {confirmSymbol && (() => {
        const confirmItem = board.find((b) => b.symbol === confirmSymbol);
        if (!confirmItem) return null;
        return (
          <TradeConfirmModal
            symbol={confirmSymbol}
            item={confirmItem}
            ticks={ticks}
            busy={takingSymbol === confirmSymbol}
            onConfirm={() => void executeTrade(confirmSymbol)}
            onCancel={() => setConfirmSymbol(null)}
          />
        );
      })()}
    </div>
  );
}
