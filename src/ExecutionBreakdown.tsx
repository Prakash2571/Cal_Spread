/**
 * The expected-net-profit arithmetic, broken out so the operator can see WHY a
 * box qualified or was rejected — never a single opaque number.
 *
 *   expected net = gross - entry fees - est. exit fees - execution cost - buffer
 *
 * Used in the opportunity detail and the open-position card. Pure presentation:
 * every figure is supplied by the backend, which remains the sole trading
 * authority.
 */

import type { BoxChargeOrigin } from "./api";
import { ChargeOriginTag } from "./BoxDirection";

function rupees(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  const sign = v < 0 ? "-" : "";
  return `${sign}₹${Math.abs(Math.round(v)).toLocaleString("en-IN")}`;
}

export interface ExecutionBreakdownProps {
  gross: number | null;
  entryFees: number | null;
  exitFees: number | null;
  executionCost: number;
  safetyBuffer: number;
  expectedNet: number | null;
  minExpectedNet: number;
  chargeOrigin?: BoxChargeOrigin;
}

export function ExecutionBreakdown(props: ExecutionBreakdownProps) {
  const {
    gross,
    entryFees,
    exitFees,
    executionCost,
    safetyBuffer,
    expectedNet,
    minExpectedNet,
    chargeOrigin,
  } = props;
  const passes = expectedNet !== null && expectedNet >= minExpectedNet;

  const Row = ({ label, value, sub }: { label: string; value: string; sub?: boolean }) => (
    <div className={`box-breakdown-row ${sub ? "box-breakdown-row--sub" : ""}`}>
      <span className="box-breakdown-k">{label}</span>
      <span className="box-breakdown-v">{value}</span>
    </div>
  );

  return (
    <div className="box-breakdown">
      <Row label="Gross edge" value={rupees(gross)} />
      <Row label="− Entry fees" value={rupees(entryFees)} sub />
      <Row label="− Est. exit fees" value={rupees(exitFees)} sub />
      <Row label="− Execution / slippage" value={rupees(executionCost)} sub />
      <Row label="− Safety buffer" value={rupees(safetyBuffer)} sub />
      <div className={`box-breakdown-row box-breakdown-row--net ${passes ? "is-pass" : "is-fail"}`}>
        <span className="box-breakdown-k">
          Expected net{chargeOrigin && <ChargeOriginTag origin={chargeOrigin} />}
        </span>
        <span className="box-breakdown-v">
          {rupees(expectedNet)}
          <span className="box-breakdown-gate"> / need {rupees(minExpectedNet)}</span>
        </span>
      </div>
    </div>
  );
}
