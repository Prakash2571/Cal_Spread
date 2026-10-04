import { displayNumber as number } from "./view.ts";
import type { Greeks, Sensitivity } from "./types.ts";

export function Stat({ label, value }: { label: string; value: string }) {
  return <div className="fv-stat"><span>{label}</span><strong>{value}</strong></div>;
}

export function GreeksView({ greeks }: { greeks: Greeks }) {
  return <>
    <h3>Frozen-volatility Black Greeks</h3>
    <div className="fv-stats">
      <Stat label="Forward Δ" value={number(greeks.forward_delta, 6)} />
      <Stat label="Forward Γ" value={number(greeks.forward_gamma, 8)} />
      <Stat label="Vega ₹/unit / 1 IV pct point" value={number(greeks.vega_1pct, 6)} />
      <Stat label="Spot Δ (proportional carry)" value={number(greeks.spot_delta, 6)} />
      <Stat label="Spot Γ (proportional carry)" value={number(greeks.spot_gamma, 8)} />
      <Stat label="Theta ₹/unit / calendar day" value={number(greeks.theta_calendar_day, 6)} />
      <Stat label="Rho ₹/unit / 1 rate pct point" value={number(greeks.rho_1pct, 6)} />
    </div>
    <p>{greeks.convention}</p>
  </>;
}

export function SensitivityView({ range }: { range: Sensitivity | null }) {
  if (!range) return null;
  return <details className="fv-sensitivity">
    <summary>{range.label}: ₹{number(range.low)}–₹{number(range.high)} /unit</summary>
    <p>Documented scenario repricing, not a statistical confidence interval.</p>
    {range.scenarios.map((s) => <div key={s.name}>
      <strong>{s.name}: ₹{number(s.price)} /unit</strong>
      <p>F={number(s.forward)} · D={number(s.discount, 8)} · IV={number(s.iv * 100)}%</p>
      <p>{s.assumption}</p>
    </div>)}
    {range.reasons.map((reason) => <p key={reason}>{reason.replace(/_/g, " ")}</p>)}
  </details>;
}
