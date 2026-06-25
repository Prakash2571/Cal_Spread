import { useEffect, useState } from "react";
import {
  fetchFnoDetail,
  getStatus,
  loginUrl,
  streamUrl,
  type FnoDetail,
  type Tick,
} from "./api.ts";
import {
  changePct,
  daysToExpiry,
  fmt,
  fmtSigned,
  formatExpiry,
} from "./format.ts";

interface Props {
  symbol: string;
  onClose: () => void;
}

type TickMap = Record<number, Tick>;

export default function StockDetail({ symbol, onClose }: Props) {
  const [detail, setDetail] = useState<FnoDetail | null>(null);
  const [ticks, setTicks] = useState<TickMap>({});
  const [error, setError] = useState<string | null>(null);
  const [needLogin, setNeedLogin] = useState(false);
  const [live, setLive] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let es: EventSource | null = null;

    setDetail(null);
    setTicks({});
    setError(null);
    setNeedLogin(false);
    setLive(false);

    (async () => {
      try {
        const d = await fetchFnoDetail(symbol);
        if (cancelled) return;
        setDetail(d);

        // Live prices require an authenticated Kite session.
        const status = await getStatus().catch(() => ({ authenticated: false }));
        if (cancelled) return;
        if (!status.authenticated) {
          setNeedLogin(true);
          return;
        }

        const tokens = [d.spot.instrument_token, ...d.futures.map((f) => f.instrument_token)];
        es = new EventSource(streamUrl(tokens));
        es.onmessage = (ev) => {
          try {
            const incoming = JSON.parse(ev.data) as Tick[];
            setTicks((prev) => {
              const next = { ...prev };
              for (const t of incoming) next[t.token] = t;
              return next;
            });
            setLive(true);
          } catch {
            // ignore malformed frame
          }
        };
        es.onerror = () => {
          setLive(false);
        };
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load details.");
        }
      }
    })();

    return () => {
      cancelled = true;
      es?.close();
    };
  }, [symbol]);

  const spotTick = detail ? ticks[detail.spot.instrument_token] : undefined;
  const spotLast = spotTick?.last_price ?? null;

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal__close" onClick={onClose} aria-label="Close">
          ×
        </button>

        {error && <div className="banner banner--error">{error}</div>}

        {needLogin && (
          <div className="banner">
            Live prices need a one-time Zerodha login.{" "}
            <a className="link" href={loginUrl}>
              Connect to Zerodha
            </a>
          </div>
        )}

        {detail && (
          <>
            <div className="detail-head">
              <div>
                <h2 className="detail-symbol">{detail.symbol}</h2>
                <p className="detail-name">{detail.spot.name}</p>
              </div>
              <span className={`live-dot ${live ? "live-dot--on" : ""}`}>
                {live ? "LIVE" : needLogin ? "login required" : "connecting…"}
              </span>
            </div>

            <table className="detail-table">
              <thead>
                <tr>
                  <th>Contract</th>
                  <th className="num">LTP</th>
                  <th className="num">Chg %</th>
                  <th className="num">Premium / Discount</th>
                </tr>
              </thead>
              <tbody>
                {/* Spot row */}
                <tr className="row-spot">
                  <td>
                    <strong>{detail.symbol}</strong>
                    <span className="muted"> (Spot)</span>
                  </td>
                  <td className="num mono">{fmt(spotLast)}</td>
                  <td className={`num ${chgClass(spotTick)}`}>
                    {fmtPct(spotTick)}
                  </td>
                  <td className="num muted">—</td>
                </tr>

                {/* Futures rows */}
                {detail.futures.map((f) => {
                  const t = ticks[f.instrument_token];
                  const last = t?.last_price ?? null;
                  const premium =
                    last !== null && spotLast !== null ? last - spotLast : null;
                  return (
                    <tr key={f.instrument_token}>
                      <td>
                        {formatExpiry(f.expiry)}
                        <span className="muted">
                          {" "}
                          ({daysToExpiry(f.expiry)} days)
                        </span>
                      </td>
                      <td className="num mono">{fmt(last)}</td>
                      <td className={`num ${chgClass(t)}`}>{fmtPct(t)}</td>
                      <td className={`num mono ${pdClass(premium)}`}>
                        {fmtSigned(premium)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            <p className="detail-foot muted">
              Premium / Discount = future price − spot price.{" "}
              <span className="tag tag--prem">green = premium</span>{" "}
              <span className="tag tag--disc">red = discount</span>
            </p>
          </>
        )}

        {!detail && !error && <div className="empty">Loading…</div>}
      </div>
    </div>
  );
}

function fmtPct(t: Tick | undefined): string {
  if (!t) return "—";
  const p = changePct(t.last_price, t.close_price);
  if (p === null) return "—";
  const s = p.toFixed(2);
  return `${p > 0 ? "+" : ""}${s}%`;
}

function chgClass(t: Tick | undefined): string {
  if (!t) return "";
  const p = changePct(t.last_price, t.close_price);
  if (p === null) return "";
  return p > 0 ? "pos" : p < 0 ? "neg" : "";
}

function pdClass(premium: number | null): string {
  if (premium === null) return "muted";
  return premium > 0 ? "prem" : premium < 0 ? "disc" : "";
}
