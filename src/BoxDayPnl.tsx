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
      {/* Margin is capital deployed, not profit, so it is deliberately rendered
          without the P&L colouring — a big number here is not a good or a bad
          thing. Hidden entirely on a backend that does not report it. */}
      {dayPnl.total_margin_used !== undefined && (
        <div
          className="box-daypnl-item box-daypnl-item--neutral"
          title={
            `Zerodha basket margin these boxes blocked: ${rupees(dayPnl.open_margin_used)} currently ` +
            `open + ${rupees(dayPnl.closed_margin_used)} from boxes already closed today. ` +
            `A SUM over the day, so it is an upper bound on what was blocked at any single ` +
            `instant — boxes that opened and closed at different times never held their margin ` +
            `at the same time.` +
            (dayPnl.margin_unknown_count
              ? ` ${dayPnl.margin_unknown_count} box(es) have no margin figure and are excluded.`
              : "")
          }
        >
          <span className="box-daypnl-k">Margin used today</span>
          <span className="box-daypnl-v">
            {rupees(dayPnl.total_margin_used)}
            {dayPnl.margin_unknown_count ? (
              <span className="box-dim"> ({dayPnl.margin_unknown_count} n/a)</span>
            ) : null}
          </span>
          <span className="box-daypnl-sub">
            {rupees(dayPnl.open_margin_used)} open · {rupees(dayPnl.closed_margin_used)} closed
          </span>
        </div>
      )}
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
