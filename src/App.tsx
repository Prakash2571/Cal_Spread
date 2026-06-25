import { useEffect, useMemo, useState } from "react";
import {
  createSession,
  fetchFnoStocks,
  loginUrl,
  type Instrument,
} from "./api.ts";
import StockDetail from "./StockDetail.tsx";

export default function App() {
  const [instruments, setInstruments] = useState<Instrument[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  async function loadStocks() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchFnoStocks(); // F&O stocks only
      setInstruments(res.instruments);
      setLoaded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  // Handle the Zerodha redirect that lands on /zerodha/verify?request_token=...
  useEffect(() => {
    if (window.location.pathname !== "/zerodha/verify") return;

    const params = new URLSearchParams(window.location.search);
    const status = params.get("status");
    const requestToken = params.get("request_token");

    if (status !== "success" || !requestToken) {
      setError("Zerodha login was cancelled or failed. Please try again.");
      window.history.replaceState({}, "", "/");
      return;
    }

    setVerifying(true);
    createSession(requestToken)
      .then(() => {
        window.history.replaceState({}, "", "/"); // clean the token from the URL
        return loadStocks();
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Login failed.");
        window.history.replaceState({}, "", "/");
      })
      .finally(() => setVerifying(false));
  }, []);

  // Auto-load stocks on first open. The instruments list usually works
  // without a login, so most users will never need to click "Connect".
  useEffect(() => {
    if (window.location.pathname === "/zerodha/verify") return;
    void loadStocks();
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return instruments;
    return instruments.filter(
      (i) =>
        i.tradingsymbol.toLowerCase().includes(q) ||
        i.name.toLowerCase().includes(q),
    );
  }, [instruments, query]);

  return (
    <div className="app">
      <header className="header">
        <h1>Cal Spread</h1>
        <p className="subtitle">NSE F&amp;O stocks via Zerodha Kite Connect</p>
      </header>

      {verifying && (
        <div className="banner">Verifying your Zerodha login…</div>
      )}

      <section className="toolbar">
        <a className="btn btn--primary" href={loginUrl}>
          Connect to Zerodha
        </a>
        <button
          className="btn"
          onClick={() => void loadStocks()}
          disabled={loading}
        >
          {loading ? "Loading…" : "Reload F&O stocks"}
        </button>
        <input
          className="search"
          type="search"
          placeholder="Search symbol or company…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {loaded && (
          <span className="count">
            {filtered.length.toLocaleString()} F&amp;O stocks
          </span>
        )}
      </section>

      {error && (
        <div className="banner banner--error">
          {error}
          <div className="hint">
            Make sure the backend is running. If it says a session is required,
            click “Connect to Zerodha” for a one-time login.
          </div>
        </div>
      )}

      {!loaded && !loading && !error && (
        <div className="empty">
          <p>Loading the list of NSE F&amp;O stocks…</p>
        </div>
      )}

      {loaded && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Symbol</th>
                <th>Company</th>
                <th>Exchange</th>
                <th className="num">F&amp;O Lot</th>
                <th className="num">Token</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((i) => (
                <tr
                  key={i.instrument_token}
                  className="row-clickable"
                  onClick={() => setSelected(i.tradingsymbol)}
                  title={`View ${i.tradingsymbol} futures`}
                >
                  <td className="mono">{i.tradingsymbol}</td>
                  <td>{i.name}</td>
                  <td>{i.exchange}</td>
                  <td className="num">{i.fno_lot_size ?? i.lot_size}</td>
                  <td className="num mono">{i.instrument_token}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {filtered.length === 0 && (
            <div className="empty">No F&amp;O stocks match “{query}”.</div>
          )}
        </div>
      )}

      {selected && (
        <StockDetail symbol={selected} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}
