/**
 * A compact list of paper_legging execution ATTEMPTS that aborted — partial
 * fills that had to be emergency-unwound at a loss.
 *
 * These are not trades (no box was opened), but they cost money, so surfacing
 * them keeps the strategy's P&L honest. Shown on demand, not streamed per-attempt.
 */

import type { BoxExecutionAttempt } from "./api";
import { DirectionBadge } from "./BoxDirection";

function rupees(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  const sign = v < 0 ? "-" : "";
  return `${sign}₹${Math.abs(Math.round(v)).toLocaleString("en-IN")}`;
}

export function BoxExecutionAttempts({ attempts }: { attempts: BoxExecutionAttempt[] }) {
  if (attempts.length === 0) {
    return <p className="box-empty">No aborted legging executions recorded.</p>;
  }
  return (
    <div className="box-table-wrap">
      <table className="box-table">
        <thead>
          <tr>
            <th>Underlying</th>
            <th>Direction</th>
            <th className="num">K1 → K2</th>
            <th>When</th>
            <th className="num">Filled</th>
            <th>Failed legs</th>
            <th className="num">Entry fees</th>
            <th className="num">Unwind fees</th>
            <th className="num">Gross loss</th>
            <th className="num">Net loss</th>
            <th>Reason</th>
          </tr>
        </thead>
        <tbody>
          {attempts.map((a, i) => (
            <tr key={`${a.candidate_key}-${a.resolved_at}-${i}`}>
              <td>
                <span className="box-sym">{a.underlying}</span>
                {a.is_index && <span className="badge-index">INDEX</span>}
              </td>
              <td><DirectionBadge direction={a.direction} /></td>
              <td className="num">{a.lower_strike} → {a.upper_strike}</td>
              <td className="box-dim">{new Date(a.resolved_at).toLocaleTimeString("en-IN")}</td>
              <td className="num">{a.filled_leg_count}/4</td>
              <td className="box-dim">{a.failed_legs.join(", ") || "—"}</td>
              <td className="num box-dim">{rupees(a.partial_entry_charges)}</td>
              <td className="num box-dim">{rupees(a.unwind_charges)}</td>
              <td className="num box-neg">{rupees(a.gross_abort_pnl)}</td>
              <td className="num box-neg">{rupees(a.net_abort_pnl)}</td>
              <td><span className="box-reason">{a.failure_reason ?? "—"}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
