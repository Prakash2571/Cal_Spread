import type { BoardItem, Tick } from "./api.ts";
import {
  daysToExpiry,
  fairPrice,
  fmt,
  fmtSigned,
  formatExpiry,
  pctText,
  pdClass,
} from "./format.ts";

interface Props {
  item: BoardItem;
  ticks: Record<number, Tick>;
  rf: number;
  div: number;
  showPrices?: boolean;
}

export default function StockCard({ item, ticks, rf, div, showPrices = true }: Props) {
  const spot = ticks[item.spot_token];
  const spotLast = spot?.last_price ?? null;

  // For public view, hide all pricing data
  if (!showPrices) {
    return (
      <article className="card">
        <header className="card-head">
          <div className="card-title">
            <span className="card-symbol">
              {item.symbol}
              {item.is_index && <span className="badge-index">INDEX</span>}
            </span>
            <span className="card-name">{item.name}</span>
          </div>
        </header>

        <table className="card-table">
          <thead>
            <tr>
              <th>Contract</th>
              <th>LTP</th>
              <th>Fair</th>
              <th>Prem/Disc</th>
            </tr>
          </thead>
          <tbody>
            {item.futures.map((f) => (
              <tr key={f.token}>
                <td>
                  <span className="contract-name">{formatExpiry(f.expiry)}</span>{" "}
                  <span className="contract-meta">{daysToExpiry(f.expiry)}d</span>
                </td>
                <td className="num muted">—</td>
                <td className="num muted">—</td>
                <td className="num muted">—</td>
              </tr>
            ))}
          </tbody>
        </table>
      </article>
    );
  }

  return (
    <article className="card">
      <header className="card-head">
        <div className="card-title">
          <span className="card-symbol">
            {item.symbol}
            {item.is_index && <span className="badge-index">INDEX</span>}
          </span>
          <span className="card-name">{item.name}</span>
        </div>
        <div className="card-quote">
          <span className="card-price mono">{fmt(spotLast)}</span>
          <span
            className={`chip ${pctChip(spot?.last_price, spot?.close_price)}`}
          >
            {pctText(spot?.last_price, spot?.close_price)}
          </span>
        </div>
      </header>

      <table className="card-table">
        <thead>
          <tr>
            <th>Contract</th>
            <th>LTP</th>
            <th>Fair</th>
            <th>Prem/Disc</th>
          </tr>
        </thead>
        <tbody>
          {item.futures.map((f) => {
            const t = ticks[f.token];
            const last = t?.last_price ?? null;
            const days = daysToExpiry(f.expiry);
            const fair = fairPrice(spotLast, rf, days, div);
            const premium =
              last !== null && spotLast !== null ? last - spotLast : null;
            return (
              <tr key={f.token}>
                <td>
                  <span className="contract-name">{formatExpiry(f.expiry)}</span>{" "}
                  <span className="contract-meta">{days}d</span>
                </td>
                <td className="num mono">{fmt(last)}</td>
                <td
                  className="num mono fair"
                  title={`Fair value · rf ${rf}% · dividend ${div.toFixed(2)}%`}
                >
                  {fmt(fair)}
                </td>
                <td className="num">
                  {premium === null ? (
                    <span className="chip muted">—</span>
                  ) : (
                    <span className={`chip ${pdClass(premium)}`}>
                      {fmtSigned(premium)}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </article>
  );
}

/** Chip class for the header % change: "prem"/"disc"/"muted". */
function pctChip(
  last: number | null | undefined,
  close: number | null | undefined,
): string {
  if (last == null || !close) return "muted";
  return last - close > 0 ? "prem" : last - close < 0 ? "disc" : "muted";
}
