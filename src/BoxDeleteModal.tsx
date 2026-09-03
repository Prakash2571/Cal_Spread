/**
 * Destructive confirmation for deleting a Box trade.
 *
 * Deleting a trade is IRREVERSIBLE and rewrites the day's statistics, so it gets an
 * explicit modal rather than a bare button. The modal names the exact trade, states
 * what will change, and keeps the destructive action visually distinct from Cancel.
 *
 * Follows the existing TradeConfirmModal structure (overlay + modal--sm + modal-head
 * + modal-actions) so it looks native to the app rather than bolted on.
 */

import { useEffect, useRef, useState } from "react";
import { XIcon } from "@phosphor-icons/react";
import { directionLabel } from "./BoxDirection.tsx";
import { BrokerBadge } from "./BoxBroker.tsx";
import type { BoxDirection, BrokerId } from "./api.ts";

interface Props {
  underlying: string;
  direction: BoxDirection;
  broker?: BrokerId | null;
  lowerStrike: number;
  upperStrike: number;
  /** "open" reads differently from "closed": one stops being monitored. */
  status: "open" | "closed" | "error";
  busy: boolean;
  /** An optional free-text reason, recorded in the append-only audit event. */
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}

export default function BoxDeleteModal({
  underlying,
  direction,
  broker,
  lowerStrike,
  upperStrike,
  status,
  busy,
  onConfirm,
  onCancel,
}: Props) {
  const [reason, setReason] = useState("");
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Focus CANCEL, not Delete. For a destructive dialog the safe action should be
  // the one a stray Enter or Space lands on.
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  // Escape cancels, matching every other dismissible surface in the app.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);

  return (
    <div className="modal-overlay" onClick={busy ? undefined : onCancel}>
      <div
        className="modal modal--sm"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="box-delete-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-head">
          <div>
            <h2 id="box-delete-title">
              Delete {underlying} {directionLabel(direction)}?
            </h2>
            <p className="modal-sub">
              {lowerStrike} → {upperStrike} · <BrokerBadge broker={broker} />
            </p>
          </div>
          <button
            type="button"
            className="modal-x"
            onClick={onCancel}
            disabled={busy}
            aria-label="Close"
          >
            <XIcon size={18} weight="regular" aria-hidden="true" />
          </button>
        </header>

        <div className="modal-body confirm-modal-body">
          <p className="box-delete-warning">
            This permanently removes this <strong>PAPER</strong> trade from Box statistics and
            history. It cannot be undone.
          </p>
          <ul className="box-delete-effects">
            {status === "open" && <li>It stops being monitored and will never close.</li>}
            <li>Open and closed trade counts are corrected.</li>
            <li>Day P&amp;L and running net are recalculated.</li>
            <li>Margin figures, including peak concurrent margin, are recomputed.</li>
            <li>An audit record of the deletion is kept.</li>
          </ul>

          <label className="box-delete-reason">
            <span className="metric-label">Reason (optional, recorded in the audit trail)</span>
            <input
              type="text"
              value={reason}
              maxLength={500}
              disabled={busy}
              placeholder="e.g. duplicate entry from a bad feed tick"
              onChange={(e) => setReason(e.target.value)}
            />
          </label>

          <div className="modal-actions">
            <button
              className="btn modal-action"
              ref={cancelRef}
              onClick={onCancel}
              disabled={busy}
            >
              Cancel
            </button>
            <button
              className="btn btn--danger modal-action"
              onClick={() => onConfirm(reason.trim())}
              disabled={busy}
            >
              {busy ? "Deleting…" : "Delete trade"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
