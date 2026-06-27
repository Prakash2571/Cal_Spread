import type { BoardItem, Tick } from "./api.ts";
import {
  daysToExpiry,
  fmt,
  fmtSigned,
  formatExpiry,
  pctClass,
  pctText,
  pdClass,
} from "./format.ts";

interface Props {
  item: BoardItem;
  ticks: Record<number, Tick>;
}

export default function StockCard({ item, ticks }: Props) {
  const spot = ticks[item.spot_token];
  const spotLast = spot?.last_price ?? null;

  return (
    <article className="card">
      <header className="card-head">
        <div className="card-title">
          <span className="card-symbol">{item.symbol}</span>
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
            <th>Chg</th>
            <th>Prem/Disc</th>
          </tr>
        </thead>
        <tbody>
          <tr className="row-spot">
            <td className="contract-name">Spot</td>
            <td className="num mono">{fmt(spotLast)}</td>
            <td className={`num ${pctClass(spot?.last_price, spot?.close_price)}`}>
              {pctText(spot?.last_price, spot?.close_price)}
            </td>
            <td className="num muted">—</td>
          </tr>

          {item.futures.map((f) => {
            const t = ticks[f.token];
            const last = t?.last_price ?? null;
            const premium =
              last !== null && spotLast !== null ? last - spotLast : null;
            return (
              <tr key={f.token}>
                <td>
                  <span className="contract-name">{formatExpiry(f.expiry)}</span>{" "}
                  <span className="contract-meta">
                    {daysToExpiry(f.expiry)}d
                  </span>
                </td>
                <td className="num mono">{fmt(last)}</td>
                <td className={`num ${pctClass(t?.last_price, t?.close_price)}`}>
                  {pctText(t?.last_price, t?.close_price)}
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
