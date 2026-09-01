/**
 * The "?" explainer for the Box page.
 *
 * Written for a TRADER, not a developer: it explains what the page is doing, what
 * every label on it means, and how each number affects whether a box is taken or
 * closed. No code identifiers, no implementation detail that a desk analyst would
 * not care about.
 */

import { useEffect, useState } from "react";

export function BoxHelp() {
  const [open, setOpen] = useState(false);

  // Esc closes, and the body must not scroll behind the panel.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        className="box-help-btn"
        onClick={() => setOpen(true)}
        title="What this page does, and what every term on it means"
        aria-label="About this page"
      >
        ?
      </button>

      {open && (
        <div className="box-help-backdrop" onClick={() => setOpen(false)}>
          <div
            className="box-help"
            role="dialog"
            aria-modal="true"
            aria-label="About the Box Arbitrage page"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="box-help-head">
              <h2>Box Arbitrage — what this page is doing</h2>
              <button type="button" className="box-help-close" onClick={() => setOpen(false)} aria-label="Close">
                ×
              </button>
            </header>

            <div className="box-help-body">
              <p className="box-help-lead">
                <strong>Everything here is paper trading.</strong> No order is ever sent to Zerodha.
                Every fill you see is simulated at a price that was actually resting on the exchange
                order book at that moment — never an invented or averaged price.
              </p>

              <Section title="The trade">
                <p>
                  A <em>box</em> is four options on the same underlying and expiry, across two strikes
                  K1 &lt; K2. It settles at a fixed value — the strike width (K2 − K1) — wherever the
                  underlying ends up. So if you can put the box on for less than that width, the
                  difference is locked in.
                </p>
                <ul>
                  <li>
                    <strong>Long box</strong> — buy K1 call, sell K2 call, buy K2 put, sell K1 put.
                    You <em>receive</em> the width at expiry, so you want to pay less than it.
                  </li>
                  <li>
                    <strong>Short box</strong> — the exact mirror. You <em>pay</em> the width, so you
                    want to take in more than it.
                  </li>
                </ul>
                <p>
                  This strategy does <strong>not</strong> hold to expiry. It takes temporary
                  bid/ask dislocations and closes them when the prices converge, usually the same day.
                </p>
              </Section>

              <Section title="How a box gets taken">
                <p>Every candidate is priced on <em>executable</em> quotes — the ask when buying, the bid when selling, never the last traded price. The decision is one number:</p>
                <p className="box-help-formula">
                  gross edge − entry charges − estimated exit charges − expected exit slippage −
                  safety buffer = <strong>expected net profit</strong>
                </p>
                <p>
                  If that clears the <strong>entry gate</strong> (₹1,200 by default), the box is taken
                  — one lot, always. Charges are the real Zerodha heads (brokerage, STT, exchange,
                  SEBI, GST, stamp duty), calculated locally and then verified against Zerodha's own
                  contract note afterwards.
                </p>
                <p>
                  Crucially, the gate is re-tested on the prices that were actually <em>filled</em>,
                  not the ones that were spotted. A dislocation that decays while the orders are in
                  flight is rejected — and if all four legs had already filled by then, the position is
                  reversed immediately and that cost is recorded rather than hidden.
                </p>
              </Section>

              <Section title="How fills are simulated">
                <p>The <strong>Mode</strong> shown at the top tells you which model produced the numbers:</p>
                <ul>
                  <li>
                    <strong>paper touch</strong> — assumes all four legs fill instantly at the prices
                    you spotted. Optimistic; useful only as a benchmark.
                  </li>
                  <li>
                    <strong>paper latency</strong> — waits a realistic decision + order-travel delay,
                    then fills from the book that actually existed when the order would have landed.
                  </li>
                  <li>
                    <strong>paper legging</strong> — the most realistic: four <em>separate</em> orders,
                    each arriving on its own, each filling or resting or timing out independently. This
                    is the one that exposes legging risk — some legs on, others not.
                  </li>
                </ul>
              </Section>

              <Section title="How a box gets closed">
                <p>An open box is managed by the backend continuously — it keeps working when the scanner is stopped and when your browser is shut. It closes when either:</p>
                <ul>
                  <li>
                    the edge has <strong>converged</strong> (the remaining edge has shrunk past the
                    threshold) <em>and</em> the net profit clears the minimum, or
                  </li>
                  <li>
                    <strong>profit capture</strong> — enough of the original edge has already been
                    banked to justify taking it.
                  </li>
                </ul>
                <p>
                  On expiry day an <strong>expiry-safety</strong> window forces an exit attempt so a
                  position is never abandoned into settlement. If the market cannot fill the close at a
                  real price, the system refuses and says so rather than inventing a fill.
                </p>
              </Section>

              <Section title="The P&L strip">
                <ul>
                  <li>
                    <strong>Open running net</strong> — what the open boxes would net if closed at the
                    current touch, after all charges. It moves with the market.
                  </li>
                  <li>
                    <strong>Closed today net</strong> — realised net on boxes closed today.
                  </li>
                  <li>
                    <strong>Day net P&L</strong> — the two added together.
                  </li>
                </ul>
                <p className="box-help-note">
                  A large negative "open running net" alongside a healthy realised figure usually means
                  open boxes are being marked at the far side of a wide spread — it is a
                  mark-to-touch, not a loss taken.
                </p>
              </Section>

              <Section title="Every label on this page">
                <Glossary
                  rows={[
                    ["Entry gate", "Minimum expected net profit, after every cost, before a box is taken. Editable from ‘Edit thresholds’ — the change is saved on the server and applies to NEW boxes only."],
                    ["Execution / Mode", "Which fill model is running (see above). These must agree."],
                    ["Directions", "Whether long boxes, short boxes or both are being scanned."],
                    ["Safety buffer", "A risk allowance subtracted inside the expected-net figure, so it is part of the entry decision — raising it makes the gate harder to clear. Not a stop-loss. Also editable from ‘Edit thresholds’."],
                    ["Universe", "What is scanned: F&O stocks plus supported indices, options only."],
                    ["Prices", "Live executable quotes, or ‘Last close’ when the market is shut — indicative only, nothing can trade."],
                    ["Strikes ATM ±", "How many strikes each side of at-the-money are scanned. Narrowing it only affects NEW boxes; open positions are untouched."],
                    ["Lot", "Always one lot per box."],
                    ["Book trusted for", "How long an UNCHANGED order book is still treated as executable. A depth feed only publishes when the book changes, so a quiet strike is not a stale one."],
                    ["Feed", "Connection heartbeat. ‘idle’ when shut, ‘DOWN’ means the data link is broken and all entries and automatic exits pause."],
                    ["Exchange lag", "Rough staleness of the data versus NSE, from the exchange's own (1-second) timestamps. Shown only while the market is open."],
                    ["Watching", "How many underlyings and candidate boxes are being evaluated."],
                    ["Monitoring", "Open positions under management — independent of RUN/STOP and of your browser."],
                    ["Gross edge", "The raw mispricing: (strike width − cost of the box) × lot, before any costs."],
                    ["Expected net", "Gross edge after charges, expected exit slippage and the safety buffer. This is what the gate tests."],
                    ["Realisable net", "What an open box would net if closed now, minus an allowance for the slippage the exit itself will cost."],
                    ["Realised net", "The actual result once the exit has executed — no allowances left, nothing estimated."],
                    ["Margin used today", "Zerodha basket margin these boxes blocked: currently-open plus boxes already closed today. It is a SUM over the day, not a peak — boxes that opened and closed at different times never held their margin at the same moment, so treat it as an upper bound on what was blocked at any one instant. Boxes whose margin call failed are excluded and counted as ‘n/a’."],
                    ["Slippage", "Fill price versus the price that was on screen when the box was spotted. Positive always means it went against you."],
                    ["Liquidity", "Whether a whole lot is genuinely resting at the touch on all four legs. Without it, nothing is entered or exited."],
                    ["Fresh", "Age of the order book behind a quote. Older than the trust window and it is not used."],
                    ["Legging", "Some legs filled and others did not, leaving one-sided exposure. The filled legs are reversed immediately and that loss is booked."],
                    ["Exposure duration", "How long a position sat one-sided — from the first leg filling until the box was complete or unwound."],
                    ["Execution health", "How the simulated fills are actually going: how many were attempted, filled and failed, the failure rate, and the slippage and delay distributions (p50 = typical, p95 = bad case)."],
                    ["Expected vs realised", "Expected net at entry minus what the trade actually netted. Persistently positive means the model is flattering itself."],
                  ]}
                />
              </Section>

              <Section title="What this does not prove">
                <p>
                  Simulated fills at observed quotes are not exchange fills. Live trading also brings
                  queue position (being at the touch is not being first in line), depth vanishing
                  between decision and arrival, partial fills, order rejection, and margin and
                  position limits. Treat these results as an upper bound on what the strategy could
                  have done, and read the Execution health figures before believing the P&L.
                </p>
              </Section>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="box-help-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function Glossary({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="box-help-glossary">
      {rows.map(([term, meaning]) => (
        <div key={term} className="box-help-row">
          <dt>{term}</dt>
          <dd>{meaning}</dd>
        </div>
      ))}
    </dl>
  );
}
