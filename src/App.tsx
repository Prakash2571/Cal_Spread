import { useEffect, useMemo, useRef, useState } from "react";
import {
  createSession,
  fetchFnoBoard,
  fetchQuotes,
  getStatus,
  logout,
  loginUrl,
  streamUrl,
  type BoardItem,
  type Tick,
} from "./api.ts";
import StockCard from "./StockCard.tsx";

type TickMap = Record<number, Tick>;

export default function App() {
  const [board, setBoard] = useState<BoardItem[]>([]);
  const [ticks, setTicks] = useState<TickMap>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [live, setLive] = useState(false);
  const [streamOpen, setStreamOpen] = useState(false);

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
    getStatus()
      .then((s) => setAuthenticated(s.authenticated))
      .catch(() => setAuthenticated(false));
  }, []);

  // Open ONE live stream for every token once authenticated + board is ready.
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
      setError("Live feed rejected by Zerodha — your session expired. Please Connect again.");
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

  return (
    <div className="app">
      <header className="header">
        <h1>Cal Spread</h1>
        <p className="subtitle">
          NSE F&amp;O stocks — spot &amp; 3 monthly futures with live
          premium/discount
        </p>
      </header>

      {verifying && <div className="banner">Verifying your Zerodha login…</div>}

      <section className="toolbar">
        {authenticated ? (
          <button className="btn" onClick={() => void handleLogout()}>
            Logout
          </button>
        ) : (
          <a className="btn btn--primary" href={loginUrl}>
            Connect to Zerodha
          </a>
        )}
        <input
          className="search"
          type="search"
          placeholder="Search symbol or company…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <span className={`live-dot ${live ? "live-dot--on" : ""}`}>
          {live
            ? "LIVE"
            : streamOpen
              ? "connected · waiting for ticks (market may be closed)"
              : authenticated
                ? "connecting…"
                : "prices: login needed"}
        </span>
        <span className="count">{filtered.length.toLocaleString()} stocks</span>
      </section>

      {!authenticated && !verifying && (
        <div className="banner">
          Showing the F&amp;O list below. Click{" "}
          <a className="link" href={loginUrl}>
            Connect to Zerodha
          </a>{" "}
          to stream live prices &amp; premium/discount.
        </div>
      )}

      {error && <div className="banner banner--error">{error}</div>}

      {loading && board.length === 0 && (
        <div className="empty">Loading F&amp;O stocks…</div>
      )}

      <div className="legend">
        Premium / Discount = future − spot.{" "}
        <span className="tag tag--prem">green = premium</span>{" "}
        <span className="tag tag--disc">red = discount</span>
      </div>

      <div className="cards">
        {filtered.map((item) => (
          <StockCard key={item.symbol} item={item} ticks={ticks} />
        ))}
      </div>

      {!loading && filtered.length === 0 && (
        <div className="empty">No F&amp;O stocks match “{query}”.</div>
      )}
    </div>
  );
}
