import { useEffect, useMemo, useRef, useState } from "react";
import {
  createSession,
  fetchDividends,
  fetchFnoBoard,
  fetchQuotes,
  getStatus,
  logout,
  loginUrl,
  streamUrl,
  getAdminStatus,
  logoutAdmin,
  verifyAdminSecret,
  verifyAccessSecret,
  createTrade,
  listTrades,
  closeTrade,
  deleteTrade,
  type BoardItem,
  type Tick,
  type Trade,
  type AdminRole,
} from "./api.ts";
import StockCard from "./StockCard.tsx";
import SkeletonCard from "./SkeletonCard.tsx";
import Admin from "./Admin.tsx";
import TradesPanel from "./TradesPanel.tsx";
import TradeConfirmModal from "./TradeConfirmModal.tsx";
import StockDetail from "./StockDetail.tsx";

type TickMap = Record<number, Tick>;

export default function App() {
  const [board, setBoard] = useState<BoardItem[]>([]);
  const [ticks, setTicks] = useState<TickMap>({});
  const [divYields, setDivYields] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [adminRole, setAdminRole] = useState<AdminRole>(null);
  const [live, setLive] = useState(false);

  const adminAuthenticated = adminRole !== null;
  const isFullAdmin = adminRole === "full";

  // Admin-only: show only stocks with a calendar arbitrage (current & next
  // month on opposite sides — one at premium, one at discount).
  const [arbOnly, setArbOnly] = useState(false);
  const [sortMinArb, setSortMinArb] = useState(false);
  const [sortOi, setSortOi] = useState(false);
  const [sortSpread, setSortSpread] = useState(false);
  const [sortDepth, setSortDepth] = useState(false);
  const [streamOpen, setStreamOpen] = useState(false);
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
    setRfRate(value === "" ? 0 : n);
    if (Number.isFinite(n)) localStorage.setItem("cal_spread_rf", String(n));
  }

  const tickBuffer = useRef<TickMap>({});
  const verifyGuard = useRef(false);

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
    await logout();
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

  // Once authenticated, leave the admin login routes.
  useEffect(() => {
    if (adminAuthenticated && (route === "/admin/verify" || route === "/admin/access")) {
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

  // Load the board + auth status on first open.
  useEffect(() => {
    void loadBoard();
    
    // Check admin authentication + role (full vs trade-access)
    getAdminStatus()
      .then((s) => setAdminRole(s.role))
      .catch(() => setAdminRole(null));
    
    getStatus()
      .then((s) => setAuthenticated(s.authenticated))
      .catch(() => setAuthenticated(false));
    // Dividend yields come from Yahoo (independent of Zerodha login).
    fetchDividends()
      .then(setDivYields)
      .catch(() => setDivYields({}));
  }, []);

  // Load trades once any admin (full or trade-access) is authenticated.
  useEffect(() => {
    if (!adminAuthenticated) return;
    void refreshTrades();
  }, [adminRole]);

  // While no Zerodha session is active, poll the backend so that ANY open
  // public tab automatically starts showing live data once the admin connects
  // Zerodha (no manual refresh needed).
  useEffect(() => {
    if (authenticated) return;
    const id = setInterval(() => {
      getStatus()
        .then((s) => {
          if (s.authenticated) setAuthenticated(true);
        })
        .catch(() => {
          /* backend unreachable — keep trying */
        });
    }, 15000);
    return () => clearInterval(id);
  }, [authenticated]);

  // Open ONE live stream for every token once a Zerodha session is active on
  // the backend (works for ANY visitor, not just the admin who logged in).
  useEffect(() => {
    if (!authenticated || board.length === 0) return;

    const tokens = board.flatMap((b) => [
      b.spot_token,
      ...b.futures.map((f) => f.token),
    ]);

    // 1) Seed prices immediately via REST snapshot (works even after market
    //    close, so spot AND futures premiums show right away).
    fetchQuotes(tokens)
      .then((seed) => {
        if (seed.length === 0) return;
        setTicks((prev) => {
          const next = { ...prev };
          for (const t of seed) next[t.token] = t;
          return next;
        });
      })
      .catch(() => {
        /* non-fatal: live stream may still fill values during market hours */
      });

    // 2) Live updates via WebSocket-backed SSE.
    const es = new EventSource(streamUrl(tokens));

    // Batch ticks and flush twice a second to keep rendering smooth.
    const flush = setInterval(() => {
      if (Object.keys(tickBuffer.current).length === 0) return;
      setTicks((prev) => ({ ...prev, ...tickBuffer.current }));
      tickBuffer.current = {};
    }, 500);

    es.onopen = () => setStreamOpen(true);
    es.onmessage = (ev) => {
      try {
        const incoming = JSON.parse(ev.data) as Tick[];
        for (const t of incoming) tickBuffer.current[t.token] = t;
        setLive(true);
      } catch {
        // ignore malformed frame
      }
    };
    es.addEventListener("kite_error", () => {
      setLive(false);
      setStreamOpen(false);
      setAuthenticated(false);
      setError("Live feed disconnected — the data provider session ended.");
      es.close();
    });
    es.onerror = () => setLive(false);

    return () => {
      clearInterval(flush);
      setStreamOpen(false);
      es.close();
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

      // Sort by the biggest opportunity in percentage terms (descending),
      // unless sortMinArb is active — then ascending (smallest diff first).
      list = [...list].sort((a, b) =>
        sortMinArb ? arbPct(a) - arbPct(b) : arbPct(b) - arbPct(a),
      );
    }

    if (sortOi || sortSpread || sortDepth) {
      list = [...list].sort((a, b) => {
        let cmp = 0;

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

    return list;
  }, [board, query, arbOnly, sortMinArb, sortOi, sortSpread, sortDepth, ticks]);

  const status = live
    ? { kind: "live", label: "Live" }
    : streamOpen
      ? { kind: "wait", label: "Awaiting ticks" }
      : authenticated
        ? { kind: "wait", label: "Connecting…" }
        : { kind: "idle", label: "Login for live" };

  // Full-admin verification route
  if (route === "/admin/verify" && !adminAuthenticated) {
    return (
      <Admin
        verify={verifyAdminSecret}
        title="Admin Verification"
        subtitle="Enter the admin secret for full access (Zerodha + trades)."
        placeholder="Enter admin secret"
        onAuthenticated={() => {
          setAdminRole("full");
          goHome();
        }}
      />
    );
  }

  // Trade-access route (view & take trades only, no Zerodha controls)
  if (route === "/admin/access" && !adminAuthenticated) {
    return (
      <Admin
        verify={verifyAccessSecret}
        title="Trade Access"
        subtitle="Enter the access code to view and take trades."
        placeholder="Enter access code"
        onAuthenticated={() => {
          setAdminRole("trade");
          goHome();
        }}
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
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.2"
              strokeLinecap="round" strokeLinejoin="round">
              <path d="M7 3v18M17 3v18" />
              <rect x="4" y="7" width="6" height="9" rx="1.2" fill="#ffffff" stroke="none" />
              <rect x="14" y="5" width="6" height="8" rx="1.2" fill="#ffffff" stroke="none" />
            </svg>
          </div>
          <div className="card-title">
            <h1>Calspread</h1>
          </div>
        </div>

        <div className="toolbar">
          <div className="search-wrap">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            <input
              className="search"
              type="search"
              placeholder="Search symbol or company…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          {(authenticated || adminAuthenticated) && (
            <span className={`status status--${status.kind}`}>
              <span className="status-dot" />
              {status.label}
            </span>
          )}
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
          <span className="count">
            <strong>{filtered.length.toLocaleString()}</strong> stocks
          </span>
          {adminAuthenticated && (
            <button
              className={`btn${arbOnly ? " btn--primary" : ""}`}
              onClick={() => {
                setArbOnly((v) => {
                  if (v) setSortMinArb(false);
                  return !v;
                });
              }}
              title="Show only stocks where current & next month are on opposite sides (one premium, one discount)"
            >
              Arbitrage
            </button>
          )}
          {arbOnly && (
            <button
              className={`btn${sortMinArb ? " btn--primary" : ""}`}
              onClick={() => {
                setSortMinArb((v) => !v);
                setSortOi(false);
                setSortSpread(false);
                setSortDepth(false);
              }}
              title="Sort by minimum percentage difference between current and next month futures (smallest first)"
            >
              Min Arb
            </button>
          )}
          {adminAuthenticated && (
            <button
              className={`btn${sortOi ? " btn--primary" : ""}`}
              onClick={() => {
                setSortOi((v) => !v);
                setSortMinArb(false);
              }}
              title="Sort by mid-month futures OI (high to low)"
            >
              OI
            </button>
          )}
          {adminAuthenticated && (
            <button
              className={`btn${sortSpread ? " btn--primary" : ""}`}
              onClick={() => {
                setSortSpread((v) => !v);
                setSortMinArb(false);
              }}
              title="Sort by bid-ask spread for 2nd month future (tightest first)"
            >
              Spread
            </button>
          )}
          {adminAuthenticated && (
            <button
              className={`btn${sortDepth ? " btn--primary" : ""}`}
              onClick={() => {
                setSortDepth((v) => !v);
                setSortMinArb(false);
              }}
              title="Sort by total orders in top 5 bids + top 5 asks for 2nd month future (deepest first)"
            >
              Depth
            </button>
          )}
          {adminAuthenticated && (
            <button
              className="btn"
              onClick={() => {
                setTradesOpen(true);
                void refreshTrades();
              }}
            >
              Trades
              {openTradeSymbols.size > 0 && (
                <span className="btn-badge">{openTradeSymbols.size}</span>
              )}
            </button>
          )}
          {isFullAdmin ? (
            authenticated ? (
              <button className="btn" onClick={() => void handleFullLogout()}>
                Logout
              </button>
            ) : (
              <a className="btn btn--primary" href={loginUrl()}>
                Connect to Zerodha
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
        <div className="banner">
          Click{" "}
          <a className="link" href={loginUrl()}>
            Connect to Zerodha
          </a>{" "}
          to stream live prices &amp; premium/discount.
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
