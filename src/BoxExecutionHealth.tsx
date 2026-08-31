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
        <HealthStat label="Attempted" value={String(exec.attempted)} />
        <HealthStat label="Filled" value={String(exec.filled)} />
        <HealthStat label="Failed" value={String(exec.failed)} />
        <HealthStat label="Failure rate" value={pct(exec.failure_rate)} />
        <HealthStat label="Entry slippage p50 / p95" value={`${rupees(exec.entry_slippage?.p50)} / ${rupees(exec.entry_slippage?.p95)}`} />
        <HealthStat label="Decision→fill p50 / p95" value={`${ms(exec.decision_to_fill_ms?.p50)} / ${ms(exec.decision_to_fill_ms?.p95)}`} />
        <HealthStat label="Exit slippage p50" value={rupees(exec.exit_slippage?.p50)} />
        <HealthStat
          label="Expected vs realised (p50)"
          value={rupees(legging?.expected_vs_realised_net?.p50)}
          title="Expected net at entry minus the realised net of closed trades"
        />
      </div>

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
