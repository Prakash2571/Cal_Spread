import { useEffect, useMemo, useState } from "react";
import {
  createSession,
  fetchInstruments,
  loginUrl,
  type Instrument,
} from "./api.ts";

export default function App() {
  const [instruments, setInstruments] = useState<Instrument[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [verifying, setVerifying] = useState(false);

  async function loadStocks() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchInstruments(); // backend defaults to NSE equities
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
        <p className="subtitle">NSE stocks via Zerodha Kite Connect</p>
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
          {loading ? "Loading…" : "Load stocks"}
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
            {filtered.length.toLocaleString()} stocks
          </span>
        )}
      </section>

      {error && (
        <div className="banner banner--error">
          {error}
          <div className="hint">
            Make sure the backend is running and you have completed the Zerodha
            login (click “Connect to Zerodha”).
          </div>
        </div>
      )}

      {!loaded && !loading && !error && (
        <div className="empty">
          <p>
            Click <strong>Connect to Zerodha</strong> to log in, then load the
            full list of NSE stocks.
          </p>
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
                <th>Type</th>
                <th className="num">Lot</th>
                <th className="num">Token</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((i) => (
                <tr key={i.instrument_token}>
                  <td className="mono">{i.tradingsymbol}</td>
                  <td>{i.name}</td>
                  <td>{i.exchange}</td>
                  <td>{i.instrument_type}</td>
                  <td className="num">{i.lot_size}</td>
                  <td className="num mono">{i.instrument_token}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {filtered.length === 0 && (
            <div className="empty">No stocks match “{query}”.</div>
          )}
        </div>
      )}
    </div>
  );
}
