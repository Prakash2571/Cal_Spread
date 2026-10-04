import { useEffect, useRef } from "react";
import { GreeksView, SensitivityView, Stat } from "./Components.tsx";
import { displayIv, displayNumber as number, localTimestamp, reasonText } from "./view.ts";
import type { Independent, Row } from "./types.ts";

interface Props {
  row: Row;
  valuationTime: string | null;
  estimate: Independent | undefined;
  busy: boolean;
  unavailable: boolean;
  onClose: () => void;
  onIndependent: () => void;
}

export default function ContractDetail({ row, valuationTime, estimate, busy, unavailable, onClose, onIndependent }: Props) {
  const drawer = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    drawer.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close.current();
      if (event.key !== "Tab") return;
      const buttons = drawer.current?.querySelectorAll<HTMLElement>("button:not(:disabled), a[href], summary, [tabindex='0']");
      if (!buttons?.length) return;
      const first = buttons[0], last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, []);

  return <div className="fv-drawer-backdrop" onClick={onClose}>
    <aside ref={drawer} className="fv-drawer" role="dialog" aria-modal="true" aria-label="Contract valuation detail" onClick={(e) => e.stopPropagation()}>
      <div className="fv-section-header"><h2>{row.tradingsymbol}</h2><button className="btn" onClick={onClose}>Close</button></div>
      <p>Listed European {row.side}. Actual lot multiplier: {row.lot_size ?? "unavailable"}. Expiry {localTimestamp(row.metadata?.expiry_timestamp)}.</p>
      <p>Valuation snapshot: {localTimestamp(valuationTime)}. {unavailable && "Current calculations are unavailable for this viewed snapshot."}</p>
      <p>Settlement underlying: {row.metadata?.settlement_underlying ?? "unverified"}</p>
      <p className={`fv-quality fv-quality--${row.quality}`}>{row.quality} · {reasonText(row.reasons)}</p>
      <div className="fv-stats">
        <Stat label="Full-chain ₹/unit (in-sample)" value={number(row.fair_value)} />
        <Stat label="Full-chain ₹/lot" value={number(row.fair_value_per_lot)} />
        <Stat label="Bid IV" value={displayIv(row.bid_iv?.iv)} />
        <Stat label="Mid IV" value={displayIv(row.observed_iv?.iv)} />
        <Stat label="Ask IV" value={displayIv(row.ask_iv?.iv)} />
        <Stat label="Available touch depth" value={number(row.quote?.available_depth, 0)} />
      </div>
      <p>Bid–ask IV range is quote-implied, not a statistical confidence interval.</p>
      <p>Exchange: {localTimestamp(row.quote?.exchange_timestamp)}<br />Received: {localTimestamp(row.quote?.receive_timestamp)}<br />Freshness basis: {row.quote?.freshness_basis ?? "unavailable"}</p>
      {row.greeks && <GreeksView greeks={row.greeks} />}
      {row.comparison && <>
        <h3>Model comparisons before fees/execution costs</h3>
        <p>{row.comparison.label}: midpoint minus model ₹{number(row.comparison.mid_deviation)} /unit, ₹{number(row.comparison.lot_mid_deviation)} /lot ({number(row.comparison.mid_deviation_percent)}%).</p>
        <p>Theoretical buy difference (model−ask): ₹{number(row.comparison.theoretical_buy_difference)} /unit, ₹{number(row.comparison.lot_buy_difference)} /lot.</p>
        <p>Theoretical sell difference (bid−model): ₹{number(row.comparison.theoretical_sell_difference)} /unit, ₹{number(row.comparison.lot_sell_difference)} /lot.</p>
      </>}
      {row.expiry_payoff && <p>{row.expiry_payoff.status}: ₹{number(row.expiry_payoff.value)} /unit · {row.expiry_payoff.reason}</p>}
      <SensitivityView range={row.sensitivity} />
      <h3>Leave-one-strike-out estimate</h3>
      <p>Removes both call and put at strike {row.strike} from forward estimation and smile calibration, then refits. Bounded and calculated on demand.</p>
      <button className="btn btn--primary" disabled={busy || unavailable} onClick={onIndependent}>{busy ? "Refitting…" : "Calculate independent estimate"}</button>
      {estimate && <>
        <p>Status: {estimate.status} · {reasonText(estimate.reasons)}</p>
        <p>Refit input snapshot: <code>{estimate.input_snapshot_id}</code></p>
        {estimate.values.map((v) => <p key={v.side}>{v.side}: ₹{number(v.fair_value)} /unit, ₹{number(v.per_lot)} /actual lot</p>)}
      </>}
    </aside>
  </div>;
}
