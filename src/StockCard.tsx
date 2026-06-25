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
    <div className="card">
      <div className="card-head">
        <div className="card-title">
          <span className="card-symbol">{item.symbol}</span>
          <span className="muted card-name">{item.name}</span>
        </div>
        <div className="card-ltp">
          <span className="mono">{fmt(spotLast)}</span>
          <span className={pctClass(spot?.last_price, spot?.close_price)}>
            {" "}
            {pctText(spot?.last_price, spot?.close_price)}
          </span>
        </div>
      </div>

      <table className="card-table">
        <tbody>
          <tr className="row-spot">
            <td>
              <strong>Spot</strong>
            </td>
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
                  {formatExpiry(f.expiry)}
                  <span className="muted"> ({daysToExpiry(f.expiry)} days)</span>
                </td>
                <td className="num mono">{fmt(last)}</td>
                <td className={`num ${pctClass(t?.last_price, t?.close_price)}`}>
                  {pctText(t?.last_price, t?.close_price)}
                </td>
                <td className={`num mono ${pdClass(premium)}`}>
                  {fmtSigned(premium)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
