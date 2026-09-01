/**
 * Admin editor for the two thresholds an operator actually tunes at runtime:
 * the ENTRY GATE (minimum expected net profit) and the SAFETY BUFFER.
 *
 * Both are saved server-side, so a change survives a restart and every browser
 * sees it. Everything else about the strategy stays env-configured on purpose —
 * latencies, freshness limits and capacity describe the execution model, not an
 * operator preference, and letting them drift mid-session would make paper fills
 * incomparable.
 *
 * The inputs are LOCAL state seeded from the server, not controlled by it: this
 * page re-renders several times a second off the SSE snapshot, and binding the
 * fields straight to `config` would fight every keystroke.
 */

import { useEffect, useState } from "react";
import { saveBoxSettings, type BoxConfigView, type BoxStatus } from "./api";

function rupees(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  const sign = v < 0 ? "-" : "";
  return `${sign}₹${Math.abs(Math.round(v)).toLocaleString("en-IN")}`;
}

/**
 * Below this, an entry gate gets a confirmation prompt.
 *
 * Round-trip charges on four option legs are already ≈₹190, so a gate under ₹100
 * is very likely a typo rather than an intent.
 */
const NEAR_ZERO_GATE = 100;

export function BoxGates({
  cfg,
  canTrade,
  onSaved,
}: {
  cfg: BoxConfigView | undefined;
  canTrade: boolean;
  onSaved: (next: { config: BoxConfigView; status: BoxStatus }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [gate, setGate] = useState("");
  const [safety, setSafety] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const serverGate = cfg?.min_expected_net_profit;
  const serverSafety = cfg?.safety_buffer;

  // Re-seed the fields from the server whenever the panel is opened, or when the
  // server's own values change while it is closed (another admin, or a restart).
  useEffect(() => {
    if (open) return;
    if (serverGate !== undefined) setGate(String(Math.round(serverGate)));
    if (serverSafety !== undefined) setSafety(String(Math.round(serverSafety)));
  }, [open, serverGate, serverSafety]);

  const limits = cfg?.tunable;
  const gateNum = Number(gate);
  const safetyNum = Number(safety);
  const gateValid = gate.trim() !== "" && Number.isFinite(gateNum) && gateNum >= 0;
  const safetyValid = safety.trim() !== "" && Number.isFinite(safetyNum) && safetyNum >= 0;
  // Only "dirty" once the server's own values are known — otherwise the fields
  // would compare against NaN and Save would look enabled before there is anything
  // to compare to.
  const dirty =
    serverGate !== undefined &&
    serverSafety !== undefined &&
    ((gateValid && Math.round(gateNum) !== Math.round(serverGate)) ||
      (safetyValid && Math.round(safetyNum) !== Math.round(serverSafety)));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!gateValid || !safetyValid) {
      setError("Both values must be numbers of ₹0 or more.");
      return;
    }
    // A gate at or near zero is a legitimate configuration ("take anything that is
    // net-positive at all"), but it is also what a mistyped number looks like — and
    // it governs automatic entries from the next evaluation. Worth one question.
    if (Math.round(gateNum) < NEAR_ZERO_GATE) {
      const ok = window.confirm(
        `An entry gate of ${rupees(Math.round(gateNum))} means boxes will be entered on almost ` +
          `any positive expected net profit, and every fill still pays real charges and slippage. ` +
          `Apply it?`,
      );
      if (!ok) return;
    }
    setSaving(true);
    setError(null);
    setSaved(null);
    try {
      const next = await saveBoxSettings({
        min_expected_net_profit: Math.round(gateNum),
        safety_buffer: Math.round(safetyNum),
      });
      onSaved(next);
      setSaved(
        `Saved. New boxes now need ${rupees(next.config.min_expected_net_profit)} of expected net ` +
          `profit, with a ${rupees(next.config.safety_buffer)} safety buffer inside it. ` +
          `Open positions are unaffected.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save the settings.");
    } finally {
      setSaving(false);
    }
  }

  function reset() {
    if (serverGate !== undefined) setGate(String(Math.round(serverGate)));
    if (serverSafety !== undefined) setSafety(String(Math.round(serverSafety)));
    setError(null);
    setSaved(null);
  }

  if (!canTrade) return null;

  return (
    <section className="box-gates">
      <button
        type="button"
        className="btn btn--sm box-gates-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title="Change the entry gate and safety buffer the scanner trades on"
      >
        {open ? "Hide thresholds" : "Edit thresholds"}
        <span className="box-gates-summary">
          gate {rupees(serverGate)} · safety {rupees(serverSafety)}
        </span>
      </button>

      {open && (
        <form className="box-gates-form" onSubmit={(e) => void submit(e)}>
          <label className="box-gates-field">
            <span className="box-gates-k">Entry gate (₹ expected net)</span>
            <input
              type="number"
              inputMode="numeric"
              step={50}
              min={limits?.min_expected_net_profit.min ?? 0}
              max={limits?.min_expected_net_profit.max ?? 1_000_000}
              value={gate}
              onChange={(e) => setGate(e.target.value)}
              disabled={saving}
              aria-invalid={!gateValid}
            />
            <span className="box-gates-hint">
              A box is entered only when gross minus entry fees, estimated exit fees, simulated
              execution cost AND the safety buffer clears this.
            </span>
          </label>

          <label className="box-gates-field">
            <span className="box-gates-k">Safety buffer (₹)</span>
            <input
              type="number"
              inputMode="numeric"
              step={25}
              min={limits?.safety_buffer.min ?? 0}
              max={limits?.safety_buffer.max ?? 1_000_000}
              value={safety}
              onChange={(e) => setSafety(e.target.value)}
              disabled={saving}
              aria-invalid={!safetyValid}
            />
            <span className="box-gates-hint">
              Deducted <strong>inside</strong> the expected-net figure above, so raising it makes the
              gate strictly harder to clear.
            </span>
          </label>

          <div className="box-gates-actions">
            <button className="btn btn--primary btn--sm" type="submit" disabled={saving || !dirty}>
              {saving ? "Saving…" : "Save"}
            </button>
            <button
              className="btn btn--sm"
              type="button"
              onClick={reset}
              disabled={saving || !dirty}
            >
              Reset
            </button>
            <span className="box-gates-note">
              Saved on the server and applied to the next evaluation. Affects NEW boxes only —
              positions already open keep the terms they were opened on.
            </span>
          </div>

          {error && <p className="box-gates-msg box-gates-msg--error">{error}</p>}
          {saved && !error && <p className="box-gates-msg box-gates-msg--ok">{saved}</p>}
        </form>
      )}
    </section>
  );
}
