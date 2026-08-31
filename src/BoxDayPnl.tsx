/**
 * A compact "how is today going" strip for the Box page.
 *
 * Shows the RUNNING day P&L the backend computes: the sum of open positions'
 * current net P&L, the realised net of trades closed today, and their total. The
 * backend is the sole authority for these figures (they come off the same
 * touch-based metrics the monitor uses); this only renders them.
 */

import type { BoxDayPnl } from "./api";

function rupees(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  const sign = v < 0 ? "-" : "";
  return `${sign}₹${Math.abs(Math.round(v)).toLocaleString("en-IN")}`;
}

function pnlClass(v: number): string {
  return v > 0 ? "is-pos" : v < 0 ? "is-neg" : "";
}

export function BoxDayPnlStrip({ dayPnl }: { dayPnl: BoxDayPnl | undefined }) {
  if (!dayPnl) return null;
  return (
    <section className="box-daypnl" aria-label="Running day P&L">
      <Item
        label={`Open running net (${dayPnl.open_count})`}
        value={dayPnl.open_running_net_pnl}
        title="Sum of the current net P&L of every open box position"
      />
      <Item
        label={`Closed today net (${dayPnl.closed_count})`}
        value={dayPnl.closed_realised_net_pnl}
        title="Sum of the realised net P&L of every box closed today"
      />
      <Item
        label="Day net P&L"
        value={dayPnl.total_net_pnl}
        title="Open running net + today's realised net"
        total
      />
    </section>
  );
}

function Item({
  label,
  value,
  title,
  total,
}: {
  label: string;
  value: number;
  title?: string;
  total?: boolean;
}) {
  return (
    <div className={`box-daypnl-item${total ? " box-daypnl-total" : ""}`} title={title}>
      <span className="box-daypnl-k">{label}</span>
      <span className={`box-daypnl-v ${pnlClass(value)}`}>{rupees(value)}</span>
    </div>
  );
}
