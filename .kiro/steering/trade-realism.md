# Trade realism: match the broker, not a model

Every price and P&L figure in this app must read the way the same position reads
in the broker's own app. The purpose is that a number here can be trusted as
"what I would actually have if I had really traded this". When a choice comes up
between a figure that is theoretically nicer and one that matches the broker
screen, **the broker screen wins.**

## Open positions are marked to LTP

An open trade's live P&L is computed against `last_price` (LTP) for both legs —
this is what a broker shows for an open position, so it is what we show.

It follows that the figure moves on every tick. That is correct, not a bug.

Do **not** "improve" this by marking the legs to the exit-side touch (long leg to
the best bid, short leg to the best ask). That is arguably a truer estimate of
what a close would fetch, and the tick feed does carry the depth to do it
(`Tick.bid` / `.ask` / `.bids` / `.asks`), but it would no longer match the
broker screen, which is the thing being matched.

Two consequences to keep in mind rather than paper over:

- A position shows a **small loss the moment it is taken**, because the entry
  crossed the spread. A broker behaves the same way. Don't zero it out.
- The live figure **still owes the exit spread**, because closing re-prices
  against the book. Again, same as the broker.

## Fills are at the touch (best bid / best ask)

Entry: the long leg pays the best **ask**, the short leg receives the best
**bid** (`bestPrice()` in the backend `index.ts`). Exit mirrors it: sell the long
leg into the **bid**, buy the short leg back at the **ask**.

- These are real, tick-size-valid, executable prices. A volume-weighted average
  across depth levels is **not** — it produces a price that does not exist on the
  exchange — so it is deliberately not used.
- Fills are **top-of-book only; quantity is never consulted — and for this app
  that is exact, not an approximation.** The app trades exactly **1 lot**, and
  NSE requires every F&O order to be a multiple of the lot size (partial lots
  cannot be traded). So every resting order, and therefore the aggregate
  quantity at any depth level, is at least one lot: a 1-lot order can never
  exhaust the touch and has no deeper level to walk into. The modelled slippage
  of exactly one spread is the real fill.
- That guarantee is **tied to the 1-lot design.** If multi-lot sizing is ever
  added, this stops holding — a 5-lot order can outsize the touch — and only
  then does a quantity-aware walk become necessary (rounding to a valid tick).
  Do not "pre-fix" it before then; the current code is correct as it stands.
- If a needed side of the book is empty, **refuse the trade** rather than invent
  a fill from LTP. A fabricated entry poisons the P&L for the life of the trade.

## Charges are reported, never silently deducted

P&L is the **price move**. Brokerage and statutory charges are shown beside it,
not subtracted from it, so both the result and its cost stay legible. Netted
figures are fine when explicitly labelled as such (e.g. "after charges").
