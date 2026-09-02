/**
 * A compact execution-health panel for the Box page.
 *
 * Broken out of the (already large) Box page rather than inlined. It summarises
 * what the paper simulator is actually experiencing: fill vs abort rates, legging
 * losses, latency and slippage — never a per-attempt firehose. The backend
 * remains the sole authority; this only displays the rolling metrics it publishes.
 */

import type { BoxExecutionMode, BoxMetricsSnapshot } from "./api";

function rupees(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  const sign = v < 0 ? "-" : "";
  return `${sign}₹${Math.abs(Math.round(v)).toLocaleString("en-IN")}`;
}

function pct(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  return `${Math.round(v * 1000) / 10}%`;
}

function ms(v: number | null | undefined): string {
  return v === null || v === undefined ? "—" : `${Math.round(v)}ms`;
}

export function BoxExecutionHealth({
  metrics,
  mode,
}: {
  metrics: BoxMetricsSnapshot | undefined;
  mode: BoxExecutionMode;
}) {
  if (!metrics) return null;
  const exec = metrics.execution;
  const legging = metrics.legging;

  return (
    <section className="box-exec-health">
      <h3 className="box-exec-health-title">
        Execution health <span className="box-exec-mode">{mode}</span>
      </h3>

      <div className="box-exec-grid">
        <HealthStat
          label="Attempts"
          value={String(exec.attempted)}
          title="Parent strategy attempts — one per detected candidate that entered an order pipeline. Internal leg/order retries never count as a new attempt."
        />
        <HealthStat label="Successful" value={String(exec.successful)} cls="is-good" />
        <HealthStat
          label="Partial recovered"
          value={String(exec.partial_recovered)}
          title="Some legs filled and the position was recovered/unwound cleanly — no residual exposure remains."
        />
        <HealthStat
          label="Partial unresolved"
          value={String(exec.partial_unresolved)}
          cls="is-bad"
          title="Some legs filled and residual exposure remains outstanding."
        />
        <HealthStat label="Failed" value={String(exec.failed)} cls="is-bad" />
        <HealthStat label="Aborted" value={String(exec.aborted)} />
        <HealthStat
          label="Retries"
          value={String(exec.retries)}
          title="Internal leg/order retries inside an attempt — excluded from the Attempts count above."
        />
        <HealthStat label="Success rate" value={pct(exec.success_rate)} cls="is-good" />
        <HealthStat
          label="Failure rate"
          value={pct(exec.failure_rate)}
          cls="is-bad"
          title="(Failed + Partial unresolved) / Completed"
        />
        <HealthStat
          label="Decision→fill p50 / p95"
          value={`${ms(exec.latency.detection_to_fill_ms?.p50)} / ${ms(exec.latency.detection_to_fill_ms?.p95)}`}
        />
        <HealthStat
          label="Decision deterioration p50 / p95"
          value={`${rupees(exec.decision_deterioration?.p50)} / ${rupees(exec.decision_deterioration?.p95)}`}
          title="Detection expected net minus the realised expected net at actual fill prices. Positive means the mispricing decayed before the fill."
        />
        <HealthStat
          label="Execution slippage p50 / p95"
          value={`${rupees(exec.execution_slippage?.p50)} / ${rupees(exec.execution_slippage?.p95)}`}
          title="Fill price vs. the arrival-instant reference book. Zero is a valid, meaningful reading — it means the fill matched the captured arrival book exactly, not that nothing was measured."
        />
        <HealthStat label="Exit slippage p50" value={rupees(exec.exit_slippage?.p50)} />
        <HealthStat
          label="Expected vs realised (p50)"
          value={rupees(legging?.expected_vs_realised_net?.p50)}
          title="Expected net at entry minus the realised net of closed trades"
        />
      </div>

      {Object.keys(exec.rejection_categories).length > 0 && (
        <>
          <h4 className="box-exec-sub">Rejection categories</h4>
          <div className="box-exec-grid">
            {Object.entries(exec.rejection_categories)
              .sort((a, b) => b[1] - a[1])
              .slice(0, 8)
              .map(([reason, count]) => (
                <HealthStat key={reason} label={reason} value={String(count)} />
              ))}
          </div>
        </>
      )}

      {legging && legging.outcomes.total > 0 && (
        <>
          <h4 className="box-exec-sub">Legging (four independent orders)</h4>
          <div className="box-exec-grid">
            <HealthStat label="4/4 filled" value={pct(legging.fill_rate_4_of_4)} cls="is-good" />
            <HealthStat label="3/4 abort" value={pct(legging.failure_rate_3_of_4)} cls="is-bad" />
            <HealthStat label="2/4 abort" value={pct(legging.failure_rate_2_of_4)} cls="is-bad" />
            <HealthStat label="1/4 abort" value={pct(legging.failure_rate_1_of_4)} cls="is-bad" />
            <HealthStat label="Aborts" value={String(legging.outcomes.aborts)} />
            <HealthStat label="Avg legging loss" value={rupees(legging.legging_net_loss?.mean)} cls="is-bad" />
            <HealthStat label="Legging loss p95" value={rupees(legging.legging_net_loss?.p95)} cls="is-bad" />
            <HealthStat label="1st→last fill p95" value={ms(legging.first_to_last_fill_ms?.p95)} />
            <HealthStat
              label="Most-failing leg"
              value={
                legging.most_failing_role
                  ? `${legging.most_failing_role.role} (${legging.most_failing_role.count})`
                  : "—"
              }
            />
          </div>
        </>
      )}
    </section>
  );
}

function HealthStat({ label, value, cls, title }: { label: string; value: string; cls?: string; title?: string }) {
  return (
    <div className={`box-exec-stat ${cls ?? ""}`} title={title}>
      <span className="box-exec-stat-k">{label}</span>
      <span className="box-exec-stat-v">{value}</span>
    </div>
  );
}
