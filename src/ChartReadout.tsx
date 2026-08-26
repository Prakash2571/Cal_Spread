/** One value shown in a chart readout (a coloured dot, a label and a value). */
export interface ReadoutItem {
  label: string;
  color: string;
  value: string;
  /** Mirrors ChartSeries.dashed - dims the dot the way the old legend did. */
  dashed?: boolean;
}

interface Props {
  /** Timestamp label for the point being reported (hovered, else the latest). */
  time: string | null;
  items: ReadoutItem[];
  /** True while the values come from a hovered point rather than the latest. */
  hovering?: boolean;
  /** Compact "first point" summary, shown only when not hovering. */
  start?: { time: string; items: ReadoutItem[] } | null;
}

/**
 * Always-visible values strip above a chart.
 *
 * This replaces the old floating tooltip + separate legend: the latest point's
 * time and values are readable without hovering (and hovering just retargets
 * the same strip), so nothing ever covers the plot and the reader never has to
 * chase the right-hand edge to see where the series ended up.
 */
export default function ChartReadout({
  time,
  items,
  hovering = false,
  start = null,
}: Props) {
  return (
    <div className="chart-readout">
      <div className="chart-readout-main">
        <span
          className={`chart-readout-time${hovering ? " chart-readout-time--hover" : ""}`}
        >
          {time ?? "-"}
        </span>
        {items.map((it) => (
          <span key={it.label} className="chart-readout-item">
            <span
              className="chart-dot"
              style={{ background: it.color, opacity: it.dashed ? 0.6 : 1 }}
            />
            <span className="chart-readout-label">{it.label}</span>
            <span className="chart-readout-val">{it.value}</span>
          </span>
        ))}
      </div>
      {/* Kept in the layout even while hovering, so retargeting the strip can
          never shift the plot underneath the cursor. */}
      {start && (
        <div
          className="chart-readout-start"
          style={hovering ? { visibility: "hidden" } : undefined}
        >
          <span className="chart-readout-label">From</span>
          <span className="chart-readout-time">{start.time}</span>
          {start.items.map((it) => (
            <span key={it.label} className="chart-readout-item">
              <span
                className="chart-dot chart-dot--sm"
                style={{ background: it.color, opacity: it.dashed ? 0.6 : 1 }}
              />
              <span className="chart-readout-val">{it.value}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
