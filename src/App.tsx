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
  type BoardItem,
  type Tick,
} from "./api.ts";
import StockCard from "./StockCard.tsx";
import Admin from "./Admin.tsx";

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
  const [adminAuthenticated, setAdminAuthenticated] = useState(false);
  const [live, setLive] = useState(false);
  const [streamOpen, setStreamOpen] = useState(false);
  const [rfRate, setRfRate] = useState<number>(() => {
    const saved = parseFloat(localStorage.getItem("cal_spread_rf") ?? "");
    return Number.isFinite(saved) ? saved : 6.5;
  });

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

  async function handleAdminLogout() {
    logoutAdmin();
    await handleLogout();
    setAdminAuthenticated(false);
  }

  // Check for admin route
  useEffect(() => {
    if (window.location.pathname === "/admin/verify") {
      // Don't do anything else, show admin login
      return;
    }
  }, []);

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
    
    // Check admin authentication
    getAdminStatus()
      .then((s) => setAdminAuthenticated(s.authenticated))
      .catch(() => setAdminAuthenticated(false));
    
    getStatus()
      .then((s) => setAuthenticated(s.authenticated))
      .catch(() => setAuthenticated(false));
    // Dividend yields come from Yahoo (independent of Zerodha login).
    fetchDividends()
      .then(setDivYields)
      .catch(() => setDivYields({}));
  }, []);

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
    const q = query.trim().toLowerCase();
    if (!q) return board;
    return board.filter(
      (b) =>
        b.symbol.toLowerCase().includes(q) ||
        b.name.toLowerCase().includes(q),
    );
  }, [board, query]);

  const status = live
    ? { kind: "live", label: "Live" }
    : streamOpen
      ? { kind: "wait", label: "Awaiting ticks" }
      : authenticated
        ? { kind: "wait", label: "Connecting…" }
        : { kind: "idle", label: "Login for live" };

  // Handle admin verification route
  if (window.location.pathname === "/admin/verify") {
    if (adminAuthenticated) {
      // Redirect to home after successful admin auth
      window.history.replaceState({}, "", "/");
    } else {
      return (
        <Admin
          onAuthenticated={() => {
            setAdminAuthenticated(true);
            window.history.replaceState({}, "", "/");
          }}
        />
      );
    }
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
            <h1>Cal Spread</h1>
            <p className="subtitle">NSE F&amp;O · spot &amp; 3 monthly futures</p>
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
          {adminAuthenticated && (
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
            <>
              {authenticated ? (
                <button className="btn" onClick={() => void handleAdminLogout()}>
                  Logout
                </button>
              ) : (
                <a className="btn btn--primary" href={loginUrl()}>
                  Connect to Zerodha
                </a>
              )}
            </>
          )}
        </div>
      </header>

      {verifying && <div className="banner">Verifying your login…</div>}

      {adminAuthenticated && !authenticated && !verifying && (
        <div className="banner">
          Click{" "}
          <a className="link" href={loginUrl()}>
            Connect to Zerodha
          </a>{" "}
          to stream live prices &amp; premium/discount.
        </div>
      )}

      {error && <div className="banner banner--error">{error}</div>}

      {authenticated && (
        <div className="legend">
          <span>
            <strong>Fair</strong> = Spot × [1 + (rf − div)×(days/365)] · dividend
            yields via Yahoo
          </span>
          <span className="legend-sep">•</span>
          <span>Prem/Disc = future − spot</span>
          <span className="tag tag--prem">premium</span>
          <span className="tag tag--disc">discount</span>
        </div>
      )}

      {loading && board.length === 0 ? (
        <div className="empty">
          <span className="spinner" />
          Loading F&amp;O stocks…
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
            />
          ))}
        </div>
      )}

      {!loading && filtered.length === 0 && (
        <div className="empty">No F&amp;O stocks match “{query}”.</div>
      )}
    </div>
  );
}
