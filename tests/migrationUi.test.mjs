import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BrokerBadge } from '../src/BrokerBadge.tsx';
import TradesPanel from '../src/TradesPanel.tsx';

test('broker badges retain each record venue and the historical Zerodha default', () => {
  for (const [broker, label] of [['dhan', 'DHAN'], ['zerodha', 'ZERODHA'], [null, 'ZERODHA'], [undefined, 'ZERODHA']]) {
    const html = renderToStaticMarkup(createElement(BrokerBadge, { broker }));
    assert.ok(html.includes(`>${label}</span>`), html);
    assert.ok(!html.includes('fee schedule'), 'a venue badge must not invent the charge calculator used');
  }
});

test('calendar trade history retains fills, gross P&L and separate round-trip charges without Box tabs', () => {
  const now = new Date();
  const expiry = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-20`;
  const charge = (total) => ({ legs: [], value: 0, brokerage: total, stt: 0, exchange_txn: 0,
    sebi: 0, stamp_duty: 0, gst: 0, total, source: 'kite', at: now.toISOString() });
  const trade = { id: 'aaaaaaaaaaaaaaaaaaaaaaaa', symbol: 'BHEL', name: 'BHEL', is_index: false,
    lot_size: 75, buy: { token: 1, expiry, entry: 100 }, sell: { token: 2, expiry, entry: 200 },
    status: 'closed', opened_at: now.toISOString(), closed_at: now.toISOString(), close_pnl: 150,
    buy_close: 103, sell_close: 201, margin: 1000, entry_charges: charge(10), exit_charges: charge(20),
    est_exit_charges: charge(20), entry_value: null, exit_value: null, total_charges: 30, net_pnl: 120 };
  const html = renderToStaticMarkup(createElement(TradesPanel, { trades: [trade], ticks: {}, spotBySymbol: {},
    loading: false, error: null, closingId: null, deletingId: null, onClose() {}, onCloseTrade() {},
    onOpenTrade() {}, onDeleteTrade() {} }));
  assert.ok(html.includes('BHEL'));
  assert.ok(html.includes('P&amp;L'));
  assert.ok(html.includes('after charges'));
  assert.ok(html.includes('+₹120</span>'), 'the net summary must retain the separately deducted ₹30 charges');
  assert.ok(html.includes('History'));
  assert.ok(!html.includes('role="tab"'));
  assert.doesNotMatch(html.replace(/<[^>]*>/g, ''), /\bBox\b/);
});

test('the retained client has no Box route, Box API exports or hidden Trades-panel request', () => {
  const api = readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const panel = readFileSync(new URL('../src/TradesPanel.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(api, /\/api\/box\b|export\s+(?:type|interface|(?:async\s+)?function)\s+\w*Box\w*/);
  assert.doesNotMatch(app, /["']\/box["']|refreshBoxTrades|fetchBoxTrades/);
  assert.doesNotMatch(panel, /BoxTradesTab|boxOpen|boxTrades|onOpenBoxPage/);
});
